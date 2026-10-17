import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
    ConflictException,
    UnauthorizedException,
    Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import 'multer';
import { Prisma } from '../../generated/prisma/client';
import type { Attachment } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/database/prisma.service';
import { SaveAttachmentDto } from './dto';
import { AttachmentEntity, PublicUploadEntity } from './entities';
import { StorageService } from './storage';
import {
    isPublicUploadKey,
    isTaskUploadKey,
    normalizeUserUploadDirectory,
} from './storage/filename.util';
import { SettingsService } from '../settings';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import type { AccessDb } from '../../common/authorization/access-locks';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import {
    isAllowedTicketAttachment,
    MAX_TICKET_ATTACHMENT_SIZE,
    MAX_TICKET_ATTACHMENTS,
    TICKET_UPLOAD_DIRECTORY,
} from './attachment-limits';
import type { TicketAttachmentRef } from './attachment-limits';
import { AttachmentObjectUrlService } from './object-url.service';

/** Minimal attachment row the ticket flow reads (structural, not Prisma-bound). */
export type TicketAttachmentRow = Pick<
    Attachment,
    'filename' | 'mimeType' | 'size' | 'url' | 'fileKey'
>;

/** Query the public object endpoint accepts; `exp` / `sig` make it a signed link. */
export interface PublicObjectQuery {
    key: string;
    provider?: 'LOCAL' | 'OSS';
    bucket?: string;
    exp?: number;
    sig?: string;
}

const uploaderSelect = { id: true, name: true } as const;
const ALLOWED_BLOB_MIME_TYPES = new Set([
    'text/plain',
    'text/csv',
    'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

@Injectable()
export class AttachmentsService {
    private readonly logger = new Logger(AttachmentsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly storage: StorageService,
        private readonly settingsService: SettingsService,
        private readonly access: ProjectAccessService,
        private readonly jwtService: JwtService,
        private readonly objectUrls: AttachmentObjectUrlService,
    ) {}

    async findAll(taskId: string, principal: AccessPrincipal) {
        await this.access.task(principal, taskId);

        const attachments = await this.prisma.attachment.findMany({
            where: { taskId, visibility: { in: ['PRIVATE', 'EXTERNAL'] } },
            include: { uploadedBy: { select: uploaderSelect } },
            orderBy: { createdAt: 'desc' },
        });

        return attachments.map((a) => new AttachmentEntity(a));
    }

    async save(taskId: string, userId: string, dto: SaveAttachmentDto) {
        if (
            !dto.source ||
            dto.source === 'UPLOAD' ||
            dto.fileKey ||
            dto.bucket ||
            dto.checksum ||
            (dto.storageProvider && dto.storageProvider !== 'EXTERNAL')
        ) {
            throw new BadRequestException(
                'First-party attachments must use the private upload endpoint',
            );
        }
        const attachment = await this.access.withTask(
            { type: 'USER', userId },
            taskId,
            'attachment.write',
            async (tx) =>
                tx.attachment.create({
                    data: {
                        filename: dto.filename,
                        mimeType: dto.mimeType,
                        size: dto.size,
                        url: dto.url,
                        storageProvider: 'EXTERNAL',
                        visibility: 'EXTERNAL',
                        source: dto.source as
                            'URL' | 'GOOGLE_DRIVE' | 'DROPBOX',
                        taskId,
                        uploadedById: userId,
                    },
                    include: { uploadedBy: { select: uploaderSelect } },
                }),
        );

        return new AttachmentEntity(attachment);
    }

    async upload(
        taskId: string,
        userId: string,
        file: Express.Multer.File | undefined,
    ) {
        if (!file) {
            throw new BadRequestException('File is required');
        }

        const principal: AccessPrincipal = { type: 'USER', userId };
        const task = await this.access.withTask(
            principal,
            taskId,
            'attachment.write',
            (_tx, _access, task) => Promise.resolve(task),
        );
        await this.validateFile(file);

        const stored = await this.storage.putObject({
            buffer: file.buffer,
            filename: file.originalname,
            mimeType: file.mimetype || 'application/octet-stream',
            size: file.size,
            organizationId: task.organizationId,
            taskId,
            uploadedById: userId,
            visibility: 'PRIVATE',
        });

        try {
            return await this.access.withTask(
                principal,
                taskId,
                'attachment.write',
                async (tx) => {
                    const created = await tx.attachment.create({
                        data: {
                            filename: file.originalname,
                            mimeType:
                                file.mimetype || 'application/octet-stream',
                            size: file.size,
                            url: '',
                            fileKey: stored.key,
                            storageProvider: stored.provider,
                            bucket: stored.bucket ?? null,
                            checksum: stored.checksum ?? null,
                            source: 'UPLOAD',
                            visibility: 'PRIVATE',
                            taskId,
                            uploadedById: userId,
                        },
                        include: { uploadedBy: { select: uploaderSelect } },
                    });

                    const updated = await tx.attachment.update({
                        where: { id: created.id },
                        data: {
                            url: `/api/tasks/${taskId}/attachments/${created.id}/download`,
                        },
                        include: { uploadedBy: { select: uploaderSelect } },
                    });

                    return new AttachmentEntity(updated);
                },
            );
        } catch (error) {
            await this.storage
                .deleteObject(stored.provider, stored.key, stored.bucket)
                .catch(() =>
                    this.logger.warn(
                        'Failed to clean up uncommitted private attachment',
                    ),
                );
            throw error;
        }
    }

    async uploadPublic(
        file: Express.Multer.File | undefined,
        userId: string,
        directory?: string,
    ) {
        if (!file) {
            throw new BadRequestException('File is required');
        }

        await this.validateFile(file);
        const uploadDirectory = normalizeUserUploadDirectory(userId, directory);
        if (
            uploadDirectory.toLowerCase() === 'organizations' ||
            uploadDirectory.toLowerCase().startsWith('organizations/')
        ) {
            throw new BadRequestException('Reserved attachment directory');
        }

        const mimeType = file.mimetype || 'application/octet-stream';
        const stored = await this.storage.putObject({
            buffer: file.buffer,
            filename: file.originalname,
            mimeType,
            size: file.size,
            organizationId: 'public',
            taskId: 'public',
            uploadedById: userId,
            directory: uploadDirectory,
            publicUpload: true,
            visibility: 'PUBLIC',
        });

        // The row exists before any business flow claims it. A ticket can then
        // only attach files the server itself accepted, and an unclaimed row is
        // exactly the cleanup criterion for uploads that never get submitted.
        const attachment = await this.prisma.attachment.create({
            data: {
                filename: file.originalname,
                mimeType,
                size: file.size,
                url: stored.url ?? '',
                fileKey: stored.key,
                storageProvider: stored.provider,
                bucket: stored.bucket ?? null,
                checksum: stored.checksum ?? null,
                source: 'UPLOAD',
                visibility: 'PUBLIC',
                uploadedById: userId,
            },
        });

        return new PublicUploadEntity({
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
            storageProvider: attachment.storageProvider,
            directory: uploadDirectory,
            bucket: attachment.bucket ?? undefined,
            fileKey: stored.key,
            url: await this.objectUrls.toObjectUrl(stored.key, stored.url),
            checksum: attachment.checksum ?? undefined,
            uploadedById: userId,
        });
    }

    /**
     * Binds freshly-uploaded rows to a ticket or to a ticket reply.
     *
     * Every check reads the server-side row, never the fields the client sent:
     * size, MIME type and URL all come from what was actually stored, so a
     * tampered request cannot smuggle in a different file's metadata.
     */
    async claimForTicket(
        db: Prisma.TransactionClient,
        refs: TicketAttachmentRef[] | undefined,
        target: { ticketId?: string; ticketReplyId?: string },
        userId: string,
    ): Promise<Attachment[]> {
        if (!refs?.length) return [];

        if (refs.length > MAX_TICKET_ATTACHMENTS) {
            throw new BadRequestException(
                `At most ${MAX_TICKET_ATTACHMENTS} attachments are allowed`,
            );
        }

        const keys = refs.map((ref) => ref.fileKey);
        if (new Set(keys).size !== keys.length) {
            throw new BadRequestException('Duplicate attachments');
        }

        const rows = await db.attachment.findMany({
            where: { fileKey: { in: keys } },
        });
        if (rows.length !== keys.length) {
            throw new BadRequestException('Attachment is missing or expired');
        }

        for (const row of rows) {
            if (!row.uploadedById || row.uploadedById !== userId) {
                throw new ForbiddenException(
                    'Attachment belongs to another user',
                );
            }
            if (row.taskId || row.ticketId || row.ticketReplyId) {
                throw new ConflictException('Attachment is already in use');
            }
            if (row.size > MAX_TICKET_ATTACHMENT_SIZE) {
                throw new BadRequestException(
                    'Attachment exceeds the 5MB limit',
                );
            }
            if (!isAllowedTicketAttachment(row.mimeType, row.filename)) {
                throw new BadRequestException(
                    `Unsupported attachment type: ${row.mimeType}`,
                );
            }
        }

        await db.attachment.updateMany({
            where: {
                fileKey: { in: keys },
                taskId: null,
                ticketId: null,
                ticketReplyId: null,
            },
            data: { ...target },
        });

        return rows.map((row) => ({ ...row, ...target }));
    }

    /** Client-facing view of ticket attachment rows, with a usable URL each. */
    async toTicketAttachmentRefs(
        rows: TicketAttachmentRow[] | undefined,
    ): Promise<TicketAttachmentRef[]> {
        if (!rows?.length) return [];

        return Promise.all(
            rows.map(async (row) => ({
                filename: row.filename,
                mimeType: row.mimeType,
                size: row.size,
                fileKey: row.fileKey ?? '',
                url: row.fileKey
                    ? await this.objectUrls.toObjectUrl(row.fileKey, row.url)
                    : row.url,
            })),
        );
    }

    /**
     * Streams or redirects a general object.
     *
     * Access rules, in order:
     *  - a valid signed link — the API only signs keys for callers allowed to
     *    read them, so the link stands in for an Authorization header that an
     *    `<img src>` / `<a href>` can never send;
     *  - a Bearer token whose user may read the attachment.
     */
    async getPublicObjectDownload(query: PublicObjectQuery, bearer?: string) {
        if (!this.isSignedRequest(query)) {
            const user = await this.requireBearerUser(bearer);
            await this.assertObjectAccess(query.key, user);
        }

        const storageProvider =
            query.provider ?? (await this.storage.activeProviderName());

        return {
            filename: this.filenameFromKey(query.key),
            mimeType: this.mimeTypeFromKey(query.key),
            download: await this.storage.getDownload(
                storageProvider,
                query.key,
                query.bucket,
                'PUBLIC',
            ),
        };
    }

    async getDownload(
        taskId: string,
        attachmentId: string,
        principal: AccessPrincipal,
    ) {
        const { task } = await this.access.task(principal, taskId);

        const attachment = await this.findAttachment(taskId, attachmentId);
        if (attachment.visibility === 'UNKNOWN') {
            throw new NotFoundException(
                'Attachment is not available until classified',
            );
        }
        if (
            attachment.visibility === 'EXTERNAL' &&
            attachment.source !== 'UPLOAD'
        ) {
            return {
                attachment,
                download: { type: 'redirect', url: attachment.url } as const,
            };
        }
        if (
            attachment.visibility !== 'PRIVATE' ||
            attachment.source !== 'UPLOAD' ||
            !attachment.fileKey ||
            !isTaskUploadKey(attachment.fileKey, task.organizationId, taskId)
        ) {
            throw new NotFoundException('Attachment object key not found');
        }

        return {
            attachment,
            download: await this.storage.getDownload(
                attachment.storageProvider,
                attachment.fileKey,
                attachment.bucket,
                'PRIVATE',
            ),
        };
    }

    async remove(taskId: string, attachmentId: string, userId: string) {
        const attachment = await this.access.withTask(
            { type: 'USER', userId },
            taskId,
            'attachment.write',
            async (tx, access) => {
                const attachment = await this.findAttachment(
                    taskId,
                    attachmentId,
                    tx,
                );

                // Uploader or ADMIN+ can delete
                const isAdmin = access.effectiveRole === 'ADMIN';
                if (attachment.uploadedById !== userId && !isAdmin) {
                    throw new ForbiddenException(
                        'Only the uploader or an admin can delete this attachment',
                    );
                }

                await tx.attachment.delete({
                    where: { id: attachmentId, taskId },
                });
                await tx.auditLog.create({
                    data: {
                        actorId: userId,
                        organizationId: access.organizationId,
                        projectId: access.projectId,
                        action: 'DELETE',
                        entity: 'Attachment',
                        entityId: attachmentId,
                        before: {
                            filename: attachment.filename,
                            visibility: attachment.visibility,
                        },
                    },
                });
                return attachment;
            },
        );
        // Delete the stored object when Beacon owns the upload.
        if (
            attachment.visibility === 'PRIVATE' &&
            attachment.source === 'UPLOAD' &&
            attachment.fileKey
        ) {
            await this.storage
                .deleteObject(
                    attachment.storageProvider,
                    attachment.fileKey,
                    attachment.bucket,
                )
                .catch(() => {
                    this.logger.warn(
                        'Failed to delete committed private attachment object',
                    );
                });
        }
    }

    // ── PRIVATE HELPERS ─────────────────────────────────────────────────

    private isSignedRequest(query: PublicObjectQuery): boolean {
        if (!query.exp || !query.sig) return false;
        return this.objectUrls.verify(query.key, query.exp, query.sig);
    }

    /**
     * Verifies a raw bearer token on the public object endpoint. That route is
     * `@Public()` so browsers can open signed links, which means the guard no
     * longer resolves the caller and it has to happen here.
     */
    private async requireBearerUser(bearer?: string): Promise<JwtPayload> {
        if (!bearer) throw new UnauthorizedException('Missing access token');

        let payload: JwtPayload;
        try {
            payload = await this.jwtService.verifyAsync<JwtPayload>(bearer);
        } catch {
            throw new UnauthorizedException('Invalid or expired access token');
        }

        const current = await this.prisma.user.findFirst({
            where: { id: payload.sub, isActive: true, deletedAt: null },
            select: { id: true, email: true, globalRole: true },
        });
        if (!current) {
            throw new UnauthorizedException('User is no longer active');
        }

        return {
            sub: current.id,
            email: current.email,
            globalRole: current.globalRole,
        };
    }

    /**
     * Who may read an object when no signature vouches for the caller:
     *  - ticket attachment: the uploader, the ticket author, the reply author or
     *    a platform operator; internal notes only for uploader / operators;
     *  - unclaimed upload: its owner, or anyone while it sits outside `tickets/`
     *    (avatars and other general uploads keep their old behaviour).
     */
    private async assertObjectAccess(
        key: string,
        user: JwtPayload,
    ): Promise<void> {
        const record = await this.prisma.attachment.findFirst({
            where: { fileKey: key },
            select: {
                uploadedById: true,
                ticketId: true,
                ticketReplyId: true,
                ticket: { select: { authorId: true } },
                ticketReply: {
                    select: { authorId: true, isInternalNote: true },
                },
            },
        });

        if (!record) {
            if (!isPublicUploadKey(key)) {
                throw new ForbiddenException('Object key is not accessible');
            }
            return;
        }

        const isOperator = user.globalRole === 'SUPER_ADMIN';
        const isUploader =
            Boolean(record.uploadedById) && record.uploadedById === user.sub;

        if (!record.ticketId && !record.ticketReplyId) {
            if (isUploader || isOperator) return;
            if (
                isPublicUploadKey(key) &&
                !key.startsWith(`${TICKET_UPLOAD_DIRECTORY}/`)
            ) {
                return;
            }
            throw new ForbiddenException('Object key is not accessible');
        }

        // A note's attachments inherit the note's visibility: the submitter must
        // not reach them by holding on to the fileKey.
        if (record.ticketReply?.isInternalNote) {
            if (isOperator || isUploader) return;
            throw new ForbiddenException('Object key is not accessible');
        }

        if (
            isOperator ||
            isUploader ||
            record.ticket?.authorId === user.sub ||
            record.ticketReply?.authorId === user.sub
        ) {
            return;
        }

        throw new ForbiddenException('Object key is not accessible');
    }

    private async findAttachment(
        taskId: string,
        attachmentId: string,
        db: AccessDb = this.prisma,
    ): Promise<Attachment> {
        const attachment = await db.attachment.findFirst({
            where: { id: attachmentId, taskId },
        });

        if (!attachment) {
            throw new NotFoundException('Attachment not found');
        }

        return attachment;
    }

    private async validateFile(file: Express.Multer.File) {
        const settings = await this.settingsService.getAttachmentSettings();
        const mimeType = file.mimetype || 'application/octet-stream';
        const sizeMb = file.size / 1024 / 1024;

        if (mimeType.startsWith('image/')) {
            if (sizeMb > settings.maxImageSizeMb) {
                throw new BadRequestException(
                    `Image exceeds ${settings.maxImageSizeMb}MB`,
                );
            }
            return;
        }

        if (mimeType === 'application/pdf') {
            if (sizeMb > settings.maxPdfSizeMb) {
                throw new BadRequestException(
                    `PDF exceeds ${settings.maxPdfSizeMb}MB`,
                );
            }
            return;
        }

        if (!ALLOWED_BLOB_MIME_TYPES.has(mimeType)) {
            throw new BadRequestException(`Unsupported file type: ${mimeType}`);
        }

        if (sizeMb > settings.maxBlobSizeMb) {
            throw new BadRequestException(
                `File exceeds ${settings.maxBlobSizeMb}MB`,
            );
        }
    }

    private filenameFromKey(key: string): string {
        const filename = key.split('/').pop() || 'attachment';
        try {
            return decodeURIComponent(filename);
        } catch {
            return filename;
        }
    }

    private mimeTypeFromKey(key: string): string {
        const lowerKey = key.toLowerCase();
        if (lowerKey.endsWith('.png')) return 'image/png';
        if (lowerKey.endsWith('.jpg') || lowerKey.endsWith('.jpeg')) {
            return 'image/jpeg';
        }
        if (lowerKey.endsWith('.gif')) return 'image/gif';
        if (lowerKey.endsWith('.webp')) return 'image/webp';
        if (lowerKey.endsWith('.svg')) return 'image/svg+xml';
        if (lowerKey.endsWith('.pdf')) return 'application/pdf';
        if (lowerKey.endsWith('.txt')) return 'text/plain; charset=utf-8';
        if (lowerKey.endsWith('.csv')) return 'text/csv; charset=utf-8';
        return 'application/octet-stream';
    }
}

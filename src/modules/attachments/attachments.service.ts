import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import 'multer';
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

        const stored = await this.storage.putObject({
            buffer: file.buffer,
            filename: file.originalname,
            mimeType: file.mimetype || 'application/octet-stream',
            size: file.size,
            organizationId: 'public',
            taskId: 'public',
            uploadedById: userId,
            directory: uploadDirectory,
            publicUpload: true,
            visibility: 'PUBLIC',
        });

        return new PublicUploadEntity({
            filename: file.originalname,
            mimeType: file.mimetype || 'application/octet-stream',
            size: file.size,
            storageProvider: stored.provider,
            directory: uploadDirectory,
            bucket: stored.bucket,
            fileKey: stored.key,
            url: stored.url,
            checksum: stored.checksum,
            uploadedById: userId,
        });
    }

    async getPublicObjectDownload(
        key: string,
        provider?: 'LOCAL' | 'OSS',
        bucket?: string,
    ) {
        if (!isPublicUploadKey(key)) {
            throw new ForbiddenException('Object key is not accessible');
        }

        const storageProvider =
            provider ?? (await this.storage.activeProviderName());

        return {
            filename: this.filenameFromKey(key),
            mimeType: this.mimeTypeFromKey(key),
            download: await this.storage.getDownload(
                storageProvider,
                key,
                bucket,
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

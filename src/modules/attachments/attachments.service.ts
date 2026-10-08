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
    normalizeUserUploadDirectory,
} from './storage/filename.util';
import { SettingsService } from '../settings';

const uploaderSelect = { id: true, name: true, email: true } as const;
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
    ) {}

    async findAll(taskId: string) {
        await this.ensureTaskExists(taskId);

        const attachments = await this.prisma.attachment.findMany({
            where: { taskId },
            include: { uploadedBy: { select: uploaderSelect } },
            orderBy: { createdAt: 'desc' },
        });

        return attachments.map((a) => new AttachmentEntity(a));
    }

    async save(taskId: string, userId: string, dto: SaveAttachmentDto) {
        await this.ensureTaskExists(taskId);

        const attachment = await this.prisma.attachment.create({
            data: {
                filename: dto.filename,
                mimeType: dto.mimeType,
                size: dto.size,
                url: dto.url,
                fileKey: dto.fileKey ?? null,
                storageProvider:
                    (dto.storageProvider as any) ??
                    (dto.source === 'UPLOAD'
                        ? await this.storage.activeProviderName()
                        : 'EXTERNAL'),
                bucket: dto.bucket ?? null,
                checksum: dto.checksum ?? null,
                source: (dto.source as any) ?? 'UPLOAD',
                taskId,
                uploadedById: userId,
            },
            include: { uploadedBy: { select: uploaderSelect } },
        });

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

        const task = await this.ensureTaskExists(taskId);
        await this.validateFile(file);

        const stored = await this.storage.putObject({
            buffer: file.buffer,
            filename: file.originalname,
            mimeType: file.mimetype || 'application/octet-stream',
            size: file.size,
            organizationId: task.organizationId,
            taskId,
            uploadedById: userId,
        });

        const created = await this.prisma.attachment.create({
            data: {
                filename: file.originalname,
                mimeType: file.mimetype || 'application/octet-stream',
                size: file.size,
                url: stored.url || '',
                fileKey: stored.key,
                storageProvider: stored.provider,
                bucket: stored.bucket ?? null,
                checksum: stored.checksum ?? null,
                source: 'UPLOAD',
                taskId,
                uploadedById: userId,
            },
            include: { uploadedBy: { select: uploaderSelect } },
        });

        if (created.url) {
            return new AttachmentEntity(created);
        }

        const updated = await this.prisma.attachment.update({
            where: { id: created.id },
            data: {
                url: `/api/tasks/${taskId}/attachments/${created.id}/download`,
            },
            include: { uploadedBy: { select: uploaderSelect } },
        });

        return new AttachmentEntity(updated);
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
            ),
        };
    }

    async getDownload(taskId: string, attachmentId: string) {
        await this.ensureTaskExists(taskId);

        const attachment = await this.findAttachment(taskId, attachmentId);
        if (attachment.source !== 'UPLOAD') {
            return {
                attachment,
                download: { type: 'redirect', url: attachment.url } as const,
            };
        }
        if (!attachment.fileKey) {
            throw new NotFoundException('Attachment object key not found');
        }

        return {
            attachment,
            download: await this.storage.getDownload(
                attachment.storageProvider,
                attachment.fileKey,
                attachment.bucket,
            ),
        };
    }

    async remove(
        taskId: string,
        attachmentId: string,
        userId: string,
        userRole: string,
    ) {
        await this.ensureTaskExists(taskId);

        const attachment = await this.findAttachment(taskId, attachmentId);

        // Uploader or ADMIN+ can delete
        const isAdmin = ['OWNER', 'ADMIN'].includes(userRole);
        if (attachment.uploadedById !== userId && !isAdmin) {
            throw new ForbiddenException(
                'Only the uploader or an admin can delete this attachment',
            );
        }

        // Delete the stored object when Beacon owns the upload.
        if (attachment.source === 'UPLOAD' && attachment.fileKey) {
            await this.storage
                .deleteObject(
                    attachment.storageProvider,
                    attachment.fileKey,
                    attachment.bucket,
                )
                .catch((error) => {
                    this.logger.warn(
                        `Failed to delete attachment object ${attachment.fileKey}: ${error instanceof Error ? error.message : String(error)}`,
                    );
                });
        }

        await this.prisma.attachment.delete({ where: { id: attachmentId } });
    }

    // ── PRIVATE HELPERS ─────────────────────────────────────────────────

    private async ensureTaskExists(taskId: string) {
        const task = await this.prisma.task.findFirst({
            where: { id: taskId, deletedAt: null },
            select: { id: true, organizationId: true, projectId: true },
        });
        if (!task) throw new NotFoundException('Task not found');
        return task;
    }

    private async findAttachment(
        taskId: string,
        attachmentId: string,
    ): Promise<Attachment> {
        const attachment = await this.prisma.attachment.findFirst({
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

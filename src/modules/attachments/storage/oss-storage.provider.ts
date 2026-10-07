import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';
import type { StorageConfig } from '../../../config';
import { SettingsService } from '../../settings';
import {
    AttachmentStorageProvider,
    DownloadResult,
    PutObjectInput,
    PutObjectResult,
} from './storage.types';
import { buildObjectKey } from './filename.util';

@Injectable()
export class OssStorageProvider implements AttachmentStorageProvider {
    private readonly config: StorageConfig;
    private readonly client: S3Client;

    constructor(
        private readonly configService: ConfigService,
        private readonly settingsService: SettingsService,
    ) {
        this.config = this.configService.get<StorageConfig>('storage')!;
        const oss = this.config.oss;
        this.client = new S3Client({
            endpoint: oss.endpoint || undefined,
            region: oss.region,
            forcePathStyle: oss.forcePathStyle,
            credentials:
                oss.accessKeyId && oss.accessKeySecret
                    ? {
                          accessKeyId: oss.accessKeyId,
                          secretAccessKey: oss.accessKeySecret,
                      }
                    : undefined,
        });
    }

    async putObject(input: PutObjectInput): Promise<PutObjectResult> {
        const bucket = this.bucket();
        const key = buildObjectKey({
            organizationId: input.organizationId,
            taskId: input.taskId,
            objectId: randomUUID(),
            filename: input.filename,
        });
        const checksum = createHash('sha256')
            .update(input.buffer)
            .digest('hex');

        await this.client.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: input.buffer,
                ContentLength: input.size,
                ContentType: input.mimeType,
                Metadata: {
                    checksum,
                    uploadedById: input.uploadedById,
                    taskId: input.taskId,
                    organizationId: input.organizationId,
                },
            }),
        );

        return {
            provider: 'OSS',
            bucket,
            key,
            url: await this.publicUrl(key),
            checksum,
        };
    }

    async deleteObject(key: string, bucket?: string | null): Promise<void> {
        await this.client.send(
            new DeleteObjectCommand({
                Bucket: bucket || this.bucket(),
                Key: key,
            }),
        );
    }

    async getDownload(
        key: string,
        bucket?: string | null,
    ): Promise<DownloadResult> {
        const publicUrl = await this.publicUrl(key);
        if (publicUrl) {
            return { type: 'redirect', url: publicUrl };
        }

        const signedUrlTtlSeconds = await this.settingsService.getNumber(
            'storage.oss.signedUrlTtlSeconds',
            300,
        );

        const url = await getSignedUrl(
            this.client,
            new GetObjectCommand({
                Bucket: bucket || this.bucket(),
                Key: key,
            }),
            { expiresIn: signedUrlTtlSeconds },
        );

        return { type: 'redirect', url };
    }

    private bucket(): string {
        const bucket = this.config.oss.bucket;
        if (!bucket) {
            throw new BadRequestException('STORAGE_OSS_BUCKET is required');
        }
        return bucket;
    }

    private async publicUrl(key: string): Promise<string> {
        const base = (
            await this.settingsService.getString(
                'storage.oss.publicBaseUrl',
                '',
            )
        ).replace(/\/$/, '');
        return base ? `${base}/${key}` : '';
    }
}

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
    StorageVisibility,
} from './storage.types';
import { buildObjectKey, buildPublicObjectKey } from './filename.util';

/**
 * Effective OSS configuration. Values come from the `storage.oss.*` settings
 * rows so an operator can switch buckets or rotate keys from the admin UI; the
 * matching environment variables remain the fallback for deployments that never
 * wrote a row.
 */
interface OssRuntimeConfig {
    endpoint: string;
    region: string;
    bucket: string;
    privateBucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    forcePathStyle: boolean;
}

@Injectable()
export class OssStorageProvider implements AttachmentStorageProvider {
    /**
     * The S3 client is built from the resolved settings, so it has to be rebuilt
     * when they change. Rebuilding per request would leak sockets; rebuilding on
     * a fingerprint mismatch keeps the cached client valid across calls while
     * still picking up an admin edit on the next request.
     */
    private cached?: {
        fingerprint: string;
        client: S3Client;
        config: OssRuntimeConfig;
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly settingsService: SettingsService,
    ) {}

    async putObject(input: PutObjectInput): Promise<PutObjectResult> {
        const { client, config } = await this.resolved();
        const objectId = randomUUID();
        const publicUpload =
            input.visibility === 'PUBLIC' && input.publicUpload === true;
        const bucket = publicUpload
            ? this.requireBucket(config)
            : this.requirePrivateBucket(config);
        const key = publicUpload
            ? buildPublicObjectKey({
                  userId: input.uploadedById ?? 'unknown',
                  directory: input.directory,
                  objectId,
                  filename: input.filename,
              })
            : buildObjectKey({
                  organizationId: input.organizationId,
                  taskId: input.taskId,
                  objectId,
                  filename: input.filename,
              });
        const checksum = createHash('sha256')
            .update(input.buffer)
            .digest('hex');

        await client.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: input.buffer,
                ContentLength: input.size,
                ContentType: input.mimeType,
                ACL: publicUpload ? undefined : 'private',
                Metadata: {
                    checksum,
                    taskId: input.taskId,
                    organizationId: input.organizationId,
                    ...(input.uploadedById
                        ? { uploadedById: input.uploadedById }
                        : {}),
                },
            }),
        );

        return {
            provider: 'OSS',
            bucket,
            key,
            url: publicUpload ? await this.publicUrl(key) : '',
            checksum,
        };
    }

    async deleteObject(key: string, bucket?: string | null): Promise<void> {
        const { client, config } = await this.resolved();
        await client.send(
            new DeleteObjectCommand({
                Bucket: bucket || this.requireBucket(config),
                Key: key,
            }),
        );
    }

    async getDownload(
        key: string,
        bucket?: string | null,
        visibility: StorageVisibility = 'PRIVATE',
    ): Promise<DownloadResult> {
        const { client, config } = await this.resolved();
        const publicUrl =
            visibility === 'PUBLIC' ? await this.publicUrl(key) : '';
        if (visibility === 'PRIVATE' && bucket !== config.privateBucket) {
            throw new BadRequestException(
                'Private attachment bucket is not trusted',
            );
        }
        if (visibility === 'PUBLIC' && bucket && bucket !== config.bucket) {
            throw new BadRequestException(
                'Public attachment bucket is not trusted',
            );
        }
        if (publicUrl) {
            return { type: 'redirect', url: publicUrl };
        }

        const signedUrlTtlSeconds = await this.settingsService.getNumber(
            'storage.oss.signedUrlTtlSeconds',
            300,
        );

        const url = await getSignedUrl(
            client,
            new GetObjectCommand({
                Bucket: bucket || this.requireBucket(config),
                Key: key,
            }),
            { expiresIn: Math.max(1, Math.min(300, signedUrlTtlSeconds)) },
        );

        return { type: 'redirect', url };
    }

    /** Resolves the settings, rebuilding the client when anything changed. */
    private async resolved(): Promise<{
        client: S3Client;
        config: OssRuntimeConfig;
    }> {
        const config = await this.readConfig();
        const fingerprint = JSON.stringify(config);

        if (this.cached?.fingerprint === fingerprint) {
            return { client: this.cached.client, config };
        }

        const client = new S3Client({
            endpoint: config.endpoint || undefined,
            region: config.region || 'auto',
            forcePathStyle: config.forcePathStyle,
            credentials:
                config.accessKeyId && config.accessKeySecret
                    ? {
                          accessKeyId: config.accessKeyId,
                          secretAccessKey: config.accessKeySecret,
                      }
                    : undefined,
        });

        this.cached = { fingerprint, client, config };
        return { client, config };
    }

    private async readConfig(): Promise<OssRuntimeConfig> {
        const env = this.configService.get<StorageConfig>('storage')!.oss;
        const [
            endpoint,
            region,
            bucket,
            privateBucket,
            accessKeyId,
            accessKeySecret,
            forcePathStyle,
        ] = await Promise.all([
            this.settingsService.getString(
                'storage.oss.endpoint',
                env.endpoint,
            ),
            this.settingsService.getString('storage.oss.region', env.region),
            this.settingsService.getString('storage.oss.bucket', env.bucket),
            this.settingsService.getString(
                'storage.oss.privateBucket',
                env.privateBucket,
            ),
            this.settingsService.getString(
                'storage.oss.accessKeyId',
                env.accessKeyId,
            ),
            this.settingsService.getString(
                'storage.oss.accessKeySecret',
                env.accessKeySecret,
            ),
            this.settingsService.getBoolean(
                'storage.oss.forcePathStyle',
                env.forcePathStyle,
            ),
        ]);

        return {
            endpoint,
            region,
            bucket,
            privateBucket,
            accessKeyId,
            accessKeySecret,
            forcePathStyle,
        };
    }

    private requireBucket(config: OssRuntimeConfig): string {
        if (!config.bucket) {
            throw new BadRequestException(
                'storage.oss.bucket is required (set it in the admin settings)',
            );
        }
        return config.bucket;
    }

    private requirePrivateBucket(config: OssRuntimeConfig): string {
        if (!config.privateBucket || config.privateBucket === config.bucket) {
            throw new BadRequestException(
                'A separate storage.oss.privateBucket with private access is required',
            );
        }
        return config.privateBucket;
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

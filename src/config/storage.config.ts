import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export type StorageDriver = 'local' | 'oss';

export interface StorageConfig {
    driver: StorageDriver;
    localRoot: string;
    publicBaseUrl: string;
    oss: {
        endpoint: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        accessKeySecret: string;
        forcePathStyle: boolean;
        publicBaseUrl: string;
        signedUrlTtlSeconds: number;
    };
    attachments: {
        maxImageSizeMb: number;
        maxPdfSizeMb: number;
        maxBlobSizeMb: number;
        maxFilesPerRequest: number;
    };
}

const parseBool = (value: string) => ['1', 'true', 'yes'].includes(value);

export const storageConfig = registerAs('storage', (): StorageConfig => ({
    driver: optionalEnv('STORAGE_DRIVER', 'local') as StorageDriver,
    localRoot: optionalEnv('STORAGE_LOCAL_ROOT', 'storage/uploads'),
    publicBaseUrl: optionalEnv('STORAGE_PUBLIC_BASE_URL', ''),
    oss: {
        endpoint: optionalEnv('STORAGE_OSS_ENDPOINT', ''),
        region: optionalEnv('STORAGE_OSS_REGION', 'auto'),
        bucket: optionalEnv('STORAGE_OSS_BUCKET', ''),
        accessKeyId: optionalEnv('STORAGE_OSS_ACCESS_KEY_ID', ''),
        accessKeySecret: optionalEnv('STORAGE_OSS_ACCESS_KEY_SECRET', ''),
        forcePathStyle: parseBool(
            optionalEnv('STORAGE_OSS_FORCE_PATH_STYLE', 'false'),
        ),
        publicBaseUrl: optionalEnv('STORAGE_OSS_PUBLIC_BASE_URL', ''),
        signedUrlTtlSeconds: parseInt(
            optionalEnv('STORAGE_OSS_SIGNED_URL_TTL_SECONDS', '300'),
            10,
        ),
    },
    attachments: {
        maxImageSizeMb: parseInt(
            optionalEnv('ATTACHMENT_MAX_IMAGE_SIZE_MB', '8'),
            10,
        ),
        maxPdfSizeMb: parseInt(
            optionalEnv('ATTACHMENT_MAX_PDF_SIZE_MB', '16'),
            10,
        ),
        maxBlobSizeMb: parseInt(
            optionalEnv('ATTACHMENT_MAX_BLOB_SIZE_MB', '32'),
            10,
        ),
        maxFilesPerRequest: parseInt(
            optionalEnv('ATTACHMENT_MAX_FILES_PER_REQUEST', '5'),
            10,
        ),
    },
}));

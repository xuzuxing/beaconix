import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface StorageConfig {
    localRoot: string;
    oss: {
        endpoint: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        accessKeySecret: string;
        forcePathStyle: boolean;
    };
}

const parseBool = (value: string) => ['1', 'true', 'yes'].includes(value);

export const storageConfig = registerAs('storage', (): StorageConfig => ({
    localRoot: optionalEnv('STORAGE_LOCAL_ROOT', 'storage/uploads'),
    oss: {
        endpoint: optionalEnv('STORAGE_OSS_ENDPOINT', ''),
        region: optionalEnv('STORAGE_OSS_REGION', 'auto'),
        bucket: optionalEnv('STORAGE_OSS_BUCKET', ''),
        accessKeyId: optionalEnv('STORAGE_OSS_ACCESS_KEY_ID', ''),
        accessKeySecret: optionalEnv('STORAGE_OSS_ACCESS_KEY_SECRET', ''),
        forcePathStyle: parseBool(
            optionalEnv('STORAGE_OSS_FORCE_PATH_STYLE', 'false'),
        ),
    },
}));

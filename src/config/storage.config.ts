import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface StorageConfig {
    publicRoot: string;
    privateRoot: string;
    oss: {
        endpoint: string;
        region: string;
        bucket: string;
        privateBucket: string;
        accessKeyId: string;
        accessKeySecret: string;
        forcePathStyle: boolean;
    };
}

const parseBool = (value: string) => ['1', 'true', 'yes'].includes(value);

/**
 * URL path the public storage root is mounted on.
 *
 * `main.ts` serves the public root here and `LocalStorageProvider` builds every
 * public link from it, so the mount and the links can never drift apart. The
 * directory behind it follows `STORAGE_PUBLIC_ROOT`.
 */
export const PUBLIC_STATIC_PREFIX = '/storage/public';

export const storageConfig = registerAs('storage', (): StorageConfig => ({
    // Public attachments (avatars, general uploads) live under one root that
    // may be served statically. `STORAGE_LOCAL_ROOT` is the pre-split name and
    // still applies when the new variable is absent, so deployments that never
    // renamed the directory keep working.
    publicRoot: optionalEnv(
        'STORAGE_PUBLIC_ROOT',
        optionalEnv('STORAGE_LOCAL_ROOT', 'storage/public'),
    ),
    privateRoot: optionalEnv('STORAGE_PRIVATE_ROOT', 'storage/private'),
    oss: {
        endpoint: optionalEnv('STORAGE_OSS_ENDPOINT', ''),
        region: optionalEnv('STORAGE_OSS_REGION', 'auto'),
        bucket: optionalEnv('STORAGE_OSS_BUCKET', ''),
        privateBucket: optionalEnv('STORAGE_OSS_PRIVATE_BUCKET', ''),
        accessKeyId: optionalEnv('STORAGE_OSS_ACCESS_KEY_ID', ''),
        accessKeySecret: optionalEnv('STORAGE_OSS_ACCESS_KEY_SECRET', ''),
        forcePathStyle: parseBool(
            optionalEnv('STORAGE_OSS_FORCE_PATH_STYLE', 'false'),
        ),
    },
}));

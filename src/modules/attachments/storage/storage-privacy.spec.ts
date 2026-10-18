import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { LocalStorageProvider } from './local-storage.provider';
import { OssStorageProvider } from './oss-storage.provider';
import type { PutObjectInput } from './storage.types';

jest.mock('node:fs/promises', () => ({
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('node:fs', () => ({
    ...jest.requireActual('node:fs'),
    createReadStream: jest.fn().mockReturnValue({ privateStream: true }),
}));
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn().mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
    })),
    PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
    GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
    DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: jest.fn().mockResolvedValue('https://private.test/signed'),
}));

function fixture(options = {}, settingValues: Record<string, unknown> = {}) {
    const config = new ConfigService({
        storage: {
            publicRoot: 'storage/test-public',
            privateRoot: 'storage/test-private',
            oss: {
                bucket: 'public',
                privateBucket: 'private',
                region: 'auto',
                ...options,
            },
        },
    });
    const settings = {
        // `storage.oss.*` reads fall back to the environment fixture unless the
        // test seeds an explicit setting value.
        getString: jest.fn((key: string, fallback: string): Promise<string> =>
            Promise.resolve(
                typeof settingValues[key] === 'string'
                    ? settingValues[key]
                    : key === 'storage.publicBaseUrl' ||
                        key === 'storage.oss.publicBaseUrl'
                      ? 'https://public.test'
                      : fallback,
            ),
        ),
        getNumber: jest.fn((_key: string, fallback: number): Promise<number> =>
            Promise.resolve(fallback),
        ),
        getBoolean: jest.fn(
            (key: string, fallback: boolean): Promise<boolean> =>
                Promise.resolve(
                    typeof settingValues[key] === 'boolean'
                        ? settingValues[key]
                        : fallback,
                ),
        ),
    };
    const input: PutObjectInput = {
        buffer: Buffer.from('private bytes'),
        filename: 'report.txt',
        mimeType: 'text/plain',
        size: 13,
        organizationId: 'org',
        taskId: 'task',
        uploadedById: 'user',
        visibility: 'PRIVATE',
    };
    return { config, settings, input };
}

describe('Attachment physical storage isolation', () => {
    beforeEach(() => jest.clearAllMocks());

    it('writes private local objects outside the public root and never builds a public URL', async () => {
        const { config, settings, input } = fixture();
        const provider = new LocalStorageProvider(config, settings as never);
        const stored = await provider.putObject(input);
        expect(stored.url).toBe('');
        expect(stored.key).toMatch(/^attachments\/org\/task\//);
        expect(mkdir).toHaveBeenCalled();
        expect(writeFile).toHaveBeenCalledWith(
            resolve('storage/test-private', stored.key),
            input.buffer,
        );
        expect(settings.getString).not.toHaveBeenCalled();
        const download = await provider.getDownload(
            stored.key,
            null,
            'PRIVATE',
        );
        expect(download.type).toBe('stream');
        expect(createReadStream).toHaveBeenCalledWith(
            resolve('storage/test-private', stored.key),
        );
        expect(settings.getString).not.toHaveBeenCalled();
    });

    it('files ticket uploads in the private root, never the public one', async () => {
        const { config, settings, input } = fixture();
        const provider = new LocalStorageProvider(config, settings as never);

        const stored = await provider.putObject({
            ...input,
            organizationId: undefined,
            taskId: undefined,
            directory: 'tickets',
        });

        expect(stored.key).toMatch(/^tickets\//);
        expect(stored.url).toBe('');
        expect(writeFile).toHaveBeenCalledWith(
            resolve('storage/test-private', stored.key),
            input.buffer,
        );
    });

    it('keeps ordinary public local uploads and URLs working', async () => {
        const { config, settings, input } = fixture();
        const provider = new LocalStorageProvider(config, settings as never);
        const stored = await provider.putObject({
            ...input,
            visibility: 'PUBLIC',
            directory: 'avatars',
        });
        expect(stored.key).toMatch(/^avatars\//);
        expect(writeFile).toHaveBeenCalledWith(
            resolve('storage/test-public', stored.key),
            input.buffer,
        );
        expect(stored.url).toBe(
            `https://public.test/storage/public/${stored.key}`,
        );
        await expect(
            provider.getDownload(stored.key, null, 'PUBLIC'),
        ).resolves.toEqual({ type: 'redirect', url: stored.url });
    });

    it('links public objects through the mounted static path', async () => {
        // No site root configured: the link stays relative so the browser can
        // resolve it against whatever host served the page.
        const relative = fixture({}, { 'storage.publicBaseUrl': '' });
        const relativeProvider = new LocalStorageProvider(
            relative.config,
            relative.settings as never,
        );
        const relativeStored = await relativeProvider.putObject({
            ...relative.input,
            visibility: 'PUBLIC',
            directory: 'uploads',
        });
        expect(relativeStored.url).toBe(
            `/storage/public/${relativeStored.key}`,
        );

        // A site root that already ends with the mount path is not doubled.
        const prefixed = fixture(
            {},
            { 'storage.publicBaseUrl': 'https://cdn.test/storage/public' },
        );
        const prefixedProvider = new LocalStorageProvider(
            prefixed.config,
            prefixed.settings as never,
        );
        const prefixedStored = await prefixedProvider.putObject({
            ...prefixed.input,
            visibility: 'PUBLIC',
            directory: 'uploads',
        });
        expect(prefixedStored.url).toBe(
            `https://cdn.test/storage/public/${prefixedStored.key}`,
        );
    });

    it('routes reads and deletes by key, not by the caller visibility', async () => {
        const { config, settings, input } = fixture();
        const provider = new LocalStorageProvider(config, settings as never);
        const stored = await provider.putObject({
            ...input,
            organizationId: undefined,
            taskId: undefined,
            directory: 'tickets',
        });

        // A private key never redirects, even if a caller labelled it PUBLIC.
        await expect(
            provider.getDownload(stored.key, null, 'PUBLIC'),
        ).resolves.toEqual(expect.objectContaining({ type: 'stream' }));
        expect(createReadStream).toHaveBeenLastCalledWith(
            resolve('storage/test-private', stored.key),
        );

        // A public key redirects to the static host serving the public root,
        // while its delete still resolves inside that root.
        await expect(
            provider.getDownload('avatars/2026/10/a.png', null, 'PUBLIC'),
        ).resolves.toEqual({
            type: 'redirect',
            url: 'https://public.test/storage/public/avatars/2026/10/a.png',
        });

        await provider.deleteObject(stored.key);
        expect(unlink).toHaveBeenCalledWith(
            resolve('storage/test-private', stored.key),
        );
        await provider.deleteObject('avatars/2026/10/a.png');
        expect(unlink).toHaveBeenLastCalledWith(
            resolve('storage/test-public/avatars/2026/10/a.png'),
        );
    });

    it.each(['storage/test-public', 'storage/test-public/nested', 'storage'])(
        'rejects overlapping private root %s',
        (privateRoot) => {
            const { config, settings } = fixture();
            config.set('storage.privateRoot', privateRoot);
            expect(
                () => new LocalStorageProvider(config, settings as never),
            ).toThrow(BadRequestException);
        },
    );

    it('rejects traversal without opening a stream', async () => {
        const { config, settings } = fixture();
        const provider = new LocalStorageProvider(config, settings as never);
        await expect(
            provider.getDownload('../outside', null, 'PRIVATE'),
        ).rejects.toThrow('escapes storage root');
        expect(createReadStream).not.toHaveBeenCalled();
    });

    it('uploads private OSS objects to a distinct bucket with private ACL', async () => {
        const { config, settings, input } = fixture();
        const provider = new OssStorageProvider(config, settings as never);
        const stored = await provider.putObject(input);
        expect(PutObjectCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                Bucket: 'private',
                ACL: 'private',
                Body: input.buffer,
            }),
        );
        expect(stored.bucket).toBe('private');
        expect(stored.url).toBe('');
        // Bucket names come from settings first and the environment second.
        expect(settings.getString).toHaveBeenCalledWith(
            'storage.oss.privateBucket',
            'private',
        );
        await expect(
            provider.getDownload(stored.key, 'private', 'PRIVATE'),
        ).resolves.toEqual({
            type: 'redirect',
            url: 'https://private.test/signed',
        });
        expect(GetObjectCommand).toHaveBeenCalledWith({
            Bucket: 'private',
            Key: stored.key,
        });
        expect(getSignedUrl).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            { expiresIn: 300 },
        );
        expect(settings.getNumber).toHaveBeenCalledWith(
            'storage.oss.signedUrlTtlSeconds',
            300,
        );
    });

    it.each(['', 'public'])(
        'fails private OSS uploads closed for bucket %s',
        async (privateBucket) => {
            const { config, settings, input } = fixture({ privateBucket });
            const provider = new OssStorageProvider(config, settings as never);
            await expect(provider.putObject(input)).rejects.toThrow(
                BadRequestException,
            );
            const client = (S3Client as unknown as jest.Mock).mock.results.at(
                -1,
            )!.value;
            expect(client.send).not.toHaveBeenCalled();
        },
    );

    it('rejects untrusted private and public bucket locators', async () => {
        const { config, settings } = fixture();
        const provider = new OssStorageProvider(config, settings as never);
        await expect(
            provider.getDownload('key', 'public', 'PRIVATE'),
        ).rejects.toThrow(BadRequestException);
        await expect(
            provider.getDownload('key', 'private', 'PUBLIC'),
        ).rejects.toThrow(BadRequestException);
        expect(getSignedUrl).not.toHaveBeenCalled();
    });

    it('lets admin settings override the environment and rebuilds the client', async () => {
        const { config, settings, input } = fixture(
            {},
            {
                'storage.oss.endpoint': 'https://oss.example.test',
                'storage.oss.region': 'oss-cn-hangzhou',
                'storage.oss.bucket': 'settings-public',
                'storage.oss.privateBucket': 'settings-private',
            },
        );
        const provider = new OssStorageProvider(config, settings as never);

        const stored = await provider.putObject(input);

        expect(stored.bucket).toBe('settings-private');
        expect(S3Client).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: 'https://oss.example.test',
                region: 'oss-cn-hangzhou',
            }),
        );
        expect(S3Client).toHaveBeenCalledTimes(1);

        // An admin edit changes the fingerprint, so the next call rebuilds.
        settings.getString.mockImplementation(
            (key: string, fallback: string): Promise<string> =>
                Promise.resolve(
                    key === 'storage.oss.endpoint'
                        ? 'https://oss2.example.test'
                        : key === 'storage.oss.bucket'
                          ? 'settings-public'
                          : key === 'storage.oss.privateBucket'
                            ? 'settings-private'
                            : fallback,
                ),
        );
        await provider.putObject(input);
        expect(S3Client).toHaveBeenCalledTimes(2);
        expect(S3Client).toHaveBeenLastCalledWith(
            expect.objectContaining({ endpoint: 'https://oss2.example.test' }),
        );
    });
});

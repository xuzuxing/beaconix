import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
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

function fixture(options = {}) {
    const config = new ConfigService({
        storage: {
            localRoot: 'storage/test-public',
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
        getString: jest.fn().mockResolvedValue('https://public.test'),
        getNumber: jest.fn().mockResolvedValue(900),
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
        expect(stored.key).toMatch(/^organizations\/org\/tasks\/task\//);
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

    it('keeps ordinary public local uploads and URLs working', async () => {
        const { config, settings, input } = fixture();
        const provider = new LocalStorageProvider(config, settings as never);
        const stored = await provider.putObject({
            ...input,
            visibility: 'PUBLIC',
            publicUpload: true,
        });
        expect(writeFile).toHaveBeenCalledWith(
            resolve('storage/test-public', stored.key),
            input.buffer,
        );
        expect(stored.url).toBe(`https://public.test/${stored.key}`);
        await expect(
            provider.getDownload(stored.key, null, 'PUBLIC'),
        ).resolves.toEqual({ type: 'redirect', url: stored.url });
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
        expect(settings.getString).not.toHaveBeenCalled();
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
        expect(settings.getString).not.toHaveBeenCalled();
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
});

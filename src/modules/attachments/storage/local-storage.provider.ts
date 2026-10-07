import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { StorageConfig } from '../../../config';
import {
    AttachmentStorageProvider,
    DownloadResult,
    PutObjectInput,
    PutObjectResult,
} from './storage.types';
import { buildObjectKey } from './filename.util';

@Injectable()
export class LocalStorageProvider implements AttachmentStorageProvider {
    private readonly root: string;

    constructor(private readonly configService: ConfigService) {
        const storage = this.configService.get<StorageConfig>('storage')!;
        this.root = resolve(process.cwd(), storage.localRoot);
    }

    async putObject(input: PutObjectInput): Promise<PutObjectResult> {
        const key = buildObjectKey({
            organizationId: input.organizationId,
            taskId: input.taskId,
            objectId: randomUUID(),
            filename: input.filename,
        });
        const target = this.resolveKey(key);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, input.buffer);

        return {
            provider: 'LOCAL',
            key,
            url: '',
            checksum: createHash('sha256').update(input.buffer).digest('hex'),
        };
    }

    async deleteObject(key: string): Promise<void> {
        const target = this.resolveKey(key);
        await unlink(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
        });
    }

    getDownload(key: string): Promise<DownloadResult> {
        return Promise.resolve({
            type: 'stream',
            stream: createReadStream(this.resolveKey(key)),
        });
    }

    private resolveKey(key: string): string {
        const target = resolve(this.root, key);
        if (!target.startsWith(this.root)) {
            throw new Error('Resolved attachment path escapes storage root');
        }
        return target;
    }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { StorageConfig } from '../../../config';
import { SettingsService } from '../../settings';
import {
    AttachmentStorageProvider,
    DownloadResult,
    PutObjectInput,
    PutObjectResult,
} from './storage.types';
import { buildObjectKey, buildPublicObjectKey } from './filename.util';

@Injectable()
export class LocalStorageProvider implements AttachmentStorageProvider {
    private readonly root: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly settingsService: SettingsService,
    ) {
        const storage = this.configService.get<StorageConfig>('storage')!;
        this.root = resolve(process.cwd(), storage.localRoot);
    }

    async putObject(input: PutObjectInput): Promise<PutObjectResult> {
        const objectId = randomUUID();
        const key = input.publicUpload
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
        const target = this.resolveKey(key);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, input.buffer);

        return {
            provider: 'LOCAL',
            key,
            url: await this.publicUrl(key),
            checksum: createHash('sha256').update(input.buffer).digest('hex'),
        };
    }

    async deleteObject(key: string): Promise<void> {
        const target = this.resolveKey(key);
        await unlink(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
        });
    }

    async getDownload(key: string): Promise<DownloadResult> {
        const publicUrl = await this.publicUrl(key);
        if (publicUrl) {
            return { type: 'redirect', url: publicUrl };
        }

        return {
            type: 'stream',
            stream: createReadStream(this.resolveKey(key)),
        };
    }

    private resolveKey(key: string): string {
        const target = resolve(this.root, key);
        if (!target.startsWith(this.root)) {
            throw new Error('Resolved attachment path escapes storage root');
        }
        return target;
    }

    private async publicUrl(key: string): Promise<string> {
        const base = (
            await this.settingsService.getString('storage.publicBaseUrl', '')
        ).replace(/\/$/, '');
        return base ? `${base}/${key}` : '';
    }
}

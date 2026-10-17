import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
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

@Injectable()
export class LocalStorageProvider implements AttachmentStorageProvider {
    private readonly root: string;
    private readonly privateRoot: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly settingsService: SettingsService,
    ) {
        const storage = this.configService.get<StorageConfig>('storage')!;
        this.root = resolve(process.cwd(), storage.localRoot);
        this.privateRoot = resolve(
            process.cwd(),
            storage.privateRoot || `${storage.localRoot}-private`,
        );
        if (
            this.contains(this.root, this.privateRoot) ||
            this.contains(this.privateRoot, this.root)
        ) {
            throw new BadRequestException(
                'Public and private storage roots must not overlap',
            );
        }
    }

    async putObject(input: PutObjectInput): Promise<PutObjectResult> {
        const objectId = randomUUID();
        const publicUpload =
            input.visibility === 'PUBLIC' && input.publicUpload === true;
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
        const target = this.resolveKey(
            key,
            publicUpload ? this.root : this.privateRoot,
        );
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, input.buffer);

        return {
            provider: 'LOCAL',
            key,
            url: publicUpload ? await this.publicUrl(key) : '',
            checksum: createHash('sha256').update(input.buffer).digest('hex'),
        };
    }

    async deleteObject(key: string): Promise<void> {
        const target = this.resolveKey(
            key,
            key.startsWith('organizations/') ? this.privateRoot : this.root,
        );
        await unlink(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
        });
    }

    async getDownload(
        key: string,
        _bucket?: string | null,
        visibility: StorageVisibility = 'PRIVATE',
        options?: { followPublicUrl?: boolean },
    ): Promise<DownloadResult> {
        // `storage.publicBaseUrl` only resolves when a web server actually maps
        // it onto the public storage root; pointing it at another host or a
        // frontend domain turns the download into a 404. Signed attachment links
        // therefore opt out (`followPublicUrl: false`) and stream from disk.
        if (options?.followPublicUrl !== false) {
            const publicUrl =
                visibility === 'PUBLIC' ? await this.publicUrl(key) : '';
            if (publicUrl) {
                return { type: 'redirect', url: publicUrl };
            }
        }

        return {
            type: 'stream',
            stream: createReadStream(
                this.resolveKey(
                    key,
                    visibility === 'PRIVATE' ? this.privateRoot : this.root,
                ),
            ),
        };
    }

    private resolveKey(key: string, root: string): string {
        const target = resolve(root, key);
        const within = relative(root, target);
        if (!within || within.startsWith('..') || isAbsolute(within)) {
            throw new Error('Resolved attachment path escapes storage root');
        }
        return target;
    }

    private contains(root: string, target: string): boolean {
        const within = relative(root, target);
        return (
            !within ||
            (within !== '..' &&
                !within.startsWith(`..${sep}`) &&
                !isAbsolute(within))
        );
    }

    private async publicUrl(key: string): Promise<string> {
        const base = (
            await this.settingsService.getString('storage.publicBaseUrl', '')
        ).replace(/\/$/, '');
        return base ? `${base}/${key}` : '';
    }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PUBLIC_STATIC_PREFIX, type StorageConfig } from '../../../config';
import { SettingsService } from '../../settings';
import {
    AttachmentStorageProvider,
    DownloadResult,
    PutObjectInput,
    PutObjectResult,
    StorageVisibility,
} from './storage.types';
import {
    buildPrivateObjectKey,
    buildPublicObjectKey,
    isPrivateObjectKey,
} from './filename.util';

@Injectable()
export class LocalStorageProvider implements AttachmentStorageProvider {
    private readonly publicRoot: string;
    private readonly privateRoot: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly settingsService: SettingsService,
    ) {
        const storage = this.configService.get<StorageConfig>('storage')!;
        this.publicRoot = resolve(process.cwd(), storage.publicRoot);
        this.privateRoot = resolve(
            process.cwd(),
            storage.privateRoot || `${storage.publicRoot}-private`,
        );
        if (
            this.contains(this.publicRoot, this.privateRoot) ||
            this.contains(this.privateRoot, this.publicRoot)
        ) {
            throw new BadRequestException(
                'Public and private storage roots must not overlap',
            );
        }
    }

    async putObject(input: PutObjectInput): Promise<PutObjectResult> {
        const objectId = randomUUID();
        const isPublic = input.visibility === 'PUBLIC';
        // `visibility` picks the root; the key it generates is what routes every
        // later read, delete and cleanup pass, so the two can never disagree.
        const key = isPublic
            ? buildPublicObjectKey({
                  directory: input.directory,
                  objectId,
                  filename: input.filename,
              })
            : buildPrivateObjectKey({
                  organizationId: input.organizationId,
                  taskId: input.taskId,
                  directory: input.directory,
                  objectId,
                  filename: input.filename,
              });
        const target = this.resolveKey(
            key,
            isPublic ? this.publicRoot : this.privateRoot,
        );
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, input.buffer);

        return {
            provider: 'LOCAL',
            key,
            url: isPublic ? await this.publicUrl(key) : '',
            checksum: createHash('sha256').update(input.buffer).digest('hex'),
        };
    }

    async deleteObject(key: string): Promise<void> {
        const target = this.resolveKey(key, this.rootFor(key));
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
        // therefore opt out (`followPublicUrl: false`) and stream from disk. A
        // private key never redirects, whatever the caller passed.
        if (
            options?.followPublicUrl !== false &&
            visibility === 'PUBLIC' &&
            !isPrivateObjectKey(key)
        ) {
            const publicUrl = await this.publicUrl(key);
            if (publicUrl) {
                return { type: 'redirect', url: publicUrl };
            }
        }

        return {
            type: 'stream',
            stream: createReadStream(this.resolveKey(key, this.rootFor(key))),
        };
    }

    /** The root a key belongs to, decided by its first segment alone. */
    private rootFor(key: string): string {
        return isPrivateObjectKey(key) ? this.privateRoot : this.publicRoot;
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

    /**
     * Public URL for a stored key.
     *
     * `storage.publicBaseUrl` is the **site** root (`https://api.example.com`),
     * not the storage root: the public root is mounted at
     * `PUBLIC_STATIC_PREFIX`, so the key alone is not a URL. With no base
     * configured the link stays relative and the browser resolves it against
     * whatever host served the page.
     */
    private async publicUrl(key: string): Promise<string> {
        const base = (
            await this.settingsService.getString('storage.publicBaseUrl', '')
        ).replace(/\/$/, '');
        // A value that already ends with the mount path is used as-is, so a
        // deployment that configured the full public root keeps working.
        const root = base.endsWith(PUBLIC_STATIC_PREFIX)
            ? base
            : `${base}${PUBLIC_STATIC_PREFIX}`;
        return `${root}/${key}`;
    }
}

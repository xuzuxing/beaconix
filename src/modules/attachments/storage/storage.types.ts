import type { ReadStream } from 'node:fs';

export type StorageProviderName = 'LOCAL' | 'OSS';
export type StorageVisibility = 'PRIVATE' | 'PUBLIC';

export interface PutObjectInput {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    size: number;
    /** Tenant of a task attachment; absent for ticket uploads. */
    organizationId?: string;
    /** Task of a task attachment; absent for ticket uploads. */
    taskId?: string;
    uploadedById?: string;
    /**
     * Public uploads: the target directory under the public root (`avatars`,
     * `uploads`, …). Private uploads without a task: the directory under the
     * private root (currently `tickets`).
     */
    directory?: string;
    /**
     * Decides both the key space and the root: `PUBLIC` writes to the public
     * root with a publishable key, `PRIVATE` to the private root. Defaults to
     * PRIVATE.
     */
    visibility?: StorageVisibility;
}

export interface PutObjectResult {
    provider: StorageProviderName;
    bucket?: string;
    key: string;
    url: string;
    checksum?: string;
}

export type DownloadResult =
    | {
          type: 'stream';
          stream: ReadStream;
      }
    | {
          type: 'redirect';
          url: string;
      };

export interface AttachmentStorageProvider {
    putObject(input: PutObjectInput): Promise<PutObjectResult>;
    deleteObject(key: string, bucket?: string | null): Promise<void>;
    getDownload(
        key: string,
        bucket?: string | null,
        visibility?: StorageVisibility,
        options?: { followPublicUrl?: boolean },
    ): Promise<DownloadResult>;
}

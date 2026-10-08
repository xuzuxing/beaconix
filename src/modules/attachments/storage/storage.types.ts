import type { ReadStream } from 'node:fs';

export type StorageProviderName = 'LOCAL' | 'OSS';

export interface PutObjectInput {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    size: number;
    organizationId: string;
    taskId: string;
    uploadedById?: string;
    directory?: string;
    publicUpload?: boolean;
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
    getDownload(key: string, bucket?: string | null): Promise<DownloadResult>;
}

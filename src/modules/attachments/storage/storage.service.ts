import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StorageConfig } from '../../../config';
import { LocalStorageProvider } from './local-storage.provider';
import { OssStorageProvider } from './oss-storage.provider';
import {
    AttachmentStorageProvider,
    DownloadResult,
    PutObjectInput,
    PutObjectResult,
} from './storage.types';

@Injectable()
export class StorageService {
    constructor(
        private readonly configService: ConfigService,
        private readonly local: LocalStorageProvider,
        private readonly oss: OssStorageProvider,
    ) {}

    putObject(input: PutObjectInput): Promise<PutObjectResult> {
        return this.activeProvider().putObject(input);
    }

    deleteObject(
        provider: string,
        key: string,
        bucket?: string | null,
    ): Promise<void> {
        return this.provider(provider).deleteObject(key, bucket);
    }

    getDownload(
        provider: string,
        key: string,
        bucket?: string | null,
    ): Promise<DownloadResult> {
        return this.provider(provider).getDownload(key, bucket);
    }

    activeProviderName(): 'LOCAL' | 'OSS' {
        const storage = this.configService.get<StorageConfig>('storage')!;
        return storage.driver === 'oss' ? 'OSS' : 'LOCAL';
    }

    private activeProvider(): AttachmentStorageProvider {
        return this.provider(this.activeProviderName());
    }

    private provider(provider: string): AttachmentStorageProvider {
        return provider === 'OSS' ? this.oss : this.local;
    }
}

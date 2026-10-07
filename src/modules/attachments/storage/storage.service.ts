import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../settings';
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
        private readonly settingsService: SettingsService,
        private readonly local: LocalStorageProvider,
        private readonly oss: OssStorageProvider,
    ) {}

    async putObject(input: PutObjectInput): Promise<PutObjectResult> {
        return (await this.activeProvider()).putObject(input);
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

    async activeProviderName(): Promise<'LOCAL' | 'OSS'> {
        const driver = await this.settingsService.getString(
            'storage.driver',
            'local',
        );
        return driver === 'oss' ? 'OSS' : 'LOCAL';
    }

    private async activeProvider(): Promise<AttachmentStorageProvider> {
        return this.provider(await this.activeProviderName());
    }

    private provider(provider: string): AttachmentStorageProvider {
        return provider === 'OSS' ? this.oss : this.local;
    }
}

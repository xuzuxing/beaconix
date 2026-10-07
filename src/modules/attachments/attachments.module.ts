import { Module } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { AttachmentsController } from './attachments.controller';
import {
    LocalStorageProvider,
    OssStorageProvider,
    StorageService,
} from './storage';

@Module({
    controllers: [AttachmentsController],
    providers: [
        AttachmentsService,
        StorageService,
        LocalStorageProvider,
        OssStorageProvider,
    ],
    exports: [AttachmentsService],
})
export class AttachmentsModule {}

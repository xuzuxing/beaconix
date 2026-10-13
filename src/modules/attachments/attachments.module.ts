import { Module } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { AttachmentsController } from './attachments.controller';
import { PublicAttachmentsController } from './public-attachments.controller';
import {
    LocalStorageProvider,
    OssStorageProvider,
    StorageService,
} from './storage';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

@Module({
    imports: [AuthorizationModule],
    controllers: [AttachmentsController, PublicAttachmentsController],
    providers: [
        AttachmentsService,
        StorageService,
        LocalStorageProvider,
        OssStorageProvider,
    ],
    exports: [AttachmentsService],
})
export class AttachmentsModule {}

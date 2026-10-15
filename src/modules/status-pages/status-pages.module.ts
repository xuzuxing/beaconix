import { Module } from '@nestjs/common';
import { StatusPagesController } from './status-pages.controller';
import { StatusPagesPublicController } from './status-pages-public.controller';
import { PublicStatusEtagInterceptor } from './public-status-etag.interceptor';
import { StatusPagesService } from './status-pages.service';

@Module({
    controllers: [StatusPagesController, StatusPagesPublicController],
    providers: [StatusPagesService, PublicStatusEtagInterceptor],
    exports: [StatusPagesService],
})
export class StatusPagesModule {}

import { Module } from '@nestjs/common';
import { StatusPagesController } from './status-pages.controller';
import { StatusPagesPublicController } from './status-pages-public.controller';
import { StatusPagesService } from './status-pages.service';

@Module({
    controllers: [StatusPagesController, StatusPagesPublicController],
    providers: [StatusPagesService],
    exports: [StatusPagesService],
})
export class StatusPagesModule {}

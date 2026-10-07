import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { NotifierModule } from '../notifier/notifier.module';
import { MonitorsController } from './monitors.controller';
import { MonitorsService } from './monitors.service';

@Module({
    imports: [AdminModule, NotifierModule],
    controllers: [MonitorsController],
    providers: [MonitorsService],
    exports: [MonitorsService],
})
export class MonitorsModule {}

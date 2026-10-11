import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { NotifierModule } from '../notifier/notifier.module';
import { MonitorsController } from './monitors.controller';
import { MonitorsService } from './monitors.service';
import { MonitorSecurityModule } from './monitor-security.module';

@Module({
    imports: [AdminModule, NotifierModule, MonitorSecurityModule],
    controllers: [MonitorsController],
    providers: [MonitorsService],
    exports: [MonitorsService],
})
export class MonitorsModule {}

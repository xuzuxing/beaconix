import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { NotifierModule } from '../notifier/notifier.module';
import { MonitorsController } from './monitors.controller';
import { MonitorsService } from './monitors.service';
import { MonitorSecurityModule } from './monitor-security.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

@Module({
    imports: [
        AdminModule,
        NotifierModule,
        MonitorSecurityModule,
        AuthorizationModule,
    ],
    controllers: [MonitorsController],
    providers: [MonitorsService],
    exports: [MonitorsService],
})
export class MonitorsModule {}

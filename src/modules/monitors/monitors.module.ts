import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { MonitorsController } from './monitors.controller';
import { MonitorsService } from './monitors.service';

@Module({
    imports: [AdminModule],
    controllers: [MonitorsController],
    providers: [MonitorsService],
    exports: [MonitorsService],
})
export class MonitorsModule {}

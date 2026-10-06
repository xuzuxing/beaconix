import { Module } from '@nestjs/common';
import { QueuesModule } from '../../infra/queue/queues.module';
import { AdminModule } from '../admin/admin.module';
import { NotifierModule } from '../notifier/notifier.module';
import { StateModule } from '../state/state.module';
import { CheckerController } from './checker.controller';
import { CheckerScheduler } from './checker.scheduler';
import { CheckerService } from './checker.service';
import { HttpChecker, TcpChecker } from './checkers';
import { MonitorCheckProcessor } from './monitor-check.processor';
import { MonitorScanProcessor } from './monitor-scan.processor';

@Module({
    imports: [StateModule, NotifierModule, AdminModule, QueuesModule],
    controllers: [CheckerController],
    providers: [
        CheckerService,
        CheckerScheduler,
        MonitorScanProcessor,
        MonitorCheckProcessor,
        HttpChecker,
        TcpChecker,
    ],
    exports: [CheckerService, HttpChecker, TcpChecker],
})
export class CheckerModule {}

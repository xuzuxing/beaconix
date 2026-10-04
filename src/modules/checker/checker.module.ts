import { Module } from '@nestjs/common';
import { NotifierModule } from '../notifier/notifier.module';
import { StateModule } from '../state/state.module';
import { CheckerController } from './checker.controller';
import { CheckerScheduler } from './checker.scheduler';
import { CheckerService } from './checker.service';
import { HttpChecker, TcpChecker } from './checkers';

@Module({
    imports: [StateModule, NotifierModule],
    controllers: [CheckerController],
    providers: [CheckerService, CheckerScheduler, HttpChecker, TcpChecker],
    exports: [CheckerService, HttpChecker, TcpChecker],
})
export class CheckerModule {}

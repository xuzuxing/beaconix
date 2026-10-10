import { Module } from '@nestjs/common';
import { QueuesModule } from '../../infra/queue/queues.module';
import { AdminModule } from '../admin/admin.module';
import { NotifierModule } from '../notifier/notifier.module';
import { RulesModule } from '../rules/rules.module';
import { StateModule } from '../state/state.module';
import { CheckerController } from './checker.controller';
import { CheckerScheduler } from './checker.scheduler';
import { CheckerService } from './checker.service';
import { HttpChecker, TcpChecker } from './checkers';
import { DnsChecker } from './checkers/dns.checker';
import { PingChecker, PingRunner } from './checkers/ping.checker';
import { CheckerRegistry } from './checker.registry';
import { MonitorCheckProcessor } from './monitor-check.processor';
import { MonitorScanProcessor } from './monitor-scan.processor';
import { MonitorSecurityModule } from '../monitors/monitor-security.module';
import {
    ApplicationCheckRuntime,
    ApplicationNetworkService,
} from './checkers/application-runtime';
import { MysqlChecker } from './checkers/mysql.checker';
import { PostgresChecker } from './checkers/postgres.checker';
import { RedisChecker } from './checkers/redis.checker';
import { MongodbChecker } from './checkers/mongodb.checker';
import { DockerChecker } from './checkers/docker.checker';
import { GrpcChecker } from './checkers/grpc.checker';
import { WebsocketChecker } from './checkers/websocket.checker';

@Module({
    imports: [
        StateModule,
        NotifierModule,
        RulesModule,
        AdminModule,
        QueuesModule,
        MonitorSecurityModule,
    ],
    controllers: [CheckerController],
    providers: [
        CheckerService,
        CheckerScheduler,
        MonitorScanProcessor,
        MonitorCheckProcessor,
        HttpChecker,
        TcpChecker,
        DnsChecker,
        PingChecker,
        PingRunner,
        CheckerRegistry,
        ApplicationNetworkService,
        ApplicationCheckRuntime,
        MysqlChecker,
        PostgresChecker,
        RedisChecker,
        MongodbChecker,
        DockerChecker,
        GrpcChecker,
        WebsocketChecker,
    ],
    exports: [CheckerService, HttpChecker, TcpChecker],
})
export class CheckerModule {}

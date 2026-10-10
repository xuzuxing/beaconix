import { Injectable } from '@nestjs/common';
import type { MonitorType } from '../../generated/prisma/enums';
import type { MonitorModel } from '../../generated/prisma/models';
import {
    CONFIG_VERSION,
    validateMonitorConfig,
} from '../monitors/monitor-config';
import type { CheckerStrategy } from './checkers/checker.interface';
import type { CheckResult } from './checkers/check-result';
import { HttpChecker } from './checkers/http.checker';
import { TcpChecker } from './checkers/tcp.checker';
import { DnsChecker } from './checkers/dns.checker';
import { PingChecker } from './checkers/ping.checker';
import { MysqlChecker } from './checkers/mysql.checker';
import { PostgresChecker } from './checkers/postgres.checker';
import { RedisChecker } from './checkers/redis.checker';
import { MongodbChecker } from './checkers/mongodb.checker';
import { DockerChecker } from './checkers/docker.checker';
import { GrpcChecker } from './checkers/grpc.checker';
import { WebsocketChecker } from './checkers/websocket.checker';
import { MonitorSecretsService } from '../monitors/monitor-secrets.service';

@Injectable()
export class CheckerRegistry {
    private readonly strategies: Map<MonitorType, CheckerStrategy>;

    constructor(
        http: HttpChecker,
        tcp: TcpChecker,
        dns: DnsChecker,
        ping: PingChecker,
        mysql: MysqlChecker,
        postgres: PostgresChecker,
        redis: RedisChecker,
        mongodb: MongodbChecker,
        docker: DockerChecker,
        grpc: GrpcChecker,
        websocket: WebsocketChecker,
        private readonly secrets: MonitorSecretsService,
    ) {
        const strategies: CheckerStrategy[] = [
            http,
            tcp,
            dns,
            ping,
            mysql,
            postgres,
            redis,
            mongodb,
            docker,
            grpc,
            websocket,
        ];
        this.strategies = new Map(
            strategies.map((entry) => [entry.type, entry]),
        );
        if (this.strategies.size !== strategies.length) {
            throw new Error('Duplicate checker strategy');
        }
    }

    get(type: MonitorType): CheckerStrategy | undefined {
        return this.strategies.get(type);
    }

    async check(monitor: MonitorModel): Promise<CheckResult> {
        const strategy = this.get(monitor.type);
        try {
            if (monitor.configVersion !== CONFIG_VERSION) {
                throw new Error('Unsupported monitor configVersion');
            }
            const config = validateMonitorConfig(
                monitor.type,
                this.secrets.open(monitor),
            );
            monitor = { ...monitor, config };
        } catch {
            return {
                success: false,
                evaluated: false,
                failureKind: 'CONFIGURATION',
                latency: 0,
                error: 'Invalid monitor configuration',
                checkedAt: new Date(),
            };
        }
        if (!strategy) {
            return {
                success: false,
                evaluated: false,
                failureKind: 'CAPABILITY',
                latency: 0,
                error: 'Unsupported monitor type',
                checkedAt: new Date(),
            };
        }
        return strategy.run(monitor);
    }
}

import { Injectable } from '@nestjs/common';
import { createConnection } from 'mysql2';
import { createConnection as connectSocket } from 'node:net';
import { MonitorType } from '../../../generated/prisma/enums';
import type { MonitorModel } from '../../../generated/prisma/models';
import type { CheckerStrategy } from './checker.interface';
import {
    ApplicationCheckError,
    ApplicationCheckRuntime,
} from './application-runtime';

@Injectable()
export class MysqlChecker implements CheckerStrategy {
    readonly type = MonitorType.MYSQL;
    constructor(private readonly runtime: ApplicationCheckRuntime) {}

    run(monitor: MonitorModel) {
        return this.runtime.run(monitor, async (context) => {
            const { config, host, port, address } = context;
            const socket = connectSocket({ host: address, port });
            context.cleanup(() => socket.destroy());
            const connection = createConnection({
                host,
                port,
                user: config.username,
                password: config.password ?? '',
                database: config.database,
                connectTimeout: context.remaining(),
                stream: socket,
                ssl: config.tls
                    ? {
                          ca: config.tlsCa,
                          rejectUnauthorized: true,
                          verifyIdentity: true,
                      }
                    : undefined,
                multipleStatements: false,
                enableKeepAlive: false,
                maxPreparedStatements: 0,
                // A monitor must never service a server's LOCAL INFILE request.
                flags: ['-LOCAL_FILES'],
            });
            connection.on('error', () => undefined);
            context.cleanup(() => connection.destroy());
            const [rows] = await connection.promise().query({
                sql: 'SELECT 1 AS beacon_health',
                timeout: context.remaining(),
            });
            if (
                !Array.isArray(rows) ||
                (rows[0] as { beacon_health?: unknown })?.beacon_health !== 1
            ) {
                throw new ApplicationCheckError(
                    'ASSERTION',
                    'MySQL health query returned an unexpected result',
                );
            }
            return { protocol: 'MYSQL', operation: 'SELECT 1' };
        });
    }
}

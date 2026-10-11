import { Injectable } from '@nestjs/common';
import { Client } from 'pg';
import { Socket } from 'node:net';
import { MonitorType } from '../../../generated/prisma/enums';
import type { MonitorModel } from '../../../generated/prisma/models';
import type { CheckerStrategy } from './checker.interface';
import {
    ApplicationCheckError,
    ApplicationCheckRuntime,
} from './application-runtime';

@Injectable()
export class PostgresChecker implements CheckerStrategy {
    readonly type = MonitorType.POSTGRESQL;
    constructor(private readonly runtime: ApplicationCheckRuntime) {}

    run(monitor: MonitorModel) {
        return this.runtime.run(monitor, async (context) => {
            const { config, host, port, address } = context;
            const socket = new Socket();
            context.cleanup(() => socket.destroy());
            const client = new Client({
                host: address,
                port,
                // A string '' makes pg consult PGPASSWORD/.pgpass. A callback never does.
                user: config.username,
                password: () => config.password ?? '',
                database: config.database,
                connectionTimeoutMillis: context.remaining(),
                query_timeout: context.remaining(),
                statement_timeout: context.remaining(),
                ssl: config.tls
                    ? {
                          servername: host,
                          ca: config.tlsCa,
                          rejectUnauthorized: true,
                      }
                    : false,
                stream: socket,
                keepAlive: false,
                application_name: 'beacon-monitor',
            });
            client.on('error', () => undefined);
            context.cleanup(() => {
                socket.destroy();
                void client.end().catch(() => undefined);
            });
            await client.connect();
            context.signal.throwIfAborted();
            const result = await client.query('SELECT 1 AS beacon_health');
            if (result.rows[0]?.beacon_health !== 1) {
                throw new ApplicationCheckError(
                    'ASSERTION',
                    'PostgreSQL health query returned an unexpected result',
                );
            }
            return { protocol: 'POSTGRESQL', operation: 'SELECT 1' };
        });
    }
}

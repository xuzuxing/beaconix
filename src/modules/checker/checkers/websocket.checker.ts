import { Injectable } from '@nestjs/common';
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import type { ConnectionOptions } from 'node:tls';
import { MonitorType } from '../../../generated/prisma/enums';
import type { MonitorModel } from '../../../generated/prisma/models';
import type { CheckerStrategy } from './checker.interface';
import { ApplicationCheckRuntime } from './application-runtime';

@Injectable()
export class WebsocketChecker implements CheckerStrategy {
    readonly type = MonitorType.WEBSOCKET;
    constructor(private readonly runtime: ApplicationCheckRuntime) {}

    run(monitor: MonitorModel) {
        return this.runtime.run(
            monitor,
            (context) =>
                new Promise((resolve, reject) => {
                    const { config, host } = context;
                    const options: WebSocket.ClientOptions & ConnectionOptions =
                        {
                            lookup: context.lookup,
                            servername: host,
                            ca: config.tlsCa,
                            rejectUnauthorized: true,
                            handshakeTimeout: context.remaining(),
                            followRedirects: false,
                            maxPayload: 65536,
                            perMessageDeflate: false,
                            headers: config.token
                                ? { authorization: `Bearer ${config.token}` }
                                : {},
                        };
                    const client = new WebSocket(monitor.target, options);
                    client.on('error', reject);
                    client.on('close', () =>
                        reject(new Error('WebSocket closed before heartbeat')),
                    );
                    context.cleanup(() => client.terminate());
                    const heartbeat = randomBytes(16);
                    client.once('open', () => {
                        if (context.signal.aborted) {
                            client.terminate();
                            return;
                        }
                        client.ping(heartbeat, undefined, (error) => {
                            if (error) reject(error);
                        });
                    });
                    client.on('pong', (payload: Buffer) => {
                        if (payload.equals(heartbeat))
                            resolve({ protocol: 'WEBSOCKET', heartbeat: true });
                    });
                }),
        );
    }
}

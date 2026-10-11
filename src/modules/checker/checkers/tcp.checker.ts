import { Injectable } from '@nestjs/common';
import { Socket } from 'node:net';
import type { CheckResult } from './check-result';
import { MonitorType } from '../../../generated/prisma/enums';
import type { MonitorModel } from '../../../generated/prisma/models';
import type { CheckerStrategy } from './checker.interface';

export interface TcpTarget {
    host: string;
    port: number;
}

/** Parses `host:port`, also accepting bracketed IPv6 literals. */
export function parseTcpTarget(target: string): TcpTarget | null {
    const match =
        /^(?:\[(?<v6>[0-9a-fA-F:]+)\]|(?<host>[^:\s]+)):(?<port>\d{1,5})$/.exec(
            target.trim(),
        );

    const groups = match?.groups;
    if (!groups) return null;

    const port = Number(groups.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

    const host = groups.v6 ?? groups.host;
    if (!host) return null;

    return { host, port };
}

@Injectable()
export class TcpChecker implements CheckerStrategy {
    readonly type = MonitorType.TCP;

    run(monitor: MonitorModel): Promise<CheckResult> {
        return this.check(monitor.target, monitor.timeout);
    }
    /** Opens a TCP connection and measures how long the handshake takes. */
    async check(target: string, timeout: number): Promise<CheckResult> {
        const parsed = parseTcpTarget(target);

        if (!parsed) {
            return {
                success: false,
                latency: 0,
                error: `Invalid host:port target "${target}"`,
                evaluated: false,
                failureKind: 'CONFIGURATION',
                checkedAt: new Date(),
            };
        }

        const startedAt = Date.now();

        return new Promise<CheckResult>((resolve) => {
            const socket = new Socket();
            const timer = setTimeout(
                () => finish(false, `Connection timed out after ${timeout}ms`),
                timeout,
            );
            let settled = false;

            const finish = (success: boolean, error: string | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                resolve({
                    success,
                    latency: Date.now() - startedAt,
                    error,
                    checkedAt: new Date(),
                    serviceVerdict: success ? 'SUCCESS' : 'FAILURE',
                    failureReason: !success
                        ? /timed out/i.test(error ?? '')
                            ? 'TIMEOUT'
                            : /ECONNREFUSED/i.test(error ?? '')
                              ? 'CONNECTION_REFUSED'
                              : 'CHECK_FAILED'
                        : undefined,
                    failureKind: success
                        ? null
                        : error?.includes('timed out')
                          ? 'TIMEOUT'
                          : 'TRANSPORT',
                });
            };

            socket.setTimeout(timeout);
            socket.once('connect', () => finish(true, null));
            socket.once('timeout', () =>
                finish(false, `Connection timed out after ${timeout}ms`),
            );
            socket.once('error', (error: Error) =>
                finish(false, error.message),
            );

            socket.connect(parsed.port, parsed.host);
        });
    }
}

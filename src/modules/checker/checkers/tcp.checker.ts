import { Injectable } from '@nestjs/common';
import { Socket } from 'node:net';
import type { CheckResult } from './check-result';

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
export class TcpChecker {
    /** Opens a TCP connection and measures how long the handshake takes. */
    async check(target: string, timeout: number): Promise<CheckResult> {
        const parsed = parseTcpTarget(target);

        if (!parsed) {
            return {
                success: false,
                latency: 0,
                error: `Invalid host:port target "${target}"`,
                checkedAt: new Date(),
            };
        }

        const startedAt = Date.now();

        return new Promise<CheckResult>((resolve) => {
            const socket = new Socket();
            let settled = false;

            const finish = (success: boolean, error: string | null) => {
                if (settled) return;
                settled = true;
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

import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicAddress } from './network-guard';
import { MonitorType } from '../../../generated/prisma/enums';
import type { MonitorModel } from '../../../generated/prisma/models';
import { isDomain, normalizeDomain } from '../../monitors/monitor-config';
import type { CheckerStrategy } from './checker.interface';
import type { CheckFailureKind, CheckResult } from './check-result';

/**
 * PING keeps its historical predicate name for callers, but the blocklist now
 * lives in `network-guard` so HTTP/TCP/DNS-side checks share one definition.
 */
export const isPublicPingAddress = isPublicAddress;

/** Separate provider keeps OS execution mockable without shell commands. */
@Injectable()
export class PingRunner {
    async run(
        address: string,
        timeout: number,
        platform: NodeJS.Platform = process.platform,
    ): Promise<{
        stdout: string;
        stderr: string;
        code?: string | number;
        killed?: boolean;
    }> {
        const windows = platform === 'win32';
        const args = windows
            ? ['-n', '1', '-w', String(timeout), address]
            : [
                  '-n',
                  '-c',
                  '1',
                  '-W',
                  String(Math.max(1, Math.ceil(timeout / 1000))),
                  address,
              ];
        return new Promise((resolve) => {
            execFile(
                windows ? 'ping.exe' : 'ping',
                args,
                {
                    timeout,
                    killSignal: 'SIGKILL',
                    maxBuffer: 16 * 1024,
                    windowsHide: true,
                    shell: false,
                    encoding: 'utf8',
                    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
                },
                (error, stdout, stderr) =>
                    resolve({
                        stdout,
                        stderr,
                        code: error?.code,
                        killed: error?.killed,
                    }),
            );
        });
    }
}

@Injectable()
export class PingChecker implements CheckerStrategy {
    readonly type = MonitorType.PING;

    constructor(private readonly runner: PingRunner) {}

    async run(monitor: MonitorModel): Promise<CheckResult> {
        const startedAt = Date.now();
        const fail = (
            error: string,
            failureKind: CheckFailureKind,
            evaluated = true,
        ): CheckResult => ({
            success: false,
            error,
            failureKind,
            evaluated,
            latency: Date.now() - startedAt,
            checkedAt: new Date(),
        });
        if (!['win32', 'linux'].includes(process.platform)) {
            return fail(
                'PING is unsupported on this platform',
                'CAPABILITY',
                false,
            );
        }
        if (!isIP(monitor.target) && !isDomain(monitor.target)) {
            return fail(
                'PING target must be a hostname or IP',
                'CONFIGURATION',
                false,
            );
        }

        let address = monitor.target;
        if (!isIP(address)) {
            const resolver = new Resolver({
                timeout: monitor.timeout,
                tries: 1,
            });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const resolutions = await Promise.race([
                    Promise.allSettled([
                        resolver.resolve4(normalizeDomain(address)),
                        resolver.resolve6(normalizeDomain(address)),
                    ]),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => {
                            reject(new Error('timeout'));
                            resolver.cancel();
                        }, monitor.timeout);
                    }),
                ]);
                const addresses = resolutions.flatMap((entry) =>
                    entry.status === 'fulfilled' ? entry.value : [],
                );
                if (addresses.length === 0) {
                    return fail(
                        'PING hostname could not be resolved',
                        'TRANSPORT',
                    );
                }
                if (addresses.some((value) => !isPublicPingAddress(value))) {
                    return fail(
                        'PING destination is not public',
                        'POLICY',
                        false,
                    );
                }
                address = addresses[0];
            } catch {
                return fail('PING hostname resolution timed out', 'TIMEOUT');
            } finally {
                clearTimeout(timer);
                resolver.cancel();
            }
        }
        if (!isPublicPingAddress(address)) {
            return fail('PING destination is not public', 'POLICY', false);
        }

        const samples: number[] = [];
        let sent = 0;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const remaining = monitor.timeout - (Date.now() - startedAt);
            if (remaining <= 0) break;
            const result = await this.runner.run(
                address,
                Math.max(1, Math.floor(remaining / (3 - attempt))),
            );
            sent += 1;
            if (
                typeof result.code === 'string' ||
                /not permitted|permission|not found|invalid option|access is denied/i.test(
                    result.stderr + result.stdout,
                )
            ) {
                return fail(
                    'PING executable or ICMP permission unavailable',
                    'CAPABILITY',
                    false,
                );
            }
            // Reply lines contain either time=, TTL=, or the pinned destination.
            // Do not depend on the Windows console's localized word for "time".
            const reply = result.stdout
                .split(/\r?\n/)
                .find(
                    (line) =>
                        /ms/i.test(line) &&
                        (/time\s*[=<]|ttl=/i.test(line) ||
                            line.includes(address)),
                );
            const match =
                reply && /([=<])\s*(\d+(?:[.,]\d+)?)\s*ms/i.exec(reply);
            if (result.code === undefined && match) {
                samples.push(
                    match[1] === '<'
                        ? Number(match[2]) / 2
                        : Number(match[2].replace(',', '.')),
                );
            }
        }
        const success = samples.length > 0;
        return {
            success,
            error: success ? null : 'No ICMP reply received',
            failureKind: success ? null : 'TIMEOUT',
            checkedAt: new Date(),
            latency: success
                ? Math.round(
                      samples.reduce((a, b) => a + b, 0) / samples.length,
                  )
                : Date.now() - startedAt,
            meta: {
                protocol: 'PING',
                sent,
                received: samples.length,
                packetLoss: sent
                    ? Math.round((1 - samples.length / sent) * 10000) / 100
                    : 100,
            },
        };
    }
}

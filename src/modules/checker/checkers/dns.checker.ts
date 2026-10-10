import { Injectable } from '@nestjs/common';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MonitorType } from '../../../generated/prisma/enums';
import type { MonitorModel } from '../../../generated/prisma/models';
import {
    isDomain,
    normalizeDomain,
    normalizeDnsValue,
    validateMonitorConfig,
} from '../../monitors/monitor-config';
import type { DnsConfig } from '../../monitors/monitor-config';
import type { CheckerStrategy } from './checker.interface';
import type { CheckResult } from './check-result';

@Injectable()
export class DnsChecker implements CheckerStrategy {
    readonly type = MonitorType.DNS;

    async run(monitor: MonitorModel): Promise<CheckResult> {
        const startedAt = Date.now();
        let config: DnsConfig;
        try {
            config = validateMonitorConfig(
                this.type,
                monitor.config,
            ) as DnsConfig;
            if (!isDomain(monitor.target) || isIP(monitor.target))
                throw new Error('Invalid domain');
        } catch {
            return {
                success: false,
                evaluated: false,
                failureKind: 'CONFIGURATION',
                latency: 0,
                error: 'Invalid DNS configuration',
                checkedAt: new Date(),
            };
        }
        const resolver = new Resolver({ timeout: monitor.timeout, tries: 1 });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const target = normalizeDomain(monitor.target);
            const query = async () => {
                if (config.recordType === 'CNAME') {
                    return (await resolver.resolveCname(target)).map(
                        (value) => ({
                            value: normalizeDnsValue('CNAME', value),
                            ttl: undefined,
                        }),
                    );
                }
                const records =
                    config.recordType === 'A'
                        ? await resolver.resolve4(target, { ttl: true })
                        : await resolver.resolve6(target, { ttl: true });
                return records.map((record) => ({
                    value: normalizeDnsValue(config.recordType, record.address),
                    ttl: record.ttl,
                }));
            };
            const records = await Promise.race([
                query(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        reject(
                            Object.assign(new Error('DNS query timed out'), {
                                code: 'ETIMEOUT',
                            }),
                        );
                        resolver.cancel();
                    }, monitor.timeout);
                }),
            ]);
            const values = [
                ...new Set(records.map((record) => record.value)),
            ].sort();
            const success =
                values.length > 0 &&
                (config.expectedValues === undefined ||
                    JSON.stringify(values) ===
                        JSON.stringify(config.expectedValues));
            const actualValues = values.slice(0, 32);
            return {
                success,
                latency: Date.now() - startedAt,
                checkedAt: new Date(),
                error: success
                    ? null
                    : values.length
                      ? 'DNS records do not match expectedValues'
                      : 'No DNS records returned',
                failureKind: success ? null : 'ASSERTION',
                meta: {
                    protocol: 'DNS',
                    recordType: config.recordType,
                    actualValues,
                    ...(config.recordType !== 'CNAME'
                        ? {
                              ttl: actualValues.map(
                                  (value) =>
                                      records.find(
                                          (record) => record.value === value,
                                      )!.ttl!,
                              ),
                          }
                        : {}),
                },
            };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            return {
                success: false,
                latency: Date.now() - startedAt,
                checkedAt: new Date(),
                failureKind: code === 'ETIMEOUT' ? 'TIMEOUT' : 'TRANSPORT',
                error:
                    code === 'ETIMEOUT'
                        ? 'DNS query timed out'
                        : `DNS query failed (${code ?? 'UNKNOWN'})`,
            };
        } finally {
            clearTimeout(timer);
            resolver.cancel();
        }
    }
}

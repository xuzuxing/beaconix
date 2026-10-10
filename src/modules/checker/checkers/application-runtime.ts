import { Injectable } from '@nestjs/common';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import type { MonitorModel } from '../../../generated/prisma/models';
import {
    validateApplicationMonitorConfig,
    validateApplicationMonitorTarget,
} from '../../monitors/application-monitor-config';
import type { ApplicationMonitorConfig } from '../../monitors/application-monitor-config';
import { isPublicPingAddress } from './ping.checker';
import { parseTcpTarget } from './tcp.checker';
import type {
    CheckFailureKind,
    CheckMetadata,
    CheckResult,
} from './check-result';

export class ApplicationCheckError extends Error {
    constructor(
        readonly kind: CheckFailureKind,
        message: string,
        readonly evaluated = true,
    ) {
        super(message);
    }
}

export interface ApplicationCheckContext {
    config: ApplicationMonitorConfig;
    host: string;
    port: number;
    address: string;
    lookup: LookupFunction;
    signal: AbortSignal;
    remaining(): number;
    cleanup(callback: () => void): void;
}

@Injectable()
export class ApplicationNetworkService {
    async resolve(host: string, signal: AbortSignal): Promise<string> {
        const assertPublic = (address: string) => {
            if (!isPublicPingAddress(address))
                throw new ApplicationCheckError(
                    'POLICY',
                    'Application monitor destination is not public',
                    false,
                );
        };
        if (isIP(host)) {
            assertPublic(host);
            return host;
        }
        const resolver = new Resolver({ timeout: 5000, tries: 1 });
        const cancel = () => resolver.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        try {
            signal.throwIfAborted();
            const records = await Promise.allSettled([
                resolver.resolve4(host),
                resolver.resolve6(host),
            ]);
            signal.throwIfAborted();
            const addresses = records.flatMap((record) =>
                record.status === 'fulfilled' ? record.value : [],
            );
            if (!addresses.length)
                throw new ApplicationCheckError(
                    'TRANSPORT',
                    'Application monitor hostname could not be resolved',
                );
            addresses.forEach(assertPublic);
            return addresses[0];
        } finally {
            signal.removeEventListener('abort', cancel);
            resolver.cancel();
        }
    }
}

@Injectable()
export class ApplicationCheckRuntime {
    constructor(private readonly network: ApplicationNetworkService) {}

    async run(
        monitor: MonitorModel,
        operation: (
            context: ApplicationCheckContext,
        ) => Promise<CheckMetadata | undefined>,
    ): Promise<CheckResult> {
        const start = Date.now();
        const controller = new AbortController();
        const cleanups: (() => void)[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        const fail = (
            kind: CheckFailureKind,
            message: string,
            evaluated = true,
        ): CheckResult => ({
            success: false,
            error: message,
            evaluated,
            failureKind: kind,
            latency: Date.now() - start,
            checkedAt: new Date(),
        });
        try {
            let config: ApplicationMonitorConfig;
            try {
                config = validateApplicationMonitorConfig(
                    monitor.type,
                    monitor.config as Record<string, unknown>,
                );
                validateApplicationMonitorTarget(
                    monitor.type,
                    monitor.target,
                    config,
                );
                if (
                    monitor.type === 'WEBSOCKET' &&
                    config.token &&
                    new URL(monitor.target).protocol !== 'wss:'
                )
                    throw new Error();
                if (
                    !Number.isInteger(monitor.timeout) ||
                    monitor.timeout < 100 ||
                    monitor.timeout > 60000
                )
                    throw new Error();
            } catch {
                return fail(
                    'CONFIGURATION',
                    'Invalid application monitor configuration',
                    false,
                );
            }
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(
                        new ApplicationCheckError(
                            'TIMEOUT',
                            'Application monitor timed out',
                        ),
                    );
                }, monitor.timeout);
            });
            const work = async () => {
                const socket = monitor.target === 'unix:///var/run/docker.sock';
                const tcp = parseTcpTarget(monitor.target);
                const url =
                    !socket && !tcp ? new URL(monitor.target) : undefined;
                const host =
                    tcp?.host ?? url?.hostname.replace(/^\[|\]$/g, '') ?? '';
                const port =
                    tcp?.port ??
                    (url?.port
                        ? Number(url.port)
                        : url?.protocol === 'ws:'
                          ? 80
                          : 443);
                const address = socket
                    ? ''
                    : await this.network.resolve(host, controller.signal);
                controller.signal.throwIfAborted();
                const lookup: LookupFunction = (
                    _hostname,
                    options,
                    callback,
                ) => {
                    if (controller.signal.aborted) {
                        callback(new Error('Check cancelled'), '', 0);
                        return;
                    }
                    if (typeof options === 'object' && options.all) {
                        (callback as any)(null, [
                            { address, family: isIP(address) },
                        ]);
                    } else callback(null, address, isIP(address));
                };
                return operation({
                    config,
                    host,
                    port,
                    address,
                    lookup,
                    signal: controller.signal,
                    remaining: () =>
                        Math.max(1, monitor.timeout - (Date.now() - start)),
                    cleanup: (callback) => {
                        if (controller.signal.aborted) callback();
                        else cleanups.push(callback);
                    },
                });
            };
            const meta = await Promise.race([work(), deadline]);
            return {
                success: true,
                error: null,
                failureKind: null,
                latency: Date.now() - start,
                checkedAt: new Date(),
                meta,
            };
        } catch (error) {
            if (controller.signal.aborted)
                return fail('TIMEOUT', 'Application monitor timed out');
            if (error instanceof ApplicationCheckError)
                return fail(error.kind, error.message, error.evaluated);
            // Driver error strings may contain passwords, URIs, SQL or server-controlled data.
            return fail('TRANSPORT', 'Application protocol check failed');
        } finally {
            clearTimeout(timer);
            controller.abort();
            for (const cleanup of cleanups.reverse()) {
                try {
                    cleanup();
                } catch {
                    /* Cleanup must not change the verdict. */
                }
            }
        }
    }
}

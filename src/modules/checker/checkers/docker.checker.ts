import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { MonitorRuntimeConfig } from '../../../config/monitor.config';
import { MonitorType } from '../../../generated/prisma/enums';
import type { MonitorModel } from '../../../generated/prisma/models';
import type { CheckerStrategy } from './checker.interface';
import {
    ApplicationCheckError,
    ApplicationCheckRuntime,
} from './application-runtime';

const BODY_LIMIT = 1024 * 1024;
const STATES = new Set([
    'created',
    'running',
    'paused',
    'restarting',
    'removing',
    'exited',
    'dead',
]);

@Injectable()
export class DockerChecker implements CheckerStrategy {
    readonly type = MonitorType.DOCKER;
    constructor(
        private readonly runtime: ApplicationCheckRuntime,
        private readonly settings: ConfigService,
    ) {}

    run(monitor: MonitorModel) {
        return this.runtime.run(monitor, async (context) => {
            const { config, host, port } = context;
            const local = monitor.target === 'unix:///var/run/docker.sock';
            const runtime = this.settings.get<MonitorRuntimeConfig>('monitor');
            if (
                local &&
                (!runtime?.dockerSocketPath ||
                    !runtime.dockerSocketOrganizationIds.includes(
                        monitor.organizationId,
                    ))
            ) {
                throw new ApplicationCheckError(
                    'POLICY',
                    'Local Docker socket access is not authorized',
                    false,
                );
            }
            const state = await new Promise<Record<string, any>>(
                (resolve, reject) => {
                    // Only this read-only API is exposed; no arbitrary path, socket or daemon URL from config.
                    const req = (local ? httpRequest : httpsRequest)(
                        {
                            ...(local
                                ? { socketPath: runtime!.dockerSocketPath }
                                : {
                                      hostname: host,
                                      port,
                                      lookup: context.lookup,
                                      servername: host,
                                      ca: config.tlsCa,
                                      cert: config.tlsCert,
                                      key: config.tlsKey,
                                      rejectUnauthorized: true,
                                  }),
                            path: `/containers/${encodeURIComponent(config.containerId!)}/json?size=false`,
                            method: 'GET',
                            agent: false,
                            signal: context.signal,
                            headers:
                                config.token && !local
                                    ? {
                                          authorization: `Bearer ${config.token}`,
                                      }
                                    : {},
                        },
                        (response) => {
                            context.cleanup(() => response.destroy());
                            if (response.statusCode !== 200) {
                                response.destroy();
                                reject(
                                    new ApplicationCheckError(
                                        'ASSERTION',
                                        'Docker container inspection failed',
                                    ),
                                );
                                return;
                            }
                            const chunks: Buffer[] = [];
                            let bytes = 0;
                            response.on('error', reject);
                            response.on('data', (chunk: Buffer) => {
                                bytes += chunk.length;
                                if (bytes > BODY_LIMIT) {
                                    response.destroy();
                                    reject(
                                        new ApplicationCheckError(
                                            'ASSERTION',
                                            'Docker inspection response exceeded the limit',
                                        ),
                                    );
                                } else chunks.push(chunk);
                            });
                            response.on('end', () => {
                                try {
                                    const body = JSON.parse(
                                        Buffer.concat(chunks).toString('utf8'),
                                    ) as { State?: Record<string, any> };
                                    if (
                                        !body.State ||
                                        !STATES.has(body.State.Status)
                                    )
                                        throw new Error();
                                    resolve(body.State);
                                } catch {
                                    reject(
                                        new ApplicationCheckError(
                                            'ASSERTION',
                                            'Invalid Docker inspection response',
                                        ),
                                    );
                                }
                            });
                        },
                    );
                    req.on('error', reject);
                    context.cleanup(() => req.destroy());
                    req.end();
                },
            );
            const health = ['healthy', 'unhealthy', 'starting'].includes(
                state.Health?.Status,
            )
                ? (state.Health.Status as string)
                : null;
            if (state.Health !== undefined && health === null) {
                throw new ApplicationCheckError(
                    'ASSERTION',
                    'Invalid Docker health status',
                );
            }
            if (
                state.Status !== 'running' ||
                state.Running !== true ||
                state.Paused === true ||
                (health !== null && health !== 'healthy')
            ) {
                throw new ApplicationCheckError(
                    'ASSERTION',
                    'Docker container is not running and healthy',
                );
            }
            return {
                protocol: 'DOCKER',
                containerState: state.Status,
                health,
                startedAt:
                    typeof state.StartedAt === 'string' &&
                    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(
                        state.StartedAt,
                    ) &&
                    !Number.isNaN(Date.parse(state.StartedAt))
                        ? state.StartedAt
                        : null,
            };
        });
    }
}

import { Injectable } from '@nestjs/common';
import {
    credentials,
    loadPackageDefinition,
    Metadata,
    status,
} from '@grpc/grpc-js';
import type { Client, ClientUnaryCall, ServiceError } from '@grpc/grpc-js';
import { fromJSON } from '@grpc/proto-loader';
import { isIP } from 'node:net';
import { MonitorType } from '../../../generated/prisma/enums';
import type { MonitorModel } from '../../../generated/prisma/models';
import type { CheckerStrategy } from './checker.interface';
import {
    ApplicationCheckError,
    ApplicationCheckRuntime,
} from './application-runtime';

// Canonical grpc.health.v1 unary Check contract, compiled by the protobuf library.
export const HEALTH_PACKAGE = fromJSON(
    {
        nested: {
            grpc: {
                nested: {
                    health: {
                        nested: {
                            v1: {
                                nested: {
                                    HealthCheckRequest: {
                                        fields: {
                                            service: { type: 'string', id: 1 },
                                        },
                                    },
                                    HealthCheckResponse: {
                                        nested: {
                                            ServingStatus: {
                                                values: {
                                                    UNKNOWN: 0,
                                                    SERVING: 1,
                                                    NOT_SERVING: 2,
                                                    SERVICE_UNKNOWN: 3,
                                                },
                                            },
                                        },
                                        fields: {
                                            status: {
                                                type: 'ServingStatus',
                                                id: 1,
                                            },
                                        },
                                    },
                                    Health: {
                                        methods: {
                                            Check: {
                                                requestType:
                                                    'HealthCheckRequest',
                                                responseType:
                                                    'HealthCheckResponse',
                                                comment: '',
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    { enums: Number, defaults: true },
);

type HealthClient = Client & {
    check(
        request: { service: string },
        metadata: Metadata,
        options: { deadline: Date },
        callback: (
            error: ServiceError | null,
            value?: { status: number },
        ) => void,
    ): ClientUnaryCall;
};
const Health = (loadPackageDefinition(HEALTH_PACKAGE) as any).grpc.health.v1
    .Health as new (
    target: string,
    channelCredentials: ReturnType<typeof credentials.createSsl>,
    options: object,
) => HealthClient;

@Injectable()
export class GrpcChecker implements CheckerStrategy {
    readonly type = MonitorType.GRPC;
    constructor(private readonly runtime: ApplicationCheckRuntime) {}

    run(monitor: MonitorModel) {
        return this.runtime.run(monitor, async (context) => {
            const { config, address, host, port } = context;
            const target =
                isIP(address) === 6
                    ? `ipv6:[${address}]:${port}`
                    : `ipv4:${address}:${port}`;
            const client = new Health(
                target,
                config.tls
                    ? credentials.createSsl(
                          config.tlsCa ? Buffer.from(config.tlsCa) : undefined,
                      )
                    : credentials.createInsecure(),
                {
                    'grpc.ssl_target_name_override': host,
                    'grpc.default_authority': host,
                    'grpc.enable_http_proxy': 0,
                    'grpc.enable_retries': 0,
                    'grpc.max_receive_message_length': 16384,
                    'grpc.max_send_message_length': 16384,
                    'grpc.use_local_subchannel_pool': 1,
                },
            );
            context.cleanup(() => client.close());
            const metadata = new Metadata();
            if (config.token)
                metadata.set('authorization', `Bearer ${config.token}`);
            await new Promise<void>((resolve, reject) => {
                const call = client.check(
                    { service: config.service ?? '' },
                    metadata,
                    { deadline: new Date(Date.now() + context.remaining()) },
                    (error, value) => {
                        if (error) {
                            reject(
                                error.code === status.DEADLINE_EXCEEDED
                                    ? new ApplicationCheckError(
                                          'TIMEOUT',
                                          'gRPC health check timed out',
                                      )
                                    : error,
                            );
                        } else if (value?.status !== 1) {
                            reject(
                                new ApplicationCheckError(
                                    'ASSERTION',
                                    'gRPC service is not SERVING',
                                ),
                            );
                        } else resolve();
                    },
                );
                context.cleanup(() => call.cancel());
            });
            return { protocol: 'GRPC', serving: true };
        });
    }
}

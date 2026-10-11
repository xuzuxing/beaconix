import type { ApiPropertyOptions } from '@nestjs/swagger';
import {
    DEFAULT_HTTP_BODY_BYTES,
    MAX_HTTP_BODY_BYTES,
    MAX_JSON_ASSERTIONS,
} from '../http-monitor-config';
import { APPLICATION_MONITOR_TYPES } from '../application-monitor-config';

export const MONITOR_CONFIG_API_OPTIONS: ApiPropertyOptions = {
    description:
        'Type-specific replacement config; omitted PATCH config preserves credentials. HTTP: keyword and/or JSON Pointer jsonAssertions (AND), bounded UTF-8 body. DNS: recordType/expectedValues. TCP/PING: {}. Application database targets are host:port; TLS defaults true. Password/token/tlsKey are write-only, encrypted at rest and omitted from responses. Replacing config must resubmit credentials. SQL is fixed SELECT 1. Docker: containerId with HTTPS daemon or operator-authorized socket. gRPC: standard grpc.health.v1.Health/Check, service defaults empty. WebSocket: matching protocol ping/pong; token requires wss. Application default timeout is 10000ms.',
    anyOf: [
        ...APPLICATION_MONITOR_TYPES.map((type) => {
            const fields: Record<string, Record<string, unknown>> = {
                username: { type: 'string', maxLength: 256 },
                password: { type: 'string', maxLength: 4096, writeOnly: true },
                database: { type: 'string', maxLength: 256 },
                authSource: {
                    type: 'string',
                    maxLength: 256,
                    default: 'admin',
                },
                db: { type: 'integer', minimum: 0, maximum: 15, default: 0 },
                tls: { type: 'boolean', default: true },
                tlsCa: {
                    type: 'string',
                    maxLength: 16384,
                    description: 'Inline PEM, never a filesystem path',
                },
                tlsCert: {
                    type: 'string',
                    maxLength: 16384,
                    description: 'Inline PEM client certificate',
                },
                tlsKey: {
                    type: 'string',
                    maxLength: 16384,
                    writeOnly: true,
                    description: 'Inline PEM private key',
                },
                containerId: { type: 'string', maxLength: 128 },
                service: { type: 'string', maxLength: 256, default: '' },
                token: { type: 'string', maxLength: 4096, writeOnly: true },
            };
            const byType: Record<string, string[]> = {
                MYSQL: ['username', 'password', 'database', 'tls', 'tlsCa'],
                POSTGRESQL: [
                    'username',
                    'password',
                    'database',
                    'tls',
                    'tlsCa',
                ],
                REDIS: ['username', 'password', 'db', 'tls', 'tlsCa'],
                MONGODB: [
                    'username',
                    'password',
                    'database',
                    'authSource',
                    'tls',
                    'tlsCa',
                ],
                DOCKER: ['containerId', 'token', 'tlsCa', 'tlsCert', 'tlsKey'],
                GRPC: ['service', 'tls', 'tlsCa', 'token'],
                WEBSOCKET: ['token', 'tlsCa'],
            };
            return {
                type: 'object' as const,
                title: `${type} configuration`,
                additionalProperties: false,
                required: ['MYSQL', 'POSTGRESQL'].includes(type)
                    ? ['username', 'database']
                    : type === 'DOCKER'
                      ? ['containerId']
                      : [],
                properties: Object.fromEntries(
                    byType[type].map((key) => [key, fields[key]]),
                ),
            };
        }),
        {
            type: 'object',
            title: 'HTTP configuration',
            additionalProperties: false,
            properties: {
                keyword: { type: 'string', minLength: 1, maxLength: 1024 },
                keywordMode: {
                    type: 'string',
                    enum: ['contains', 'notContains'],
                    default: 'contains',
                    description: 'Requires keyword',
                },
                maxBodyBytes: {
                    type: 'integer',
                    minimum: 1024,
                    maximum: MAX_HTTP_BODY_BYTES,
                    default: DEFAULT_HTTP_BODY_BYTES,
                    description:
                        'Requires at least one body assertion; counts decoded response bytes',
                },
                jsonAssertions: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_JSON_ASSERTIONS,
                    items: {
                        oneOf: [
                            {
                                type: 'object',
                                additionalProperties: false,
                                required: ['path', 'operator'],
                                properties: {
                                    path: {
                                        type: 'string',
                                        maxLength: 256,
                                        example: '/data/status',
                                        description:
                                            'Empty string selects the root; max 16 segments',
                                    },
                                    operator: {
                                        type: 'string',
                                        enum: ['exists', 'notExists'],
                                    },
                                },
                            },
                            {
                                type: 'object',
                                additionalProperties: false,
                                required: ['path', 'operator', 'value'],
                                properties: {
                                    path: {
                                        type: 'string',
                                        maxLength: 256,
                                        example: '/data/status',
                                    },
                                    operator: {
                                        type: 'string',
                                        enum: ['eq', 'neq'],
                                    },
                                    value: {
                                        description:
                                            'Strict comparison, no coercion; missing paths fail both eq and neq',
                                        oneOf: [
                                            {
                                                type: 'string',
                                                maxLength: 1024,
                                                nullable: true,
                                            },
                                            { type: 'number' },
                                            { type: 'boolean' },
                                        ],
                                    },
                                },
                            },
                        ],
                    },
                },
            },
        },
        {
            type: 'object',
            title: 'DNS configuration',
            additionalProperties: false,
            properties: {
                recordType: {
                    type: 'string',
                    enum: ['A', 'AAAA', 'CNAME'],
                    default: 'A',
                },
                expectedValues: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 32,
                    items: { type: 'string', maxLength: 253 },
                },
            },
        },
    ],
};

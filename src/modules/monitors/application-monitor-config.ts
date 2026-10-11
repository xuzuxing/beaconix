import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import { MonitorType } from '../../generated/prisma/enums';
import { parseTcpTarget } from '../checker/checkers/tcp.checker';

export const APPLICATION_MONITOR_TYPES: MonitorType[] = [
    'MYSQL',
    'POSTGRESQL',
    'REDIS',
    'MONGODB',
    'DOCKER',
    'GRPC',
    'WEBSOCKET',
];
export const MONITOR_SECRET_FIELDS = ['password', 'token', 'tlsKey'] as const;
export type ApplicationMonitorConfig = {
    username?: string;
    password?: string;
    database?: string;
    authSource?: string;
    db?: number;
    tls?: boolean;
    tlsCa?: string;
    tlsCert?: string;
    tlsKey?: string;
    containerId?: string;
    service?: string;
    token?: string;
};

const FIELDS: Record<string, string[]> = {
    MYSQL: ['username', 'password', 'database', 'tls', 'tlsCa', 'query'],
    POSTGRESQL: ['username', 'password', 'database', 'tls', 'tlsCa', 'query'],
    REDIS: ['username', 'password', 'db', 'tls', 'tlsCa'],
    MONGODB: ['username', 'password', 'database', 'authSource', 'tls', 'tlsCa'],
    DOCKER: ['containerId', 'tlsCa', 'tlsCert', 'tlsKey', 'token'],
    GRPC: ['service', 'tls', 'tlsCa', 'token'],
    WEBSOCKET: ['token', 'tlsCa'],
};

export function validateApplicationMonitorConfig(
    type: MonitorType,
    input: Record<string, unknown>,
): ApplicationMonitorConfig {
    const fail = (message: string): never => {
        throw new BadRequestException(message);
    };
    const allowed = FIELDS[type];
    if (!allowed || Object.keys(input).some((key) => !allowed.includes(key))) {
        fail(`Unknown ${type} config field`);
    }
    const output: Record<string, string | number | boolean> = {};
    // Fixed order makes semantically equivalent replacements revision-stable.
    for (const key of allowed) {
        const value = input[key];
        if (value === undefined) continue;
        if (key === 'query') {
            if (value !== 'SELECT 1') fail('Only SELECT 1 is supported');
            continue;
        }
        if (key === 'tls') {
            if (typeof value !== 'boolean') fail('tls must be boolean');
        } else if (key === 'db') {
            if (
                !Number.isInteger(value) ||
                Number(value) < 0 ||
                Number(value) > 15
            ) {
                fail('db must be an integer from 0 to 15');
            }
        } else {
            const max = key.startsWith('tls')
                ? 16384
                : key === 'password' || key === 'token'
                  ? 4096
                  : 256;
            if (
                typeof value !== 'string' ||
                value.length > max ||
                value.includes('\0')
            ) {
                fail(`Invalid ${key}`);
            }
            if (
                key !== 'password' &&
                key !== 'service' &&
                !(value as string).length
            ) {
                fail(`${key} cannot be empty`);
            }
            if (key === 'token' && /[\r\n]/.test(value as string))
                fail('Invalid token');
        }
        output[key] = value as string | number | boolean;
    }
    if (['MYSQL', 'POSTGRESQL'].includes(type)) {
        if (!output.username || !output.database)
            fail('username and database are required');
    }
    if (type === 'MONGODB') {
        if (
            (output.username !== undefined) !==
            (output.password !== undefined)
        ) {
            fail('MongoDB username and password must be supplied together');
        }
        for (const key of ['database', 'authSource']) {
            if (
                output[key] !== undefined &&
                /[/\\." $]/.test(String(output[key]))
            ) {
                fail(`Invalid MongoDB ${key}`);
            }
        }
        output.database ??= 'admin';
        output.authSource ??= 'admin';
    }
    if (['MYSQL', 'POSTGRESQL', 'REDIS', 'MONGODB', 'GRPC'].includes(type)) {
        output.tls ??= true;
        if (!output.tls && output.tlsCa) fail('tlsCa requires tls');
    }
    if (type === 'REDIS') {
        if (output.username && output.password === undefined)
            fail('Redis username requires password');
        output.db ??= 0;
    }
    if (type === 'DOCKER') {
        if (
            typeof output.containerId !== 'string' ||
            !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(output.containerId)
        ) {
            fail('containerId must be a container ID or name');
        }
        if (!!output.tlsCert !== !!output.tlsKey)
            fail('tlsCert and tlsKey must be supplied together');
    }
    if (type === 'GRPC') {
        output.service ??= '';
        if (output.token && !output.tls) fail('gRPC token requires TLS');
    }
    return Object.fromEntries(
        Object.entries(output).sort(([a], [b]) => a.localeCompare(b)),
    );
}

export function validateApplicationMonitorTarget(
    type: MonitorType,
    target: string,
    config?: object,
): void {
    const fail = (): never => {
        throw new BadRequestException(`Invalid ${type} target`);
    };
    if (['MYSQL', 'POSTGRESQL', 'REDIS', 'MONGODB', 'GRPC'].includes(type)) {
        const parsed = parseTcpTarget(target);
        if (
            !parsed ||
            target !== target.trim() ||
            (!isIP(parsed.host) &&
                (parsed.host.length > 253 ||
                    !parsed.host
                        .split('.')
                        .every((label) =>
                            /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
                                label,
                            ),
                        )))
        )
            fail();
        // mysql2 cannot verify IP-SAN identity on a supplied, DNS-pinned socket.
        if (
            type === 'MYSQL' &&
            (config as ApplicationMonitorConfig | undefined)?.tls !== false &&
            isIP(parsed!.host)
        ) {
            throw new BadRequestException(
                'MySQL TLS targets require a DNS hostname',
            );
        }
        return;
    }
    if (type === 'DOCKER' && target === 'unix:///var/run/docker.sock') {
        if (
            config &&
            Object.keys(config).some((key) => key !== 'containerId')
        ) {
            throw new BadRequestException(
                'Local Docker socket config only supports containerId',
            );
        }
        return;
    }
    let url: URL;
    try {
        url = new URL(target);
    } catch {
        return fail();
    }
    if (url.username || url.password || url.hash || url.search) fail();
    if (type === 'DOCKER') {
        if (url.protocol !== 'https:' || url.pathname !== '/') fail();
    } else if (type === 'WEBSOCKET') {
        if (!['ws:', 'wss:'].includes(url.protocol)) fail();
        if (
            ((config as ApplicationMonitorConfig | undefined)?.token ||
                (config as ApplicationMonitorConfig | undefined)?.tlsCa) &&
            url.protocol !== 'wss:'
        )
            fail();
    } else fail();
}

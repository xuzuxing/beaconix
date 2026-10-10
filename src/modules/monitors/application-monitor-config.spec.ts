import {
    validateApplicationMonitorConfig,
    validateApplicationMonitorTarget,
} from './application-monitor-config';
import { validateMonitorConfig } from './monitor-config';
import type { MonitorType } from '../../generated/prisma/enums';

describe('Application monitor config', () => {
    it.each(['MYSQL', 'POSTGRESQL'] as const)(
        '%s defaults TLS and only accepts the fixed query',
        (type) => {
            expect(
                validateMonitorConfig(type, {
                    username: 'monitor',
                    database: 'health',
                    query: 'SELECT 1',
                }),
            ).toEqual({
                username: 'monitor',
                database: 'health',
                tls: true,
            });
            expect(() =>
                validateMonitorConfig(type, {
                    username: 'monitor',
                    database: 'health',
                    query: 'DROP TABLE users',
                }),
            ).toThrow();
            expect(() => validateMonitorConfig(type, {})).toThrow('required');
        },
    );
    it.each([
        ['MYSQL', { username: 'u', database: 'd', socketPath: '/etc/passwd' }],
        [
            'POSTGRESQL',
            { username: 'u', database: 'd', connectionString: 'postgres://x' },
        ],
        ['REDIS', { retryStrategy: 'anything' }],
        ['REDIS', { db: -1 }],
        ['REDIS', { db: 16 }],
        ['REDIS', { db: 1.5 }],
        ['REDIS', { username: 'u' }],
        ['MONGODB', { username: 'u' }],
        ['MONGODB', { password: 'p' }],
        ['MONGODB', { replicaSet: 'rs' }],
        ['MONGODB', { database: '../x' }],
        ['DOCKER', { containerId: '../containers' }],
        ['DOCKER', { containerId: 'x', tlsKey: 'key' }],
        ['GRPC', { token: 'secret', tls: false }],
        ['GRPC', { token: 'secret\r\nheader:value' }],
        ['WEBSOCKET', { followRedirects: true }],
        ['WEBSOCKET', { tlsKey: 'unsupported' }],
        ['MYSQL', { username: 'u', database: 'd', tls: false, tlsCa: 'pem' }],
        ['REDIS', { tls: null }],
        ['GRPC', { service: 'x'.repeat(257) }],
        ['REDIS', { password: 'x'.repeat(4097) }],
    ])('rejects unsafe %s config %#', (type, config) => {
        expect(() =>
            validateMonitorConfig(type as MonitorType, config),
        ).toThrow();
    });
    it.each([
        ['MYSQL', 'db.example.com:3306'],
        ['POSTGRESQL', '[2606:4700:4700::1111]:5432'],
        ['REDIS', 'redis.example.com:6379'],
        ['MONGODB', 'mongo.example.com:27017'],
        ['DOCKER', 'https://docker.example.com:2376'],
        ['DOCKER', 'unix:///var/run/docker.sock'],
        ['GRPC', 'grpc.example.com:50051'],
        ['WEBSOCKET', 'wss://ws.example.com/health'],
    ])('accepts %s target %s', (type, target) => {
        expect(() =>
            validateApplicationMonitorTarget(type as MonitorType, target),
        ).not.toThrow();
    });
    it.each([
        ['MYSQL', 'mysql://user:password@db.example.com:3306'],
        ['POSTGRESQL', 'db.example.com'],
        ['REDIS', 'db.example.com:0'],
        ['MONGODB', 'db.example.com:65536'],
        ['MYSQL', 'bad..host:3306'],
        ['MYSQL', '-host:3306'],
        ['DOCKER', 'http://docker.example.com:2375'],
        ['DOCKER', 'unix:///etc/passwd'],
        ['DOCKER', 'https://docker.example.com/arbitrary/path'],
        ['DOCKER', 'https://user:password@docker.example.com'],
        ['WEBSOCKET', 'https://ws.example.com'],
        ['WEBSOCKET', 'wss://ws.example.com/?token=secret'],
        ['WEBSOCKET', 'wss://ws.example.com/#fragment'],
    ])('rejects %s target %s', (type, target) => {
        expect(() =>
            validateApplicationMonitorTarget(type as MonitorType, target),
        ).toThrow();
    });
    it('does not send bearer tokens over an unencrypted WebSocket', () => {
        expect(() =>
            validateApplicationMonitorTarget('WEBSOCKET', 'ws://example.com', {
                token: 'x',
            }),
        ).toThrow();
    });
    it('blocks the mysql2 TLS IP identity limitation explicitly and allows unencrypted IP targets', () => {
        expect(() =>
            validateApplicationMonitorTarget('MYSQL', '1.1.1.1:3306', {
                tls: true,
            }),
        ).toThrow('DNS hostname');
        expect(() =>
            validateApplicationMonitorTarget('MYSQL', '1.1.1.1:3306', {
                tls: false,
            }),
        ).not.toThrow();
    });
    it('rejects ignored TLS/auth options on unencrypted transports', () => {
        expect(() =>
            validateApplicationMonitorTarget('WEBSOCKET', 'ws://example.com', {
                tlsCa: 'pem',
            }),
        ).toThrow();
        expect(() =>
            validateApplicationMonitorTarget(
                'DOCKER',
                'unix:///var/run/docker.sock',
                { containerId: 'api', token: 'ignored' },
            ),
        ).toThrow();
    });
    it('normalizes defaults and fixed property ordering', () => {
        expect(validateApplicationMonitorConfig('REDIS', {})).toEqual({
            tls: true,
            db: 0,
        });
        expect(validateApplicationMonitorConfig('MONGODB', {})).toEqual({
            database: 'admin',
            authSource: 'admin',
            tls: true,
        });
        expect(validateApplicationMonitorConfig('GRPC', {})).toEqual({
            tls: true,
            service: '',
        });
    });
});

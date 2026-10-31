import { Reflector } from '@nestjs/core';
import { AuditLogInterceptor } from './audit-log.interceptor';
import { lastValueFrom, of } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';
import { AUDIT_LOG_KEY } from '../decorators/audit-log.decorator';

describe('Audit monitor secret redaction', () => {
    it('recursively strips nested credentials and encrypted payloads from snapshots', () => {
        const interceptor = new AuditLogInterceptor(
            new Reflector(),
            {} as never,
        );
        const before = {
            id: 'monitor-1',
            credentialsEnc: 'ciphertext',
            config: {
                username: 'monitor',
                password: 'secret',
                token: 'token-value',
                tlsKey: 'private-key',
            },
            items: [{ secret: 'nested-secret' }],
            createdAt: new Date('2026-10-10T00:00:00Z'),
        };
        const result = (interceptor as any).stripSensitiveFields(before);
        expect(result.credentialsEnc).toBe('[REDACTED]');
        expect(result.config).toEqual({
            username: 'monitor',
            password: '[REDACTED]',
            token: '[REDACTED]',
            tlsKey: '[REDACTED]',
        });
        expect(result.items[0].secret).toBe('[REDACTED]');
        expect(result.createdAt).toEqual(before.createdAt);
        expect(before.config.password).toBe('secret');
    });
});

describe('Audit snapshots written through the interceptor', () => {
    async function write(
        entity: string,
        before: any,
        after: any,
        idField = 'id',
    ) {
        const handler = () => undefined;
        Reflect.defineMetadata(AUDIT_LOG_KEY, { entity, idField }, handler);
        const prisma = {
            [entity[0].toLowerCase() + entity.slice(1)]: {
                findUnique: jest.fn().mockResolvedValue(before),
            },
            auditLog: { create: jest.fn().mockResolvedValue({}) },
        };
        const interceptor = new AuditLogInterceptor(
            new Reflector(),
            prisma as never,
        );
        const context = {
            getHandler: () => handler,
            switchToHttp: () => ({
                getRequest: () => ({
                    method: 'PATCH',
                    params: { id: 'entity', orgId: 'org' },
                    headers: {},
                    user: { sub: 'actor' },
                    ip: '127.0.0.1',
                }),
            }),
        } as unknown as ExecutionContext;
        const returned = await lastValueFrom(
            interceptor.intercept(context, { handle: () => of(after) }),
        );
        expect(returned).toBe(after);
        return prisma.auditLog.create.mock.calls[0][0].data;
    }

    it('redacts both channel snapshots without changing the response or source config', async () => {
        const before = {
            id: 'entity',
            config: {
                appSecret: 'before-secret',
                webhookUrl:
                    'https://open.feishu.cn/open-apis/bot/v2/hook/before-token',
            },
        };
        const after = {
            id: 'entity',
            config: {
                APP_SECRET: 'after-secret',
                webhook_url: 'https://qyapi.weixin.qq.com/send?key=after-key',
                headers: {
                    Authorization: 'Bearer secret',
                    'X-Api-Key': 'api-secret',
                },
            },
        };
        const log = await write('NotificationChannel', before, after);
        expect(JSON.stringify(log)).not.toMatch(
            /before-secret|before-token|after-secret|after-key|Bearer secret|api-secret/,
        );
        expect(log.before.config.appSecret).toBe('[REDACTED]');
        expect(after.config.APP_SECRET).toBe('after-secret');
        expect(before.config.appSecret).toBe('before-secret');
    });

    it('redacts the one-time ApiKey.key without hiding project short codes', async () => {
        const log = await write(
            'ApiKey',
            { id: 'entity', keyHash: 'hash' },
            {
                id: 'entity',
                key: 'bk_org_one-time-secret',
                keyPrefix: 'bk_org_prefix',
                name: 'CI',
            },
        );
        expect(log.after).toEqual({
            id: 'entity',
            key: '[REDACTED]',
            keyPrefix: 'bk_org_prefix',
            name: 'CI',
        });
        expect(log.before.keyHash).toBe('[REDACTED]');
        const project = await write(
            'Project',
            { id: 'entity', key: 'PROJ' },
            { id: 'entity', key: 'NEW' },
        );
        expect(project.before.key).toBe('PROJ');
        expect(project.after.key).toBe('NEW');
    });

    it('keeps secret settings values redacted but preserves the setting key', async () => {
        const log = await write(
            'Setting',
            { key: 'wechat.appSecret', isSecret: true, value: 'old-value' },
            { key: 'wechat.appSecret', isSecret: true, value: 'new-value' },
            'key',
        );
        expect(log.before).toMatchObject({
            key: 'wechat.appSecret',
            value: '[REDACTED]',
        });
        expect(log.after).toMatchObject({
            key: 'wechat.appSecret',
            value: '[REDACTED]',
        });
    });
});

import { Reflector } from '@nestjs/core';
import { AuditLogInterceptor } from './audit-log.interceptor';

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

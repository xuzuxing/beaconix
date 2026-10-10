import { ConfigService } from '@nestjs/config';
import { MonitorSecretsService } from './monitor-secrets.service';

const context = {
    organizationId: 'org-a',
    type: 'REDIS' as const,
    target: 'redis.example.com:6379',
};
const key = Buffer.alloc(32, 7).toString('base64');
const service = () =>
    new MonitorSecretsService(
        new ConfigService({ monitor: { secretKey: key } }),
    );

describe('MonitorSecretsService', () => {
    it('encrypts secrets with random authenticated nonces and never returns them', () => {
        const secrets = service();
        const original = {
            tls: true,
            password: 'distinct-monitor-password',
            token: 'distinct-token',
            tlsKey: 'private-key',
        };
        const sealed = secrets.seal(original, context);
        expect(sealed.config).toEqual({ tls: true });
        expect(sealed.credentialsEnc).toMatch(/^v1:/);
        expect(sealed.credentialsEnc).not.toContain('distinct');
        expect(secrets.open({ ...context, ...sealed })).toEqual(original);
        expect(secrets.seal(original, context).credentialsEnc).not.toEqual(
            sealed.credentialsEnc,
        );
        expect(original.password).toEqual('distinct-monitor-password');
    });
    it.each([
        { organizationId: 'other-org' },
        { type: 'MYSQL' as const },
        { target: 'other.example.com:6379' },
    ])('binds ciphertext to org, type and target %#', (change) => {
        const secrets = service();
        const sealed = secrets.seal({ password: 'secret' }, context);
        expect(() =>
            secrets.open({ ...context, ...sealed, ...change }),
        ).toThrow();
    });
    it('fails closed on missing keys, invalid keys and tampering', () => {
        const secrets = service();
        const sealed = secrets.seal({ password: '' }, context);
        const missing = new MonitorSecretsService(new ConfigService());
        expect(() => missing.seal({ password: 'secret' }, context)).toThrow(
            'not configured',
        );
        expect(() => missing.open({ ...context, ...sealed })).toThrow();
        expect(
            () =>
                new MonitorSecretsService(
                    new ConfigService({ monitor: { secretKey: 'bad' } }),
                ),
        ).toThrow();
        const parts = sealed.credentialsEnc!.split(':');
        parts[2] = Buffer.alloc(16).toString('base64');
        expect(() =>
            secrets.open({
                ...context,
                ...sealed,
                credentialsEnc: parts.join(':'),
            }),
        ).toThrow();
    });
    it('does not require encryption for credential-free basic checks and defensively redacts config', () => {
        const secrets = new MonitorSecretsService(new ConfigService());
        expect(secrets.seal({ recordType: 'A' }, context)).toEqual({
            config: { recordType: 'A' },
            credentialsEnc: null,
        });
        expect(
            secrets.publicConfig({
                username: 'monitor',
                password: 'secret',
                token: 'secret',
                tlsKey: 'secret',
            }),
        ).toEqual({ username: 'monitor' });
    });
});

import { CheckerRegistry } from './checker.registry';
import type { MonitorModel } from '../../generated/prisma/models';
import { MonitorSecretsService } from '../monitors/monitor-secrets.service';
import { ConfigService } from '@nestjs/config';

describe('CheckerRegistry', () => {
    function setup() {
        const strategies = [
            'HTTP',
            'TCP',
            'DNS',
            'PING',
            'MYSQL',
            'POSTGRESQL',
            'REDIS',
            'MONGODB',
            'DOCKER',
            'GRPC',
            'WEBSOCKET',
        ].map((type) => ({
            type,
            run: jest.fn().mockResolvedValue({ success: true }),
        }));
        const registry = new CheckerRegistry(
            strategies[0] as never,
            strategies[1] as never,
            strategies[2] as never,
            strategies[3] as never,
            strategies[4] as never,
            strategies[5] as never,
            strategies[6] as never,
            strategies[7] as never,
            strategies[8] as never,
            strategies[9] as never,
            strategies[10] as never,
            { open: (monitor: MonitorModel) => monitor.config } as never,
        );
        return { registry, strategies };
    }

    it('dispatches to the registered strategy', async () => {
        const { registry, strategies } = setup();
        const monitor = {
            type: 'DNS',
            config: { recordType: 'A' },
            configVersion: 1,
        } as unknown as MonitorModel;
        expect(await registry.check(monitor)).toEqual({ success: true });
        expect(strategies[2].run).toHaveBeenCalledWith(monitor);
    });

    it('blocks unknown configuration versions and invalid persisted config', async () => {
        const { registry, strategies } = setup();
        expect(
            await registry.check({
                type: 'HTTP',
                config: {},
                configVersion: 2,
            } as unknown as MonitorModel),
        ).toMatchObject({ evaluated: false, failureKind: 'CONFIGURATION' });
        expect(
            await registry.check({
                type: 'DNS',
                config: { password: 'not allowed' },
                configVersion: 1,
            } as unknown as MonitorModel),
        ).toMatchObject({ evaluated: false, failureKind: 'CONFIGURATION' });
        expect(
            strategies.every(
                (strategy) => strategy.run.mock.calls.length === 0,
            ),
        ).toBe(true);
    });

    it('rejects duplicate registrations at startup', () => {
        const duplicate = { type: 'HTTP', run: jest.fn() } as never;
        expect(
            () =>
                new CheckerRegistry(
                    duplicate,
                    duplicate,
                    duplicate,
                    duplicate,
                    duplicate,
                    duplicate,
                    duplicate,
                    duplicate,
                    duplicate,
                    duplicate,
                    duplicate,
                    {} as never,
                ),
        ).toThrow('Duplicate');
    });

    it('decrypts only for execution and blocks tampered credentials before invoking drivers', async () => {
        const { registry, strategies } = setup();
        const secrets = new MonitorSecretsService(
            new ConfigService({
                monitor: { secretKey: Buffer.alloc(32, 7).toString('base64') },
            }),
        );
        (registry as any).secrets = secrets;
        const context = {
            organizationId: 'org-a',
            type: 'REDIS' as const,
            target: 'redis.example.com:6379',
        };
        const sealed = secrets.seal({ password: 'private-password' }, context);
        const monitor = {
            ...context,
            ...sealed,
            configVersion: 1,
        } as MonitorModel;
        await registry.check(monitor);
        expect(strategies[6].run).toHaveBeenCalledWith(
            expect.objectContaining({
                config: { password: 'private-password', tls: true, db: 0 },
            }),
        );
        expect(monitor.config).toEqual({});
        strategies[6].run.mockClear();
        expect(
            await registry.check({ ...monitor, organizationId: 'other-org' }),
        ).toMatchObject({ evaluated: false, failureKind: 'CONFIGURATION' });
        expect(strategies[6].run).not.toHaveBeenCalled();
    });
});

import { Resolver } from 'node:dns/promises';
import type { MonitorModel } from '../../../generated/prisma/models';
import {
    ApplicationCheckError,
    ApplicationCheckRuntime,
    ApplicationNetworkService,
} from './application-runtime';

const monitor = {
    type: 'REDIS',
    target: 'redis.example.com:6379',
    config: {},
    timeout: 100,
} as unknown as MonitorModel;

describe('Application network policy', () => {
    afterEach(() => jest.restoreAllMocks());
    it.each([
        '127.0.0.1',
        '10.0.0.1',
        '169.254.169.254',
        '::1',
        '::ffff:127.0.0.1',
        '192.168.1.1',
        '2001:db8::1',
    ])('blocks nonpublic %s', async (host) => {
        await expect(
            new ApplicationNetworkService().resolve(
                host,
                new AbortController().signal,
            ),
        ).rejects.toMatchObject({ kind: 'POLICY', evaluated: false });
    });
    it('rejects mixed public/private DNS answers', async () => {
        jest.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue([
            '1.1.1.1',
            '127.0.0.1',
        ] as never);
        jest.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue(
            [] as never,
        );
        await expect(
            new ApplicationNetworkService().resolve(
                'example.com',
                new AbortController().signal,
            ),
        ).rejects.toMatchObject({ kind: 'POLICY' });
    });
    it('returns a pinned public address', async () => {
        jest.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue([
            '1.1.1.1',
        ] as never);
        jest.spyOn(Resolver.prototype, 'resolve6').mockRejectedValue(
            new Error('ENODATA'),
        );
        await expect(
            new ApplicationNetworkService().resolve(
                'example.com',
                new AbortController().signal,
            ),
        ).resolves.toBe('1.1.1.1');
    });
});

describe('ApplicationCheckRuntime', () => {
    const network = { resolve: jest.fn().mockResolvedValue('1.1.1.1') };
    beforeEach(() => network.resolve.mockReset().mockResolvedValue('1.1.1.1'));
    it('uses a fixed lookup even if a driver asks for another hostname', async () => {
        const result = await new ApplicationCheckRuntime(network).run(
            monitor,
            (context) => {
                expect(context.host).toBe('redis.example.com');
                expect(context.address).toBe('1.1.1.1');
                context.lookup('unexpected.internal', {}, (_error, address) =>
                    expect(address).toBe('1.1.1.1'),
                );
                return Promise.resolve({
                    protocol: 'REDIS',
                    operation: 'PING',
                });
            },
        );
        expect(result.success).toBe(true);
    });
    it('bounds the whole operation, cleans up and handles late errors', async () => {
        const cleanup = jest.fn();
        const result = await new ApplicationCheckRuntime(network).run(
            monitor,
            async (context) => {
                context.cleanup(cleanup);
                return new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error('late password secret')),
                        140,
                    ),
                );
            },
        );
        expect(result).toMatchObject({
            success: false,
            failureKind: 'TIMEOUT',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        await new Promise((resolve) => setTimeout(resolve, 60));
    });
    it('blocks policy failures without marking the target DOWN', async () => {
        network.resolve.mockRejectedValue(
            new ApplicationCheckError('POLICY', 'blocked', false),
        );
        const operation = jest.fn();
        expect(
            await new ApplicationCheckRuntime(network as never).run(
                monitor,
                operation,
            ),
        ).toMatchObject({ evaluated: false, failureKind: 'POLICY' });
        expect(operation).not.toHaveBeenCalled();
    });
    it('does not start connections after DNS exceeds the deadline', async () => {
        network.resolve.mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(() => resolve('1.1.1.1'), 140),
                ),
        );
        const operation = jest.fn();
        const result = await new ApplicationCheckRuntime(network).run(
            monitor,
            operation,
        );
        expect(result.failureKind).toBe('TIMEOUT');
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(operation).not.toHaveBeenCalled();
    });
    it('sanitizes all unknown driver failures and cleans up', async () => {
        const cleanup = jest.fn();
        const result = await new ApplicationCheckRuntime(network).run(
            monitor,
            (context) => {
                context.cleanup(cleanup);
                return Promise.reject(
                    new Error(
                        'password=secret connectionString=redis://secret@host',
                    ),
                );
            },
        );
        expect(result.error).toBe('Application protocol check failed');
        expect(cleanup).toHaveBeenCalled();
    });
});

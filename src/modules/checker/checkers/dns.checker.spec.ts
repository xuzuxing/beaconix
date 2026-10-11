import { Resolver } from 'node:dns/promises';
import { DnsChecker } from './dns.checker';
import type { MonitorModel } from '../../../generated/prisma/models';

jest.mock('node:dns/promises', () => ({ Resolver: jest.fn() }));

const monitor = {
    type: 'DNS',
    target: 'example.com',
    timeout: 1000,
    config: {},
} as MonitorModel;

describe('DnsChecker', () => {
    const resolver = {
        resolve4: jest.fn(),
        resolve6: jest.fn(),
        resolveCname: jest.fn(),
        cancel: jest.fn(),
    };
    beforeEach(() => {
        jest.clearAllMocks();
        (Resolver as unknown as jest.Mock).mockImplementation(() => resolver);
    });
    afterEach(() => jest.useRealTimers());

    it('compares normalized unordered record sets and stores bounded TTL metadata', async () => {
        resolver.resolve4.mockResolvedValue([
            { address: '8.8.8.8', ttl: 20 },
            { address: '1.1.1.1', ttl: 30 },
        ]);
        const result = await new DnsChecker().run({
            ...monitor,
            config: {
                recordType: 'A',
                expectedValues: ['1.1.1.1', '8.8.8.8'],
            },
        });
        expect(result.success).toBe(true);
        expect(result.meta).toEqual({
            protocol: 'DNS',
            recordType: 'A',
            actualValues: ['1.1.1.1', '8.8.8.8'],
            ttl: [30, 20],
        });
        expect(resolver.cancel).toHaveBeenCalled();
    });

    it('fails empty records and mismatched assertions', async () => {
        resolver.resolve4.mockResolvedValue([]);
        expect((await new DnsChecker().run(monitor)).success).toBe(false);
        resolver.resolve4.mockResolvedValue([{ address: '8.8.8.8', ttl: 20 }]);
        expect(
            await new DnsChecker().run({
                ...monitor,
                config: { recordType: 'A', expectedValues: ['1.1.1.1'] },
            }),
        ).toMatchObject({ success: false, failureKind: 'ASSERTION' });
    });

    it('normalizes CNAME case and trailing dot without inventing TTL', async () => {
        resolver.resolveCname.mockResolvedValue(['WWW.Example.COM.']);
        const result = await new DnsChecker().run({
            ...monitor,
            config: {
                recordType: 'CNAME',
                expectedValues: ['www.example.com'],
            },
        });
        expect(result.success).toBe(true);
        expect(result.meta).not.toHaveProperty('ttl');
    });

    it('supports IPv6 records', async () => {
        resolver.resolve6.mockResolvedValue([
            { address: '2001:4860:4860::8888', ttl: 20 },
        ]);
        expect(
            (
                await new DnsChecker().run({
                    ...monitor,
                    config: { recordType: 'AAAA' },
                })
            ).success,
        ).toBe(true);
    });

    it('classifies resolution failures', async () => {
        resolver.resolve4.mockRejectedValue(
            Object.assign(new Error('missing'), { code: 'ENOTFOUND' }),
        );
        expect(await new DnsChecker().run(monitor)).toMatchObject({
            success: false,
            failureKind: 'TRANSPORT',
            error: 'DNS query failed (ENOTFOUND)',
        });
    });

    it('cancels a hung resolver at the whole-operation deadline', async () => {
        jest.useFakeTimers();
        resolver.resolve4.mockReturnValue(new Promise(() => {}));
        const result = new DnsChecker().run(monitor);
        await jest.advanceTimersByTimeAsync(1000);
        expect(await result).toMatchObject({
            success: false,
            failureKind: 'TIMEOUT',
        });
        expect(resolver.cancel).toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    it('blocks invalid configuration without treating it as an outage', async () => {
        expect(
            await new DnsChecker().run({
                ...monitor,
                config: { recordType: 'MX' },
            }),
        ).toMatchObject({ evaluated: false, failureKind: 'CONFIGURATION' });
        expect(resolver.resolve4).not.toHaveBeenCalled();
    });
});

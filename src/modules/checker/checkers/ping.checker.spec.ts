import { PingChecker, isPublicPingAddress } from './ping.checker';
import type { MonitorModel } from '../../../generated/prisma/models';
import { Resolver } from 'node:dns/promises';

jest.mock('node:dns/promises', () => ({ Resolver: jest.fn() }));
const monitor = { target: '1.1.1.1', timeout: 3000 } as MonitorModel;

describe('PingChecker', () => {
    const runner = { run: jest.fn() };
    const resolver = {
        resolve4: jest.fn(),
        resolve6: jest.fn(),
        cancel: jest.fn(),
    };
    beforeEach(() => {
        jest.clearAllMocks();
        (Resolver as unknown as jest.Mock).mockImplementation(() => resolver);
    });

    it('uses three attempts, averages successful RTTs and diagnoses packet loss', async () => {
        runner.run
            .mockResolvedValueOnce({ stdout: 'time=10 ms', stderr: '' })
            .mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 })
            .mockResolvedValueOnce({ stdout: 'time=20 ms', stderr: '' });
        expect(await new PingChecker(runner).run(monitor)).toMatchObject({
            success: true,
            latency: 15,
            meta: { protocol: 'PING', sent: 3, received: 2, packetLoss: 33.33 },
        });
        expect(runner.run).toHaveBeenCalledTimes(3);
        expect(runner.run.mock.calls.every(([ip]) => ip === '1.1.1.1')).toBe(
            true,
        );
    });

    it('classifies missing executable and permission failures as blocked', async () => {
        runner.run.mockResolvedValue({
            stdout: '',
            stderr: '',
            code: 'ENOENT',
        });
        expect(await new PingChecker(runner).run(monitor)).toMatchObject({
            success: false,
            evaluated: false,
            failureKind: 'CAPABILITY',
        });
        runner.run.mockResolvedValue({
            stdout: '',
            stderr: 'Operation not permitted',
            code: 2,
        });
        expect((await new PingChecker(runner).run(monitor)).evaluated).toBe(
            false,
        );
    });

    it('does not count destination-unreachable output as an ICMP success', async () => {
        runner.run.mockResolvedValue({
            stdout: 'Destination host unreachable',
            stderr: '',
            code: 1,
        });
        expect(await new PingChecker(runner).run(monitor)).toMatchObject({
            success: false,
        });
    });

    it('pins hostname resolution to a public IP', async () => {
        resolver.resolve4.mockResolvedValue(['1.1.1.1']);
        resolver.resolve6.mockResolvedValue([]);
        runner.run.mockResolvedValue({ stdout: 'time<1ms', stderr: '' });
        expect(
            (
                await new PingChecker(runner).run({
                    ...monitor,
                    target: 'example.com',
                })
            ).success,
        ).toBe(true);
        expect(runner.run.mock.calls[0][0]).toBe('1.1.1.1');
        expect(resolver.cancel).toHaveBeenCalled();
    });

    it('rejects hostnames resolving to private addresses', async () => {
        resolver.resolve4.mockResolvedValue(['127.0.0.1']);
        resolver.resolve6.mockResolvedValue([]);
        expect(
            await new PingChecker(runner).run({
                ...monitor,
                target: 'example.com',
            }),
        ).toMatchObject({ evaluated: false, failureKind: 'POLICY' });
        expect(runner.run).not.toHaveBeenCalled();
    });

    it.each([
        '127.0.0.1',
        '169.254.169.254',
        '10.0.0.1',
        '::1',
        '::ffff:127.0.0.1',
        'fd00::1',
        'fe80::1',
        '2001:db8::1',
        '-c',
        'a;curl',
        'example.com/health',
    ])('blocks unsafe target %s', async (target) => {
        expect(
            (await new PingChecker(runner).run({ ...monitor, target }))
                .evaluated,
        ).toBe(false);
        expect(runner.run).not.toHaveBeenCalled();
    });

    it('recognizes public IPv4 and IPv6 addresses', () => {
        expect(isPublicPingAddress('8.8.8.8')).toBe(true);
        expect(isPublicPingAddress('2606:4700:4700::1111')).toBe(true);
    });
});

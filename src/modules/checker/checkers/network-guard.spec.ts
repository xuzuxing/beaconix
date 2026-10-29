import {
    assertLiteralPublicAddress,
    resolvePublicHost,
    pinnedLookup,
    isPublicAddress,
    privateTargetsAllowed,
} from './network-guard';
import { lookup } from 'node:dns/promises';

jest.mock('node:dns/promises', () => ({
    ...jest.requireActual('node:dns/promises'),
    lookup: jest.fn(),
}));
const mockLookup = jest.mocked(lookup);

const original = process.env.MONITOR_ALLOW_PRIVATE_TARGETS;

function restoreEnv() {
    if (original === undefined) {
        delete process.env.MONITOR_ALLOW_PRIVATE_TARGETS;
    } else {
        process.env.MONITOR_ALLOW_PRIVATE_TARGETS = original;
    }
}

describe('network-guard', () => {
    beforeEach(() => {
        delete process.env.MONITOR_ALLOW_PRIVATE_TARGETS;
        mockLookup.mockReset();
    });

    afterAll(restoreEnv);

    describe('isPublicAddress', () => {
        it.each([
            '127.0.0.1',
            '10.1.2.3',
            '172.20.0.1',
            '192.168.1.1',
            '169.254.169.254',
            '100.64.0.1',
            '198.51.100.7',
            '0.0.0.0',
            '::1',
            'fd00::1',
            'fe80::1',
            '2001:db8::1',
        ])('treats %s as non-public', (address) => {
            expect(isPublicAddress(address)).toBe(false);
        });

        it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
            'treats %s as public',
            (address) => {
                expect(isPublicAddress(address)).toBe(true);
            },
        );

        it('treats a hostname as non-public', () => {
            expect(isPublicAddress('example.com')).toBe(false);
        });
    });

    describe('resolvePublicHost', () => {
        it('rejects a literal private address', async () => {
            await expect(resolvePublicHost('10.0.0.5')).resolves.toEqual({
                ok: false,
                reason: 'private or reserved address',
            });
        });

        it('rejects the cloud metadata address', async () => {
            const verdict = await resolvePublicHost('169.254.169.254');

            expect(verdict.ok).toBe(false);
        });

        it('accepts a literal public address', async () => {
            await expect(resolvePublicHost('1.1.1.1')).resolves.toEqual({
                ok: true,
                address: '1.1.1.1',
                family: 4,
            });
        });

        it('propagates DNS failures instead of allowing an unchecked lookup', async () => {
            mockLookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
            await expect(resolvePublicHost('missing.invalid')).rejects.toThrow(
                'ENOTFOUND',
            );
        });

        it('rejects every address when a domain resolves into a private range', async () => {
            mockLookup.mockResolvedValue([
                { address: '1.1.1.1', family: 4 },
                { address: '127.0.0.1', family: 4 },
            ] as never);
            const verdict = await resolvePublicHost('mixed.example');

            expect(verdict.ok).toBe(false);
        });

        it('returns a checked address and never resolves again for a pinned lookup', async () => {
            mockLookup.mockResolvedValueOnce([
                { address: '1.1.1.1', family: 4 },
            ] as never);
            mockLookup.mockResolvedValue([
                { address: '127.0.0.1', family: 4 },
            ] as never);
            const verdict = await resolvePublicHost('rebind.example');
            expect(verdict).toEqual({
                ok: true,
                address: '1.1.1.1',
                family: 4,
            });
            if (!verdict.ok) throw new Error('Expected public address');
            const callback = jest.fn();
            const lookup = pinnedLookup(verdict);
            lookup('rebind.example', {}, callback);
            expect(callback).toHaveBeenLastCalledWith(null, '1.1.1.1', 4);
            lookup('rebind.example', { all: true }, callback);
            expect(callback).toHaveBeenLastCalledWith(null, [
                { address: '1.1.1.1', family: 4 },
            ]);
            expect(mockLookup).toHaveBeenCalledTimes(1);
        });

        it('handles bracketed IPv6 literals without a DNS lookup', async () => {
            await expect(
                resolvePublicHost('[2606:4700:4700::1111]'),
            ).resolves.toEqual({
                ok: true,
                address: '2606:4700:4700::1111',
                family: 6,
            });
            await expect(resolvePublicHost('[::1]')).resolves.toMatchObject({
                ok: false,
            });
            expect(mockLookup).not.toHaveBeenCalled();
        });

        it('fails closed when DNS returns no addresses', async () => {
            mockLookup.mockResolvedValue([] as never);
            await expect(resolvePublicHost('empty.example')).rejects.toThrow(
                'no addresses',
            );
        });

        it('observes the deadline even while DNS is pending', async () => {
            mockLookup.mockReturnValue(new Promise(() => {}));
            const controller = new AbortController();
            const pending = resolvePublicHost(
                'slow.example',
                controller.signal,
            );
            controller.abort(new Error('Check deadline exceeded'));
            await expect(pending).rejects.toThrow('deadline exceeded');
        });
    });

    describe('assertLiteralPublicAddress', () => {
        it('rejects literal private addresses only', () => {
            expect(assertLiteralPublicAddress('192.168.0.10').ok).toBe(false);
            // 域名不在这里判定：解析发生在执行期。
            expect(assertLiteralPublicAddress('example.com').ok).toBe(true);
            expect(assertLiteralPublicAddress('1.1.1.1').ok).toBe(true);
        });
    });

    describe('privateTargetsAllowed', () => {
        it.each(['true', '1', 'YES'])(
            'accepts %s as the self-hosted opt-in',
            (value) => {
                process.env.MONITOR_ALLOW_PRIVATE_TARGETS = value;

                expect(privateTargetsAllowed()).toBe(true);
            },
        );

        it('stays off by default and for unrelated values', () => {
            process.env.MONITOR_ALLOW_PRIVATE_TARGETS = 'off';

            expect(privateTargetsAllowed()).toBe(false);
        });

        it('lets the guard through when opted in', async () => {
            process.env.MONITOR_ALLOW_PRIVATE_TARGETS = 'true';

            await expect(resolvePublicHost('10.0.0.5')).resolves.toEqual({
                ok: true,
                address: '10.0.0.5',
                family: 4,
            });
            expect(assertLiteralPublicAddress('10.0.0.5').ok).toBe(true);
        });
    });
});

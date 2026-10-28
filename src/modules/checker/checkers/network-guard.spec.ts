import {
    assertLiteralPublicAddress,
    assertPublicHost,
    isPublicAddress,
    privateTargetsAllowed,
} from './network-guard';

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

    describe('assertPublicHost', () => {
        it('rejects a literal private address', async () => {
            await expect(assertPublicHost('10.0.0.5')).resolves.toEqual({
                ok: false,
                reason: 'private or reserved address',
            });
        });

        it('rejects the cloud metadata address', async () => {
            const verdict = await assertPublicHost('169.254.169.254');

            expect(verdict.ok).toBe(false);
        });

        it('accepts a literal public address', async () => {
            await expect(assertPublicHost('1.1.1.1')).resolves.toEqual({
                ok: true,
            });
        });

        it('accepts an unresolvable host so the transport reports the real error', async () => {
            await expect(
                assertPublicHost('definitely-not-a-real-host.invalid'),
            ).resolves.toEqual({ ok: true });
        });

        it('rejects every address when a domain resolves into a private range', async () => {
            // `localhost` resolves to loopback on every platform we run on.
            const verdict = await assertPublicHost('localhost');

            expect(verdict.ok).toBe(false);
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

            await expect(assertPublicHost('10.0.0.5')).resolves.toEqual({
                ok: true,
            });
            expect(assertLiteralPublicAddress('10.0.0.5').ok).toBe(true);
        });
    });
});

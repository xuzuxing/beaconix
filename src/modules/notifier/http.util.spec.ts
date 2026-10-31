import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as addressGuard from '../../common/utils/address.util';
import { assertZeroCode, getJson, postJson } from './http.util';
import { parseNotificationUrl } from './notification-url';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

describe('notification outbound HTTP boundary', () => {
    const originalFetch = global.fetch;
    const originalPrivate = process.env.MONITOR_ALLOW_PRIVATE_TARGETS;
    beforeEach(() => {
        (lookup as jest.Mock)
            .mockReset()
            .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        global.fetch = jest.fn().mockResolvedValue(new Response('{"code":0}'));
        process.env.MONITOR_ALLOW_PRIVATE_TARGETS = 'true';
    });
    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
        jest.useRealTimers();
        if (originalPrivate === undefined)
            delete process.env.MONITOR_ALLOW_PRIVATE_TARGETS;
        else process.env.MONITOR_ALLOW_PRIVATE_TARGETS = originalPrivate;
    });

    it.each([
        'http://127.0.0.1/hook',
        'http://127.1/',
        'http://2130706433/',
        'http://0x7f000001/',
        'http://[::1]/',
        'http://[::ffff:127.0.0.1]/',
        'http://10.0.0.1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://100.64.0.1/',
        'http://192.168.1.1/',
        'http://[fd00::1]/',
        'https://user:password@public.example/hook',
        'ftp://public.example/hook',
        'https://',
        'https://public.example/hook#secret',
    ])('rejects unsafe URL %s before any network I/O', async (url) => {
        expect(() => parseNotificationUrl(url)).toThrow();
        await expect(
            postJson(url, { secret: 'body-secret' }),
        ).rejects.toThrow();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(lookup).not.toHaveBeenCalled();
    });

    it.each([
        { addresses: [{ address: '127.0.0.1', family: 4 }] },
        {
            addresses: [
                { address: '93.184.216.34', family: 4 },
                { address: '10.0.0.1', family: 4 },
            ],
        },
        {
            addresses: [
                { address: '93.184.216.34', family: 4 },
                { address: 'fd00::1', family: 6 },
            ],
        },
    ])(
        'refuses every private or mixed DNS result despite the monitor LAN override',
        async ({ addresses }) => {
            (lookup as jest.Mock).mockResolvedValue(addresses);
            await expect(
                postJson('https://tenant.example/hook', {}),
            ).rejects.toThrow('public addresses');
            expect(global.fetch).not.toHaveBeenCalled();
        },
    );

    it('sends JSON with a pinned dispatcher and disables redirects', async () => {
        const pin = jest.spyOn(addressGuard, 'pinnedLookup');
        await expect(
            postJson('https://tenant.example/hook?key=secret', {
                text: 'hello',
            }),
        ).resolves.toEqual({ code: 0 });
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(pin).toHaveBeenCalledWith({
            ok: true,
            address: '93.184.216.34',
            family: 4,
        });
        expect(global.fetch).toHaveBeenCalledWith(
            expect.any(URL),
            expect.objectContaining({
                method: 'POST',
                redirect: 'manual',
                dispatcher: expect.anything(),
                body: '{"text":"hello"}',
            }),
        );
    });

    it.each([301, 302, 303, 307, 308])(
        'never follows HTTP %s or echoes the credential-bearing location',
        async (status) => {
            (global.fetch as jest.Mock).mockResolvedValue(
                new Response(null, {
                    status,
                    headers: { location: 'http://127.0.0.1/?token=stolen' },
                }),
            );
            await expect(
                postJson('https://tenant.example/hook/credential', {}),
            ).rejects.toThrow(`HTTP ${status} from notification endpoint`);
            expect(global.fetch).toHaveBeenCalledTimes(1);
        },
    );

    it('omits arbitrary remote response bodies from errors', async () => {
        (global.fetch as jest.Mock).mockResolvedValue(
            new Response('appSecret=leaked', { status: 500 }),
        );
        await expect(
            getJson('https://tenant.example/?secret=hidden'),
        ).rejects.toThrow('HTTP 500 from notification endpoint');
    });

    it('bounds streamed response bytes', async () => {
        (global.fetch as jest.Mock).mockResolvedValue(
            new Response('x'.repeat(65_537)),
        );
        await expect(postJson('https://tenant.example/', {})).rejects.toThrow(
            'size limit',
        );
    });

    it.each(['dns', 'body'])(
        'applies one timeout including a stalled %s',
        async (phase) => {
            jest.useFakeTimers();
            if (phase === 'dns')
                (lookup as jest.Mock).mockImplementation(
                    () => new Promise(() => {}),
                );
            else
                (global.fetch as jest.Mock).mockResolvedValue(
                    new Response(new ReadableStream()),
                );
            const assertion = expect(
                postJson('https://tenant.example/', {}, 20),
            ).rejects.toThrow('timed out');
            await jest.advanceTimersByTimeAsync(30);
            await assertion;
        },
    );

    it('normalizes transport failures without retaining credential-bearing causes', async () => {
        (global.fetch as jest.Mock).mockRejectedValue(
            new Error(
                'request failed for https://tenant.example/hook/secret-token',
            ),
        );
        await expect(postJson('https://tenant.example/', {})).rejects.toThrow(
            'Notification request failed',
        );
    });

    it('does not echo provider error text', () => {
        expect(() =>
            assertZeroCode(
                { code: 1, errmsg: 'appSecret=leaked' },
                ['code'],
                'Feishu',
            ),
        ).toThrow('Feishu rejected the message: 1');
    });

    it('uses the admitted address for an actual socket and preserves the URL Host', async () => {
        global.fetch = originalFetch;
        const received: string[] = [];
        const server = createServer((request, response) => {
            received.push(request.headers.host ?? '');
            request.resume();
            response.end('{"code":0}');
        });
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        const port = (server.address() as AddressInfo).port;
        // Only the admission result is stubbed for the loopback transport test;
        // the strict address rejection above exercises the real DNS validator.
        jest.spyOn(addressGuard, 'resolvePublicHost').mockResolvedValue({
            ok: true,
            address: '127.0.0.1',
            family: 4,
        });
        try {
            await expect(
                postJson(`http://pinned.example:${port}/hook`, {}),
            ).resolves.toEqual({ code: 0 });
            expect(received).toEqual([`pinned.example:${port}`]);
            expect(lookup).not.toHaveBeenCalled();
        } finally {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });
});

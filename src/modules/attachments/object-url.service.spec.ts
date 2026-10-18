import type { ConfigService } from '@nestjs/config';
import { AttachmentObjectUrlService } from './object-url.service';
import type { SettingsService } from '../settings';

function createService(ttlSeconds = 300, publicBaseUrl = '') {
    const config = {
        get: jest.fn().mockReturnValue({ secret: 'unit-test-secret' }),
    } as unknown as ConfigService;
    const settings = {
        getNumber: jest.fn().mockResolvedValue(ttlSeconds),
        getString: jest.fn().mockResolvedValue(publicBaseUrl),
    } as unknown as SettingsService;

    return { service: new AttachmentObjectUrlService(config, settings) };
}

describe('AttachmentObjectUrlService', () => {
    it('signs a key and verifies the exact key and expiry', async () => {
        const { service } = createService();

        const url = await service.sign('tickets/2026/10/error.log');
        expect(url.startsWith('/api/attachments/object?')).toBe(true);

        const params = new URL(url, 'http://localhost').searchParams;
        const key = params.get('key');
        const exp = Number(params.get('exp'));
        const sig = params.get('sig');

        expect(key).toBe('tickets/2026/10/error.log');
        expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
        expect(sig).toMatch(/^[0-9a-f]{64}$/);
        expect(service.verify(key!, exp, sig!)).toBe(true);

        // A signature is bound to its key and expiry.
        expect(service.verify('tickets/2026/10/other.log', exp, sig!)).toBe(
            false,
        );
        expect(service.verify(key!, exp + 60, sig!)).toBe(false);
        expect(service.verify(key!, exp, 'f'.repeat(64))).toBe(false);
    });

    it('rejects an expired link', async () => {
        const { service } = createService();

        const url = await service.sign('tickets/a.png');
        const params = new URL(url, 'http://localhost').searchParams;
        const exp = Number(params.get('exp'));
        const sig = params.get('sig');

        expect(service.verify(params.get('key')!, exp, sig!)).toBe(true);
        expect(
            service.verify(
                params.get('key')!,
                Math.floor(Date.now() / 1000) - 1,
                sig!,
            ),
        ).toBe(false);
    });

    it('uses the provider url only for remote storage', async () => {
        const { service } = createService();

        await expect(
            service.toObjectUrl(
                'tickets/a.png',
                'OSS',
                'https://cdn.test/a.png',
            ),
        ).resolves.toBe('https://cdn.test/a.png');

        // A LOCAL object is only reachable through the signed endpoint, even
        // when storage.publicBaseUrl produced an absolute URL.
        await expect(
            service.toObjectUrl(
                'tickets/a.png',
                'LOCAL',
                'https://cdn.test/a.png',
            ),
        ).resolves.toMatch(/^\/api\/attachments\/object\?/);
        await expect(
            service.toObjectUrl('tickets/a.png', 'LOCAL', ''),
        ).resolves.toMatch(/^\/api\/attachments\/object\?/);
    });

    it('returns a permanent unsigned link for a public object', async () => {
        const { service } = createService();

        // A provider that produced a public URL owns it: OSS's CDN address…
        await expect(
            service.toPublicUrl('users/u/a.png', 'https://cdn.test/a.png'),
        ).resolves.toBe('https://cdn.test/a.png');

        // …or LOCAL's configured storage.publicBaseUrl, which already hosts the
        // public root.
        await expect(
            service.toPublicUrl('users/u/a.png', 'https://static.test/a.png'),
        ).resolves.toBe('https://static.test/a.png');

        // Only without either does the link fall back to the API, still without
        // exp/sig: the URL is persisted and rendered long after a signature
        // would have expired.
        await expect(service.toPublicUrl('users/u/a.png', '')).resolves.toBe(
            '/api/attachments/object?key=users%2Fu%2Fa.png',
        );
        await expect(service.toPublicUrl('users/u/a.png')).resolves.toBe(
            '/api/attachments/object?key=users%2Fu%2Fa.png',
        );
    });

    it('prefixes the fallback link with a configured public base', async () => {
        const { service } = createService(300, 'https://api.test');

        await expect(service.toPublicUrl('users/u/a.png', '')).resolves.toBe(
            'https://api.test/api/attachments/object?key=users%2Fu%2Fa.png',
        );
    });
});

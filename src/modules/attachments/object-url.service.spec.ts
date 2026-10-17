import type { ConfigService } from '@nestjs/config';
import { AttachmentObjectUrlService } from './object-url.service';
import type { SettingsService } from '../settings';

function createService(ttlSeconds = 300) {
    const config = {
        get: jest.fn().mockReturnValue({ secret: 'unit-test-secret' }),
    } as unknown as ConfigService;
    const settings = {
        getNumber: jest.fn().mockResolvedValue(ttlSeconds),
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
});

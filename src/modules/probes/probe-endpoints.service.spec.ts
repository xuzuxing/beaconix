import { ProbeEndpointsService } from './probe-endpoints.service';
import type { SettingsService } from '../settings/settings.service';

function createService(overridden: Record<string, unknown> = {}) {
    const settings = {
        getOverriddenValue: jest.fn((key: string) =>
            Promise.resolve(overridden[key]),
        ),
    };

    const service = new ProbeEndpointsService(
        settings as unknown as SettingsService,
    );

    return { service, settings };
}

const ENV_KEYS = [
    'BEACON_ACTIVATE_URL',
    'BEACON_PUBLIC_API_URL',
    'BEACON_INSTALL_URL',
] as const;

describe('ProbeEndpointsService', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (originalEnv[key] === undefined) delete process.env[key];
            else process.env[key] = originalEnv[key];
        }
    });

    beforeEach(() => {
        for (const key of ENV_KEYS) delete process.env[key];
    });

    describe('getEndpoints', () => {
        it('falls back to the built-in addresses when nothing is configured', async () => {
            const { service } = createService();

            await expect(service.getEndpoints()).resolves.toEqual({
                activateUrl: 'https://beaconix.app/activate',
                publicApiUrl: 'https://beaconix.app/api',
                installUrl: 'https://get.beaconix.app/install.sh',
            });
        });

        it('uses the environment variables when the setting was never overridden', async () => {
            process.env.BEACON_ACTIVATE_URL = 'https://env.test/activate';
            process.env.BEACON_PUBLIC_API_URL = 'https://env.test/api';
            process.env.BEACON_INSTALL_URL = 'https://env.test/install.sh';
            const { service } = createService();

            await expect(service.getEndpoints()).resolves.toEqual({
                activateUrl: 'https://env.test/activate',
                publicApiUrl: 'https://env.test/api',
                installUrl: 'https://env.test/install.sh',
            });
        });

        it('prefers the value saved in the admin console over the environment', async () => {
            process.env.BEACON_PUBLIC_API_URL = 'https://env.test/api';
            const { service, settings } = createService({
                'probe.endpoint.publicApiUrl': 'https://console.test/api',
            });

            const endpoints = await service.getEndpoints();

            expect(endpoints.publicApiUrl).toBe('https://console.test/api');
            expect(settings.getOverriddenValue).toHaveBeenCalledWith(
                'probe.endpoint.publicApiUrl',
            );
            expect(settings.getOverriddenValue).toHaveBeenCalledWith(
                'probe.endpoint.activateUrl',
            );
            expect(settings.getOverriddenValue).toHaveBeenCalledWith(
                'probe.endpoint.installUrl',
            );
        });

        it('treats a blank console value as "not set" and keeps falling through', async () => {
            process.env.BEACON_PUBLIC_API_URL = 'https://env.test/api';
            const { service } = createService({
                'probe.endpoint.publicApiUrl': '   ',
            });

            await expect(service.publicApiUrl()).resolves.toBe(
                'https://env.test/api',
            );
        });

        it('strips trailing slashes so URLs never double up', async () => {
            const { service } = createService({
                'probe.endpoint.activateUrl': 'https://console.test/activate//',
                'probe.endpoint.publicApiUrl': 'https://console.test/api/',
                'probe.endpoint.installUrl': 'https://console.test/install.sh/',
            });

            await expect(service.getEndpoints()).resolves.toEqual({
                activateUrl: 'https://console.test/activate',
                publicApiUrl: 'https://console.test/api',
                installUrl: 'https://console.test/install.sh',
            });
        });
    });

    describe('single-value helpers', () => {
        it('resolve one address each without touching the others', async () => {
            const { service, settings } = createService({
                'probe.endpoint.installUrl': 'https://console.test/install.sh',
            });

            await expect(service.installScriptUrl()).resolves.toBe(
                'https://console.test/install.sh',
            );
            await expect(service.activationUrl()).resolves.toBe(
                'https://beaconix.app/activate',
            );
            expect(settings.getOverriddenValue).not.toHaveBeenCalledWith(
                'probe.endpoint.publicApiUrl',
            );
        });
    });
});

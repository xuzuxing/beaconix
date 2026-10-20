import { resendConfig } from './resend.config';
import type { ResendConfig } from './resend.config';

const loadConfig = () =>
    (resendConfig as unknown as () => ResendConfig)() satisfies ResendConfig;

const ENV_KEYS = [
    'RESEND_API_KEY',
    'RESEND_FROM_EMAIL',
    'RESEND_FROM_NAME',
] as const;
const originalEnv: Record<string, string | undefined> = {};

function restoreEnv() {
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalEnv[key];
        }
    }
}

describe('resendConfig', () => {
    beforeAll(() => {
        for (const key of ENV_KEYS) {
            originalEnv[key] = process.env[key];
        }
    });

    afterEach(restoreEnv);

    it('loads an optional API key', () => {
        process.env.RESEND_API_KEY = 're_test_key';

        const config = loadConfig();

        expect(config.apiKey).toBe('re_test_key');
    });

    it('allows an empty API key because EmailModule validates by app environment', () => {
        delete process.env.RESEND_API_KEY;

        const config = loadConfig();

        expect(config.apiKey).toBe('');
    });

    it('uses default sender details when env values are omitted', () => {
        delete process.env.RESEND_FROM_EMAIL;
        delete process.env.RESEND_FROM_NAME;

        const config = loadConfig();

        expect(config.fromEmail).toBe('noreply@mail.khaledsaeed.tech');
        expect(config.fromName).toBe('Beaconix');
    });
});

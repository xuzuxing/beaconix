import { resendConfig } from './resend.config';
import type { ResendConfig } from './resend.config';

const loadConfig = () =>
    (resendConfig as unknown as () => ResendConfig)() satisfies ResendConfig;

const ENV_KEYS = ['NODE_ENV', 'EMAIL_DEV_MODE', 'RESEND_API_KEY'] as const;
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

    it('enables dev mode in development without requiring an API key', () => {
        process.env.NODE_ENV = 'development';
        delete process.env.EMAIL_DEV_MODE;
        delete process.env.RESEND_API_KEY;

        const config = loadConfig();

        expect(config.devMode).toBe(true);
        expect(config.apiKey).toBe('');
    });

    it('requires an API key in production', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.EMAIL_DEV_MODE;
        delete process.env.RESEND_API_KEY;

        expect(() => loadConfig()).toThrow(
            'Missing required environment variable: RESEND_API_KEY',
        );
    });

    it('lets EMAIL_DEV_MODE=false force real sending in development', () => {
        process.env.NODE_ENV = 'development';
        process.env.EMAIL_DEV_MODE = 'false';
        process.env.RESEND_API_KEY = 're_dev_key';

        const config = loadConfig();

        expect(config.devMode).toBe(false);
        expect(config.apiKey).toBe('re_dev_key');
    });

    it('lets EMAIL_DEV_MODE=true suppress sending in production', () => {
        process.env.NODE_ENV = 'production';
        process.env.EMAIL_DEV_MODE = 'true';
        delete process.env.RESEND_API_KEY;

        const config = loadConfig();

        expect(config.devMode).toBe(true);
    });
});

import { registerAs } from '@nestjs/config';
import { requireEnv, optionalEnv } from './env';

export interface ResendConfig {
    apiKey: string;
    fromEmail: string;
    fromName: string;
    /**
     * When true, emails are not sent through Resend — they are printed to the
     * application console instead. Defaults to true in development.
     */
    devMode: boolean;
}

const TRUTHY_VALUES = ['1', 'true', 'yes', 'on'];
const FALSY_VALUES = ['0', 'false', 'no', 'off'];

function resolveDevMode(): boolean {
    const isDevelopment =
        optionalEnv('NODE_ENV', 'development') === 'development';
    const raw = optionalEnv('EMAIL_DEV_MODE', '').trim().toLowerCase();

    if (TRUTHY_VALUES.includes(raw)) {
        return true;
    }
    if (FALSY_VALUES.includes(raw)) {
        return false;
    }
    return isDevelopment;
}

export const resendConfig = registerAs('resend', (): ResendConfig => {
    const devMode = resolveDevMode();

    return {
        // In dev mode emails are only logged, so an API key is optional.
        apiKey: devMode
            ? optionalEnv('RESEND_API_KEY', '')
            : requireEnv('RESEND_API_KEY'),
        fromEmail: optionalEnv(
            'RESEND_FROM_EMAIL',
            'noreply@mail.khaledsaeed.tech',
        ),
        fromName: optionalEnv('RESEND_FROM_NAME', 'Beacon'),
        devMode,
    };
});

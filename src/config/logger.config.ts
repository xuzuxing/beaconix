import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface LokiLogConfig {
    /** Loki push endpoint, e.g. `http://loki:3100`. Empty means disabled. */
    url?: string;
    /** batching */
    batching: {
        interval: number;
        maxBufferSize: number;
    };
    timeout?: number;
    /** Optional HTTP basic auth for Loki. */
    basicAuth?: {
        username: string;
        password: string;
    };
}

export interface LoggerConfig {
    serviceName: string;
    dir: string;
    level: string;
    prettyPrint: boolean;
    toConsole: boolean;
    toFile: boolean;
    excludePaths: string[];
    sensitiveFields: string[];
    /** Direct Loki push. Push is enabled only when `loki.url` is set. */
    loki: LokiLogConfig;
}

function parseBoolean(value: string): boolean {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseCsv(value: string): string[] {
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

export const loggerConfig = registerAs('logger', (): LoggerConfig => ({
    serviceName: optionalEnv('LOGGER_SERVICE_NAME', 'beaconix'),
    dir: optionalEnv('LOGGER_DIR', 'logs'),
    level: optionalEnv('LOGGER_LEVEL', 'info'),
    prettyPrint: parseBoolean(optionalEnv('LOGGER_PRETTY_PRINT', 'true')),
    toConsole: parseBoolean(optionalEnv('LOGGER_TO_CONSOLE', 'true')),
    toFile: parseBoolean(optionalEnv('LOGGER_TO_FILE', 'false')),
    excludePaths: parseCsv(
        optionalEnv('LOGGER_EXCLUDE_PATHS', '/api/docs,/health'),
    ),
    sensitiveFields: parseCsv(
        optionalEnv(
            'LOGGER_SENSITIVE_FIELDS',
            'password,token,refreshToken,accessToken,authorization,cookie,secret,secretKey,apiKey',
        ),
    ),
    loki: {
        url: optionalEnv('LOGGER_LOKI_URL', ''),
        batching: {
            interval: Number(optionalEnv('LOGGER_LOKI_INTERVAL', '5')),
            maxBufferSize: Number(
                optionalEnv('LOGGER_LOKI_MAX_BUFFER_SIZE', '1000'),
            ),
        },
        basicAuth: {
            username: optionalEnv('LOGGER_LOKI_AUTH_USERNAME'),
            password: optionalEnv('LOGGER_LOKI_AUTH_PASSWORD'),
        },
    },
}));

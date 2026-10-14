import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface LoggerConfig {
    serviceName: string;
    dir: string;
    level: string;
    prettyPrint: boolean;
    toConsole: boolean;
    toFile: boolean;
    excludePaths: string[];
    sensitiveFields: string[];
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
}));

import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface RumConfig {
    maxAppsPerProject: number;
    appRequestsPerMinute: number;
    sourceRequestsPerMinute: number;
    errorRetentionDays: number;
}

function positiveInteger(key: string, fallback: string): number {
    const value = Number.parseInt(optionalEnv(key, fallback), 10);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${key} must be a positive integer`);
    }
    return value;
}

export const rumConfig = registerAs('rum', (): RumConfig => ({
    maxAppsPerProject: positiveInteger('RUM_MAX_APPS_PER_PROJECT', '20'),
    appRequestsPerMinute: positiveInteger('RUM_APP_REQUESTS_PER_MINUTE', '600'),
    sourceRequestsPerMinute: positiveInteger(
        'RUM_SOURCE_REQUESTS_PER_MINUTE',
        '120',
    ),
    errorRetentionDays: positiveInteger('RUM_ERROR_RETENTION_DAYS', '90'),
}));

import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface MonitorRuntimeConfig {
    secretKey: string;
    dockerSocketPath: string;
    dockerSocketOrganizationIds: string[];
}

export const monitorConfig = registerAs(
    'monitor',
    (): MonitorRuntimeConfig => ({
        secretKey: optionalEnv('MONITOR_SECRET_KEY', ''),
        dockerSocketPath: optionalEnv('MONITOR_DOCKER_SOCKET_PATH', ''),
        dockerSocketOrganizationIds: optionalEnv(
            'MONITOR_DOCKER_SOCKET_ORGANIZATION_IDS',
            '',
        )
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
    }),
);

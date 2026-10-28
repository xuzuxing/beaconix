import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface MonitorRuntimeConfig {
    secretKey: string;
    dockerSocketPath: string;
    dockerSocketOrganizationIds: string[];
    /**
     * Lets the **local** checker reach private/reserved addresses. Probes are
     * unaffected (they monitor whatever their own network allows). Keep it false
     * on SaaS: the local executor must not become an internal network scanner.
     * The checker reads the same variable in `checkers/network-guard.ts`.
     */
    allowPrivateTargets: boolean;
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
        allowPrivateTargets: ['true', '1', 'yes'].includes(
            optionalEnv('MONITOR_ALLOW_PRIVATE_TARGETS', '')
                .trim()
                .toLowerCase(),
        ),
    }),
);

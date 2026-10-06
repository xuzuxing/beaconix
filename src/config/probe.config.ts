import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface ProbeConfig {
    /**
     * A probe that has not called in for this long is treated as offline.
     * Probes that report their own heartbeat interval get `3 x interval` when
     * that is longer, so a slow probe is not flipped offline between two beats.
     */
    offlineAfterSeconds: number;
}

/** Probes are considered offline after this multiple of their reported interval. */
export const PROBE_OFFLINE_INTERVAL_FACTOR = 3;

const DEFAULT_OFFLINE_AFTER_SECONDS = 180;

export const probeConfig = registerAs('probe', (): ProbeConfig => {
    const parsed = parseInt(
        optionalEnv(
            'PROBE_OFFLINE_AFTER_SECONDS',
            `${DEFAULT_OFFLINE_AFTER_SECONDS}`,
        ),
        10,
    );

    return {
        offlineAfterSeconds:
            Number.isFinite(parsed) && parsed > 0
                ? parsed
                : DEFAULT_OFFLINE_AFTER_SECONDS,
    };
});

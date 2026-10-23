import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

/**
 * Defaults for the addresses this deployment hands out to probes and operators.
 *
 * They are only the last link in the chain: an overridden value in
 * `settings` (`probe.endpoint.*`, editable in the admin console) wins, then the
 * matching `BEACON_*` environment variable, then these constants. A probe
 * installed with a wrong address restart-loops on the "Insecure API URL" /
 * DNS failure path, so every consumer must read them from here instead of
 * hard-coding one.
 */
export const DEFAULT_PROBE_ACTIVATE_URL = 'https://beaconix.app/activate';
export const DEFAULT_PROBE_PUBLIC_API_URL = 'https://beaconix.app/api';
export const DEFAULT_PROBE_INSTALL_URL = 'https://get.beaconix.app/install.sh';

export interface ProbeEndpoints {
    /** Confirmation page printed by `beaconix-probe login` (CLI appends `?code=`). */
    activateUrl: string;
    /** API base returned in install commands and probe credentials. */
    publicApiUrl: string;
    /** Installer referenced by the one-line install command. */
    installUrl: string;
}

interface EndpointDefinition {
    settingKey: string;
    envKey: string;
    fallback: string;
}

/**
 * The three addresses this deployment hands out, in the order they are resolved:
 * the admin console value (`probe.endpoint.*`), then the matching `BEACON_*`
 * environment variable, then the built-in production default below.
 */
const ENDPOINTS = {
    activateUrl: {
        settingKey: 'probe.endpoint.activateUrl',
        envKey: 'BEACON_ACTIVATE_URL',
        fallback: DEFAULT_PROBE_ACTIVATE_URL,
    },
    publicApiUrl: {
        settingKey: 'probe.endpoint.publicApiUrl',
        envKey: 'BEACON_PUBLIC_API_URL',
        fallback: DEFAULT_PROBE_PUBLIC_API_URL,
    },
    // The installer is published at the bucket root, next to (not inside) the
    // `/probe` download base, so it needs its own entry point.
    // See probes/RELEASE.md §5.
    installUrl: {
        settingKey: 'probe.endpoint.installUrl',
        envKey: 'BEACON_INSTALL_URL',
        fallback: DEFAULT_PROBE_INSTALL_URL,
    },
} as const satisfies Record<keyof ProbeEndpoints, EndpointDefinition>;

@Injectable()
export class ProbeEndpointsService {
    constructor(private readonly settings: SettingsService) {}

    async getEndpoints(): Promise<ProbeEndpoints> {
        const [activateUrl, publicApiUrl, installUrl] = await Promise.all([
            this.resolve(ENDPOINTS.activateUrl),
            this.resolve(ENDPOINTS.publicApiUrl),
            this.resolve(ENDPOINTS.installUrl),
        ]);

        return { activateUrl, publicApiUrl, installUrl };
    }

    activationUrl(): Promise<string> {
        return this.resolve(ENDPOINTS.activateUrl);
    }

    publicApiUrl(): Promise<string> {
        return this.resolve(ENDPOINTS.publicApiUrl);
    }

    installScriptUrl(): Promise<string> {
        return this.resolve(ENDPOINTS.installUrl);
    }

    /**
     * `getOverriddenValue` only reports values an operator actually saved, so a
     * seeded default row never shadows the environment variable. Blank strings
     * count as "not set" — a cleared field should fall through, not produce an
     * empty URL.
     */
    private async resolve(definition: EndpointDefinition): Promise<string> {
        const overridden = await this.settings.getOverriddenValue(
            definition.settingKey,
        );
        const fromSetting =
            typeof overridden === 'string' ? overridden.trim() : '';
        const fromEnv = (process.env[definition.envKey] ?? '').trim();
        const url = fromSetting || fromEnv || definition.fallback;

        // Trailing slashes would yield `https://host/api//probes/...` and
        // `.../activate/?code=`, so normalise once here.
        return url.replace(/\/+$/, '');
    }
}

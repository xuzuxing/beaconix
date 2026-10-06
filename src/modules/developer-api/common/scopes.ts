/** Scopes a programmatic credential can be limited to. */
export const API_SCOPES = [
    'monitors:read',
    'monitors:write',
    'probes:read',
    'probes:write',
    'status-pages:read',
    'status-pages:write',
    'monitoring:read',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
    return (API_SCOPES as readonly string[]).includes(value);
}

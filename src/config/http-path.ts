/** Shared by app configuration and the deployment renderer. Empty means root. */
export function normalizeGlobalPrefix(value: string): string {
    const prefix = value.trim().replace(/^\/+|\/+$/g, '');
    if (!prefix) return '';
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) {
        throw new Error('GLOBAL_PREFIX must contain URL path segments only');
    }
    return `/${prefix}`;
}

export function httpPath(prefix: string, path: string): string {
    return `${normalizeGlobalPrefix(prefix)}/${path.replace(/^\/+/, '')}`;
}

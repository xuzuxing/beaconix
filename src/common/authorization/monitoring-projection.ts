import type { ProjectRole } from '../../generated/prisma/enums';

const secrets =
    /password|secret|credential|authorization|cookie|tlsKey|privateKey|token|webhook/i;
const restricted = new Set([
    'config',
    'headers',
    'requestHeaders',
    'responseHeaders',
    'body',
    'requestBody',
    'responseBody',
    'details',
    'notificationChannelIds',
    'probeResults',
    'executions',
    'tree',
    'bodyContains',
]);

export function sanitizeMonitoringTarget(target: string): string {
    try {
        const url = new URL(target);
        if (!url.username && !url.password && !url.search && !url.hash)
            return target;
        url.username = '';
        url.password = '';
        // Target query values can carry credentials under arbitrary names.
        for (const key of new Set(url.searchParams.keys())) {
            url.searchParams.set(key, '[REDACTED]');
        }
        url.hash = '';
        return url.toString();
    } catch {
        return /[?@#]/.test(target) ? '[REDACTED]' : target;
    }
}

export function sanitizeMonitoringDiagnostic(text: string): string {
    let ambiguous = false;
    const sanitized = text.replace(
        /\b[a-z][a-z\d+.-]*:\/\/[^\s"<>]+/gi,
        (target) => {
            try {
                // Apostrophes are valid URI characters, including in userinfo.
                new URL(target);
                return sanitizeMonitoringTarget(target);
            } catch {
                ambiguous = true;
                return '[REDACTED]';
            }
        },
    );
    return ambiguous ? '[REDACTED]' : sanitized;
}

// Projection always makes a copy, so a lower-role response cannot mutate L1/L2.
export function monitoringProjection<T>(value: T, role: ProjectRole): T {
    if (typeof value === 'string')
        return sanitizeMonitoringDiagnostic(value) as T;
    if (value === null || value === undefined || typeof value !== 'object')
        return value;
    if (value instanceof Date) return value;
    if (Array.isArray(value))
        return value.map((item) => monitoringProjection(item, role)) as T;
    return Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
            if (secrets.test(key)) return [];
            if (role !== 'ADMIN' && restricted.has(key)) return [];
            if (
                role !== 'ADMIN' &&
                ['target', 'lastError', 'error', 'message'].includes(key)
            ) {
                return [[key, item === null ? null : '[REDACTED]']];
            }
            if (key === 'target' && typeof item === 'string') {
                return [[key, sanitizeMonitoringTarget(item)]];
            }
            return [[key, monitoringProjection(item, role)]];
        }),
    ) as T;
}

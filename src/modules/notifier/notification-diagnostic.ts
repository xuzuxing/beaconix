import { sanitizeMonitoringDiagnostic } from '../../common/authorization/monitoring-projection';

/** Channel errors are persisted and returned to users; remote echoes are untrusted. */
export function notificationDiagnostic(
    error: unknown,
    config: unknown,
): string {
    const values = new Set<string>();
    function collect(value: unknown) {
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
            if (
                typeof item === 'string' &&
                /secret|token|password|webhook|authorization|api.?key|private.?key/i.test(
                    key,
                )
            ) {
                if (item) values.add(item);
                if (item.trim()) values.add(item.trim());
                if (/webhook/i.test(key) && URL.canParse(item)) {
                    const url = new URL(item);
                    // Bot credentials may live in the path or under arbitrary query keys.
                    for (const part of url.searchParams.values())
                        if (part) values.add(part);
                    const hook = /\/hook\/([^/]+)/i.exec(url.pathname)?.[1];
                    if (hook) {
                        values.add(hook);
                        try {
                            values.add(decodeURIComponent(hook));
                        } catch {
                            /* Keep the raw invalid escape redacted. */
                        }
                    }
                }
            } else collect(item);
        }
    }
    collect(config);
    let text = error instanceof Error ? error.message : String(error);
    const encoded = [...values]
        .flatMap((value) => {
            try {
                return [value, encodeURIComponent(value)];
            } catch {
                return [value];
            }
        })
        .sort((a, b) => b.length - a.length);
    for (const value of encoded) text = text.split(value).join('[REDACTED]');
    return sanitizeMonitoringDiagnostic(text).slice(0, 500);
}

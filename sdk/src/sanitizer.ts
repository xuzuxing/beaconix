const SECRET_ASSIGNMENT =
    /((?:password|passwd|token|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SENSITIVE_KEY =
    /(?:password|passwd|token|authorization|cookie|secret|api[_-]?key|credit|card|cvv|session)/i;

export function sanitizeText(value: unknown, maxLength = 2000): string {
    return String(value ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
        .replace(JWT_TOKEN, '[REDACTED_JWT]')
        .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
        .trim()
        .slice(0, maxLength);
}

export function stripUrl(value: string, base?: string): string {
    if (!value) return '';
    if (/^(?:data|javascript|blob):/i.test(value.trim())) return '[REDACTED]';
    try {
        const url = new URL(value, base ?? browserBase());
        return `${url.origin}${url.pathname}`.slice(0, 2048);
    } catch {
        return sanitizeText(value.split(/[?#]/, 1)[0], 2048);
    }
}

export function sanitizeRecord(
    value: unknown,
    depth = 0,
): string | number | boolean | null | object | unknown[] {
    if (depth > 4) return '[TRUNCATED]';
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return sanitizeText(value, 1000);
    if (value instanceof Error) {
        return {
            name: sanitizeText(value.name, 100),
            message: sanitizeText(value.message, 1000),
        };
    }
    if (Array.isArray(value)) {
        return value
            .slice(0, 20)
            .map((item) => sanitizeRecord(item, depth + 1));
    }
    if (typeof value !== 'object') return null;
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 20)) {
        const cleanKey = sanitizeText(key, 100);
        if (!cleanKey) continue;
        if (SENSITIVE_KEY.test(cleanKey)) {
            result[cleanKey] = '[REDACTED]';
        } else if (
            typeof nested === 'string' &&
            /^(?:page|url|href|location)$/i.test(cleanKey)
        ) {
            result[cleanKey] = stripUrl(nested);
        } else {
            result[cleanKey] = sanitizeRecord(nested, depth + 1);
        }
    }
    return result;
}

export function serializeConsoleArguments(args: unknown[]): unknown[] {
    return args.slice(0, 10).map((argument) => sanitizeRecord(argument));
}

export function targetSelector(
    target: EventTarget | Node | null,
): string | null {
    if (typeof Element === 'undefined' || !(target instanceof Element))
        return null;
    const id = target.id ? `#${safeSelector(target.id)}` : '';
    const classes = Array.from(target.classList)
        .slice(0, 3)
        .map((value) => `.${safeSelector(value)}`)
        .join('');
    return `${target.tagName.toLowerCase()}${id}${classes}`.slice(0, 300);
}

export function sanitizeStyle(value: string): string {
    return value.replace(/url\((['"]?)(.*?)\1\)/gi, (_match, quote, url) => {
        return `url(${quote}${stripUrl(String(url))}${quote})`;
    });
}

export function utf8Size(value: string): number {
    if (typeof TextEncoder !== 'undefined')
        return new TextEncoder().encode(value).length;
    if (typeof Blob !== 'undefined') return new Blob([value]).size;
    return value.length;
}

function browserBase(): string {
    return typeof window === 'undefined'
        ? 'https://rum.invalid/'
        : window.location.href;
}

function safeSelector(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

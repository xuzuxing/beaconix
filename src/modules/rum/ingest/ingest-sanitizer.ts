import type { ReportRumErrorDto, RumErrorCategoryValue } from '../dto';

const SECRET_ASSIGNMENT =
    /((?:password|passwd|token|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

function removeControlCharacters(value: string): string {
    return Array.from(value)
        .filter((character) => {
            const code = character.charCodeAt(0);
            return (
                code === 9 ||
                code === 10 ||
                code === 13 ||
                (code >= 32 && code !== 127)
            );
        })
        .join('');
}

export function sanitizeRumText(value: string, maxLength: number): string {
    return removeControlCharacters(value)
        .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
        .replace(JWT_TOKEN, '[REDACTED_JWT]')
        .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
        .trim()
        .slice(0, maxLength);
}

export function sanitizeRumPage(value?: string): string | null {
    if (!value) return null;
    const clean = sanitizeRumText(value, 2048);
    try {
        const absolute = new URL(clean);
        return `${absolute.origin}${absolute.pathname}`.slice(0, 2048);
    } catch {
        const path = clean.split(/[?#]/, 1)[0];
        return path ? path.slice(0, 2048) : null;
    }
}

const SENSITIVE_KEY =
    /(?:password|passwd|token|authorization|cookie|secret|api[_-]?key|credit|card|cvv|session)/i;

export function sanitizeRumJson(
    value: unknown,
    depth = 0,
): string | number | boolean | null | object | unknown[] {
    if (depth > 6) return '[TRUNCATED]';
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return sanitizeRumText(value, 2000);
    if (Array.isArray(value))
        return value
            .slice(0, 100)
            .map((item) => sanitizeRumJson(item, depth + 1));
    if (typeof value !== 'object') return null;
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 50)) {
        const cleanKey = sanitizeRumText(key, 100);
        if (!cleanKey) continue;
        if (SENSITIVE_KEY.test(cleanKey)) {
            result[cleanKey] = '[REDACTED]';
            continue;
        }
        if (
            typeof nested === 'string' &&
            /^(?:page|url|href|location)$/i.test(cleanKey)
        ) {
            result[cleanKey] = sanitizeRumPage(nested);
            continue;
        }
        result[cleanKey] = sanitizeRumJson(nested, depth + 1);
    }
    return result;
}

export function sanitizeRumError(dto: ReportRumErrorDto) {
    const category = inferRumErrorCategory(dto.category, dto.type);
    const level = dto.level ?? 'ERROR';
    const requestId = dto.requestId
        ? sanitizeRumText(dto.requestId, 200)
        : dto.http?.requestId
          ? sanitizeRumText(dto.http.requestId, 200)
          : null;
    return {
        schemaVersion: dto.schemaVersion ?? 1,
        clientEventId: dto.clientEventId
            ? sanitizeRumText(dto.clientEventId, 100)
            : null,
        category,
        level,
        type: sanitizeRumText(dto.type, 100),
        message: sanitizeRumText(dto.message, 2000),
        stack: dto.stack ? sanitizeRumText(dto.stack, 16000) : null,
        page: sanitizeRumPage(dto.page),
        release: dto.release ? sanitizeRumText(dto.release, 100) : null,
        sessionId: dto.sessionId ? sanitizeRumText(dto.sessionId, 100) : null,
        endUserId: dto.userId ? sanitizeRumText(dto.userId, 200) : null,
        anonymousId: dto.anonymousId
            ? sanitizeRumText(dto.anonymousId, 200)
            : null,
        requestId,
        http: dto.http
            ? {
                  ...(dto.http.method
                      ? {
                            method: sanitizeRumText(
                                dto.http.method.toUpperCase(),
                                20,
                            ),
                        }
                      : {}),
                  ...(dto.http.url
                      ? { url: sanitizeRumPage(dto.http.url) }
                      : {}),
                  ...(dto.http.status !== undefined
                      ? { status: dto.http.status }
                      : {}),
                  ...(dto.http.durationMs !== undefined
                      ? { durationMs: dto.http.durationMs }
                      : {}),
                  ...(requestId ? { requestId } : {}),
                  ...(dto.http.failureKind
                      ? {
                            failureKind: sanitizeRumText(
                                dto.http.failureKind,
                                50,
                            ),
                        }
                      : {}),
              }
            : null,
        resource: dto.resource
            ? {
                  ...(dto.resource.tagName
                      ? {
                            tagName: sanitizeRumText(
                                dto.resource.tagName.toLowerCase(),
                                50,
                            ),
                        }
                      : {}),
                  ...(dto.resource.url
                      ? { url: sanitizeRumPage(dto.resource.url) }
                      : {}),
              }
            : null,
        vue: dto.vue
            ? {
                  ...(dto.vue.componentName
                      ? {
                            componentName: sanitizeRumText(
                                dto.vue.componentName,
                                200,
                            ),
                        }
                      : {}),
                  ...(dto.vue.info
                      ? { info: sanitizeRumText(dto.vue.info, 500) }
                      : {}),
              }
            : null,
        breadcrumbs: (dto.breadcrumbs ?? []).map((breadcrumb) => ({
            type: sanitizeRumText(breadcrumb.type, 50),
            ...(breadcrumb.category
                ? {
                      category: sanitizeRumText(breadcrumb.category, 50),
                  }
                : {}),
            ...(breadcrumb.level ? { level: breadcrumb.level } : {}),
            occurredAt: new Date(breadcrumb.occurredAt).toISOString(),
            ...(breadcrumb.data
                ? { data: sanitizeRumJson(breadcrumb.data) }
                : {}),
        })),
        sdk: dto.sdk
            ? {
                  ...(dto.sdk.name
                      ? { name: sanitizeRumText(dto.sdk.name, 100) }
                      : {}),
                  ...(dto.sdk.version
                      ? { version: sanitizeRumText(dto.sdk.version, 50) }
                      : {}),
              }
            : null,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : null,
    };
}

function inferRumErrorCategory(
    category: RumErrorCategoryValue | undefined,
    type: string,
): RumErrorCategoryValue {
    if (category) return category;
    return /unhandledrejection|promise/i.test(type) ? 'PROMISE' : 'JAVASCRIPT';
}

export function rumErrorContextSize(
    error: ReturnType<typeof sanitizeRumError>,
): number {
    return Buffer.byteLength(
        JSON.stringify({
            http: error.http,
            resource: error.resource,
            vue: error.vue,
            breadcrumbs: error.breadcrumbs,
            sdk: error.sdk,
        }),
        'utf8',
    );
}

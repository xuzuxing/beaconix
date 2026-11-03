import type { ReportRumErrorDto } from '../dto';

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

function sanitizeText(value: string, maxLength: number): string {
    return removeControlCharacters(value)
        .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
        .replace(JWT_TOKEN, '[REDACTED_JWT]')
        .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
        .trim()
        .slice(0, maxLength);
}

function sanitizePage(value?: string): string | null {
    if (!value) return null;
    const clean = sanitizeText(value, 2048);
    try {
        const absolute = new URL(clean);
        return `${absolute.origin}${absolute.pathname}`.slice(0, 2048);
    } catch {
        const path = clean.split(/[?#]/, 1)[0];
        return path ? path.slice(0, 2048) : null;
    }
}

export function sanitizeRumError(dto: ReportRumErrorDto) {
    return {
        type: sanitizeText(dto.type, 100),
        message: sanitizeText(dto.message, 2000),
        stack: dto.stack ? sanitizeText(dto.stack, 16000) : null,
        page: sanitizePage(dto.page),
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : null,
    };
}

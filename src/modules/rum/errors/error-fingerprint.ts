import { createHash } from 'node:crypto';
import type { RumErrorCategoryValue } from '../dto';

export const RUM_FINGERPRINT_VERSION = 2;

export interface RumErrorFingerprintInput {
    category: RumErrorCategoryValue;
    type: string;
    message: string;
    stack?: string | null;
    http?: Record<string, unknown> | null;
    resource?: Record<string, unknown> | null;
}

export function createRumErrorFingerprint(
    appId: string,
    error: RumErrorFingerprintInput,
): string {
    const signature = createSignature(error);
    return createHash('sha256')
        .update(
            `${RUM_FINGERPRINT_VERSION}\u0000${appId}\u0000${error.category}\u0000${signature}`,
        )
        .digest('hex');
}

function createSignature(error: RumErrorFingerprintInput): string {
    if (error.category === 'HTTP') {
        return [
            stringValue(error.http?.method).toUpperCase(),
            normalizeUrl(stringValue(error.http?.url)),
            stringValue(error.http?.status),
        ].join('\u0000');
    }
    if (error.category === 'RESOURCE') {
        return [
            stringValue(error.resource?.tagName).toLowerCase(),
            normalizeUrl(stringValue(error.resource?.url)),
        ].join('\u0000');
    }
    const topFrame = normalizeTopFrame(error.stack);
    return [error.type, topFrame || normalizeMessage(error.message)].join(
        '\u0000',
    );
}

function normalizeTopFrame(stack?: string | null): string {
    if (!stack) return '';
    const frame = stack
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /(?:https?:\/\/|\/|\\).+:\d+:\d+/.test(line));
    if (!frame) return '';
    return frame
        .replace(/[?#].*?(?=:\d+:\d+|$)/g, '')
        .replace(/:\d+:\d+(\)?)$/, ':?:?$1')
        .slice(0, 1000);
}

function normalizeMessage(message: string): string {
    return message
        .replace(/\b\d{2,}\b/g, '#')
        .replace(/[A-Fa-f0-9]{16,}/g, '<id>')
        .trim()
        .slice(0, 1000);
}

function normalizeUrl(value: string): string {
    if (!value) return '';
    try {
        const url = new URL(value, 'https://rum.invalid');
        return url.pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
    } catch {
        return value.split(/[?#]/, 1)[0].replace(/\/\d+(?=\/|$)/g, '/:id');
    }
}

function stringValue(value: unknown): string {
    if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        typeof value === 'bigint'
    ) {
        return String(value);
    }
    return '';
}

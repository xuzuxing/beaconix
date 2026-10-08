import { extname } from 'node:path';

const FALLBACK_FILENAME = 'attachment';

export function sanitizeFilename(filename: string): string {
    const cleaned = filename
        .normalize('NFKC')
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/./g, (char) => (char.charCodeAt(0) < 32 ? '-' : char))
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned || FALLBACK_FILENAME;
}

export function buildObjectKey(input: {
    organizationId: string;
    taskId: string;
    objectId: string;
    filename: string;
    now?: Date;
}): string {
    const now = input.now ?? new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const finalName = buildFinalName(input.objectId, input.filename);

    return [
        'organizations',
        input.organizationId,
        'tasks',
        input.taskId,
        year,
        month,
        finalName,
    ].join('/');
}

export function normalizeUploadDirectory(
    directory: string | undefined,
    fallback: string,
): string {
    const normalizedFallback = normalizeDirectory(fallback);
    if (!directory) return normalizedFallback;

    return normalizeDirectory(directory) || normalizedFallback;
}

export function buildPublicObjectKey(input: {
    userId: string;
    directory?: string;
    objectId: string;
    filename: string;
    now?: Date;
}): string {
    const now = input.now ?? new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const directory = normalizeUploadDirectory(
        input.directory,
        `users/${input.userId}`,
    );
    const finalName = buildFinalName(input.objectId, input.filename);

    return [directory, year, month, finalName].join('/');
}

export function normalizeUserUploadDirectory(
    userId: string,
    directory?: string,
): string {
    return normalizeUploadDirectory(directory, `users/${userId}`);
}

export function isPublicUploadKey(key: string): boolean {
    const segments = key.split('/');
    return (
        key.length > 0 &&
        !key.includes('\\') &&
        !segments.includes('..') &&
        !key.startsWith('organizations/')
    );
}

function normalizeDirectory(directory: string): string {
    return directory
        .normalize('NFKC')
        .split(/[\\/]+/)
        .map((segment) =>
            segment
                .replace(/[:*?"<>|]/g, '-')
                .replace(/./g, (char) => (char.charCodeAt(0) < 32 ? '-' : char))
                .replace(/\s+/g, '-')
                .replace(/[^\p{L}\p{N}._-]/gu, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 64),
        )
        .filter((segment) => segment && segment !== '.' && segment !== '..')
        .slice(0, 6)
        .join('/');
}

function buildFinalName(objectId: string, filename: string): string {
    const safeFilename = sanitizeFilename(filename);
    const extension = extname(safeFilename);
    const basename = extension
        ? safeFilename.slice(0, -extension.length)
        : safeFilename;
    const compactName = basename
        .replace(/[^\p{L}\p{N}._ -]/gu, '-')
        .slice(0, 80)
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    return `${objectId}-${compactName || FALLBACK_FILENAME}${extension}`;
}

import { extname } from 'node:path';

const FALLBACK_FILENAME = 'attachment';

/**
 * Directory layout.
 *
 * Keys carry the split; the root on disk (or the bucket) does not. Every key
 * lives in exactly one of two spaces:
 *
 *   public  root →  avatars/…, uploads/…  (also any other safe custom directory)
 *   private root →  attachments/…, tickets/…, temp/…
 *
 * The first segment decides which, so a key alone is enough to route a read,
 * a write or a delete — the caller no longer has to pass `visibility` into the
 * storage layer and get it right every time.
 */
export const AVATARS_DIRECTORY = 'avatars';
export const UPLOADS_DIRECTORY = 'uploads';
export const ATTACHMENTS_DIRECTORY = 'attachments';
export const TICKETS_DIRECTORY = 'tickets';
export const TEMP_DIRECTORY = 'temp';

/** Tenant-first prefix task attachments used before the split. */
const LEGACY_PRIVATE_DIRECTORY = 'organizations';

/** First path segments that only ever resolve to the private root. */
const PRIVATE_DIRECTORIES = new Set([
    ATTACHMENTS_DIRECTORY,
    TICKETS_DIRECTORY,
    TEMP_DIRECTORY,
    LEGACY_PRIVATE_DIRECTORY,
]);

export function sanitizeFilename(filename: string): string {
    const cleaned = filename
        .normalize('NFKC')
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/./g, (char) => (char.charCodeAt(0) < 32 ? '-' : char))
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned || FALLBACK_FILENAME;
}

/**
 * Key for a private object.
 *
 * A task attachment is tenant-scoped: `attachments/<org>/<task>/yyyy/mm/…`.
 * Anything private that belongs to no task yet (a ticket upload still waiting
 * to be claimed) is filed under its own directory, `tickets/yyyy/mm/…`.
 */
export function buildPrivateObjectKey(input: {
    organizationId?: string | null;
    taskId?: string | null;
    directory?: string;
    objectId: string;
    filename: string;
    now?: Date;
}): string {
    const now = input.now ?? new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const finalName = buildFinalName(input.objectId, input.filename);
    const base =
        input.organizationId && input.taskId
            ? [ATTACHMENTS_DIRECTORY, input.organizationId, input.taskId].join(
                  '/',
              )
            : normalizeUploadDirectory(input.directory, TICKETS_DIRECTORY);

    return [base, year, month, finalName].join('/');
}

/** Key for a public object: `<directory>/yyyy/mm/<uuid>-<name>`. */
export function buildPublicObjectKey(input: {
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
        UPLOADS_DIRECTORY,
    );
    const finalName = buildFinalName(input.objectId, input.filename);

    return [directory, year, month, finalName].join('/');
}

export function normalizeUploadDirectory(
    directory: string | undefined,
    fallback: string,
): string {
    const normalizedFallback = normalizeDirectory(fallback);
    if (!directory) return normalizedFallback;

    return normalizeDirectory(directory) || normalizedFallback;
}

/** True when `name` (or a key's first segment) belongs to the private space. */
export function isPrivateDirectory(name: string): boolean {
    return PRIVATE_DIRECTORIES.has(name.split('/')[0]?.toLowerCase() ?? '');
}

/** True when a key resolves to the private root. */
export function isPrivateObjectKey(key: string): boolean {
    return isPrivateDirectory(key);
}

/**
 * True when a key may be published: a well-formed key outside every private
 * directory. Custom directories (`teams/`, `openchoreo/`) stay allowed, which
 * is what keeps existing callers working.
 */
export function isPublicUploadKey(key: string): boolean {
    const segments = key.split('/');
    return (
        key.length > 0 &&
        !key.includes('\\') &&
        !key.includes('%') &&
        !key.startsWith('/') &&
        !key.includes(':') &&
        !segments.includes('.') &&
        !segments.includes('') &&
        !segments.includes('..') &&
        !isPrivateObjectKey(key)
    );
}

export function isTaskUploadKey(
    key: string,
    organizationId: string,
    taskId: string,
): boolean {
    return (
        key.startsWith(
            `${ATTACHMENTS_DIRECTORY}/${organizationId}/${taskId}/`,
        ) &&
        !/[\\%:]/.test(key) &&
        key
            .split('/')
            .every(
                (segment) => !!segment && segment !== '.' && segment !== '..',
            )
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

    const safeExtension = extension.replace(/[^\p{L}\p{N}._-]/gu, '-');
    return `${objectId}-${compactName || FALLBACK_FILENAME}${safeExtension}`;
}

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
    const safeFilename = sanitizeFilename(input.filename);
    const extension = extname(safeFilename);
    const basename = extension
        ? safeFilename.slice(0, -extension.length)
        : safeFilename;
    const compactName = basename
        .replace(/[^a-zA-Z0-9._ -\u4e00-\u9fa5]/g, '-')
        .slice(0, 80)
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    const finalName = `${input.objectId}-${compactName || FALLBACK_FILENAME}${extension}`;

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

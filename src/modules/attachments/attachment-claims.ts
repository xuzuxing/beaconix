import type { Prisma } from '../../generated/prisma/client';
import { PUBLIC_STATIC_PREFIX } from '../../config';
import { isPublicUploadKey } from './storage/filename.util';

/**
 * Claims the upload rows behind URLs a business flow just persisted.
 *
 * A general upload lands in `attachments` with no host, and the nightly
 * cleanup treats an unhosted row older than a day as garbage. That rule is
 * right for an abandoned ticket form, but wrong for an avatar, an organization
 * logo or a brand image: nothing ever points a `taskId` / `ticketId` at them,
 * so the row looked abandoned and the file behind a live URL was deleted 24
 * hours after upload.
 *
 * Every flow that stores such a URL therefore reports it here. `claimedAt` is
 * the durable "in use" mark, and the cleanup skips claimed rows.
 */

/** Only the delegate methods the claim needs — any Prisma client accepts it. */
export interface ClaimDb {
    attachment: Pick<
        Prisma.TransactionClient['attachment'],
        'findMany' | 'updateMany'
    >;
}

/**
 * Storage key a persisted URL points at, when it points into our own storage.
 *
 * Two link shapes reach the database: the public static mount
 * (`/storage/public/avatars/2026/10/x.png`) and the object endpoint
 * (`/api/attachments/object?key=avatars%2F…`). A third-party URL (a WeChat
 * avatar, or a CDN address an OSS bucket handed back) yields `null` — there is
 * no local object to claim.
 */
export function objectKeyFromUrl(
    url: string | null | undefined,
): string | null {
    const trimmed = url?.trim();
    if (!trimmed) return null;

    const queryIndex = trimmed.indexOf('?');
    if (queryIndex !== -1) {
        const key = new URLSearchParams(trimmed.slice(queryIndex + 1)).get(
            'key',
        );
        if (key) return publicKey(key);
    }

    const path = (
        queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex)
    ).split('#')[0];
    const mount = `${PUBLIC_STATIC_PREFIX}/`;
    const mountIndex = path.indexOf(mount);
    if (mountIndex === -1) return null;

    const encoded = path.slice(mountIndex + mount.length);
    try {
        return publicKey(decodeURIComponent(encoded));
    } catch {
        return null;
    }
}

/**
 * Marks the rows behind `urls` as in use and returns how many it touched.
 *
 * Only public-space objects qualify: `tickets/` and `attachments/` keys belong
 * to a host that claims them itself, and a private file must never be kept
 * alive by a URL that merely resembles it. Rows already claimed, or already
 * hosted, are left alone.
 */
export async function claimPersistedObjects(
    db: ClaimDb,
    urls: ReadonlyArray<string | null | undefined>,
    now: Date = new Date(),
): Promise<number> {
    const candidates = [
        ...new Set(
            urls
                .map((url) => url?.trim())
                .filter((url): url is string => !!url),
        ),
    ];
    if (!candidates.length) return 0;

    const keys = [
        ...new Set(
            candidates
                .map(objectKeyFromUrl)
                .filter((key): key is string => !!key),
        ),
    ];

    const rows = await db.attachment.findMany({
        where: {
            claimedAt: null,
            taskId: null,
            ticketId: null,
            ticketReplyId: null,
            OR: [
                { url: { in: candidates } },
                // The same object may be referenced through another host or
                // link shape than the row stored, so match its key too.
                ...(keys.length ? [{ fileKey: { in: keys } }] : []),
            ],
        },
        select: { id: true, fileKey: true },
    });

    const ids = rows
        .filter((row) => !row.fileKey || isPublicUploadKey(row.fileKey))
        .map((row) => row.id);
    if (!ids.length) return 0;

    const { count } = await db.attachment.updateMany({
        where: { id: { in: ids }, claimedAt: null },
        data: { claimedAt: now },
    });
    return count;
}

function publicKey(key: string): string | null {
    const trimmed = key.trim();
    return isPublicUploadKey(trimmed) ? trimmed : null;
}

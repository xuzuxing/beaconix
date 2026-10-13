import { Prisma } from '../../generated/prisma/client';
import type { AccessPrincipal } from './access.types';

export type AccessDb = Prisma.TransactionClient;
export type ProjectLockMode = 'SHARE' | 'UPDATE' | 'NO KEY UPDATE';

export async function lockIdentities(
    tx: AccessDb,
    principals: AccessPrincipal[],
) {
    const users = principals
        .filter((principal) => principal.type === 'USER')
        .map((principal) => principal.userId);
    for (const id of [...new Set(users)].sort()) {
        await tx.$queryRaw`
            SELECT "id" FROM "users" WHERE "id" = ${id} FOR SHARE
        `;
    }
    const tokens = principals
        .filter((principal) => principal.type === 'USER')
        .flatMap((principal) => (principal.patId ? [principal.patId] : []));
    for (const id of [...new Set(tokens)].sort()) {
        await tx.$queryRaw`
            SELECT "id" FROM "personal_access_tokens" WHERE "id" = ${id} FOR SHARE
        `;
    }
    const keys = principals
        .filter((principal) => principal.type === 'API_KEY')
        .map((principal) => principal.keyId);
    for (const id of [...new Set(keys)].sort()) {
        await tx.$queryRaw`
            SELECT "id" FROM "api_keys" WHERE "id" = ${id} FOR SHARE
        `;
    }
}

export async function lockOrganization(
    tx: AccessDb,
    organizationId: string,
    mode: 'SHARE' | 'UPDATE' = 'SHARE',
) {
    await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "organizations" WHERE "id" = ${organizationId}
        ${mode === 'UPDATE' ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`}
    `);
}

export async function lockMemberships(
    tx: AccessDb,
    memberships: { id: string; update?: boolean }[],
) {
    const modes = new Map<string, boolean>();
    for (const membership of memberships) {
        modes.set(
            membership.id,
            !!membership.update || !!modes.get(membership.id),
        );
    }
    for (const id of [...modes.keys()].sort()) {
        await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "memberships" WHERE "id" = ${id}
            ${modes.get(id) ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`}
        `);
    }
}

export async function lockProjects(
    tx: AccessDb,
    projectIds: string[],
    mode: ProjectLockMode = 'SHARE',
) {
    const clause = {
        SHARE: Prisma.sql`FOR SHARE`,
        UPDATE: Prisma.sql`FOR UPDATE`,
        'NO KEY UPDATE': Prisma.sql`FOR NO KEY UPDATE`,
    }[mode];
    for (const id of [...new Set(projectIds)].sort()) {
        await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "projects" WHERE "id" = ${id} ${clause}
        `);
    }
}

export async function lockOrganizationMembers(
    tx: AccessDb,
    organizationId: string,
    userIds: string[],
    updatedUserIds: string[] = [],
    organizationMode: 'SHARE' | 'UPDATE' = 'SHARE',
) {
    await lockIdentities(
        tx,
        userIds.map((userId) => ({ type: 'USER', userId })),
    );
    await lockOrganization(tx, organizationId, organizationMode);
    const memberships = await tx.membership.findMany({
        where: { organizationId, userId: { in: userIds } },
        select: { id: true, userId: true },
    });
    await lockMemberships(
        tx,
        memberships.map((membership) => ({
            id: membership.id,
            update: updatedUserIds.includes(membership.userId),
        })),
    );
}

export async function retryAccessTransaction<T>(
    run: () => Promise<T>,
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await run();
        } catch (error) {
            const retryable =
                error instanceof Prisma.PrismaClientKnownRequestError &&
                (error.code === 'P2034' ||
                    (error.code === 'P2010' &&
                        ['40001', '40P01'].includes(String(error.meta?.code))));
            if (!retryable || attempt >= 2) throw error;
            await new Promise((resolve) =>
                setTimeout(resolve, 10 * (attempt + 1)),
            );
        }
    }
}

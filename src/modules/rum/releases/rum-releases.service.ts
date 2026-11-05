import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infra/database/prisma.service';

interface ReleaseErrorsRow {
    release: string | null;
    firstSeen: Date;
    lastSeen: Date;
    errorGroups: number;
    occurrences: number;
}

interface ReleaseEventsRow {
    release: string | null;
    firstSeen: Date;
    lastSeen: Date;
    events: number;
}

interface ReleaseReplaysRow {
    release: string | null;
    firstSeen: Date;
    lastSeen: Date;
    replays: number;
}

interface GroupIdRow {
    groupId: string;
}

interface TimestampRow {
    value: Date | null;
}

export interface RumReleaseSummary {
    release: string | null;
    isUnknown: boolean;
    firstSeenAt: Date | null;
    lastSeenAt: Date | null;
    errorGroups: number;
    occurrences: number;
    events: number;
    replays: number;
}

const RELEASE_GROUP_SELECT = {
    id: true,
    type: true,
    category: true,
    level: true,
    message: true,
    page: true,
    release: true,
    status: true,
    count: true,
    firstSeenAt: true,
    lastSeenAt: true,
} satisfies Prisma.RumErrorGroupSelect;

@Injectable()
export class RumReleasesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    async list(
        projectId: string,
        appId: string,
        principal: AccessPrincipal,
    ): Promise<{ items: RumReleaseSummary[]; total: number }> {
        await this.authorize(projectId, appId, principal);

        const [errorRows, eventRows, replayRows] = await Promise.all([
            this.prisma.$queryRaw<ReleaseErrorsRow[]>`
                SELECT "release",
                       MIN("receivedAt") AS "firstSeen",
                       MAX("receivedAt") AS "lastSeen",
                       COUNT(DISTINCT "groupId")::int AS "errorGroups",
                       COUNT(*)::int AS "occurrences"
                FROM "rum_error_occurrences"
                WHERE "appId" = ${appId}
                GROUP BY "release"
            `,
            this.prisma.$queryRaw<ReleaseEventsRow[]>`
                SELECT "release",
                       MIN("receivedAt") AS "firstSeen",
                       MAX("receivedAt") AS "lastSeen",
                       COUNT(*)::int AS "events"
                FROM "rum_events"
                WHERE "appId" = ${appId}
                GROUP BY "release"
            `,
            this.prisma.$queryRaw<ReleaseReplaysRow[]>`
                SELECT "release",
                       MIN("startedAt") AS "firstSeen",
                       MAX("lastSeenAt") AS "lastSeen",
                       COUNT(*)::int AS "replays"
                FROM "rum_replay_sessions"
                WHERE "appId" = ${appId}
                GROUP BY "release"
            `,
        ]);

        const summaries = new Map<string, RumReleaseSummary>();
        const upsert = (release: string | null): RumReleaseSummary => {
            const key = release ?? '';
            let summary = summaries.get(key);
            if (!summary) {
                summary = {
                    release,
                    isUnknown: release === null,
                    firstSeenAt: null,
                    lastSeenAt: null,
                    errorGroups: 0,
                    occurrences: 0,
                    events: 0,
                    replays: 0,
                };
                summaries.set(key, summary);
            }
            return summary;
        };
        const stretch = (
            summary: RumReleaseSummary,
            firstSeen: Date | null,
            lastSeen: Date | null,
        ) => {
            if (
                firstSeen &&
                (!summary.firstSeenAt || firstSeen < summary.firstSeenAt)
            )
                summary.firstSeenAt = firstSeen;
            if (
                lastSeen &&
                (!summary.lastSeenAt || lastSeen > summary.lastSeenAt)
            )
                summary.lastSeenAt = lastSeen;
        };

        for (const row of errorRows) {
            const summary = upsert(row.release);
            summary.errorGroups = Number(row.errorGroups ?? 0);
            summary.occurrences = Number(row.occurrences ?? 0);
            stretch(summary, row.firstSeen, row.lastSeen);
        }
        for (const row of eventRows) {
            const summary = upsert(row.release);
            summary.events = Number(row.events ?? 0);
            stretch(summary, row.firstSeen, row.lastSeen);
        }
        for (const row of replayRows) {
            const summary = upsert(row.release);
            summary.replays = Number(row.replays ?? 0);
            stretch(summary, row.firstSeen, row.lastSeen);
        }

        const items = [...summaries.values()].sort((a, b) => {
            if (!a.firstSeenAt) return 1;
            if (!b.firstSeenAt) return -1;
            return b.firstSeenAt.getTime() - a.firstSeenAt.getTime();
        });
        return { items, total: items.length };
    }

    async compare(
        projectId: string,
        appId: string,
        base: string | undefined,
        target: string | undefined,
        principal: AccessPrincipal,
    ) {
        if (base === undefined || target === undefined) {
            throw new BadRequestException(
                'base and target release are required (use an empty value for the unknown release)',
            );
        }
        if (base === target) {
            throw new BadRequestException('base and target must differ');
        }
        await this.authorize(projectId, appId, principal);

        const [baseGroups, targetGroups, baseStart, earlierGroups] =
            await Promise.all([
                this.groupIds(appId, base),
                this.groupIds(appId, target),
                this.releaseStart(appId, base),
                this.earlierGroupIds(appId, base),
            ]);

        const newIds = [...targetGroups].filter((id) => !baseGroups.has(id));
        const fixedIds = [...baseGroups].filter((id) => !targetGroups.has(id));
        const regressedIds = newIds.filter((id) => earlierGroups.has(id));

        const groups = await this.groups(appId, [
            ...new Set([...newIds, ...fixedIds, ...regressedIds]),
        ]);
        const byId = new Map(groups.map((group) => [group.id, group]));
        const pick = (ids: string[]) =>
            ids
                .map((id) => byId.get(id))
                .filter((group): group is (typeof groups)[number] => !!group);

        return {
            base: { release: this.releaseValue(base), isUnknown: base === '' },
            target: {
                release: this.releaseValue(target),
                isUnknown: target === '',
            },
            baseStartedAt: baseStart,
            new: pick(newIds),
            fixed: pick(fixedIds),
            regressed: pick(regressedIds),
            counts: {
                new: newIds.length,
                fixed: fixedIds.length,
                regressed: regressedIds.length,
            },
        };
    }

    private releaseValue(value: string): string | null {
        return value === '' ? null : value;
    }

    private async groupIds(
        appId: string,
        release: string,
    ): Promise<Set<string>> {
        const rows = await this.prisma.$queryRaw<GroupIdRow[]>`
            SELECT DISTINCT "groupId"
            FROM "rum_error_occurrences"
            WHERE "appId" = ${appId}
              AND COALESCE("release", '') = ${release}
        `;
        return new Set(rows.map((row) => row.groupId));
    }

    private async earlierGroupIds(
        appId: string,
        base: string,
    ): Promise<Set<string>> {
        const rows = await this.prisma.$queryRaw<GroupIdRow[]>`
            SELECT DISTINCT "groupId"
            FROM "rum_error_occurrences"
            WHERE "appId" = ${appId}
              AND COALESCE("release", '') <> ${base}
              AND "receivedAt" < COALESCE(
                  (SELECT MIN("receivedAt") FROM "rum_error_occurrences"
                   WHERE "appId" = ${appId}
                     AND COALESCE("release", '') = ${base}),
                  'infinity'::timestamp
              )
        `;
        return new Set(rows.map((row) => row.groupId));
    }

    private async releaseStart(
        appId: string,
        release: string,
    ): Promise<Date | null> {
        const rows = await this.prisma.$queryRaw<TimestampRow[]>`
            SELECT MIN("receivedAt") AS "value"
            FROM "rum_error_occurrences"
            WHERE "appId" = ${appId}
              AND COALESCE("release", '') = ${release}
        `;
        return rows[0]?.value ?? null;
    }

    private async groups(appId: string, ids: string[]) {
        if (!ids.length) return [];
        return this.prisma.rumErrorGroup.findMany({
            where: { appId, id: { in: ids } },
            select: RELEASE_GROUP_SELECT,
            orderBy: { lastSeenAt: 'desc' },
        });
    }

    private async authorize(
        projectId: string,
        appId: string,
        principal: AccessPrincipal,
    ): Promise<void> {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        const app = await this.prisma.rumApp.findFirst({
            where: {
                id: appId,
                organizationId: access.organizationId,
                projectId,
                deletedAt: null,
            },
            select: { id: true },
        });
        if (!app) throw new NotFoundException('RUM app not found');
    }
}

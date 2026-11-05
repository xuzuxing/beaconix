import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleInit,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import { Prisma } from '../../../generated/prisma/client';
import {
    RumMaintenanceJobStatus,
    RumMaintenanceJobType,
} from '../../../generated/prisma/enums';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import type { CreateRumSubjectDeletionDto } from '../dto';

const DELETE_BATCH_SIZE = 5000;
const MAX_BATCHES = 200;
const MAX_JOBS_PER_SWEEP = 5;

const PURGE_TABLES = [
    'rum_error_occurrences',
    'rum_error_groups',
    'rum_events',
    'rum_replay_sessions',
    'rum_metric_buckets',
    'rum_perf_samples',
    'rum_perf_buckets',
] as const;

interface SubjectDeletionPayload {
    endUserId?: string;
    anonymousId?: string;
}

export interface SubjectDeletionResult {
    occurrences: number;
    events: number;
    perfSamples: number;
    replaySessions: number;
    unlinkedRecords: number;
    aggregatesRetained: boolean;
}

@Injectable()
export class RumMaintenanceService implements OnModuleInit {
    private readonly logger = new Logger(RumMaintenanceService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
        private readonly registry: ScheduledJobRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.rumMaintenance,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.rumMaintenance],
            handler: () => this.processPending(),
        });
    }

    async requestPurge(
        projectId: string,
        appId: string,
        principal: AccessPrincipal,
    ) {
        return this.request(projectId, appId, principal, {
            type: RumMaintenanceJobType.PURGE,
        });
    }

    async requestSubjectDeletion(
        projectId: string,
        appId: string,
        dto: CreateRumSubjectDeletionDto,
        principal: AccessPrincipal,
    ) {
        const payload: SubjectDeletionPayload = {};
        if (dto.endUserId) payload.endUserId = dto.endUserId.trim();
        if (dto.anonymousId) payload.anonymousId = dto.anonymousId.trim();
        if (!payload.endUserId && !payload.anonymousId) {
            throw new BadRequestException(
                'endUserId or anonymousId is required',
            );
        }
        return this.request(projectId, appId, principal, {
            type: RumMaintenanceJobType.SUBJECT_DELETION,
            payload,
        });
    }

    async findJob(
        projectId: string,
        appId: string,
        jobId: string,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'rum.read',
        );
        await this.ensureApp(access.organizationId, projectId, appId);
        const job = await this.prisma.rumMaintenanceJob.findFirst({
            where: { id: jobId, appId },
        });
        if (!job) throw new NotFoundException('RUM maintenance job not found');
        return job;
    }

    /**
     * Claims and runs pending maintenance jobs. Each job is claimed with a
     * conditional update so replicas never execute the same job twice, and the
     * job row keeps the outcome queryable after the request returned.
     */
    async processPending(): Promise<void> {
        const pending = await this.prisma.rumMaintenanceJob.findMany({
            where: { status: RumMaintenanceJobStatus.PENDING },
            orderBy: { createdAt: 'asc' },
            take: MAX_JOBS_PER_SWEEP,
            select: { id: true },
        });
        for (const candidate of pending) {
            const claimed = await this.prisma.rumMaintenanceJob.updateMany({
                where: {
                    id: candidate.id,
                    status: RumMaintenanceJobStatus.PENDING,
                },
                data: {
                    status: RumMaintenanceJobStatus.RUNNING,
                    startedAt: new Date(),
                },
            });
            if (!claimed.count) continue;
            const job = await this.prisma.rumMaintenanceJob.findUnique({
                where: { id: candidate.id },
            });
            if (!job) continue;
            try {
                const result =
                    job.type === RumMaintenanceJobType.PURGE
                        ? await this.purge(job.appId)
                        : await this.deleteSubject(
                              job.appId,
                              (job.payload ?? {}) as SubjectDeletionPayload,
                          );
                await this.prisma.rumMaintenanceJob.update({
                    where: { id: job.id },
                    data: {
                        status: RumMaintenanceJobStatus.COMPLETED,
                        completedAt: new Date(),
                        result: result as Prisma.InputJsonValue,
                    },
                });
            } catch (error) {
                this.logger.error(
                    `RUM maintenance job ${job.id} failed`,
                    error as Error,
                );
                await this.prisma.rumMaintenanceJob.update({
                    where: { id: job.id },
                    data: {
                        status: RumMaintenanceJobStatus.FAILED,
                        completedAt: new Date(),
                        error: String(error).slice(0, 500),
                    },
                });
            }
        }
    }

    private async request(
        projectId: string,
        appId: string,
        principal: AccessPrincipal,
        options: {
            type: RumMaintenanceJobType;
            payload?: SubjectDeletionPayload;
        },
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'app.manage',
        );
        await this.ensureApp(access.organizationId, projectId, appId);
        const job = await this.prisma.rumMaintenanceJob.create({
            data: {
                appId,
                organizationId: access.organizationId,
                type: options.type,
                payload: options.payload
                    ? (options.payload as Prisma.InputJsonValue)
                    : undefined,
                requestedById:
                    principal.type === 'USER' ? principal.userId : null,
            },
        });
        // Best-effort immediate execution; the scheduled sweep covers restarts.
        setImmediate(() => {
            this.processPending().catch((error) =>
                this.logger.warn(
                    `RUM maintenance sweep failed: ${String(error)}`,
                ),
            );
        });
        return job;
    }

    private async purge(appId: string): Promise<Record<string, number>> {
        const counts: Record<string, number> = {};
        for (const table of PURGE_TABLES) {
            let total = 0;
            for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
                const deleted = await this.prisma.$executeRawUnsafe(
                    `DELETE FROM "${table}" WHERE "id" IN (
                        SELECT "id" FROM "${table}"
                        WHERE "appId" = $1
                        LIMIT ${DELETE_BATCH_SIZE}
                    )`,
                    appId,
                );
                total += deleted;
                if (deleted < DELETE_BATCH_SIZE) break;
            }
            counts[table] = total;
        }
        return counts;
    }

    private async deleteSubject(
        appId: string,
        payload: SubjectDeletionPayload,
    ): Promise<SubjectDeletionResult> {
        const condition = this.subjectCondition(payload);
        const sessionRows = await this.prisma.$queryRaw<
            { sessionId: string }[]
        >(Prisma.sql`
            SELECT DISTINCT "sessionId" FROM "rum_error_occurrences"
            WHERE "appId" = ${appId} AND "sessionId" IS NOT NULL AND ${condition}
            UNION
            SELECT DISTINCT "sessionId" FROM "rum_events"
            WHERE "appId" = ${appId} AND "sessionId" IS NOT NULL AND ${condition}
        `);
        const sessionIds = sessionRows.map((row) => row.sessionId);

        const unlinkedRows = await this.prisma.$queryRaw<{ count: number }[]>(
            Prisma.sql`
                SELECT (
                    (SELECT COUNT(*)::int FROM "rum_error_occurrences"
                     WHERE "appId" = ${appId} AND "sessionId" IS NULL AND ${condition})
                    +
                    (SELECT COUNT(*)::int FROM "rum_events"
                     WHERE "appId" = ${appId} AND "sessionId" IS NULL AND ${condition})
                ) AS "count"
            `,
        );

        const occurrences = await this.deleteInBatches(
            'rum_error_occurrences',
            appId,
            condition,
        );
        const events = await this.deleteInBatches(
            'rum_events',
            appId,
            condition,
        );
        const perfSamples = payload.endUserId
            ? await this.deleteInBatches(
                  'rum_perf_samples',
                  appId,
                  Prisma.sql`"endUserId" = ${payload.endUserId}`,
              )
            : 0;

        let replaySessions = 0;
        if (sessionIds.length) {
            const deleted = await this.prisma.rumReplaySession.deleteMany({
                where: { appId, sessionKey: { in: sessionIds } },
            });
            replaySessions = deleted.count;
        }

        return {
            occurrences,
            events,
            perfSamples,
            replaySessions,
            unlinkedRecords: Number(unlinkedRows[0]?.count ?? 0),
            // Monthly metric/performance aggregates carry no subject identity,
            // so they are retained and reported explicitly.
            aggregatesRetained: true,
        };
    }

    private subjectCondition(payload: SubjectDeletionPayload): Prisma.Sql {
        const parts: Prisma.Sql[] = [];
        if (payload.endUserId)
            parts.push(Prisma.sql`"endUserId" = ${payload.endUserId}`);
        if (payload.anonymousId)
            parts.push(Prisma.sql`"anonymousId" = ${payload.anonymousId}`);
        return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
    }

    private async deleteInBatches(
        table: string,
        appId: string,
        condition: Prisma.Sql,
    ): Promise<number> {
        let total = 0;
        for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
            const deleted = await this.prisma.$executeRaw(
                Prisma.sql`
                    DELETE FROM ${Prisma.raw(`"${table}"`)}
                    WHERE "id" IN (
                        SELECT "id" FROM ${Prisma.raw(`"${table}"`)}
                        WHERE "appId" = ${appId} AND ${condition}
                        LIMIT ${DELETE_BATCH_SIZE}
                    )
                `,
            );
            total += deleted;
            if (deleted < DELETE_BATCH_SIZE) break;
        }
        return total;
    }

    private async ensureApp(
        organizationId: string,
        projectId: string,
        appId: string,
    ): Promise<void> {
        const app = await this.prisma.rumApp.findFirst({
            where: {
                id: appId,
                organizationId,
                projectId,
                deletedAt: null,
            },
            select: { id: true },
        });
        if (!app) throw new NotFoundException('RUM app not found');
    }
}

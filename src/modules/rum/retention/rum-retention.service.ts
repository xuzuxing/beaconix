import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RumConfig } from '../../../config';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 5000;
const MAX_BATCHES = 20;

@Injectable()
export class RumRetentionService implements OnModuleInit {
    private readonly logger = new Logger(RumRetentionService.name);
    private readonly config: RumConfig;

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ScheduledJobRegistry,
        configService: ConfigService,
    ) {
        this.config = configService.get<RumConfig>('rum')!;
    }

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.rumErrorCleanup,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.rumErrorCleanup],
            handler: () => this.handleCleanup(),
        });
    }

    async handleCleanup(): Promise<void> {
        const errorCutoff = new Date(
            Date.now() - this.config.errorRetentionDays * MS_PER_DAY,
        );
        const eventCutoff = new Date(
            Date.now() - this.config.eventRetentionDays * MS_PER_DAY,
        );
        const replayCutoff = new Date(
            Date.now() - this.config.replayRetentionDays * MS_PER_DAY,
        );
        const metricCutoff = new Date(
            Date.now() -
                Math.max(
                    this.config.errorRetentionDays,
                    this.config.eventRetentionDays,
                ) *
                    MS_PER_DAY,
        );
        let errors = 0;
        let events = 0;
        let replays = 0;
        let metrics = 0;

        for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
            const deleted = await this.prisma.$executeRaw`
                DELETE FROM "rum_error_groups" WHERE "id" IN (
                    SELECT "id" FROM "rum_error_groups"
                    WHERE "lastSeenAt" < ${errorCutoff}
                    ORDER BY "lastSeenAt" ASC
                    LIMIT ${DELETE_BATCH_SIZE}
                )
            `;
            errors += deleted;
            if (deleted < DELETE_BATCH_SIZE) break;
        }

        for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
            const deleted = await this.prisma.$executeRaw`
                DELETE FROM "rum_events" WHERE "id" IN (
                    SELECT "id" FROM "rum_events"
                    WHERE "receivedAt" < ${eventCutoff}
                    ORDER BY "receivedAt" ASC
                    LIMIT ${DELETE_BATCH_SIZE}
                )
            `;
            events += deleted;
            if (deleted < DELETE_BATCH_SIZE) break;
        }

        for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
            const deleted = await this.prisma.$executeRaw`
                DELETE FROM "rum_replay_sessions" WHERE "id" IN (
                    SELECT "id" FROM "rum_replay_sessions"
                    WHERE "lastSeenAt" < ${replayCutoff}
                    ORDER BY "lastSeenAt" ASC
                    LIMIT ${DELETE_BATCH_SIZE}
                )
            `;
            replays += deleted;
            if (deleted < DELETE_BATCH_SIZE) break;
        }

        for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
            const deleted = await this.prisma.$executeRaw`
                DELETE FROM "rum_metric_buckets" WHERE "id" IN (
                    SELECT "id" FROM "rum_metric_buckets"
                    WHERE "bucketStart" < ${metricCutoff}
                    ORDER BY "bucketStart" ASC
                    LIMIT ${DELETE_BATCH_SIZE}
                )
            `;
            metrics += deleted;
            if (deleted < DELETE_BATCH_SIZE) break;
        }

        this.logger.log(
            `RUM retention removed ${errors} error group(s), ${events} event(s), ${replays} replay session(s), and ${metrics} metric bucket(s)`,
        );
    }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../infra/database/prisma.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How long each monitoring history table is kept. */
const CHECK_LOG_RETENTION_DAYS = 30;
const PROBE_EXECUTION_RETENTION_DAYS = 7;
const PROBE_RESULT_RETENTION_DAYS = 2;

/** Rows per delete statement, and statements per table per run. */
const DELETE_BATCH_SIZE = 5000;
const MAX_BATCHES_PER_TABLE = 20;

interface RetentionTarget {
    table: string;
    column: string;
    days: number;
}

/**
 * Table and column names are fixed identifiers, so they cannot be bound as
 * parameters; the cutoff itself is always passed as a value.
 */
const RETENTION_TARGETS: RetentionTarget[] = [
    {
        table: 'check_logs',
        column: 'checkedAt',
        days: CHECK_LOG_RETENTION_DAYS,
    },
    {
        table: 'probe_executions',
        column: 'executedAt',
        days: PROBE_EXECUTION_RETENTION_DAYS,
    },
    {
        table: 'probe_results',
        column: 'checkedAt',
        days: PROBE_RESULT_RETENTION_DAYS,
    },
];

/**
 * Trims the monitoring history tables. They only ever grow - a single 60s
 * monitor adds ~1440 check rows and ~1440 execution rows per day - and nothing
 * else deletes from them.
 *
 * Runs daily at 3:00 AM (after the 2:00 AM token cleanup) and deletes in
 * batches so removing a large backlog never holds one long transaction.
 */
@Injectable()
export class MonitorDataCleanupService {
    private readonly logger = new Logger(MonitorDataCleanupService.name);

    constructor(private readonly prisma: PrismaService) {}

    @Cron(CronExpression.EVERY_DAY_AT_3AM, {
        name: 'monitor-data-cleanup',
    })
    async handleCleanup(): Promise<void> {
        const startedAt = Date.now();

        for (const target of RETENTION_TARGETS) {
            try {
                const removed = await this.trim(target);

                this.logger.log(
                    `Removed ${removed} row(s) from ${target.table} (older than ${target.days} day(s))`,
                );
            } catch (error) {
                // One failing table must not stop the others.
                this.logger.error(
                    `Cleanup failed for ${target.table}`,
                    error as Error,
                );
            }
        }

        this.logger.log(
            `Monitor data cleanup completed in ${Date.now() - startedAt}ms`,
        );
    }

    private async trim(target: RetentionTarget): Promise<number> {
        const cutoff = new Date(Date.now() - target.days * MS_PER_DAY);
        let removed = 0;
        let batches = 0;

        for (; batches < MAX_BATCHES_PER_TABLE; batches += 1) {
            const deleted = await this.prisma.$executeRawUnsafe(
                `DELETE FROM "${target.table}" WHERE "id" IN (` +
                    `SELECT "id" FROM "${target.table}" ` +
                    `WHERE "${target.column}" < $1 LIMIT ${DELETE_BATCH_SIZE})`,
                cutoff,
            );

            removed += deleted;

            if (deleted < DELETE_BATCH_SIZE) break;
        }

        if (batches === MAX_BATCHES_PER_TABLE) {
            this.logger.warn(
                `${target.table} still holds rows older than ${target.days} day(s); the rest is removed on the next run`,
            );
        }

        return removed;
    }
}

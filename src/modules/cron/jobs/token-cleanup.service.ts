import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';

/**
 * Cleans up dead refresh-token families while retaining live-family ancestors.
 * Runs every day at 2:00 AM.
 */
@Injectable()
export class TokenCleanupService implements OnModuleInit {
    private readonly logger = new Logger(TokenCleanupService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ScheduledJobRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.tokenCleanup,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.tokenCleanup],
            handler: () => this.handleTokenCleanup(),
        });
    }

    async handleTokenCleanup(): Promise<void> {
        const jobStart = Date.now();
        this.logger.log('Starting expired token cleanup...');

        try {
            let count = 0;
            let cursor = '';
            for (;;) {
                const batch = await this.prisma.$transaction(async (tx) => {
                    const cutoff = new Date();
                    // Match refresh/logout's user-first lock order. In particular,
                    // a token can expire while its replacement is being signed;
                    // cleanup must wait for that replacement to commit before
                    // deciding whether its ancestors are still needed for logout.
                    const users = await tx.$queryRaw<{ id: string }[]>`
                        SELECT u.id FROM users AS u
                        WHERE u.id > ${cursor} AND EXISTS (
                            SELECT 1 FROM refresh_tokens AS token
                            WHERE token."userId" = u.id
                            AND (token."expiresAt" <= ${cutoff} OR token."revokedAt" IS NOT NULL)
                        )
                        ORDER BY u.id LIMIT 200 FOR UPDATE OF u
                    `;
                    if (!users.length) return { users, removed: 0 };
                    const now = new Date();
                    const removed = await tx.$executeRaw`
                        DELETE FROM refresh_tokens AS stale
                        WHERE stale."userId" IN (${Prisma.join(users.map((user) => user.id))})
                        AND (stale."expiresAt" <= ${now} OR stale."revokedAt" IS NOT NULL)
                        AND NOT EXISTS (
                            SELECT 1 FROM refresh_tokens AS live
                            WHERE live."userId" = stale."userId"
                            AND live."familyId" = stale."familyId"
                            AND live."revokedAt" IS NULL AND live."expiresAt" > ${now}
                        )
                    `;
                    return { users, removed };
                });
                count += batch.removed;
                if (batch.users.length < 200) break;
                cursor = batch.users[batch.users.length - 1].id;
            }

            const duration = Date.now() - jobStart;
            this.logger.log(
                `Token cleanup completed in ${duration}ms — ` +
                    `removed: ${count}`,
            );
        } catch (error) {
            const duration = Date.now() - jobStart;
            this.logger.error(
                `Token cleanup failed after ${duration}ms`,
                error instanceof Error ? error.stack : String(error),
            );
        }
    }
}

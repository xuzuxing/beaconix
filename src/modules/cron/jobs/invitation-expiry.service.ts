import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';

/**
 * Marks PENDING invitations as EXPIRED when their expiresAt date has passed.
 * Runs every hour to catch expiries promptly.
 *
 * "EXPIRED — expiresAt passed — set by cron job"
 */
@Injectable()
export class InvitationExpiryService implements OnModuleInit {
    private readonly logger = new Logger(InvitationExpiryService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ScheduledJobRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.invitationExpiry,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.invitationExpiry],
            handler: () => this.handleInvitationExpiry(),
        });
    }

    async handleInvitationExpiry(): Promise<void> {
        const jobStart = Date.now();
        this.logger.log('Starting invitation expiry check...');

        try {
            const { count } = await this.prisma.invitation.updateMany({
                where: {
                    status: 'PENDING',
                    expiresAt: { lt: new Date() },
                },
                data: {
                    status: 'EXPIRED',
                },
            });

            const duration = Date.now() - jobStart;
            this.logger.log(
                `Invitation expiry completed in ${duration}ms — ` +
                    `expired: ${count} invitation(s)`,
            );
        } catch (error) {
            const duration = Date.now() - jobStart;
            this.logger.error(
                `Invitation expiry check failed after ${duration}ms`,
                error instanceof Error ? error.stack : String(error),
            );
        }
    }
}

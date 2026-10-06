import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import { SubscriptionStatus } from '../../../generated/prisma/enums';

@Injectable()
export class SubscriptionExpiryService implements OnModuleInit {
    private readonly logger = new Logger(SubscriptionExpiryService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ScheduledJobRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.subscriptionExpirySweep,
            pattern:
                SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.subscriptionExpirySweep],
            handler: () => this.expireSubscriptions(),
        });
    }

    async expireSubscriptions(): Promise<number> {
        const result = await this.prisma.subscription.updateMany({
            where: {
                status: SubscriptionStatus.ACTIVE,
                expiresAt: { lte: new Date() },
            },
            data: { status: SubscriptionStatus.EXPIRED },
        });

        if (result.count > 0) {
            this.logger.log(`Marked ${result.count} subscription(s) expired`);
        }

        return result.count;
    }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import { OrderStatus } from '../../../generated/prisma/enums';

@Injectable()
export class OrderExpiryService implements OnModuleInit {
    private readonly logger = new Logger(OrderExpiryService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ScheduledJobRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.orderExpirySweep,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.orderExpirySweep],
            handler: () => this.cancelExpiredOrders(),
        });
    }

    async cancelExpiredOrders(): Promise<number> {
        const result = await this.prisma.order.updateMany({
            where: {
                status: OrderStatus.PENDING,
                expiresAt: { lte: new Date() },
            },
            data: {
                status: OrderStatus.CANCELLED,
                cancelledAt: new Date(),
            },
        });

        if (result.count > 0) {
            this.logger.log(`Cancelled ${result.count} expired order(s)`);
        }

        return result.count;
    }
}

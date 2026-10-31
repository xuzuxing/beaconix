import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import { OrderStatus } from '../../../generated/prisma/enums';
import { PaymentService } from '../payment/payment.service';

@Injectable()
export class OrderExpiryService implements OnModuleInit {
    private readonly logger = new Logger(OrderExpiryService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ScheduledJobRegistry,
        private readonly payments: PaymentService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.orderExpirySweep,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.orderExpirySweep],
            handler: () => this.cancelExpiredOrders(),
        });
    }

    async cancelExpiredOrders(): Promise<number> {
        const orders = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.PENDING,
                expiresAt: { lte: new Date() },
            },
            select: { id: true },
            orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
            take: 100,
        });
        let count = 0;
        for (const order of orders) {
            try {
                if (await this.payments.cancelOrder(order.id, true)) count += 1;
            } catch (error) {
                this.logger.warn(
                    `Order cancellation failed for ${order.id}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        if (count) this.logger.log(`Cancelled ${count} expired order(s)`);
        return count;
    }
}

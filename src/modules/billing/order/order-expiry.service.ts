import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../infra/database/prisma.service';
import { OrderStatus } from '../../../generated/prisma/enums';

@Injectable()
export class OrderExpiryService {
    private readonly logger = new Logger(OrderExpiryService.name);

    constructor(private readonly prisma: PrismaService) {}

    @Cron(CronExpression.EVERY_5_MINUTES, {
        name: 'order-expiry-sweep',
    })
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

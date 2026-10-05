import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../infra/database/prisma.service';
import { SubscriptionStatus } from '../../../generated/prisma/enums';

@Injectable()
export class SubscriptionExpiryService {
    private readonly logger = new Logger(SubscriptionExpiryService.name);

    constructor(private readonly prisma: PrismaService) {}

    @Cron(CronExpression.EVERY_HOUR, {
        name: 'subscription-expiry-sweep',
    })
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

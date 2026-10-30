import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import { NotificationsService } from '../../notifications/notifications.service';
import { ADMIN_ROLES } from '../../notifications/notification-event';

export const ALERT_SUMMARY_TIMEZONE = 'Asia/Shanghai';

@Injectable()
export class AlertDeliveryFailureSummaryService implements OnModuleInit {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notifications: NotificationsService,
        private readonly registry: ScheduledJobRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.alertDeliveryFailureSummary,
            pattern:
                SCHEDULED_JOB_PATTERNS[
                    SCHEDULED_JOBS.alertDeliveryFailureSummary
                ],
            timezone: ALERT_SUMMARY_TIMEZONE,
            handler: () => this.summarize(),
        });
    }

    async summarize(at = new Date()): Promise<void> {
        const day = new Intl.DateTimeFormat('en-CA', {
            timeZone: ALERT_SUMMARY_TIMEZONE,
        }).format(at);
        let cursor = '';
        for (;;) {
            const organizations = await this.prisma.$queryRaw<{ id: string }[]>`
                SELECT DISTINCT o.id FROM alert_deliveries d
                JOIN alert_events e ON e.id = d."eventId"
                JOIN organizations o ON o.id = e."organizationId"
                WHERE d.status = 'FAILED' AND o."deletedAt" IS NULL AND o.id > ${cursor}
                ORDER BY o.id LIMIT 100`;
            if (!organizations.length) break;
            for (const { id } of organizations) {
                cursor = id;
                await this.prisma.$transaction(async (tx) => {
                    const failedCount = await tx.alertDelivery.count({
                        where: {
                            status: 'FAILED',
                            event: { organizationId: id },
                        },
                    });
                    if (!failedCount) return;
                    const recipients =
                        await this.notifications.organizationRecipients(
                            id,
                            tx,
                            ADMIN_ROLES,
                        );
                    await this.notifications.publish(
                        {
                            eventKey: `alert-delivery-failures:${id}:${day}`,
                            recipients,
                            organizationId: id,
                            accessScope: 'ORGANIZATION',
                            type: 'ALERT_DELIVERY_FAILED_SUMMARY',
                            title: '监控通知投递失败汇总',
                            body: `截至 ${day}，组织仍有 ${failedCount} 条监控渠道通知投递失败。请检查渠道配置，并由有权限的管理员人工重试。`,
                            resourceType: 'Organization',
                            resourceId: id,
                            email: true,
                            meta: {
                                day,
                                timezone: ALERT_SUMMARY_TIMEZONE,
                                failedCount,
                            },
                        },
                        tx,
                    );
                });
            }
            if (organizations.length < 100) break;
        }
    }
}

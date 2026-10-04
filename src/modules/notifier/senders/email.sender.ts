import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../../email/email.service';
import { EmailTemplate } from '../../email/email.types';
import { parseEmailConfig } from '../channel-config';
import type { NotificationChannelModel } from '../../../generated/prisma/models';
import type {
    NotificationChannelSender,
    NotificationPayload,
} from '../notifier.types';

@Injectable()
export class EmailSender implements NotificationChannelSender {
    private readonly logger = new Logger(EmailSender.name);

    constructor(private readonly emailService: EmailService) {}

    async send(
        channel: NotificationChannelModel,
        payload: NotificationPayload,
    ): Promise<void> {
        const config = parseEmailConfig(channel.config);

        const template =
            payload.event === 'RECOVER'
                ? EmailTemplate.MONITOR_RECOVER
                : EmailTemplate.MONITOR_DOWN;

        await Promise.all(
            config.to.map((to) =>
                this.emailService.send(template, {
                    to,
                    monitorName: payload.monitorName,
                    target: payload.target,
                    status: payload.status,
                    previousStatus: payload.previousStatus,
                    error: payload.error ?? '-',
                    latency:
                        payload.latency === null ? '-' : `${payload.latency}ms`,
                    checkedAt: payload.checkedAt.toISOString(),
                }),
            ),
        );

        this.logger.log(
            `Monitor email notification delivered to ${config.to.length} recipient(s)`,
        );
    }
}

import { Injectable, Logger } from '@nestjs/common';
import { parseWecomConfig } from '../channel-config';
import { renderMarkdown } from '../channel-message';
import { assertZeroCode, postJson } from '../http.util';
import type { NotificationChannelModel } from '../../../generated/prisma/models';
import type {
    NotificationChannelSender,
    NotificationPayload,
} from '../notifier.types';

@Injectable()
export class WecomSender implements NotificationChannelSender {
    private readonly logger = new Logger(WecomSender.name);

    async send(
        channel: NotificationChannelModel,
        payload: NotificationPayload,
    ): Promise<void> {
        const config = parseWecomConfig(channel.config);

        const result = await postJson(config.webhookUrl, {
            msgtype: 'markdown',
            markdown: { content: renderMarkdown(payload) },
        });

        assertZeroCode(result, ['errcode', 'code'], 'WeCom');

        this.logger.log(
            `WeCom notification delivered for monitor ${payload.monitorId}`,
        );
    }
}

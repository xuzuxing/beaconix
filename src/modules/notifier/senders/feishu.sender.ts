import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { parseFeishuConfig } from '../channel-config';
import { renderText } from '../channel-message';
import { assertZeroCode, postJson } from '../http.util';
import type { NotificationChannelModel } from '../../../generated/prisma/models';
import type {
    NotificationChannelSender,
    NotificationPayload,
} from '../notifier.types';

/**
 * Signature of a Feishu custom bot: base64(HMAC-SHA256(key = "timestamp\nsecret",
 * data = "")).
 */
export function signFeishuRequest(timestamp: number, secret: string): string {
    const stringToSign = `${timestamp}\n${secret}`;
    return createHmac('sha256', stringToSign).update('').digest('base64');
}

@Injectable()
export class FeishuSender implements NotificationChannelSender {
    private readonly logger = new Logger(FeishuSender.name);

    async send(
        channel: NotificationChannelModel,
        payload: NotificationPayload,
    ): Promise<void> {
        const config = parseFeishuConfig(channel.config);

        const body: Record<string, unknown> = {
            msg_type: 'text',
            content: { text: renderText(payload) },
        };

        if (config.secret) {
            const timestamp = Math.floor(Date.now() / 1000);
            body.timestamp = String(timestamp);
            body.sign = signFeishuRequest(timestamp, config.secret);
        }

        const result = await postJson(config.webhookUrl, body);
        assertZeroCode(result, ['code', 'StatusCode'], 'Feishu');

        this.logger.log(
            `Feishu notification delivered for monitor ${payload.monitorId}`,
        );
    }
}

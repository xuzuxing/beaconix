import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { parseDingtalkConfig } from '../channel-config';
import { renderMarkdown, renderTitle } from '../channel-message';
import { assertZeroCode, postJson } from '../http.util';
import type { NotificationChannelModel } from '../../../generated/prisma/models';
import type {
    NotificationChannelSender,
    NotificationPayload,
} from '../notifier.types';

/**
 * Signature of a DingTalk custom bot: urlencoded base64(HMAC-SHA256(key = secret,
 * data = "timestamp\nsecret")) appended to the webhook URL.
 */
export function signDingtalkRequest(timestamp: number, secret: string): string {
    const stringToSign = `${timestamp}\n${secret}`;
    const digest = createHmac('sha256', secret)
        .update(stringToSign)
        .digest('base64');

    return encodeURIComponent(digest);
}

@Injectable()
export class DingtalkSender implements NotificationChannelSender {
    private readonly logger = new Logger(DingtalkSender.name);

    async send(
        channel: NotificationChannelModel,
        payload: NotificationPayload,
    ): Promise<void> {
        const config = parseDingtalkConfig(channel.config);

        let url = config.webhookUrl;

        if (config.secret) {
            const timestamp = Date.now();
            const sign = signDingtalkRequest(timestamp, config.secret);
            url += `${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`;
        }

        const result = await postJson(url, {
            msgtype: 'markdown',
            markdown: {
                title: renderTitle(payload),
                text: renderMarkdown(payload),
            },
        });

        assertZeroCode(result, ['errcode', 'code'], 'DingTalk');

        this.logger.log(
            `DingTalk notification delivered for monitor ${payload.monitorId}`,
        );
    }
}

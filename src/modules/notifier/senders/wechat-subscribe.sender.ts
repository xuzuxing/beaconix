import { Injectable, Logger } from '@nestjs/common';
import type { SubscribeMessageData } from '../../../infra/wechat/miniprogram';
import { MiniprogramClient } from '../../../infra/wechat/miniprogram';
import {
    DEFAULT_WECHAT_FIELDS,
    parseWechatSubscribeConfig,
    resolveWechatFieldValue,
} from '../channel-config';
import type { NotificationChannelModel } from '../../../generated/prisma/models';
import type {
    NotificationChannelSender,
    NotificationPayload,
} from '../notifier.types';

/** WeChat caps `thing` template fields at 20 characters. */
const WECHAT_FIELD_MAX_LENGTH = 20;

function truncate(value: string, maxLength: number): string {
    return value.length <= maxLength
        ? value
        : `${value.slice(0, maxLength - 3)}...`;
}

/**
 * WeChat mini-program subscribe message channel.
 *
 * Template field mapping and length limits live here; token management and the
 * WeChat API calls are delegated to `MiniprogramClient` in `infra/wechat`.
 */
@Injectable()
export class WechatSubscribeSender implements NotificationChannelSender {
    private readonly logger = new Logger(WechatSubscribeSender.name);

    constructor(private readonly client: MiniprogramClient) {}

    async send(
        channel: NotificationChannelModel,
        payload: NotificationPayload,
    ): Promise<void> {
        const config = parseWechatSubscribeConfig(channel.config);
        const data = this.buildTemplateData(payload, config.fields);

        const result = await this.client.sendSubscribeMessageToMany({
            appId: config.appId,
            appSecret: config.appSecret,
            openIds: config.openIds,
            templateId: config.templateId,
            page: config.page,
            miniprogramState: config.miniprogramState,
            data,
        });

        if (result.failures.length > 0) {
            throw new Error(
                `WeChat subscribe send failed for ${result.failures.length}/${config.openIds.length} recipient(s): ${result.failures.join('; ')}`,
            );
        }

        this.logger.log(
            `WeChat subscribe notification delivered to ${config.openIds.length} recipient(s)`,
        );
    }

    /** Maps payload attributes onto the template's own field keys. */
    private buildTemplateData(
        payload: NotificationPayload,
        overrides?: Record<string, string>,
    ): SubscribeMessageData {
        const fields = { ...DEFAULT_WECHAT_FIELDS, ...(overrides ?? {}) };
        const data: SubscribeMessageData = {};

        for (const [field, source] of Object.entries(fields)) {
            data[field] = {
                value: truncate(
                    resolveWechatFieldValue(source, payload),
                    WECHAT_FIELD_MAX_LENGTH,
                ),
            };
        }

        return data;
    }
}

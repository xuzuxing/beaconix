import { Injectable, Logger } from '@nestjs/common';
import {
    DEFAULT_WECHAT_FIELDS,
    parseWechatSubscribeConfig,
    resolveWechatFieldValue,
} from '../channel-config';
import { getJson, postJson } from '../http.util';
import type { JsonObject } from '../http.util';
import type { NotificationChannelModel } from '../../../generated/prisma/models';
import type {
    NotificationChannelSender,
    NotificationPayload,
} from '../notifier.types';

const WECHAT_API = 'https://api.weixin.qq.com/cgi-bin';

/** WeChat caps `thing` template fields at 20 characters. */
const WECHAT_FIELD_MAX_LENGTH = 20;

/** Token codes that mean "the cached access token is no longer valid". */
const STALE_TOKEN_CODES = [40001, 42001];

interface CachedToken {
    token: string;
    expiresAt: number;
}

function truncate(value: string, maxLength: number): string {
    return value.length <= maxLength
        ? value
        : `${value.slice(0, maxLength - 3)}...`;
}

/** Renders a scalar field of a WeChat API response without Object#toString. */
function describeField(result: JsonObject, key: string): string {
    const value = result[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return '';
}

@Injectable()
export class WechatSubscribeSender implements NotificationChannelSender {
    private readonly logger = new Logger(WechatSubscribeSender.name);
    private readonly tokens = new Map<string, CachedToken>();

    async send(
        channel: NotificationChannelModel,
        payload: NotificationPayload,
    ): Promise<void> {
        const config = parseWechatSubscribeConfig(channel.config);
        const accessToken = await this.getAccessToken(config);

        const fields = { ...DEFAULT_WECHAT_FIELDS, ...(config.fields ?? {}) };
        const data: Record<string, { value: string }> = {};

        for (const [field, source] of Object.entries(fields)) {
            data[field] = {
                value: truncate(
                    resolveWechatFieldValue(source, payload),
                    WECHAT_FIELD_MAX_LENGTH,
                ),
            };
        }

        const baseBody = {
            template_id: config.templateId,
            page: config.page,
            miniprogram_state: config.miniprogramState ?? 'formal',
            lang: 'zh_CN',
            data,
        };

        const failures: string[] = [];

        for (const openId of config.openIds) {
            try {
                const result = await postJson(
                    `${WECHAT_API}/message/subscribe/send?access_token=${accessToken}`,
                    { ...baseBody, touser: openId },
                );

                const code = result.errcode;
                if (typeof code === 'number' && code !== 0) {
                    if (STALE_TOKEN_CODES.includes(code)) {
                        this.tokens.delete(config.appId);
                    }
                    failures.push(
                        `${openId}: ${code} ${describeField(result, 'errmsg')}`,
                    );
                }
            } catch (error) {
                failures.push(`${openId}: ${(error as Error).message}`);
            }
        }

        if (failures.length > 0) {
            throw new Error(
                `WeChat subscribe send failed for ${failures.length}/${config.openIds.length} recipient(s): ${failures.join('; ')}`,
            );
        }

        this.logger.log(
            `WeChat subscribe notification delivered to ${config.openIds.length} recipient(s)`,
        );
    }

    private async getAccessToken(
        config: ReturnType<typeof parseWechatSubscribeConfig>,
    ): Promise<string> {
        const cached = this.tokens.get(config.appId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.token;
        }

        const result = await getJson(
            `${WECHAT_API}/token?grant_type=client_credential&appid=${encodeURIComponent(config.appId)}&secret=${encodeURIComponent(config.appSecret)}`,
        );

        const token = result.access_token;
        if (typeof token !== 'string' || token === '') {
            throw new Error(
                `WeChat access token request failed: ${describeField(result, 'errcode')} ${describeField(result, 'errmsg')}`,
            );
        }

        const expiresIn =
            typeof result.expires_in === 'number' ? result.expires_in : 7200;

        this.tokens.set(config.appId, {
            token,
            // Refresh slightly early to avoid racing the expiry.
            expiresAt: Date.now() + Math.max(expiresIn - 300, 60) * 1000,
        });

        return token;
    }
}

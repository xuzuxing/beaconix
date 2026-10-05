import { Injectable, Logger } from '@nestjs/common';
import { WechatHttpClient } from '../clients/wechat-http.client';
import {
    WechatTokenService,
    withAccessToken,
} from '../clients/wechat-token.service';
import { WechatApiError } from '../wechat.types';
import type {
    Code2SessionInput,
    Code2SessionResult,
    GetPhoneNumberInput,
    SendSubscribeMessageBatchInput,
    SendSubscribeMessageBatchResult,
    SendSubscribeMessageInput,
    WechatPhoneNumber,
} from './miniprogram.types';

interface Code2SessionResponse {
    openid?: string;
    unionid?: string;
    session_key?: string;
}

interface PhoneNumberResponse {
    phone_info?: {
        phoneNumber?: string;
        purePhoneNumber?: string;
        countryCode?: string;
    };
}

const SUBSCRIBE_SEND_PATH = '/cgi-bin/message/subscribe/send';
const PHONE_NUMBER_PATH = '/wxa/business/getuserphonenumber';

/**
 * Mini-program client.
 *
 * Access tokens are always fetched through `WechatTokenService` (shared cache,
 * single-flight refresh) and transparently retried once when WeChat reports
 * the token as expired (40001/42001).
 */
@Injectable()
export class MiniprogramClient {
    private readonly logger = new Logger(MiniprogramClient.name);

    constructor(
        private readonly http: WechatHttpClient,
        private readonly tokens: WechatTokenService,
    ) {}

    /** Exchanges `wx.login()`'s code for openid / session_key. */
    async code2Session(input: Code2SessionInput): Promise<Code2SessionResult> {
        const result = await this.http.getJson<Code2SessionResponse>(
            '/sns/jscode2session',
            {
                query: {
                    appid: input.appId,
                    secret: input.appSecret,
                    js_code: input.code,
                    grant_type: 'authorization_code',
                },
            },
        );

        if (!result.openid || !result.session_key) {
            throw new WechatApiError({
                platform: 'mp',
                endpoint: 'GET /sns/jscode2session',
                errmsg: 'WeChat code2Session response is missing openid/session_key',
            });
        }

        return {
            openid: result.openid,
            unionid: result.unionid,
            sessionKey: result.session_key,
        };
    }

    /** Sends one subscribe message to one openid. */
    async sendSubscribeMessage(
        input: SendSubscribeMessageInput,
    ): Promise<void> {
        await withAccessToken(
            this.tokens,
            { kind: 'mp', appId: input.appId, appSecret: input.appSecret },
            (accessToken) =>
                this.http.postJson<Record<string, unknown>>(
                    `${SUBSCRIBE_SEND_PATH}?access_token=${encodeURIComponent(accessToken)}`,
                    {
                        touser: input.openId,
                        template_id: input.templateId,
                        page: input.page,
                        miniprogram_state: input.miniprogramState ?? 'formal',
                        lang: input.lang ?? 'zh_CN',
                        data: input.data,
                    },
                    { retries: 0 },
                ),
            this.logger,
        );
    }

    /**
     * Sends the same subscribe message to many openids, collecting per-recipient
     * failures instead of aborting on the first rejection.
     */
    async sendSubscribeMessageToMany(
        input: SendSubscribeMessageBatchInput,
    ): Promise<SendSubscribeMessageBatchResult> {
        const failures: string[] = [];
        let delivered = 0;

        for (const openId of input.openIds) {
            try {
                await this.sendSubscribeMessage({ ...input, openId });
                delivered += 1;
            } catch (error) {
                failures.push(
                    `${openId}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        return { delivered, failures };
    }

    /** Resolves the phone number bound to a `getPhoneNumber` code. */
    async getPhoneNumber(
        input: GetPhoneNumberInput,
    ): Promise<WechatPhoneNumber> {
        const result = await withAccessToken(
            this.tokens,
            { kind: 'mp', appId: input.appId, appSecret: input.appSecret },
            (accessToken) =>
                this.http.postJson<PhoneNumberResponse>(
                    `${PHONE_NUMBER_PATH}?access_token=${encodeURIComponent(accessToken)}`,
                    { code: input.code },
                    { retries: 0 },
                ),
            this.logger,
        );

        const info = result.phone_info;

        if (!info?.phoneNumber) {
            throw new WechatApiError({
                platform: 'mp',
                endpoint: `POST ${PHONE_NUMBER_PATH}`,
                errmsg: 'WeChat phone number response is missing phone_info',
            });
        }

        return {
            phoneNumber: info.phoneNumber,
            purePhoneNumber: info.purePhoneNumber ?? info.phoneNumber,
            countryCode: info.countryCode ?? '',
        };
    }
}

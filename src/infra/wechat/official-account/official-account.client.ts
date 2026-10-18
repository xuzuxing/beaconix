import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type {
    WechatOfficialAccountConfig,
    WechatWebsiteConfig,
} from '../../../config';
import { WechatHttpClient } from '../clients/wechat-http.client';
import {
    buildMsgSignature,
    checkMsgSignature,
    checkSignature,
    decryptMessage,
    encryptMessage,
} from '../clients/wechat-signature.util';
import {
    WechatTokenService,
    withAccessToken,
} from '../clients/wechat-token.service';
import { WechatRuntimeConfigService } from '../wechat-runtime-config.service';
import { WechatApiError, WechatConfigurationError } from '../wechat.types';
import type {
    BuildOAuthUrlInput,
    BuildQrConnectUrlInput,
    EncryptedReply,
    ExchangeCodeInput,
    GetUserInfoInput,
    OAuthTokenResult,
    OAuthUserInfo,
    ParseServerMessageInput,
    RefreshOAuthTokenInput,
    SendCustomTextMessageInput,
    SendTemplateMessageInput,
    ServerSignatureInput,
} from './official-account.types';

const OAUTH_AUTHORIZE_URL =
    'https://open.weixin.qq.com/connect/oauth2/authorize';
const QR_CONNECT_AUTHORIZE_URL = 'https://open.weixin.qq.com/connect/qrconnect';
const OAUTH_TOKEN_PATH = '/sns/oauth2/access_token';
const OAUTH_REFRESH_PATH = '/sns/oauth2/refresh_token';
const USER_INFO_PATH = '/sns/userinfo';
const TEMPLATE_SEND_PATH = '/cgi-bin/message/template/send';
const CUSTOM_SEND_PATH = '/cgi-bin/message/custom/send';
const DEFAULT_OAUTH_EXPIRES_IN = 7200;

interface OAuthTokenResponse {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    openid?: string;
    scope?: string;
    unionid?: string;
    errcode?: number;
    errmsg?: string;
}

interface UserInfoResponse {
    openid?: string;
    nickname?: string;
    sex?: number;
    province?: string;
    city?: string;
    country?: string;
    headimgurl?: string;
    privilege?: string[];
    unionid?: string;
    errcode?: number;
    errmsg?: string;
}

interface TemplateSendResponse {
    msgid?: number;
    errcode?: number;
    errmsg?: string;
}

function nowSeconds(): string {
    return String(Math.floor(Date.now() / 1000));
}

function randomNonce(): string {
    return randomBytes(8).toString('hex');
}

/**
 * Official account / service account client.
 *
 * Covers web authorisation (OAuth2), template messages, customer service
 * messages and "safe mode" server callbacks. Access tokens are shared through
 * `WechatTokenService`, exactly like the mini-program sub-package.
 */
@Injectable()
export class OfficialAccountClient {
    private readonly logger = new Logger(OfficialAccountClient.name);

    constructor(
        private readonly http: WechatHttpClient,
        private readonly tokens: WechatTokenService,
        private readonly runtimeConfig: WechatRuntimeConfigService,
    ) {}

    /**
     * Builds the `snsapi_base` / `snsapi_userinfo` authorisation URL the user
     * must be redirected to.
     */
    async buildOAuthUrl(input: BuildOAuthUrlInput): Promise<string> {
        const appId = input.appId ?? (await this.officialAccountConfig()).appId;

        if (!appId) {
            throw new WechatConfigurationError(
                'WECHAT_OA_APPID is required to build an official account OAuth URL',
            );
        }

        const query = [
            `appid=${encodeURIComponent(appId)}`,
            `redirect_uri=${encodeURIComponent(input.redirectUri)}`,
            'response_type=code',
            `scope=${input.scope ?? 'snsapi_base'}`,
            `state=${encodeURIComponent(input.state ?? '')}`,
        ].join('&');

        return `${OAUTH_AUTHORIZE_URL}?${query}#wechat_redirect`;
    }

    /**
     * Builds the `snsapi_login` QR-connect URL used for website (desktop web)
     * scan-to-login. Unlike `buildOAuthUrl`, this targets the Open Platform
     * website app and renders the QR code page directly.
     */
    async buildQrConnectUrl(input: BuildQrConnectUrlInput): Promise<string> {
        const appId = input.appId ?? (await this.websiteConfig()).appId;

        if (!appId) {
            throw new WechatConfigurationError(
                'WECHAT_WEB_APPID is required to build a website QR-connect URL',
            );
        }

        const query = [
            `appid=${encodeURIComponent(appId)}`,
            `redirect_uri=${encodeURIComponent(input.redirectUri)}`,
            'response_type=code',
            'scope=snsapi_login',
            `state=${encodeURIComponent(input.state ?? '')}`,
        ].join('&');

        return `${QR_CONNECT_AUTHORIZE_URL}?${query}#wechat_redirect`;
    }

    /** Exchanges an OAuth `code` for the web authorisation token. */
    async exchangeCodeForToken(
        input: ExchangeCodeInput,
    ): Promise<OAuthTokenResult> {
        const { appId, appSecret } = await this.resolveCredentials(input);

        const response = await this.http.getJson<OAuthTokenResponse>(
            OAUTH_TOKEN_PATH,
            {
                query: {
                    appid: appId,
                    secret: appSecret,
                    code: input.code,
                    grant_type: 'authorization_code',
                },
                platform: 'official-account',
            },
        );

        return this.toOAuthToken(response);
    }

    /** Refreshes a web authorisation token (`snsapi_userinfo` only). */
    async refreshOAuthToken(
        input: RefreshOAuthTokenInput,
    ): Promise<OAuthTokenResult> {
        const { appId } = await this.resolveCredentials(input);

        const response = await this.http.getJson<OAuthTokenResponse>(
            OAUTH_REFRESH_PATH,
            {
                query: {
                    appid: appId,
                    grant_type: 'refresh_token',
                    refresh_token: input.refreshToken,
                },
                platform: 'official-account',
            },
        );

        return this.toOAuthToken(response);
    }

    /** Reads the profile behind a web authorisation token. */
    async getUserInfo(input: GetUserInfoInput): Promise<OAuthUserInfo> {
        const response = await this.http.getJson<UserInfoResponse>(
            USER_INFO_PATH,
            {
                query: {
                    access_token: input.accessToken,
                    openid: input.openid,
                    lang: input.lang ?? 'zh_CN',
                },
                platform: 'official-account',
            },
        );

        if (!response.openid) {
            throw new WechatApiError({
                platform: 'official-account',
                endpoint: `GET ${USER_INFO_PATH}`,
                errcode: response.errcode,
                errmsg:
                    response.errmsg ??
                    'WeChat userinfo response is missing openid',
            });
        }

        return {
            openid: response.openid,
            nickname: response.nickname ?? '',
            sex: response.sex ?? 0,
            province: response.province ?? '',
            city: response.city ?? '',
            country: response.country ?? '',
            headimgurl: response.headimgurl ?? '',
            privilege: response.privilege ?? [],
            unionid: response.unionid,
        };
    }

    /** Sends a template (subscription) message. */
    async sendTemplateMessage(
        input: SendTemplateMessageInput,
    ): Promise<{ msgId: string }> {
        const { appId, appSecret } = await this.resolveCredentials(input);

        const response = await withAccessToken(
            this.tokens,
            { kind: 'mp', appId, appSecret },
            (accessToken) =>
                this.http.postJson<TemplateSendResponse>(
                    `${TEMPLATE_SEND_PATH}?access_token=${encodeURIComponent(accessToken)}`,
                    {
                        touser: input.openId,
                        template_id: input.templateId,
                        url: input.url,
                        miniprogram: input.miniprogram,
                        data: input.data,
                    },
                    { retries: 0, platform: 'official-account' },
                ),
            this.logger,
        );

        return { msgId: response.msgid ? String(response.msgid) : '' };
    }

    /** Sends a plain-text customer service message (48h window). */
    async sendCustomTextMessage(
        input: SendCustomTextMessageInput,
    ): Promise<void> {
        const { appId, appSecret } = await this.resolveCredentials(input);

        await withAccessToken(
            this.tokens,
            { kind: 'mp', appId, appSecret },
            (accessToken) =>
                this.http.postJson<Record<string, unknown>>(
                    `${CUSTOM_SEND_PATH}?access_token=${encodeURIComponent(accessToken)}`,
                    {
                        touser: input.openId,
                        msgtype: 'text',
                        text: { content: input.content },
                    },
                    { retries: 0, platform: 'official-account' },
                ),
            this.logger,
        );
    }

    /** Verifies the `signature` of the server-configuration GET request. */
    async verifyServerSignature(input: ServerSignatureInput): Promise<boolean> {
        const token = input.token ?? (await this.officialAccountConfig()).token;

        if (!token) {
            throw new WechatConfigurationError(
                'WECHAT_OA_TOKEN is required to verify the WeChat server signature',
            );
        }

        return checkSignature(
            token,
            input.timestamp,
            input.nonce,
            input.signature,
        );
    }

    /**
     * Verifies and decrypts a "safe mode" callback body.
     * Returns the plaintext XML/JSON WeChat sent.
     */
    async parseServerMessage(input: ParseServerMessageInput): Promise<string> {
        const { token, aesKey, appId } = await this.resolveCrypto(input);

        if (
            !checkMsgSignature(
                token,
                input.timestamp,
                input.nonce,
                input.encrypted,
                input.msgSignature,
            )
        ) {
            throw new WechatApiError({
                platform: 'official-account',
                endpoint: 'POST /wechat/callback',
                errmsg: 'WeChat message signature verification failed',
            });
        }

        return decryptMessage(input.encrypted, aesKey, appId);
    }

    /** Encrypts a reply and signs it the way WeChat expects. */
    async buildEncryptedReply(
        message: string,
        overrides: { token?: string; aesKey?: string; appId?: string } = {},
    ): Promise<EncryptedReply> {
        const { token, aesKey, appId } = await this.resolveCrypto(overrides);

        const timestamp = nowSeconds();
        const nonce = randomNonce();
        const encrypt = encryptMessage(message, aesKey, appId);

        return {
            encrypt,
            msgSignature: buildMsgSignature(token, timestamp, nonce, encrypt),
            timestamp,
            nonce,
        };
    }

    // -- Helpers ---------------------------------------------------------

    private async resolveCredentials(input: {
        appId?: string;
        appSecret?: string;
    }): Promise<{ appId: string; appSecret: string }> {
        const config = await this.officialAccountConfig();
        const appId = input.appId ?? config.appId;
        const appSecret = input.appSecret ?? config.appSecret;

        if (!appId || !appSecret) {
            throw new WechatConfigurationError(
                'Official account appId/appSecret are required (WECHAT_OA_APPID / WECHAT_OA_APPSECRET)',
            );
        }

        return { appId, appSecret };
    }

    private async resolveCrypto(overrides: {
        token?: string;
        aesKey?: string;
        appId?: string;
    }): Promise<{ token: string; aesKey: string; appId: string }> {
        const config = await this.officialAccountConfig();
        const token = overrides.token ?? config.token;
        const aesKey = overrides.aesKey ?? config.aesKey;
        const appId = overrides.appId ?? config.appId;

        if (!token) {
            throw new WechatConfigurationError(
                'WECHAT_OA_TOKEN is required for WeChat safe-mode messages',
            );
        }

        if (!aesKey) {
            throw new WechatConfigurationError(
                'WECHAT_OA_AES_KEY is required for WeChat safe-mode messages',
            );
        }

        if (!appId) {
            throw new WechatConfigurationError(
                'WECHAT_OA_APPID is required for WeChat safe-mode messages',
            );
        }

        return { token, aesKey, appId };
    }

    private toOAuthToken(response: OAuthTokenResponse): OAuthTokenResult {
        if (!response.access_token || !response.openid) {
            throw new WechatApiError({
                platform: 'official-account',
                endpoint: `GET ${OAUTH_TOKEN_PATH}`,
                errcode: response.errcode,
                errmsg:
                    response.errmsg ??
                    'WeChat OAuth response is missing access_token/openid',
            });
        }

        return {
            accessToken: response.access_token,
            expiresIn: response.expires_in ?? DEFAULT_OAUTH_EXPIRES_IN,
            refreshToken: response.refresh_token ?? '',
            openid: response.openid,
            scope: response.scope ?? '',
            unionid: response.unionid,
        };
    }

    private officialAccountConfig(): Promise<WechatOfficialAccountConfig> {
        return this.runtimeConfig.officialAccount();
    }

    private websiteConfig(): Promise<WechatWebsiteConfig> {
        return this.runtimeConfig.website();
    }
}

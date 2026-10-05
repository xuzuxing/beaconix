/**
 * Official account / service account (公众号) API types.
 *
 * Docs: https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html
 */

export type OfficialAccountOAuthScope = 'snsapi_base' | 'snsapi_userinfo';

export interface BuildOAuthUrlInput {
    /** Must be an authorised callback domain of the account. */
    redirectUri: string;
    /** Defaults to `snsapi_base` (silent, openid only). */
    scope?: OfficialAccountOAuthScope;
    state?: string;
    appId?: string;
}

export interface ExchangeCodeInput {
    code: string;
    appId?: string;
    appSecret?: string;
}

export interface RefreshOAuthTokenInput {
    refreshToken: string;
    appId?: string;
    /** Not used by WeChat, kept so callers can mirror the exchange call. */
    appSecret?: string;
}

export interface OAuthTokenResult {
    /** Web authorisation token — NOT the `client_credential` access token. */
    accessToken: string;
    expiresIn: number;
    refreshToken: string;
    openid: string;
    scope: string;
    unionid?: string;
}

export interface GetUserInfoInput {
    /** The web authorisation token from `exchangeCodeForToken`. */
    accessToken: string;
    openid: string;
    /** Defaults to `zh_CN`. */
    lang?: string;
}

export interface OAuthUserInfo {
    openid: string;
    nickname: string;
    sex: number;
    province: string;
    city: string;
    country: string;
    headimgurl: string;
    privilege: string[];
    unionid?: string;
}

export interface TemplateMessageFieldValue {
    value: string;
    color?: string;
}

export type TemplateMessageData = Record<string, TemplateMessageFieldValue>;

export interface SendTemplateMessageInput {
    openId: string;
    templateId: string;
    data: TemplateMessageData;
    /** Optional "view more" link. */
    url?: string;
    /** Optional mini-program jump target. */
    miniprogram?: { appid: string; pagepath: string };
    appId?: string;
    appSecret?: string;
}

export interface SendCustomTextMessageInput {
    openId: string;
    content: string;
    appId?: string;
    appSecret?: string;
}

export interface ServerSignatureInput {
    signature: string;
    timestamp: string;
    nonce: string;
    token?: string;
}

export interface ParseServerMessageInput {
    /** Base64 `Encrypt` field of the callback body. */
    encrypted: string;
    /** `msg_signature` query parameter of the callback. */
    msgSignature: string;
    timestamp: string;
    nonce: string;
    token?: string;
    aesKey?: string;
    appId?: string;
}

/** Encrypted ("safe mode") reply body plus the query params WeChat expects. */
export interface EncryptedReply {
    encrypt: string;
    msgSignature: string;
    timestamp: string;
    nonce: string;
}

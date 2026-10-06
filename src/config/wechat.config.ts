import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface WechatPayConfig {
    mchId: string;
    appId: string;
    /** Merchant certificate serial number used to sign Pay V3 requests. */
    serialNo: string;
    /** PEM content, or a path to the merchant private key file. */
    privateKey: string;
    /** APIv3 key used to decrypt Pay V3 callbacks and sensitive fields. */
    apiV3Key: string;
    /** Public URL WeChat calls back after a payment or refund. */
    notifyUrl: string;
    /** WeChat Pay public key (PEM or file path) — new merchant model. */
    publicKey: string;
    /** Public key id reported in the `Wechatpay-Serial` header. */
    publicKeyId: string;
    /** When true the billing adapter short-circuits with mock pay params. */
    mock: boolean;
}

export interface WechatMiniProgramConfig {
    appId: string;
    appSecret: string;
}

export interface WechatWebsiteConfig {
    appId: string;
    appSecret: string;
}

export interface WechatOfficialAccountConfig {
    appId: string;
    appSecret: string;
    /** Server configuration token used for SHA1 signature checks. */
    token: string;
    /** 43-character EncodingAESKey for safe-mode message encryption. */
    aesKey: string;
}

export interface WechatWorkConfig {
    corpId: string;
    corpSecret: string;
    agentId: string;
}

export interface WechatHttpConfig {
    timeoutMs: number;
    maxRetries: number;
}

export interface WechatConfig {
    pay: WechatPayConfig;
    miniprogram: WechatMiniProgramConfig;
    website: WechatWebsiteConfig;
    officialAccount: WechatOfficialAccountConfig;
    work: WechatWorkConfig;
    http: WechatHttpConfig;
}

function optionalInt(key: string, fallback: number): number {
    const parsed = parseInt(optionalEnv(key, String(fallback)), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * WeChat credentials for every product sub-package.
 *
 * All fields default to empty strings so an environment that does not use
 * WeChat still boots; the sub-packages validate what they actually need.
 */
export const wechatConfig = registerAs('wechat', (): WechatConfig => ({
    pay: {
        mchId: optionalEnv('WECHAT_PAY_MCHID', ''),
        appId: optionalEnv('WECHAT_PAY_APPID', ''),
        serialNo: optionalEnv('WECHAT_PAY_SERIAL_NO', ''),
        privateKey: optionalEnv('WECHAT_PAY_PRIVATE_KEY', ''),
        apiV3Key: optionalEnv('WECHAT_PAY_APIV3_KEY', ''),
        notifyUrl: optionalEnv('WECHAT_PAY_NOTIFY_URL', ''),
        publicKey: optionalEnv('WECHAT_PAY_PUBLIC_KEY', ''),
        publicKeyId: optionalEnv('WECHAT_PAY_PUBLIC_KEY_ID', ''),
        mock: optionalEnv('WECHAT_PAY_MOCK', 'true') !== 'false',
    },
    miniprogram: {
        appId: optionalEnv('WECHAT_MINI_APPID', ''),
        appSecret: optionalEnv('WECHAT_MINI_APPSECRET', ''),
    },
    website: {
        appId: optionalEnv('WECHAT_WEB_APPID', ''),
        appSecret: optionalEnv('WECHAT_WEB_APPSECRET', ''),
    },
    officialAccount: {
        appId: optionalEnv('WECHAT_OA_APPID', ''),
        appSecret: optionalEnv('WECHAT_OA_APPSECRET', ''),
        token: optionalEnv('WECHAT_OA_TOKEN', ''),
        aesKey: optionalEnv('WECHAT_OA_AES_KEY', ''),
    },
    work: {
        corpId: optionalEnv('WECHAT_WORK_CORPID', ''),
        corpSecret: optionalEnv('WECHAT_WORK_CORPSECRET', ''),
        agentId: optionalEnv('WECHAT_WORK_AGENTID', ''),
    },
    http: {
        timeoutMs: optionalInt('WECHAT_HTTP_TIMEOUT_MS', 8000),
        maxRetries: optionalInt('WECHAT_HTTP_MAX_RETRIES', 2),
    },
}));

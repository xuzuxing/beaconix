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

export type WechatScanLoginEnvVersion = 'release' | 'trial' | 'develop';

export interface WechatScanLoginConfig {
    /** Mini-program page that receives the QR `scene` param. Empty = home page. */
    qrPage: string;
    qrEnvVersion: WechatScanLoginEnvVersion;
    /** How long the Redis login ticket stays valid, in seconds. */
    ttlSeconds: number;
    /** Default long-poll timeout for the web client, in milliseconds. */
    pollTimeoutMs: number;
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

/**
 * 小程序虚拟支付（道具直购）。
 *
 * 与 Pay V3 完全独立的一套凭据：`offerId` + `appKey` 来自 MP 后台
 * 【虚拟支付 → 基本配置】，`paySig` 用 `appKey` 做 HMAC-SHA256。
 * 文档：https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person.html
 */
export interface WechatVirtualPayConfig {
    /** 虚拟支付 OfferID（虚拟支付商户号）。 */
    offerId: string;
    /** 现网 AppKey，`env = 0` 时用于 paySig 签名。 */
    appKey: string;
    /** 沙箱 AppKey，`env = 1` 时替代现网 AppKey。 */
    sandboxAppKey: string;
    /** 0 = 现网，1 = 沙箱。现网部署必须是 0（微信 -15011）。 */
    env: number;
    /** MP 后台【开发管理 → 消息推送】配置的 Token，明文模式验签用。 */
    pushToken: string;
    /** MP 后台【开发管理 → 消息推送】的 EncodingAESKey，安全模式解密推送用。 */
    pushAesKey: string;
    /** true 时不调用真实微信接口，便于无凭据联调。 */
    mock: boolean;
}

export interface WechatConfig {
    pay: WechatPayConfig;
    virtualPay: WechatVirtualPayConfig;
    miniprogram: WechatMiniProgramConfig;
    website: WechatWebsiteConfig;
    scanLogin: WechatScanLoginConfig;
    officialAccount: WechatOfficialAccountConfig;
    work: WechatWorkConfig;
    http: WechatHttpConfig;
}

function optionalInt(key: string, fallback: number): number {
    const parsed = parseInt(optionalEnv(key, String(fallback)), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function scanLoginEnvVersion(
    key: string,
    fallback: WechatScanLoginEnvVersion,
): WechatScanLoginEnvVersion {
    const raw = optionalEnv(key, fallback);
    // WeChat's API expects `develop`, but callers often write `developer`.
    return raw === 'developer' ? 'develop' : (raw as WechatScanLoginEnvVersion);
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
    virtualPay: {
        offerId: optionalEnv('WECHAT_VIRTUALPAY_OFFER_ID', ''),
        appKey: optionalEnv('WECHAT_VIRTUALPAY_APP_KEY', ''),
        sandboxAppKey: optionalEnv('WECHAT_VIRTUALPAY_SANDBOX_APP_KEY', ''),
        env: optionalInt('WECHAT_VIRTUALPAY_ENV', 0),
        pushToken: optionalEnv('WECHAT_VIRTUALPAY_PUSH_TOKEN', ''),
        pushAesKey: optionalEnv('WECHAT_VIRTUALPAY_PUSH_AES_KEY', ''),
        mock: optionalEnv('WECHAT_VIRTUALPAY_MOCK', 'true') !== 'false',
    },
    miniprogram: {
        appId: optionalEnv('WECHAT_MINI_APPID', ''),
        appSecret: optionalEnv('WECHAT_MINI_APPSECRET', ''),
    },
    website: {
        appId: optionalEnv('WECHAT_WEB_APPID', ''),
        appSecret: optionalEnv('WECHAT_WEB_APPSECRET', ''),
    },
    scanLogin: {
        qrPage: optionalEnv('WECHAT_SCAN_LOGIN_PAGE', ''),
        qrEnvVersion: scanLoginEnvVersion(
            'WECHAT_SCAN_LOGIN_ENV_VERSION',
            'release',
        ),
        ttlSeconds: optionalInt('WECHAT_SCAN_LOGIN_TTL_SECONDS', 300),
        pollTimeoutMs: optionalInt('WECHAT_SCAN_LOGIN_POLL_TIMEOUT_MS', 25000),
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

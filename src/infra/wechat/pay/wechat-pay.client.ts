import { Injectable, Logger } from '@nestjs/common';
import type { WechatPayConfig } from '../../../config';
import {
    WECHAT_PAY_BASE_URL,
    WechatHttpClient,
} from '../clients/wechat-http.client';
import { WechatRuntimeConfigService } from '../wechat-runtime-config.service';
import { WechatApiError, WechatConfigurationError } from '../wechat.types';
import { WechatPayCertificateService } from './wechat-pay-certificate.service';
import {
    buildAuthorizationHeader,
    buildResponseSignMessage,
    currentTimestamp,
    decryptResource,
    generateNonce,
    resolvePem,
    signMessage,
    verifyMessage,
} from './wechat-pay-signature.util';
import type {
    CreateJsapiTransactionInput,
    CreateRefundInput,
    WechatJsapiPayParams,
    WechatPayHeaderBag,
    WechatPayNotificationEnvelope,
    WechatPayRefund,
    WechatPayTransaction,
} from './wechat-pay.types';

const NOTIFICATION_MAX_SKEW_MS = 5 * 60 * 1000;
const JSAPI_TRANSACTIONS_PATH = '/v3/pay/transactions/jsapi';
const REFUNDS_PATH = '/v3/refund/domestic/refunds';

/** Case-insensitive header lookup for Express/Nest header bags. */
function readHeader(
    headers: WechatPayHeaderBag | undefined,
    name: string,
): string | undefined {
    if (!headers) return undefined;

    const target = name.toLowerCase();

    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== target) continue;
        return Array.isArray(value) ? value[0] : value;
    }

    return undefined;
}

/**
 * WeChat Pay V3 client: request signing, responses, refunds and callback
 * verification/decryption.
 *
 * Credentials are resolved lazily so an environment that keeps
 * `WECHAT_PAY_MOCK=true` boots without merchant keys.
 */
@Injectable()
export class WechatPayClient {
    private readonly logger = new Logger(WechatPayClient.name);
    private privateKeyPem?: string;

    constructor(
        private readonly http: WechatHttpClient,
        private readonly certificates: WechatPayCertificateService,
        private readonly runtimeConfig: WechatRuntimeConfigService,
    ) {}

    /** Creates a JSAPI transaction and returns its `prepay_id`. */
    async createJsapiTransaction(
        input: CreateJsapiTransactionInput,
    ): Promise<{ prepayId: string }> {
        const config = await this.requireCredentials();
        const notifyUrl = input.notifyUrl ?? config.notifyUrl;

        if (!notifyUrl) {
            throw new WechatConfigurationError(
                'WECHAT_PAY_NOTIFY_URL is required to create a WeChat Pay transaction',
            );
        }

        const response = await this.signedRequest<{ prepay_id?: string }>(
            'POST',
            JSAPI_TRANSACTIONS_PATH,
            {
                appid: config.appId,
                mchid: config.mchId,
                description: input.description,
                out_trade_no: input.outTradeNo,
                notify_url: notifyUrl,
                amount: { total: input.totalFee, currency: 'CNY' },
                payer: { openid: input.openid },
                ...(input.timeExpire ? { time_expire: input.timeExpire } : {}),
                ...(input.attach ? { attach: input.attach } : {}),
            },
        );

        if (!response.prepay_id) {
            throw new WechatApiError({
                platform: 'pay',
                endpoint: JSAPI_TRANSACTIONS_PATH,
                errmsg: 'WeChat Pay response is missing prepay_id',
            });
        }

        return { prepayId: response.prepay_id };
    }

    /** Builds the `wx.requestPayment` params from a `prepay_id`. */
    async buildJsapiPayParams(prepayId: string): Promise<WechatJsapiPayParams> {
        const config = await this.requireCredentials();
        const timeStamp = currentTimestamp();
        const nonceStr = generateNonce();
        const packageStr = `prepay_id=${prepayId}`;

        const paySign = signMessage(
            `${config.appId}\n${timeStamp}\n${nonceStr}\n${packageStr}\n`,
            await this.getPrivateKey(),
        );

        return {
            timeStamp,
            nonceStr,
            package: packageStr,
            signType: 'RSA',
            paySign,
        };
    }

    async queryTransaction(outTradeNo: string): Promise<WechatPayTransaction> {
        const config = await this.requireCredentials();

        return this.signedRequest<WechatPayTransaction>(
            'GET',
            `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchId)}`,
        );
    }

    async closeTransaction(outTradeNo: string): Promise<void> {
        const config = await this.requireCredentials();

        await this.signedRequest<Record<string, never>>(
            'POST',
            `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`,
            { mchid: config.mchId },
        );
    }

    async createRefund(input: CreateRefundInput): Promise<WechatPayRefund> {
        const config = await this.requireCredentials();
        const notifyUrl = input.notifyUrl ?? config.notifyUrl;

        return this.signedRequest<WechatPayRefund>('POST', REFUNDS_PATH, {
            out_refund_no: input.outRefundNo,
            ...(input.transactionId
                ? { transaction_id: input.transactionId }
                : { out_trade_no: input.outTradeNo }),
            ...(notifyUrl ? { notify_url: notifyUrl } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
            amount: {
                refund: input.refundFee,
                total: input.totalFee,
                currency: 'CNY',
            },
        });
    }

    async queryRefund(outRefundNo: string): Promise<WechatPayRefund> {
        return this.signedRequest<WechatPayRefund>(
            'GET',
            `${REFUNDS_PATH}/${encodeURIComponent(outRefundNo)}`,
        );
    }

    /** Forces a refresh of the cached platform certificates. */
    refreshPlatformCertificates(): Promise<number> {
        return this.certificates.refreshPlatformCertificates();
    }

    /**
     * Verifies the notification signature, decrypts the resource block and
     * returns the transaction payload.
     */
    async parseNotification(
        rawBody: string,
        headers: WechatPayHeaderBag,
    ): Promise<WechatPayTransaction> {
        const plaintext = await this.verifyAndDecrypt(
            rawBody,
            headers,
            'POST /v3/notify/transactions',
        );

        return JSON.parse(plaintext) as WechatPayTransaction;
    }

    /**
     * 退款结果通知（`/v3/refund/domestic/notifications`）。
     *
     * 与交易通知同一套验签 + AES-GCM 解密，只有 endpoint 名（错误上下文）
     * 与解密后的报文结构不同：退款通知里是 `WechatPayRefund`。
     */
    async parseRefundNotification(
        rawBody: string,
        headers: WechatPayHeaderBag,
    ): Promise<WechatPayRefund> {
        const plaintext = await this.verifyAndDecrypt(
            rawBody,
            headers,
            'POST /v3/refund/domestic/notifications',
        );

        return JSON.parse(plaintext) as WechatPayRefund;
    }

    /** 通知通用流程：头校验 → 时间窗 → 平台证书验签 → AES-GCM 解密。 */
    private async verifyAndDecrypt(
        rawBody: string,
        headers: WechatPayHeaderBag,
        endpoint: string,
    ): Promise<string> {
        const timestamp = readHeader(headers, 'wechatpay-timestamp');
        const nonce = readHeader(headers, 'wechatpay-nonce');
        const signature = readHeader(headers, 'wechatpay-signature');
        const serial = readHeader(headers, 'wechatpay-serial');

        if (!timestamp || !nonce || !signature || !serial) {
            throw new WechatApiError({
                platform: 'pay',
                endpoint,
                errmsg: 'Missing WeChat Pay signature headers',
            });
        }

        const timestampMs = Number(timestamp) * 1000;

        if (
            !Number.isFinite(timestampMs) ||
            Math.abs(Date.now() - timestampMs) > NOTIFICATION_MAX_SKEW_MS
        ) {
            throw new WechatApiError({
                platform: 'pay',
                endpoint,
                errmsg: 'WeChat Pay notification timestamp is outside the allowed window',
            });
        }

        const verifier = await this.certificates.getVerifier(serial);
        const message = buildResponseSignMessage(timestamp, nonce, rawBody);

        if (!verifyMessage(message, signature, verifier)) {
            throw new WechatApiError({
                platform: 'pay',
                endpoint,
                errmsg: 'WeChat Pay notification signature verification failed',
            });
        }

        const envelope = this.parseEnvelope(rawBody, endpoint);
        const { apiV3Key } = await this.runtimeConfig.pay();

        return decryptResource(apiV3Key, envelope.resource);
    }

    // -- Helpers ---------------------------------------------------------

    private parseEnvelope(
        rawBody: string,
        endpoint: string,
    ): WechatPayNotificationEnvelope {
        let envelope: WechatPayNotificationEnvelope;

        try {
            envelope = JSON.parse(rawBody) as WechatPayNotificationEnvelope;
        } catch {
            throw new WechatApiError({
                platform: 'pay',
                endpoint,
                errmsg: 'WeChat Pay notification body is not valid JSON',
            });
        }

        if (!envelope || typeof envelope !== 'object' || !envelope.resource) {
            throw new WechatApiError({
                platform: 'pay',
                endpoint,
                errmsg: 'WeChat Pay notification is missing the resource block',
            });
        }

        return envelope;
    }

    private async signedRequest<T>(
        method: 'GET' | 'POST',
        urlPath: string,
        body?: unknown,
    ): Promise<T> {
        const config = await this.requireCredentials();
        const timestamp = currentTimestamp();
        const nonce = generateNonce();
        const bodyText = body === undefined ? undefined : JSON.stringify(body);

        const authorization = buildAuthorizationHeader({
            mchId: config.mchId,
            serialNo: config.serialNo,
            privateKeyPem: await this.getPrivateKey(),
            method,
            urlPath,
            body: bodyText,
            timestamp,
            nonce,
        });

        return this.http.request<T>(
            method,
            `${WECHAT_PAY_BASE_URL}${urlPath}`,
            body,
            {
                platform: 'pay',
                headers: { authorization, accept: 'application/json' },
                retries: method === 'GET' ? 1 : 0,
            },
        );
    }

    private async getPrivateKey(): Promise<string> {
        if (!this.privateKeyPem) {
            const { privateKey } = await this.requireCredentials();
            this.privateKeyPem = resolvePem(
                privateKey,
                'WECHAT_PAY_PRIVATE_KEY',
            );
        }

        return this.privateKeyPem;
    }

    private async requireCredentials(): Promise<WechatPayConfig> {
        const config = await this.runtimeConfig.pay();
        const missing = (
            ['mchId', 'appId', 'serialNo', 'privateKey', 'apiV3Key'] as const
        ).filter((key) => !config[key]);

        if (missing.length > 0) {
            throw new WechatConfigurationError(
                `WeChat Pay is not configured; missing ${missing.join(', ')}`,
            );
        }

        return config;
    }
}

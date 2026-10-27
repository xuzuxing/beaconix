import { Injectable, Logger } from '@nestjs/common';
import { AlipaySdk } from 'alipay-sdk';
import { existsSync, readFileSync } from 'node:fs';
import type { AlipayConfig } from '../../config';
import {
    ALIPAY_PRODUCTION_GATEWAY,
    ALIPAY_SANDBOX_GATEWAY,
} from '../../config';
import { AlipayRuntimeConfigService } from './alipay-runtime-config.service';
import {
    ALIPAY_PRODUCT_CODE,
    AlipayApiError,
    AlipayConfigurationError,
    AlipayPayMethod,
    type AlipayCashierRequest,
    type AlipayNotifyParams,
    type AlipayPrecreateRequest,
    type AlipayPrecreateResult,
    type AlipayRefundApiResult,
    type AlipayRefundRequest,
} from './alipay.types';

/**
 * 支付宝开放平台接口的薄封装，签名/验签/网关细节全部交给官方 `alipay-sdk`。
 *
 * 只保留计费流程需要三件事：
 * - 网页/手机网站收银台：拼出可 GET 跳转的 URL（`pageExec`）；
 * - 当面付（扫码）：`precreate` 拿到 `qr_code` 支付链接；
 * - 异步通知验签：`checkNotifySign`。
 *
 * 所有方法都在调用时读运行时配置（管理页改了 30 秒内生效），SDK 实例按配置
 * 指纹缓存，配置不变就不重建。
 */
@Injectable()
export class AlipayClient {
    private readonly logger = new Logger(AlipayClient.name);
    private cached?: { fingerprint: string; sdk: AlipaySdk };

    constructor(private readonly runtimeConfig: AlipayRuntimeConfigService) {}

    /**
     * 生成收银台 URL：`GET` 过去就是支付宝的付款页。
     *
     * 只有 `page.pay` / `wap.pay` 适用；扫码走 {@link precreate}。
     */
    async buildCashierUrl(request: AlipayCashierRequest): Promise<string> {
        const { sdk, config } = await this.sdk();
        const method = AlipayPayMethod.PAGE;

        return sdk.pageExec(method, {
            method: 'GET',
            bizContent: this.bizContent(method, request),
            ...this.callbackParams(config, request),
        });
    }

    /** 手机浏览器收银台（`wap.pay`）。 */
    async buildWapCashierUrl(request: AlipayCashierRequest): Promise<string> {
        const { sdk, config } = await this.sdk();
        const method = AlipayPayMethod.WAP;

        return sdk.pageExec(method, {
            method: 'GET',
            bizContent: this.bizContent(method, request),
            ...this.callbackParams(config, request),
        });
    }

    /**
     * 当面付（扫码）预下单：返回支付宝生成的 `qr_code`。
     *
     * 这一步是服务端到服务端的调用（`exec`），会把订单推进到「等待用户扫码」，
     * 所以只在真实渠道下使用（`alipay.mock=true` 时由 provider 拦掉）。
     */
    async precreate(
        request: AlipayPrecreateRequest,
    ): Promise<AlipayPrecreateResult> {
        const { sdk, config } = await this.sdk();
        const method = AlipayPayMethod.PRECREATE;

        const result = await sdk.exec(method, {
            bizContent: this.bizContent(method, request),
            // 扫码没有浏览器跳转，`return_url` 无意义，不上送。
            ...this.callbackParams(config, request, false),
        });

        const qrCode = result?.qrCode;

        if (result?.code !== '10000' || typeof qrCode !== 'string' || !qrCode) {
            throw new AlipayApiError(
                `Alipay precreate failed: ${result?.subMsg ?? result?.msg ?? 'unknown error'}`,
                result?.code,
                result?.subCode,
            );
        }

        return { qrCode };
    }

    /**
     * 异步通知验签。
     *
     * 参数是支付宝按字典序拼接后签名的，`checkNotifySign` 会剔除 `sign` /
     * `sign_type` 与空值，所以入库前不需要我们手工拼串。
     */
    async verifyNotify(params: AlipayNotifyParams): Promise<boolean> {
        const { sdk } = await this.sdk();

        try {
            // `checkNotifySignV2` 不再对 value 做第二次 decode：`params` 已经由
            // `parseNotifyParams` 解码过（`%20` → 空格，`+` 保持原样）。默认的
            // `checkNotifySign` 会再 `decodeURIComponent` 一遍，形成双重解码。
            return sdk.checkNotifySignV2(params);
        } catch (error) {
            this.logger.warn(
                `Alipay notify verification threw: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );

            return false;
        }
    }

    /**
     * 提交退款（`alipay.trade.refund`）。
     *
     * 支付宝的退款是**同步**的：接口返回即终态，没有退款回调。幂等键是
     * `out_request_no`，同号重复请求返回同一笔结果（`fund_change = N`）。
     */
    async refund(request: AlipayRefundRequest): Promise<AlipayRefundApiResult> {
        const { sdk } = await this.sdk();

        return await sdk.exec('alipay.trade.refund', {
            bizContent: {
                outTradeNo: request.outTradeNo,
                refundAmount: request.refundAmount,
                outRequestNo: request.outRefundNo,
                ...(request.reason ? { refundReason: request.reason } : {}),
            },
        });
    }

    /** 查询退款（`alipay.trade.fastpay.refund.query`），兜底轮询用。 */
    async queryRefund(request: {
        outTradeNo: string;
        outRefundNo: string;
    }): Promise<AlipayRefundApiResult> {
        const { sdk } = await this.sdk();

        return await sdk.exec('alipay.trade.fastpay.refund.query', {
            bizContent: {
                outTradeNo: request.outTradeNo,
                outRequestNo: request.outRefundNo,
            },
        });
    }

    // -- 内部 ------------------------------------------------------------

    private bizContent(
        method: AlipayPayMethod,
        request: AlipayCashierRequest,
    ): Record<string, string> {
        return {
            outTradeNo: request.outTradeNo,
            totalAmount: request.totalAmount,
            subject: request.subject,
            productCode: ALIPAY_PRODUCT_CODE[method],
        };
    }

    /**
     * `notify_url` / `return_url` 从入参回退到配置；两者都为空的键直接不传，
     * 否则 SDK 会把 `undefined` 也当成参数拼进签名串。
     */
    private callbackParams(
        config: AlipayConfig,
        request: AlipayCashierRequest,
        includeReturnUrl = true,
    ): Record<string, string> {
        const notifyUrl = (request.notifyUrl ?? '').trim() || config.notifyUrl;
        const returnUrl = (request.returnUrl ?? '').trim() || config.returnUrl;
        const params: Record<string, string> = {};

        if (!notifyUrl) {
            // 没有异步通知就只能靠同步跳转判断到账，而同步跳转可在地址栏伪造。
            throw new AlipayConfigurationError(
                'alipay.notifyUrl is not configured: Alipay cannot confirm payments without it',
            );
        }

        params['notifyUrl'] = notifyUrl;

        if (includeReturnUrl && returnUrl) {
            params['returnUrl'] = returnUrl;
        }

        return params;
    }

    private async sdk(): Promise<{ sdk: AlipaySdk; config: AlipayConfig }> {
        const config = await this.runtimeConfig.config();
        const gateway = this.gateway(config);
        const privateKey = this.resolveKey(
            config.privateKey,
            'alipay.privateKey',
        );
        const alipayPublicKey = this.resolveKey(
            config.publicKey,
            'alipay.publicKey',
        );

        if (!config.appId) {
            throw new AlipayConfigurationError(
                'alipay.appId is not configured',
            );
        }

        const fingerprint = [
            config.appId,
            gateway,
            config.signType,
            privateKey,
            alipayPublicKey,
        ].join('|');

        if (this.cached?.fingerprint === fingerprint) {
            return { sdk: this.cached.sdk, config };
        }

        const sdk = new AlipaySdk({
            appId: config.appId,
            privateKey,
            alipayPublicKey,
            gateway,
            signType: config.signType,
            // 私钥类型不传会按 PKCS1 重新包一层头，PKCS8 私钥会直接报
            // `ERR_OSSL_UNSUPPORTED`，所以必须按 PEM 头显式指定。
            keyType: privateKey.includes('BEGIN RSA PRIVATE KEY')
                ? 'PKCS1'
                : 'PKCS8',
            // 响应字段统一成驼峰（`qr_code` → `qrCode`），与 SDK 默认一致。
            camelcase: true,
        });

        this.cached = { fingerprint, sdk };

        return { sdk, config };
    }

    private gateway(config: AlipayConfig): string {
        if (config.sandbox) return ALIPAY_SANDBOX_GATEWAY;

        return config.gateway || ALIPAY_PRODUCTION_GATEWAY;
    }

    /**
     * 密钥支持三种写法：PEM 全文、服务器上的文件路径、以及支付宝密钥工具
     * 导出的裸 base64（没有头尾，SDK 自己会补）。
     */
    private resolveKey(value: string, label: string): string {
        const trimmed = (value ?? '').trim();

        if (trimmed === '') {
            throw new AlipayConfigurationError(`${label} is not configured`);
        }

        if (trimmed.includes('-----BEGIN')) {
            return trimmed;
        }

        if (existsSync(trimmed)) {
            return readFileSync(trimmed, 'utf8').trim();
        }

        return trimmed;
    }
}

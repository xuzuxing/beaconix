import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentChannel } from '../../../generated/prisma/enums';
import {
    WechatPayClient,
    type WechatPayRefund,
} from '../../../infra/wechat/pay';
import { WechatRuntimeConfigService } from '../../../infra/wechat/wechat-runtime-config.service';
import { WechatApiError } from '../../../infra/wechat/wechat.types';
import type {
    PaymentCallbackHeaders,
    PaymentProvider,
    PaymentProviderCallbackResult,
    PaymentProviderCreateInput,
    PaymentProviderPayParams,
    PaymentProviderRefundCallback,
    PaymentProviderRefundInput,
    PaymentProviderRefundResult,
} from './payment-provider.interface';

/**
 * WeChat Pay adapter.
 *
 * `WECHAT_PAY_MOCK=true` (the default) keeps the billing flow runnable without
 * merchant credentials. Once `WECHAT_PAY_MOCK=false` and the Pay V3 config is
 * complete, calls are delegated to `WechatPayClient` from `infra/wechat`.
 */
@Injectable()
export class WechatPaymentService implements PaymentProvider {
    readonly channel = PaymentChannel.WECHAT;

    constructor(
        private readonly payClient: WechatPayClient,
        private readonly runtimeConfig: WechatRuntimeConfigService,
    ) {}

    async createPayment(
        input: PaymentProviderCreateInput,
    ): Promise<PaymentProviderPayParams> {
        if (await this.mockEnabled()) {
            return this.mockPayParams(input);
        }

        // JSAPI 必须有 openid；DTO 现在把 openid 设为可选（支付宝渠道不需要），
        // 所以这里补一条显式校验，避免把 undefined 当 openid 发给微信。
        if (!input.payerId) {
            throw new BadRequestException('openid is required for WeChat Pay');
        }

        const { prepayId } = await this.payClient.createJsapiTransaction({
            description: input.body,
            outTradeNo: input.outTradeNo,
            totalFee: input.totalFee,
            openid: input.payerId,
            ...(input.expiresAt
                ? { timeExpire: input.expiresAt.toISOString() }
                : {}),
        });

        return this.payClient.buildJsapiPayParams(prepayId);
    }

    async verifyCallback(
        rawBody: string,
        signature: string,
        headers?: PaymentCallbackHeaders,
    ): Promise<PaymentProviderCallbackResult> {
        if (await this.mockEnabled()) {
            return JSON.parse(rawBody) as PaymentProviderCallbackResult;
        }

        const notificationHeaders: PaymentCallbackHeaders = { ...headers };

        if (signature) {
            notificationHeaders['wechatpay-signature'] = signature;
        }

        return this.payClient.parseNotification(rawBody, notificationHeaders);
    }

    async queryPayment(
        outTradeNo: string,
    ): Promise<PaymentProviderCallbackResult> {
        if (await this.mockEnabled()) {
            return {
                out_trade_no: outTradeNo,
                transaction_id: '',
                trade_state: 'NOTPAY',
            };
        }
        return this.payClient.queryTransaction(outTradeNo);
    }

    async closePayment(outTradeNo: string): Promise<void> {
        if (!(await this.mockEnabled()))
            await this.payClient.closeTransaction(outTradeNo);
    }

    /**
     * 提交退款（`/v3/refund/domestic/refunds`）。
     *
     * 微信是异步确认的：接口返回 `PROCESSING` 很正常，最终结果走退款回调
     * 或 `queryRefund`，绝不能把 `PROCESSING` 当失败处理。
     */
    async refund(
        input: PaymentProviderRefundInput,
    ): Promise<PaymentProviderRefundResult> {
        if (await this.mockEnabled()) {
            return {
                status: 'SUCCESS',
                channelRefundId: `mock_refund_${input.outRefundNo}`,
                raw: { mock: true },
            };
        }

        const refund = await this.payClient.createRefund({
            outRefundNo: input.outRefundNo,
            outTradeNo: input.outTradeNo,
            transactionId: input.transactionId,
            refundFee: input.refundFee,
            totalFee: input.totalFee,
            reason: input.reason,
        });

        return mapWechatRefund(refund);
    }

    async queryRefund(input: {
        refundNo: string;
        outTradeNo?: string;
    }): Promise<PaymentProviderRefundResult> {
        if (await this.mockEnabled()) {
            return { status: 'SUCCESS', raw: { mock: true } };
        }

        try {
            return mapWechatRefund(
                await this.payClient.queryRefund(input.refundNo),
            );
        } catch (error) {
            if (
                error instanceof WechatApiError &&
                error.code === 'RESOURCE_NOT_EXISTS'
            ) {
                return { status: 'PROCESSING', notFound: true };
            }
            throw error;
        }
    }

    /**
     * 解析退款结果通知（`/v3/refund/domestic/notifications`）。
     *
     * mock 模式下直接读 JSON，方便本地把整条退款链路跑通。
     */
    async parseRefundCallback(
        rawBody: string,
        signature: string,
        headers?: PaymentCallbackHeaders,
    ): Promise<PaymentProviderRefundCallback> {
        if (await this.mockEnabled()) {
            const parsed = JSON.parse(rawBody) as {
                out_refund_no?: string;
                refund_id?: string;
                refund_status?: string;
                status?: string;
                amount?: { refund?: number; total?: number; currency?: string };
                out_trade_no?: string;
                transaction_id?: string;
            };

            return {
                outRefundNo: parsed.out_refund_no ?? '',
                channelRefundId: parsed.refund_id,
                status: mapWechatRefundStatus(
                    parsed.refund_status ?? parsed.status,
                ),
                raw: parsed,
                refundFee: parsed.amount?.refund,
                totalFee: parsed.amount?.total,
                currency: parsed.amount?.currency,
                outTradeNo: parsed.out_trade_no,
                transactionId: parsed.transaction_id,
            };
        }

        const notificationHeaders: PaymentCallbackHeaders = { ...headers };

        if (signature) {
            notificationHeaders['wechatpay-signature'] = signature;
        }

        const refund = await this.payClient.parseRefundNotification(
            rawBody,
            notificationHeaders,
        );

        return {
            outRefundNo: refund.out_refund_no,
            channelRefundId: refund.refund_id,
            status: mapWechatRefundStatus(
                refund.refund_status ?? refund.status,
            ),
            raw: refund,
            refundFee: refund.amount?.refund,
            totalFee: refund.amount?.total,
            currency: refund.amount?.currency,
            outTradeNo: refund.out_trade_no,
            transactionId: refund.transaction_id,
        };
    }

    private async mockEnabled(): Promise<boolean> {
        const { mock } = await this.runtimeConfig.pay();

        return mock;
    }

    private mockPayParams(
        input: PaymentProviderCreateInput,
    ): PaymentProviderPayParams {
        return {
            timeStamp: Math.floor(Date.now() / 1000).toString(),
            nonceStr: Math.random().toString(36).slice(2),
            package: `prepay_id=mock_${input.outTradeNo}`,
            signType: 'RSA',
            paySign: `mock_sign_${input.outTradeNo}`,
        };
    }
}

/**
 * 微信退款状态 → 平台状态。
 *
 * `ABNORMAL` 是「退款到银行卡失败」之类的异常单，需要人工介入；在平台侧
 * 先保持 `PROCESSING`，避免自动重试把问题放大。
 */
export function mapWechatRefundStatus(
    status: string | undefined,
): PaymentProviderRefundResult['status'] {
    switch (status) {
        case 'SUCCESS':
            return 'SUCCESS';
        case 'PROCESSING':
        case 'ABNORMAL':
            return 'PROCESSING';
        default:
            // CLOSED 以及未知值：请求未生效，可以安全重试。
            return 'FAILED';
    }
}

function mapWechatRefund(refund: WechatPayRefund): PaymentProviderRefundResult {
    const status = mapWechatRefundStatus(refund.status);

    return {
        status,
        channelRefundId: refund.refund_id,
        failureReason:
            status === 'FAILED'
                ? `WeChat refund status: ${refund.status ?? 'unknown'}`
                : undefined,
        raw: refund,
        refundFee: refund.amount?.refund,
        totalFee: refund.amount?.total,
    };
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentChannel } from '../../../generated/prisma/enums';
import {
    AlipayApiError,
    AlipayClient,
    AlipayPayMethod,
    AlipayRuntimeConfigService,
    ALIPAY_SUCCESS_TRADE_STATUSES,
} from '../../../infra/alipay';
import type {
    PaymentProvider,
    PaymentProviderCallbackResult,
    PaymentProviderCreateInput,
    PaymentProviderPayParams,
} from './payment-provider.interface';

/** 未指定时的默认产品码：PC 收银台。 */
const DEFAULT_PAY_METHOD = AlipayPayMethod.PAGE;

/**
 * 支付宝适配器。
 *
 * `alipay.mock=true`（默认）时不调用支付宝接口，返回模拟参数，保证无凭证也能
 * 跑通「下单 → 回调 → 开通订阅」；关闭 mock 且填好凭证后走真实收银台。
 */
@Injectable()
export class AlipayPaymentService implements PaymentProvider {
    readonly channel = PaymentChannel.ALIPAY;

    constructor(
        private readonly client: AlipayClient,
        private readonly runtimeConfig: AlipayRuntimeConfigService,
    ) {}

    async createPayment(
        input: PaymentProviderCreateInput,
    ): Promise<PaymentProviderPayParams> {
        const config = await this.runtimeConfig.config();
        const payMethod = payMethodOf(input.payMethod);
        const outTradeNo = input.outTradeNo;
        // 订单金额是「分」（Int），支付宝要「元」的两位小数字符串。
        const totalAmount = yuanFromFen(input.totalFee);
        const subject = input.body;

        if (config.mock) {
            return this.mockPayParams({ outTradeNo, totalAmount, payMethod });
        }

        // 扫码（native）：服务端预下单换 `qr_code`，前端自己渲染二维码。
        if (payMethod === AlipayPayMethod.PRECREATE) {
            const { qrCode } = await this.client.precreate({
                outTradeNo,
                totalAmount,
                subject,
                notifyUrl: config.notifyUrl,
                returnUrl: config.returnUrl,
            });

            return {
                payMethod,
                outTradeNo,
                totalAmount,
                qrCode,
                // `payUrl` 与 `qrCode` 同值：调用方只认一个字段也能用。
                payUrl: qrCode,
            };
        }

        const request = {
            outTradeNo,
            totalAmount,
            subject,
            notifyUrl: config.notifyUrl,
            returnUrl: config.returnUrl,
        };
        const payUrl =
            payMethod === AlipayPayMethod.WAP
                ? await this.client.buildWapCashierUrl(request)
                : await this.client.buildCashierUrl(request);

        return { payMethod, outTradeNo, totalAmount, payUrl };
    }

    /**
     * 解析并验签异步通知。
     *
     * 关键映射：支付宝的 `TRADE_SUCCESS` / `TRADE_FINISHED` 都归一成 `SUCCESS`，
     * 因为 `PaymentService.handleCallback` 只认 `trade_state === 'SUCCESS'`。
     */
    async verifyCallback(
        rawBody: string,
    ): Promise<PaymentProviderCallbackResult> {
        const config = await this.runtimeConfig.config();
        const params = parseNotifyParams(rawBody);
        const outTradeNo = params['out_trade_no'];

        if (!outTradeNo) {
            throw new AlipayApiError(
                'Alipay notification is missing out_trade_no',
            );
        }

        if (!config.mock) {
            if (!(await this.client.verifyNotify(params))) {
                throw new AlipayApiError(
                    'Alipay notification signature verification failed',
                );
            }

            // 多应用共用同一把公钥时，app_id 不匹配意味着这条通知不属于本应用。
            const appId = params['app_id'];
            if (config.appId && appId && appId !== config.appId) {
                throw new AlipayApiError(
                    `Alipay notification app_id ${appId} does not match the configured app`,
                );
            }
        }

        const tradeStatus = params['trade_status'] ?? '';

        return {
            out_trade_no: outTradeNo,
            transaction_id: params['trade_no'] ?? '',
            trade_state: ALIPAY_SUCCESS_TRADE_STATUSES.includes(tradeStatus)
                ? 'SUCCESS'
                : tradeStatus,
            trade_status: tradeStatus,
            total_amount: params['total_amount'],
            app_id: params['app_id'],
        };
    }

    // -- 内部 ------------------------------------------------------------

    private mockPayParams(input: {
        outTradeNo: string;
        totalAmount: string;
        payMethod: AlipayPayMethod;
    }): PaymentProviderPayParams {
        const query = new URLSearchParams({
            mock: 'true',
            method: input.payMethod,
            out_trade_no: input.outTradeNo,
            total_amount: input.totalAmount,
        }).toString();
        const payUrl = `https://openapi.alipay.com/gateway.do?${query}`;

        return {
            payMethod: input.payMethod,
            outTradeNo: input.outTradeNo,
            totalAmount: input.totalAmount,
            payUrl,
            ...(input.payMethod === AlipayPayMethod.PRECREATE
                ? { qrCode: payUrl }
                : {}),
        };
    }
}

/** 校验并归一 `payMethod`；不传或非法值都按默认的 PC 收银台处理。 */
export function payMethodOf(value: string | undefined): AlipayPayMethod {
    const methods = Object.values(AlipayPayMethod);

    return methods.includes(value as AlipayPayMethod)
        ? (value as AlipayPayMethod)
        : DEFAULT_PAY_METHOD;
}

/**
 * 分 → 元的两位小数字符串。
 *
 * 用整数取余而不是 `(fen / 100).toFixed(2)`：浮点除法的结果在极端值上可能
 * 落到 `x.999999`，促销价一分钱都不能差。
 */
export function yuanFromFen(fen: number): string {
    if (!Number.isInteger(fen) || fen < 0) {
        throw new BadRequestException(
            `Order amount must be a non-negative integer in cents, got ${fen}`,
        );
    }

    const yuan = Math.floor(fen / 100);
    const cents = fen % 100;

    return `${yuan}.${String(cents).padStart(2, '0')}`;
}

/**
 * 异步通知是 `application/x-www-form-urlencoded`：解析成字典并剔除空值，
 * 与支付宝验签时的拼接规则保持一致（空值参与拼接会必然验签失败）。
 */
export function parseNotifyParams(rawBody: string): Record<string, string> {
    const params: Record<string, string> = {};

    for (const [key, value] of new URLSearchParams(rawBody ?? '')) {
        if (value === '') continue;
        params[key] = value;
    }

    return params;
}

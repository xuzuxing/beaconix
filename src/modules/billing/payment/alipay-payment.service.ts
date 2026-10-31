import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentChannel } from '../../../generated/prisma/enums';
import {
    AlipayApiError,
    AlipayClient,
    AlipayPayMethod,
    AlipayRuntimeConfigService,
    ALIPAY_SUCCESS_TRADE_STATUSES,
    type AlipayRefundApiResult,
} from '../../../infra/alipay';
import type {
    PaymentProvider,
    PaymentProviderCallbackResult,
    PaymentProviderCreateInput,
    PaymentProviderPayParams,
    PaymentProviderRefundInput,
    PaymentProviderRefundResult,
} from './payment-provider.interface';

/** 未指定时的默认产品码：PC 收银台。 */
const DEFAULT_PAY_METHOD = AlipayPayMethod.PAGE;

/**
 * 异步通知被拒绝的原因码，挂在 `AlipayApiError.code` 上。
 *
 * 回调入口据此判断「这是外部输入的问题（回 `failure`，不抛 5xx）」，也方便
 * 运维直接搜码定位，不必去比对_message_。
 */
export const ALIPAY_NOTIFY_ERROR_CODES = {
    /** 报文里没有 `out_trade_no`：不是本平台的支付通知（多为探测/配置错）。 */
    MISSING_OUT_TRADE_NO: 'NOTIFY_MISSING_OUT_TRADE_NO',
    /** 验签不通过：伪造报文，或公钥与支付宝后台不一致。 */
    SIGN_INVALID: 'NOTIFY_SIGN_INVALID',
    /** app_id 不属于本应用：同一把公钥被多个应用共用时的串台通知。 */
    APP_ID_MISMATCH: 'NOTIFY_APP_ID_MISMATCH',
} as const;

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
                ...(input.expiresAt
                    ? { timeExpire: alipayExpiry(input.expiresAt) }
                    : {}),
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
            ...(input.expiresAt
                ? { timeExpire: alipayExpiry(input.expiresAt) }
                : {}),
        };
        const payUrl =
            payMethod === AlipayPayMethod.WAP
                ? await this.client.buildWapCashierUrl(request)
                : await this.client.buildCashierUrl(request);

        return { payMethod, outTradeNo, totalAmount, payUrl };
    }

    async queryPayment(
        outTradeNo: string,
    ): Promise<PaymentProviderCallbackResult> {
        if ((await this.runtimeConfig.config()).mock) {
            return {
                out_trade_no: outTradeNo,
                transaction_id: '',
                trade_state: 'NOTPAY',
            };
        }
        const result = await this.client.queryTransaction(outTradeNo);
        if (result.code !== '10000') {
            if (result.subCode === 'ACQ.TRADE_NOT_EXIST') {
                return {
                    out_trade_no: outTradeNo,
                    transaction_id: '',
                    trade_state: 'NOTPAY',
                };
            }
            throw new AlipayApiError(
                `Alipay query failed: ${result.subMsg ?? result.msg ?? 'unknown error'}`,
                result.code,
                result.subCode,
            );
        }
        return {
            out_trade_no: result.outTradeNo ?? outTradeNo,
            transaction_id: result.tradeNo ?? '',
            trade_state: ALIPAY_SUCCESS_TRADE_STATUSES.includes(
                result.tradeStatus ?? '',
            )
                ? 'SUCCESS'
                : result.tradeStatus === 'TRADE_CLOSED'
                  ? 'CLOSED'
                  : (result.tradeStatus ?? 'NOTPAY'),
            total_amount: result.totalAmount,
        };
    }

    async closePayment(outTradeNo: string): Promise<void> {
        if (!(await this.runtimeConfig.config()).mock)
            await this.client.closeTransaction(outTradeNo);
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
                `Alipay notification is missing out_trade_no${describeNotifyBody(params, rawBody)}`,
                ALIPAY_NOTIFY_ERROR_CODES.MISSING_OUT_TRADE_NO,
            );
        }

        if (!config.mock) {
            if (!(await this.client.verifyNotify(params))) {
                throw new AlipayApiError(
                    `Alipay notification signature verification failed${describeNotifyBody(params, rawBody)}`,
                    ALIPAY_NOTIFY_ERROR_CODES.SIGN_INVALID,
                );
            }

            // 多应用共用同一把公钥时，app_id 不匹配意味着这条通知不属于本应用。
            const appId = params['app_id'];
            if (config.appId && appId && appId !== config.appId) {
                throw new AlipayApiError(
                    `Alipay notification app_id ${appId} does not match the configured app ${config.appId}`,
                    ALIPAY_NOTIFY_ERROR_CODES.APP_ID_MISMATCH,
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

    /**
     * 提交退款（`alipay.trade.refund`）。
     *
     * 支付宝退款是同步的，接口返回即终态；金额单位要换算成元。
     */
    async refund(
        input: PaymentProviderRefundInput,
    ): Promise<PaymentProviderRefundResult> {
        const config = await this.runtimeConfig.config();

        if (config.mock) {
            return {
                status: 'SUCCESS',
                raw: { mock: true, outRefundNo: input.outRefundNo },
            };
        }

        const result = await this.client.refund({
            outTradeNo: input.outTradeNo,
            outRefundNo: input.outRefundNo,
            // 平台内金额是分，支付宝要元的两位小数字符串
            refundAmount: yuanFromFen(input.refundFee),
            reason: input.reason,
        });

        return mapAlipayRefundResult(result);
    }

    async queryRefund(input: {
        refundNo: string;
        outTradeNo: string;
    }): Promise<PaymentProviderRefundResult> {
        const config = await this.runtimeConfig.config();

        if (config.mock) {
            return { status: 'SUCCESS', raw: { mock: true } };
        }

        return mapAlipayRefundQuery(
            await this.client.queryRefund({
                outTradeNo: input.outTradeNo,
                outRefundNo: input.refundNo,
            }),
        );
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

/** Alipay expects its expiry timestamp in China Standard Time. */
function alipayExpiry(expiresAt: Date): string {
    return new Date(expiresAt.getTime() + 8 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
}

/**
 * `alipay.trade.refund` 的响应 → 平台退款结果。
 *
 * `fund_change = N` 表示「本次没有资金变动」：同号重复请求（幂等重放）会这样
 * 返回，仍然算成功——钱只退了一次。
 */
export function mapAlipayRefundResult(
    result: AlipayRefundApiResult,
): PaymentProviderRefundResult {
    if (result.code !== '10000') {
        // These business responses explicitly reject this refund. Transport
        // errors and unrecognized/system codes remain uncertain to the caller.
        if (
            result.code === '40004' &&
            [
                'ACQ.SELLER_BALANCE_NOT_ENOUGH',
                'ACQ.TRADE_NOT_EXIST',
                'ACQ.TRADE_STATUS_ERROR',
                'ACQ.REFUND_AMT_NOT_EQUAL_TOTAL',
            ].includes(result.subCode ?? '')
        )
            return {
                status: 'FAILED',
                failureReason: result.subMsg ?? result.msg ?? result.subCode,
                raw: result,
            };
        throw new AlipayApiError(
            `Alipay refund failed: ${result.subMsg ?? result.msg ?? 'unknown error'}`,
            result.code,
            result.subCode,
        );
    }

    return { status: 'SUCCESS', raw: result };
}

/**
 * `alipay.trade.fastpay.refund.query` 的响应 → 平台退款结果。
 *
 * 查不到（`code != 10000`）只能算「处理中」：支付宝可能还没落账，
 * 判失败会让轮询把正常退款标成失败。
 */
export function mapAlipayRefundQuery(
    result: AlipayRefundApiResult,
): PaymentProviderRefundResult {
    if (result.code !== '10000') {
        return {
            status: 'PROCESSING',
            raw: result,
            ...(['ACQ.TRADE_NOT_EXIST', 'ACQ.REFUND_NOT_EXIST'].includes(
                result.subCode ?? '',
            )
                ? { notFound: true }
                : {}),
        };
    }

    return {
        status:
            result.refundStatus === 'REFUND_SUCCESS' ? 'SUCCESS' : 'PROCESSING',
        raw: result,
    };
}

export function parseNotifyParams(rawBody: string): Record<string, string> {
    const params = new Map<string, string>();

    for (const pair of (rawBody ?? '').split('&')) {
        if (!pair) continue;
        const separatorIndex = pair.indexOf('=');
        const rawKey =
            separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);
        const key = decodeNotifyComponent(rawKey.replace(/\+/g, ' '));
        if (!key) continue;
        const rawValue =
            separatorIndex === -1 ? '' : pair.slice(separatorIndex + 1);
        const value = key === 'sign' ? rawValue : rawValue.replace(/\+/g, ' ');

        params.set(key, decodeNotifyComponent(value));
    }

    return Object.fromEntries(params);
}

function decodeNotifyComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * 给「通知被拒绝」的异常补一段可诊断的上下文。
 *
 * 只列**参数名**和报文长度，绝不带值：通知里有 `buyer_logon_id`、`sign`
 * 之类的敏感/冗长内容，落到日志里既没必要也难读。排查时最需要知道的正是
 * 「到底收到了什么参数」——完全空报文（探测/健康检查打到回调地址）与
 * 「有参数但键名不对（notify_url 配错应用）」靠这一行就能分开。
 */
export function describeNotifyBody(
    params: Record<string, string>,
    rawBody: string,
): string {
    const names = Object.keys(params);
    const bytes = Buffer.byteLength(rawBody ?? '', 'utf8');

    if (names.length === 0) {
        return ` (empty notification body, ${bytes} bytes received)`;
    }

    const shown = names.slice(0, 12).join(', ');
    const more = names.length > 12 ? `, +${names.length - 12} more` : '';

    return ` (received params: ${shown}${more}; ${bytes} bytes)`;
}

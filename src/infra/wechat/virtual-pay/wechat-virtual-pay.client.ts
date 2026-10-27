import { Injectable, Logger } from '@nestjs/common';
import { WechatHttpClient } from '../clients/wechat-http.client';
import {
    WechatTokenService,
    withAccessToken,
} from '../clients/wechat-token.service';
import { WechatConfigurationError } from '../wechat.types';
import { WechatRuntimeConfigService } from '../wechat-runtime-config.service';
import {
    buildVirtualPaySignData,
    calcVirtualPaySig,
    calcVirtualPayUserSignature,
    normalizeVirtualPayEnv,
    VIRTUAL_PAY_REQUEST_URI,
} from './wechat-virtual-pay-signature.util';
import type {
    VirtualPayNotifyProvideGoodsInput,
    VirtualPayOrder,
    VirtualPayPayData,
    VirtualPayQueryOrderInput,
    VirtualPayRefundOrderInput,
    VirtualPayRefundNotify,
    WechatVirtualPayEnv,
} from './wechat-virtual-pay.types';
import {
    VIRTUAL_PAY_MODE_GOODS,
    VIRTUAL_PAY_ORDER_STATUS,
} from './wechat-virtual-pay.types';

const QUERY_ORDER_PATH = '/xpay/query_order';
const REFUND_ORDER_PATH = '/xpay/refund_order';
const NOTIFY_PROVIDE_GOODS_PATH = '/xpay/notify_provide_goods';

export interface BuildVirtualPayDataInput {
    productId: string;
    /** 道具单价（分），必须与 MP 后台道具价格一致。 */
    goodsPrice: number;
    /** 业务单号，每次下单重新生成。 */
    outTradeNo: string;
    /** 透传数据（我们放 orderNo），发货推送原样带回。 */
    attach: string;
    /** `auth.code2Session` 得到的 sessionKey，用于用户态签名。 */
    sessionKey: string;
    buyQuantity?: number;
}

interface QueryOrderResponse {
    errcode?: number;
    errmsg?: string;
    order?: {
        order_id?: string;
        status?: number;
        order_type?: number;
        order_fee?: number;
        paid_fee?: number;
        refund_fee?: number;
        wx_order_id?: string;
        paid_time?: number;
        biz_meta?: string;
        env_type?: number;
    };
}

/**
 * 微信虚拟支付服务端客户端。
 *
 * 只负责协议层：签名、`access_token`、B 端接口调用与响应归一化。业务语义
 * （下单、发货、幂等、退款）在 billing 模块里。
 *
 * 所有 B 端请求的 `pay_sig` 都签在**实际发出的 body 原文**上，因此统一用
 * `postRawJson` 发送同一个字符串——被重新序列化的 body 会让签名失效。
 */
@Injectable()
export class WechatVirtualPayClient {
    private readonly logger = new Logger(WechatVirtualPayClient.name);

    constructor(
        private readonly http: WechatHttpClient,
        private readonly tokens: WechatTokenService,
        private readonly runtimeConfig: WechatRuntimeConfigService,
    ) {}

    /** 是否处于模拟模式：不调用真实微信接口，便于无凭据联调。 */
    async isMock(): Promise<boolean> {
        const { mock } = await this.runtimeConfig.virtualPay();

        return mock;
    }

    /** 当前生效的环境标识（0 现网 / 1 沙箱）与 AppKey。 */
    async credentials(): Promise<{
        offerId: string;
        appKey: string;
        env: WechatVirtualPayEnv;
        mock: boolean;
    }> {
        const config = await this.runtimeConfig.virtualPay();
        const env = normalizeVirtualPayEnv(config.env);
        // 沙箱（env = 1）必须用沙箱 AppKey 签名。绝不能静默回退到现网 AppKey，
        // 否则会出现「signData 声明 env=1、签名却用现网密钥」的自相矛盾请求，
        // 微信可能据此按现网处理，导致用户被真实扣款。
        const appKey = env === 1 ? config.sandboxAppKey : config.appKey;

        if (!config.mock) {
            if (!config.offerId) {
                throw new WechatConfigurationError(
                    'WeChat virtual payment is not configured (wechat.virtualPay.offerId / WECHAT_VIRTUALPAY_OFFER_ID)',
                );
            }
            if (env === 1 && !appKey) {
                throw new WechatConfigurationError(
                    'WeChat virtual payment sandbox AppKey is required when env = 1 (wechat.virtualPay.sandboxAppKey / WECHAT_VIRTUALPAY_SANDBOX_APP_KEY)',
                );
            }
            if (!appKey) {
                throw new WechatConfigurationError(
                    'WeChat virtual payment is not configured (wechat.virtualPay.appKey / WECHAT_VIRTUALPAY_APP_KEY)',
                );
            }
        }

        return { offerId: config.offerId, appKey, env, mock: config.mock };
    }

    /**
     * 生成 `wx.requestVirtualPayment` 的 payData。
     *
     * `signData` 会被返回给前端原样传给微信，`paySig` / `signature` 都签在这个
     * 同一个字符串上。
     */
    async buildPayData(
        input: BuildVirtualPayDataInput,
    ): Promise<VirtualPayPayData> {
        const { offerId, appKey, env, mock } = await this.credentials();

        const signData = buildVirtualPaySignData({
            offerId,
            buyQuantity: input.buyQuantity ?? 1,
            env,
            productId: input.productId,
            goodsPrice: input.goodsPrice,
            outTradeNo: input.outTradeNo,
            attach: input.attach,
        });

        if (mock && !appKey) {
            // 无凭据联调：给出结构正确的假签名，前端流程本身可以跑通。
            return {
                signData,
                mode: VIRTUAL_PAY_MODE_GOODS,
                paySig: `mock_pay_sig_${input.outTradeNo}`,
                signature: `mock_signature_${input.outTradeNo}`,
            };
        }

        return {
            signData,
            mode: VIRTUAL_PAY_MODE_GOODS,
            paySig: calcVirtualPaySig(
                appKey,
                VIRTUAL_PAY_REQUEST_URI,
                signData,
            ),
            signature: calcVirtualPayUserSignature(input.sessionKey, signData),
        };
    }

    /**
     * 查单（`/xpay/query_order`）。发货兜底与推送反查都用它。
     *
     * 模拟模式下返回「已创建、未支付」——绝不凭空造出已支付，避免误发货。
     */
    async queryOrder(
        input: VirtualPayQueryOrderInput,
    ): Promise<VirtualPayOrder> {
        const { appKey, mock } = await this.credentials();

        if (mock) {
            this.logger.debug(
                `[mock] query_order ${input.outTradeNo}: treated as unpaid`,
            );

            return {
                orderId: input.outTradeNo,
                status: VIRTUAL_PAY_ORDER_STATUS.CREATED,
                orderType: null,
                orderFee: null,
                paidFee: null,
                refundFee: null,
                wxOrderId: null,
                paidTime: null,
                bizMeta: null,
                envType: null,
            };
        }

        const body = JSON.stringify({
            openid: input.openid,
            env: input.env,
            order_id: input.outTradeNo,
        });

        const result = await this.callXpay<QueryOrderResponse>(
            QUERY_ORDER_PATH,
            appKey,
            body,
        );
        const order = result.order ?? {};

        return {
            orderId: order.order_id ?? input.outTradeNo,
            status: order.status ?? VIRTUAL_PAY_ORDER_STATUS.INIT,
            orderType: order.order_type ?? null,
            orderFee: order.order_fee ?? null,
            paidFee: order.paid_fee ?? null,
            refundFee: order.refund_fee ?? null,
            wxOrderId: order.wx_order_id ?? null,
            paidTime: order.paid_time ?? null,
            bizMeta: order.biz_meta ?? null,
            envType: order.env_type ?? null,
        };
    }

    /**
     * 发起退款（`/xpay/refund_order`）。该接口只是「启动退款任务」，最终状态
     * 需要用 `query_order` 查，退款完成还会收到 `xpay_refund_notify`。
     */
    async refundOrder(input: VirtualPayRefundOrderInput): Promise<void> {
        const { appKey, mock } = await this.credentials();

        if (mock) {
            this.logger.debug(`[mock] refund_order ${input.outTradeNo}`);
            return;
        }

        const body = JSON.stringify({
            openid: input.openid,
            order_id: input.outTradeNo,
            refund_order_id: input.refundOrderId,
            left_fee: input.leftFee,
            refund_fee: input.refundFee,
            biz_meta: input.bizMeta,
            refund_reason: input.reason,
            req_from: input.reqFrom,
            env: input.env,
        });

        await this.callXpay(REFUND_ORDER_PATH, appKey, body);
    }

    /**
     * 通知平台「已发货完成」。正常走发货推送的应答就不需要它，只在推送
     * 丢失、又不想等兜底查单时作为补偿手段。
     */
    async notifyProvideGoods(
        input: VirtualPayNotifyProvideGoodsInput,
    ): Promise<void> {
        const { appKey, mock } = await this.credentials();

        if (mock) {
            this.logger.debug(
                `[mock] notify_provide_goods ${input.outTradeNo}`,
            );
            return;
        }

        const body = JSON.stringify({
            openid: input.openid,
            env: input.env,
            order_id: input.outTradeNo,
        });

        await this.callXpay(NOTIFY_PROVIDE_GOODS_PATH, appKey, body);
    }

    /** 退款推送里的字段归一化入口，供 billing 复用同一套解析。 */
    toRefundSummary(notify: VirtualPayRefundNotify): {
        outTradeNo: string;
        refundFee: number | null;
    } {
        return { outTradeNo: notify.outTradeNo, refundFee: notify.refundFee };
    }

    private async callXpay<T = Record<string, unknown>>(
        path: string,
        appKey: string,
        body: string,
    ): Promise<T> {
        const { appId, appSecret } = await this.runtimeConfig.miniprogram();

        if (!appId || !appSecret) {
            throw new WechatConfigurationError(
                'WeChat mini program credentials are required for virtual payment (WECHAT_MINI_APPID / WECHAT_MINI_APPSECRET)',
            );
        }

        // pay_sig 签在 body 原文上：uri 用路径、不带 query。
        const paySig = calcVirtualPaySig(appKey, path, body);

        return withAccessToken(
            this.tokens,
            { kind: 'mp', appId, appSecret },
            (accessToken) =>
                this.http.postRawJson<T>(path, body, {
                    query: { access_token: accessToken, pay_sig: paySig },
                    retries: 0,
                }),
            this.logger,
        );
    }
}

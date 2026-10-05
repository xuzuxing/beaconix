import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WechatConfig } from '../../../config';
import { PaymentChannel } from '../../../generated/prisma/enums';
import { WechatPayClient } from '../../../infra/wechat/pay';
import type {
    PaymentCallbackHeaders,
    PaymentProvider,
    PaymentProviderCallbackResult,
    PaymentProviderCreateInput,
    PaymentProviderPayParams,
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
        private readonly configService: ConfigService,
    ) {}

    async createPayment(
        input: PaymentProviderCreateInput,
    ): Promise<PaymentProviderPayParams> {
        if (this.mockEnabled) {
            return this.mockPayParams(input);
        }

        const { prepayId } = await this.payClient.createJsapiTransaction({
            description: input.body,
            outTradeNo: input.outTradeNo,
            totalFee: input.totalFee,
            openid: input.payerId,
        });

        return this.payClient.buildJsapiPayParams(prepayId);
    }

    async verifyCallback(
        rawBody: string,
        signature: string,
        headers?: PaymentCallbackHeaders,
    ): Promise<PaymentProviderCallbackResult> {
        if (this.mockEnabled) {
            return JSON.parse(rawBody) as PaymentProviderCallbackResult;
        }

        const notificationHeaders: PaymentCallbackHeaders = { ...headers };

        if (signature) {
            notificationHeaders['wechatpay-signature'] = signature;
        }

        return this.payClient.parseNotification(rawBody, notificationHeaders);
    }

    private get mockEnabled(): boolean {
        return this.configService.get<WechatConfig>('wechat')?.pay.mock ?? true;
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

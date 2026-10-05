import { Injectable } from '@nestjs/common';
import { PaymentChannel } from '../../../generated/prisma/enums';
import type {
    PaymentProvider,
    PaymentProviderCallbackResult,
    PaymentProviderCreateInput,
    PaymentProviderPayParams,
} from './payment-provider.interface';

/**
 * WeChat Pay adapter. The default mock keeps the billing flow runnable
 * without WeChat credentials; set WECHAT_PAY_MOCK=false to use the real
 * implementation once merchant credentials are configured.
 */
@Injectable()
export class WechatPaymentService implements PaymentProvider {
    readonly channel = PaymentChannel.WECHAT;

    private readonly mockEnabled = process.env['WECHAT_PAY_MOCK'] !== 'false';

    createPayment(
        input: PaymentProviderCreateInput,
    ): Promise<PaymentProviderPayParams> {
        if (!this.mockEnabled) {
            return Promise.reject(
                new Error(
                    'WeChat Pay is not configured. Set WECHAT_PAY_MOCK=true in development.',
                ),
            );
        }

        return Promise.resolve({
            timeStamp: Math.floor(Date.now() / 1000).toString(),
            nonceStr: Math.random().toString(36).slice(2),
            package: `prepay_id=mock_${input.outTradeNo}`,
            signType: 'RSA',
            paySign: `mock_sign_${input.outTradeNo}`,
        });
    }

    verifyCallback(
        rawBody: string,
        signature: string,
    ): Promise<PaymentProviderCallbackResult> {
        void signature;

        if (!this.mockEnabled) {
            return Promise.reject(
                new Error(
                    'WeChat Pay is not configured. Set WECHAT_PAY_MOCK=true in development.',
                ),
            );
        }

        return Promise.resolve(
            JSON.parse(rawBody) as PaymentProviderCallbackResult,
        );
    }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentChannel } from '../../../generated/prisma/enums';
import { AlipayPaymentService } from './alipay-payment.service';
import type {
    PaymentProvider,
    RefundProvider,
} from './payment-provider.interface';
import { WechatPaymentService } from './wechat-payment.service';

@Injectable()
export class PaymentProviderFactory {
    private readonly providers = new Map<PaymentChannel, PaymentProvider>();
    /** 退款能力单独一张表：虚拟支付只退款、不实现 `PaymentProvider`。 */
    private readonly refundProviders = new Map<
        PaymentChannel,
        RefundProvider
    >();

    constructor(
        wechatPaymentService: WechatPaymentService,
        alipayPaymentService: AlipayPaymentService,
    ) {
        this.register(wechatPaymentService);
        this.register(alipayPaymentService);
    }

    /** Register a provider. Called from the constructor for built-in channels. */
    register(provider: PaymentProvider): void {
        this.providers.set(provider.channel, provider);
        // 支付 provider 都带退款能力，一并登记，省去调用方分两次注册。
        this.refundProviders.set(provider.channel, provider);
    }

    /** 登记只有退款能力的渠道（虚拟支付由 `RefundProviderRegistrar` 注册）。 */
    registerRefundProvider(provider: RefundProvider): void {
        this.refundProviders.set(provider.channel, provider);
    }

    get(channel: PaymentChannel): PaymentProvider {
        const provider = this.providers.get(channel);

        if (!provider) {
            throw new BadRequestException(
                `Unsupported payment channel: ${channel}`,
            );
        }

        return provider;
    }

    getRefundProvider(channel: PaymentChannel): RefundProvider {
        const provider = this.refundProviders.get(channel);

        if (!provider) {
            throw new BadRequestException(
                `Unsupported refund channel: ${channel}`,
            );
        }

        return provider;
    }
}

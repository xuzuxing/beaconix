import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentChannel } from '../../../generated/prisma/enums';
import { AlipayPaymentService } from './alipay-payment.service';
import type { PaymentProvider } from './payment-provider.interface';
import { WechatPaymentService } from './wechat-payment.service';

@Injectable()
export class PaymentProviderFactory {
    private readonly providers = new Map<PaymentChannel, PaymentProvider>();

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
}

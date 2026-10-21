import { BadRequestException } from '@nestjs/common';
import type { AlipayPaymentService } from './alipay-payment.service';
import { PaymentProviderFactory } from './payment-provider.factory';
import type { PaymentProvider } from './payment-provider.interface';
import type { WechatPaymentService } from './wechat-payment.service';

function provider(channel: string): PaymentProvider {
    return {
        channel,
        createPayment: jest.fn(),
        verifyCallback: jest.fn(),
    } as unknown as PaymentProvider;
}

function createFactory() {
    const wechat = provider('WECHAT');
    const alipay = provider('ALIPAY');

    const factory = new PaymentProviderFactory(
        wechat as unknown as WechatPaymentService,
        alipay as unknown as AlipayPaymentService,
    );

    return { factory, wechat, alipay };
}

describe('PaymentProviderFactory', () => {
    it('returns the provider registered for the channel', () => {
        const { factory, wechat } = createFactory();

        expect(factory.get('WECHAT')).toBe(wechat);
    });

    it('registers the Alipay provider for ALIPAY', () => {
        const { factory, alipay } = createFactory();

        expect(factory.get('ALIPAY')).toBe(alipay);
    });

    it('rejects channels without a registered provider', () => {
        const { factory } = createFactory();

        expect(() => factory.get('WECHAT_VIRTUAL')).toThrow(
            BadRequestException,
        );
    });

    it('allows registering additional providers dynamically', () => {
        const { factory } = createFactory();
        const stripe = provider('STRIPE');

        factory.register(stripe);

        expect(factory.get('STRIPE' as never)).toBe(stripe);
    });
});

import { BadRequestException } from '@nestjs/common';
import { PaymentProviderFactory } from './payment-provider.factory';
import type { PaymentProvider } from './payment-provider.interface';
import type { WechatPaymentService } from './wechat-payment.service';

function createFactory() {
    const wechat = {
        channel: 'WECHAT',
        createPayment: jest.fn(),
        verifyCallback: jest.fn(),
    } as unknown as WechatPaymentService;

    const factory = new PaymentProviderFactory(wechat);

    return { factory, wechat };
}

describe('PaymentProviderFactory', () => {
    it('returns the provider registered for the channel', () => {
        const { factory, wechat } = createFactory();

        expect(factory.get('WECHAT')).toBe(wechat);
    });

    it('rejects channels without a registered provider', () => {
        const { factory } = createFactory();

        expect(() => factory.get('ALIPAY' as never)).toThrow(
            BadRequestException,
        );
    });

    it('allows registering additional providers dynamically', () => {
        const { factory } = createFactory();
        const alipay = {
            channel: 'ALIPAY',
            createPayment: jest.fn(),
            verifyCallback: jest.fn(),
        } as unknown as PaymentProvider;

        factory.register(alipay);

        expect(factory.get('ALIPAY' as never)).toBe(alipay);
    });
});

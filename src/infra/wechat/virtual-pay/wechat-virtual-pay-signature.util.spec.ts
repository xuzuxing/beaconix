import { createHmac } from 'node:crypto';
import {
    buildVirtualPaySignData,
    calcVirtualPaySig,
    calcVirtualPayUserSignature,
    normalizeVirtualPayEnv,
    VIRTUAL_PAY_REQUEST_URI,
} from './wechat-virtual-pay-signature.util';

/** 与实现同构的独立计算，用来确认 `uri + '&' + body` 的拼法与密钥顺序。 */
function hmacHex(key: string, message: string): string {
    return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

describe('wechat virtual pay signatures', () => {
    const signDataInput = {
        offerId: '1450000000',
        buyQuantity: 1,
        env: 0 as const,
        productId: 'beacon_pro_month',
        goodsPrice: 2900,
        outTradeNo: 'V1A2B3C4D5E6F7G8',
        attach: 'BWMB3KXABC123',
    };

    it('serializes signData in the documented field order', () => {
        expect(buildVirtualPaySignData(signDataInput)).toBe(
            '{"offerId":"1450000000","buyQuantity":1,"env":0,"currencyType":"CNY",' +
                '"productId":"beacon_pro_month","goodsPrice":2900,' +
                '"outTradeNo":"V1A2B3C4D5E6F7G8","attach":"BWMB3KXABC123"}',
        );
    });

    it('escapes values instead of concatenating them raw', () => {
        const signData = buildVirtualPaySignData({
            ...signDataInput,
            attach: 'quote"and\\backslash',
        });

        expect(() => JSON.parse(signData)).not.toThrow();
        expect(JSON.parse(signData).attach).toBe('quote"and\\backslash');
    });

    it('signs paySig over `requestVirtualPayment&<signData>` with the AppKey', () => {
        const signData = buildVirtualPaySignData(signDataInput);
        const paySig = calcVirtualPaySig(
            'app-key-secret',
            VIRTUAL_PAY_REQUEST_URI,
            signData,
        );

        expect(VIRTUAL_PAY_REQUEST_URI).toBe('requestVirtualPayment');
        expect(paySig).toBe(
            hmacHex('app-key-secret', `requestVirtualPayment&${signData}`),
        );
        expect(paySig).toMatch(/^[0-9a-f]{64}$/);
    });

    it('signs the user signature with the sessionKey and no uri prefix', () => {
        const signData = buildVirtualPaySignData(signDataInput);

        expect(calcVirtualPayUserSignature('session-key-value', signData)).toBe(
            hmacHex('session-key-value', signData),
        );
    });

    it('changes the signature when a single byte of signData changes', () => {
        const signData = buildVirtualPaySignData(signDataInput);
        const tampered = buildVirtualPaySignData({
            ...signDataInput,
            goodsPrice: 2901,
        });

        expect(
            calcVirtualPaySig('k', 'requestVirtualPayment', signData),
        ).not.toBe(calcVirtualPaySig('k', 'requestVirtualPayment', tampered));
    });

    it('normalizes the environment flag to 0/1 only', () => {
        expect(normalizeVirtualPayEnv(1)).toBe(1);
        expect(normalizeVirtualPayEnv(0)).toBe(0);
        expect(normalizeVirtualPayEnv(7)).toBe(0);
    });
});

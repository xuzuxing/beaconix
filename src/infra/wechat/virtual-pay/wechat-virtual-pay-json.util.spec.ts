import {
    buildXpayJsonFailReply,
    buildXpayJsonSuccessReply,
    parseXpayJson,
} from './wechat-virtual-pay-json.util';

describe('wechat virtual pay json payloads', () => {
    it('parses a push object as-is', () => {
        const root = parseXpayJson(
            '{"Event":"xpay_goods_deliver_notify","OutTradeNo":"V1A2B3C4D5E6F7G8","WeChatPayInfo":{"MchOrderNo":"wx_1"}}',
        );

        expect(root['Event']).toBe('xpay_goods_deliver_notify');
        expect(root['OutTradeNo']).toBe('V1A2B3C4D5E6F7G8');
        expect(
            (root['WeChatPayInfo'] as Record<string, unknown>)['MchOrderNo'],
        ).toBe('wx_1');
    });

    it('rejects malformed or non-object payloads', () => {
        expect(() => parseXpayJson('<xml/>')).toThrow(/invalid JSON/);
        expect(() => parseXpayJson('[]')).toThrow(/expected a JSON object/);
        expect(() => parseXpayJson('null')).toThrow(/expected a JSON object/);
        expect(() => parseXpayJson('"text"')).toThrow(/expected a JSON object/);
    });

    it('builds the acknowledged replies', () => {
        expect(buildXpayJsonSuccessReply()).toBe(
            '{"ErrCode":0,"ErrMsg":"success"}',
        );
        expect(buildXpayJsonFailReply('boom')).toBe(
            '{"ErrCode":-1,"ErrMsg":"boom"}',
        );
        // 失败原因要截断，避免把内部细节整段回给平台
        expect(
            JSON.parse(buildXpayJsonFailReply('x'.repeat(500))).ErrMsg,
        ).toHaveLength(120);
    });
});

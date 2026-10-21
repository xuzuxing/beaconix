import {
    buildXpayFailReply,
    buildXpaySuccessReply,
    parseDeliverNotify,
    parseRefundNotify,
    parseXpayXml,
    readXpayEvent,
} from './wechat-virtual-pay-xml.util';

const DELIVER_XML = `<xml>
  <ToUserName><![CDATA[gh_1234567890ab]]></ToUserName>
  <FromUserName><![CDATA[o_official_openid]]></FromUserName>
  <CreateTime>1700000000</CreateTime>
  <MsgType><![CDATA[event]]></MsgType>
  <Event><![CDATA[xpay_goods_deliver_notify]]></Event>
  <OpenId><![CDATA[o_user_openid]]></OpenId>
  <OutTradeNo><![CDATA[V1A2B3C4D5E6F7G8]]></OutTradeNo>
  <Env>0</Env>
  <WeChatPayInfo>
    <MchOrderNo><![CDATA[wx_order_123456]]></MchOrderNo>
    <TransactionId><![CDATA[420000123420260101]]></TransactionId>
    <PaidTime>1700000100</PaidTime>
  </WeChatPayInfo>
  <GoodsInfo>
    <ProductId><![CDATA[beacon_pro_month]]></ProductId>
    <Quantity>2</Quantity>
    <OrigPrice>2900</OrigPrice>
    <ActualPrice>5800</ActualPrice>
    <Attach><![CDATA[BWMB3KXABC123]]></Attach>
  </GoodsInfo>
</xml>`;

const REFUND_XML = `<xml>
  <Event><![CDATA[xpay_refund_notify]]></Event>
  <OpenId><![CDATA[o_user_openid]]></OpenId>
  <OutTradeNo><![CDATA[V1A2B3C4D5E6F7G8]]></OutTradeNo>
  <Env>0</Env>
  <WeChatPayInfo>
    <MchOrderNo><![CDATA[wx_order_123456]]></MchOrderNo>
    <RefundId><![CDATA[wx_refund_3000001]]></RefundId>
    <RefundFee>2900</RefundFee>
    <OrderFee>2900</OrderFee>
    <RefundTime>1700000200</RefundTime>
  </WeChatPayInfo>
</xml>`;

describe('wechat virtual pay xml', () => {
    it('parses a goods deliver notify', () => {
        const root = parseXpayXml(DELIVER_XML);

        expect(readXpayEvent(root)).toBe('xpay_goods_deliver_notify');

        expect(parseDeliverNotify(root)).toEqual({
            openId: 'o_user_openid',
            outTradeNo: 'V1A2B3C4D5E6F7G8',
            env: 0,
            wxOrderId: 'wx_order_123456',
            transactionId: '420000123420260101',
            paidTime: 1700000100,
            productId: 'beacon_pro_month',
            quantity: 2,
            origPrice: 2900,
            actualPrice: 5800,
            attach: 'BWMB3KXABC123',
        });
    });

    it('parses a refund notify', () => {
        const notify = parseRefundNotify(parseXpayXml(REFUND_XML));

        expect(notify).toMatchObject({
            outTradeNo: 'V1A2B3C4D5E6F7G8',
            wxOrderId: 'wx_order_123456',
            refundId: 'wx_refund_3000001',
            refundFee: 2900,
            orderFee: 2900,
            refundTime: 1700000200,
        });
    });

    it('rejects a payload without OutTradeNo', () => {
        const root = parseXpayXml('<xml><Event>other</Event></xml>');

        expect(() => parseDeliverNotify(root)).toThrow(/OutTradeNo/);
    });

    it('rejects XML without the <xml> root', () => {
        expect(() => parseXpayXml('<root><a>1</a></root>')).toThrow(/no <xml>/);
    });

    it('does not expand entities from the payload', () => {
        const root = parseXpayXml(
            '<xml><Event>&lt;script&gt;</Event><OutTradeNo>T1</OutTradeNo></xml>',
        );

        // processEntities: false → 原文保留，不会被还原成 <script>
        expect(readXpayEvent(root)).toBe('&lt;script&gt;');
    });

    it('builds the documented success and failure replies', () => {
        expect(buildXpaySuccessReply()).toBe(
            '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>',
        );
        expect(buildXpayFailReply('order not found')).toBe(
            '<xml><ErrCode>-1</ErrCode><ErrMsg><![CDATA[order not found]]></ErrMsg></xml>',
        );
        // 应答里的 ErrMsg 不能带 CDATA 终结符，否则前端解析会截断
        expect(buildXpayFailReply('bad ]]> value')).not.toContain(']]]]>');
    });
});

describe('inline payload shapes', () => {
    it('parses a compact single-line goods notify (mixed CDATA/plain values)', () => {
        // 微信实际推送的是紧凑单行 XML：CDATA 紧挨着下一个标签。
        const xml =
            '<xml><ToUserName><![CDATA[gh_1]]></ToUserName>' +
            '<Event><![CDATA[xpay_goods_deliver_notify]]></Event>' +
            '<OpenId><![CDATA[o_user_openid]]></OpenId>' +
            '<OutTradeNo><![CDATA[VABC123456789]]></OutTradeNo>' +
            '<Env>0</Env>' +
            '<WeChatPayInfo><MchOrderNo><![CDATA[wx_order_1]]></MchOrderNo>' +
            '<PaidTime>1700000100</PaidTime></WeChatPayInfo>' +
            '<GoodsInfo><ProductId><![CDATA[beacon_pro_month]]></ProductId>' +
            '<Quantity>1</Quantity><OrigPrice>2900</OrigPrice>' +
            '<ActualPrice>1</ActualPrice>' +
            '<Attach><![CDATA[BWMB3KXABC123]]></Attach></GoodsInfo></xml>';

        const notify = parseDeliverNotify(parseXpayXml(xml));

        expect(notify.actualPrice).toBe(1);
        expect(notify.outTradeNo).toBe('VABC123456789');
        expect(notify.attach).toBe('BWMB3KXABC123');
    });
});

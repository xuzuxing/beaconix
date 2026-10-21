import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    Req,
    Res,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, Public, SkipTransform } from '../../../common/decorators';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { PaymentChannel } from '../../../generated/prisma/enums';
import { CreatePaymentDto } from './dto';
import type { PaymentCallbackHeaders } from './payment-provider.interface';
import { PaymentService } from './payment.service';
import { WechatVirtualPaymentService } from './wechat-virtual-payment.service';
import { RefundService } from '../refund/refund.service';

/** Case-insensitive header lookup for Express/Nest header bags. */
function readHeader(
    headers: PaymentCallbackHeaders | undefined,
    name: string,
): string | undefined {
    if (!headers) return undefined;

    const target = name.toLowerCase();

    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== target) continue;
        return Array.isArray(value) ? value[0] : value;
    }

    return undefined;
}

@ApiTags('Billing / Payment')
@ApiBearerAuth('access-token')
@Controller()
export class PaymentController {
    constructor(
        private readonly paymentService: PaymentService,
        private readonly virtualPayService: WechatVirtualPaymentService,
        private readonly refundService: RefundService,
    ) {}

    @Post('orders/:id/pay')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Create a payment for an order',
        description:
            '`WECHAT` returns JSAPI params for `wx.requestPayment` (web/H5). `WECHAT_VIRTUAL` returns `signData` + `paySig` + `signature` for `wx.requestVirtualPayment` inside the mini program, and requires a fresh `wx.login()` code.',
    })
    @ApiParam({ name: 'id', description: 'Order CUID' })
    @ApiBody({ type: CreatePaymentDto })
    @ApiOkResponse({
        description:
            'Payment params: JSAPI fields for WECHAT, virtual-payment payData for WECHAT_VIRTUAL',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    async pay(
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: CreatePaymentDto,
    ) {
        if (dto.channel === PaymentChannel.WECHAT_VIRTUAL) {
            return this.virtualPayService.createPayment(id, user.sub, dto);
        }

        return this.paymentService.createPayment(id, user.sub, dto);
    }

    /**
     * 支付宝异步通知（`ALIPAY_NOTIFY_URL` 指向这里）。
     *
     * 支付宝只认**纯文本 `success`**（不带引号、不是 JSON），返回别的内容或
     * 非 2xx 都会让它按 4m/10m/10m/1h/2h/6h/15h 的节奏重试。验签在 provider
     * 层用 `alipay-sdk` 完成，之后与微信共用渠道无关的幂等结算逻辑。
     */
    @Post('payment/alipay/callback')
    @Public()
    @SkipTransform()
    @ApiOperation({
        summary: 'Alipay async notification (idempotent)',
        description:
            'Form-urlencoded notification, verified with the Alipay public key. Answers the bare text `success` on success and `failure` otherwise.',
    })
    @ApiBody({
        description: 'Alipay form-urlencoded notification parameters',
        schema: { type: 'object', additionalProperties: { type: 'string' } },
    })
    @ApiOkResponse({ description: 'text/plain: success | failure' })
    async alipayCallback(
        @Req() request: RawBodyRequest<Request>,
        @Body() body: Record<string, string | string[]>,
        @Res({ passthrough: true }) response: Response,
    ) {
        // 验签对象就是这份 form-urlencoded 参数字典；`rawBody` 是原始字节，
        // 没有时用解析后的 body 重新拼（等价，参数顺序不参与验签）。
        const rawBody =
            request.rawBody?.toString('utf8') ??
            new URLSearchParams(
                Object.entries(body ?? {}).flatMap(([key, value]) =>
                    Array.isArray(value)
                        ? value.map((item) => [key, item])
                        : [[key, value]],
                ),
            ).toString();

        const result = await this.paymentService.handleAlipayCallback(rawBody);

        response.status(HttpStatus.OK).type('text/plain');

        return result.code === 'SUCCESS' ? 'success' : 'failure';
    }

    @Post('payment/wechat/callback')
    @Public()
    @SkipTransform()
    @ApiOperation({ summary: 'WeChat Pay callback (idempotent)' })
    @ApiBody({
        description:
            'WeChat Pay notification envelope with an encrypted resource',
    })
    @ApiOkResponse({ description: '{ code: "SUCCESS", message: "成功" }' })
    async wechatCallback(
        @Req() request: RawBodyRequest<Request>,
        @Headers() headers: PaymentCallbackHeaders,
        @Body() body: unknown,
        @Res({ passthrough: true }) response: Response,
    ) {
        // WeChat signs the exact bytes it sent, so verification must use the raw
        // payload captured by `rawBody: true` — never a re-serialized object.
        const rawBody =
            request.rawBody?.toString('utf8') ?? JSON.stringify(body);

        const result = await this.paymentService.handleWechatCallback(
            rawBody,
            readHeader(headers, 'wechatpay-signature') ?? '',
            headers,
        );

        // WeChat Pay V3 expects a bare acknowledgement body (no envelope) and a
        // non-2xx status for FAIL so it will retry.
        response.status(
            result.code === 'SUCCESS' ? HttpStatus.OK : HttpStatus.BAD_REQUEST,
        );

        return result;
    }

    /**
     * 微信退款结果通知（`/v3/refund/domestic/notifications`）。
     *
     * 与交易回调同一套验签与解密；退款单按 `out_refund_no` 找回本地记录，
     * 推进状态后回裸 JSON `{ code: "SUCCESS" }`。处理失败回 400 + FAIL，
     * 微信会按退避重试。
     */
    @Post('payment/wechat/refund-callback')
    @Public()
    @SkipTransform()
    @ApiOperation({ summary: 'WeChat refund callback (idempotent)' })
    @ApiBody({
        description:
            'WeChat refund notification envelope with an encrypted resource',
    })
    @ApiOkResponse({ description: '{ code: "SUCCESS", message: "成功" }' })
    async wechatRefundCallback(
        @Req() request: RawBodyRequest<Request>,
        @Headers() headers: PaymentCallbackHeaders,
        @Body() body: unknown,
        @Res({ passthrough: true }) response: Response,
    ) {
        const rawBody =
            request.rawBody?.toString('utf8') ?? JSON.stringify(body);

        const result = await this.refundService.handleWechatRefundCallback(
            rawBody,
            readHeader(headers, 'wechatpay-signature') ?? '',
            headers,
        );

        response.status(
            result.handled ? HttpStatus.OK : HttpStatus.BAD_REQUEST,
        );

        return result.handled
            ? { code: 'SUCCESS', message: '成功' }
            : { code: 'FAIL', message: result.message ?? 'FAIL' };
    }

    /**
     * MP 后台保存【消息推送】地址时的 GET 校验。
     *
     * 微信会带 `signature` / `timestamp` / `nonce` / `echostr` 发 GET，要求
     * **原样返回 `echostr`**。没配置 `pushToken` 时直接回显（本地联调），
     * 配置了则先验签。
     */
    @Get('payment/wechat-virtual/notify')
    @Public()
    @SkipTransform()
    @ApiOperation({
        summary: 'WeChat push URL verification (GET echostr)',
        description:
            '必需：否则 MP 后台【开发管理 → 消息推送】保存 URL 时会校验失败。未配置 wechat.virtualPay.pushToken 时跳过验签直接回显。',
    })
    @ApiOkResponse({ description: 'echostr echoed back as text/plain' })
    async wechatVirtualPayVerify(
        @Query() query: Record<string, string | string[] | undefined>,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.virtualPayService.verifyPushUrl({ query });

        response.type('text/plain');
        response.status(result.ok ? HttpStatus.OK : HttpStatus.FORBIDDEN);

        return result.body;
    }

    /**
     * 小程序虚拟支付的「消息推送」入口（MP 后台【开发管理 → 消息推送】里配置）。
     *
     * 平台会 POST `text/xml`：道具发货推送（`xpay_goods_deliver_notify`）与
     * 退款推送（`xpay_refund_notify`）。应答必须是 XML，且成功时 `ErrCode = 0`，
     * 否则平台最多重试 15 次。
     */
    @Post('payment/wechat-virtual/notify')
    @Public()
    @SkipTransform()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'WeChat mini-program virtual payment push',
        description:
            'Receives goods-deliver and refund pushes as JSON (MP 后台【开发管理 → 消息推送 → 数据格式】选 JSON), verifies them, re-checks the order with query_order, settles idempotently (deduplicated by wx_order_id) and replies with `{"ErrCode":0,"ErrMsg":"success"}`. XML pushes are still accepted as a fallback and answered in XML.',
    })
    @ApiOkResponse({
        description: '{"ErrCode":0,"ErrMsg":"success"}',
    })
    async wechatVirtualPayNotify(
        @Req() request: RawBodyRequest<Request>,
        @Query() query: Record<string, string | string[] | undefined>,
        @Body() body: unknown,
        @Res({ passthrough: true }) response: Response,
    ) {
        // JSON 由内置 parser 解析，XML 由 `main.ts` 里注册的 text parser 兜底；
        // 两者都以 `rawBody` 为准（验签与落库都要原文）。
        const rawBody =
            request.rawBody?.toString('utf8') ??
            (typeof body === 'string' ? body : '');

        const result = await this.virtualPayService.handleNotify({
            rawBody,
            query,
        });

        response.type(result.contentType);

        return result.reply;
    }
}

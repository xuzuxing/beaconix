import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { PaymentChannel } from '../../../../generated/prisma/enums';
import { AlipayPayMethod } from '../../../../infra/alipay';

export class CreatePaymentDto {
    @ApiPropertyOptional({
        example: 'o_xxx',
        description:
            'Channel-specific payer identifier (WeChat openid). Required for WECHAT (JSAPI); the virtual-payment channel resolves the openid from the bound mini-program identity instead. Ignored by ALIPAY.',
    })
    @IsOptional()
    @IsString()
    @MinLength(1)
    openid?: string;

    @ApiPropertyOptional({
        enum: PaymentChannel,
        example: PaymentChannel.WECHAT,
        default: PaymentChannel.WECHAT,
        description:
            'Payment channel. `WECHAT` = JSAPI (wx.requestPayment, web/H5), `WECHAT_VIRTUAL` = mini-program virtual payment for virtual goods (wx.requestVirtualPayment), `ALIPAY` = Alipay cashier URL or QR code.',
    })
    @IsOptional()
    @IsEnum(PaymentChannel)
    channel?: PaymentChannel;

    @ApiPropertyOptional({
        example: '033Kx8Ga1zH4JD0mZQGa1rU6Ga1zQ8Ga',
        description:
            'wx.login() code. Required for WECHAT_VIRTUAL: the server exchanges it for a fresh session_key used to compute the user signature (session_key expires, so a fresh code is the only reliable source).',
    })
    @IsOptional()
    @IsString()
    @MinLength(1)
    code?: string;

    @ApiPropertyOptional({
        enum: AlipayPayMethod,
        example: AlipayPayMethod.PAGE,
        description:
            '支付宝产品码，仅 `ALIPAY` 渠道使用。`alipay.trade.page.pay`（PC 收银台，默认）与 `alipay.trade.wap.pay`（手机浏览器）返回可 GET 跳转的 `payUrl`；`alipay.trade.precreate`（扫码）返回 `qrCode` 支付链接。',
    })
    @IsOptional()
    @IsEnum(AlipayPayMethod)
    payMethod?: AlipayPayMethod;
}

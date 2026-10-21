import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { PaymentChannel } from '../../../../generated/prisma/enums';

export class CreatePaymentDto {
    @ApiPropertyOptional({
        example: 'o_xxx',
        description:
            'Channel-specific payer identifier (WeChat openid). Required for WECHAT (JSAPI); the virtual-payment channel resolves the openid from the bound mini-program identity instead.',
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
            'Payment channel. `WECHAT` = JSAPI (wx.requestPayment, web/H5), `WECHAT_VIRTUAL` = mini-program virtual payment for virtual goods (wx.requestVirtualPayment).',
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
}

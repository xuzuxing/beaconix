import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { PaymentChannel } from '../../../../generated/prisma/enums';

export class CreatePaymentDto {
    @ApiProperty({
        example: 'o_xxx',
        description: 'Channel-specific payer identifier (e.g. WeChat openid)',
    })
    @IsString()
    @MinLength(1)
    openid: string;

    @ApiPropertyOptional({
        enum: PaymentChannel,
        example: PaymentChannel.WECHAT,
        default: PaymentChannel.WECHAT,
        description: 'Payment channel. New providers are added in the factory.',
    })
    @IsOptional()
    @IsEnum(PaymentChannel)
    channel?: PaymentChannel;
}

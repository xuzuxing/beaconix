import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 用户自助退款申请。
 *
 * 金额不由客户端决定：服务端按政策试算（冷静期全额 / 按未使用天数折算），
 * 客户端只能附一条理由。
 */
export class RequestRefundDto {
    @ApiPropertyOptional({
        description: 'Why you are asking for a refund',
        example: 'We no longer need the subscription',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    reason?: string;
}

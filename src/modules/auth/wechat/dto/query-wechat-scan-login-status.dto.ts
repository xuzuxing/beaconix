import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    Length,
    Max,
    Min,
} from 'class-validator';

export class QueryWechatScanLoginStatusDto {
    @ApiProperty({
        example: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
        description: 'Login ticket returned when the QR code was created.',
    })
    @IsString()
    @IsNotEmpty()
    @Length(16, 64)
    ticket: string;

    @ApiPropertyOptional({
        default: 25000,
        minimum: 1000,
        maximum: 30000,
        description:
            'How long this long-poll request should wait for a scan, in milliseconds.',
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1000)
    @Max(30000)
    timeoutMs?: number = 25000;
}

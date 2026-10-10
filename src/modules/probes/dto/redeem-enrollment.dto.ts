import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Web-initiated enrollment: redeem a one-time token for a probe secret. */
export class RedeemEnrollmentDto {
    @ApiProperty({ description: 'One-time enrollment token from the web UI' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(128)
    token: string;

    @ApiPropertyOptional({ example: 'host-01' })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    hostname?: string;

    @ApiPropertyOptional({ example: 'linux/x64' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    platform?: string;

    @ApiPropertyOptional({ example: 'v22.0.0' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    runtime?: string;
}

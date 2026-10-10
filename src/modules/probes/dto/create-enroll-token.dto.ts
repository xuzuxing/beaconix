import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ProbeProvider } from '../../../generated/prisma/enums';

/** Options the web UI passes when minting a one-time install command. */
export class CreateEnrollTokenDto {
    @ApiPropertyOptional({ example: 'Tokyo probe' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    name?: string;

    @ApiPropertyOptional({ enum: ProbeProvider })
    @IsOptional()
    @IsEnum(ProbeProvider)
    provider?: ProbeProvider;

    @ApiPropertyOptional({ example: 'ap-northeast-1' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    region?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsEnum,
    IsNotEmpty,
    IsOptional,
    IsString,
    MaxLength,
} from 'class-validator';
import { ProbeProvider, ProbeScope } from '../../../generated/prisma/enums';

/** Confirmation submitted by the web confirmation page after the user approves. */
export class ApproveEnrollmentDto {
    @ApiProperty({ description: 'User code shown by the CLI' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(32)
    userCode: string;

    @ApiPropertyOptional({
        enum: ProbeScope,
        default: ProbeScope.TENANT,
        description:
            'SYSTEM requires SUPER_ADMIN; TENANT requires organizationId',
    })
    @IsOptional()
    @IsEnum(ProbeScope)
    scope?: ProbeScope;

    @ApiPropertyOptional({
        description: 'Organization the probe is created in (TENANT only)',
    })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    organizationId?: string;

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

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsDateString,
    IsEnum,
    IsOptional,
    IsString,
    MaxLength,
    ValidateIf,
} from 'class-validator';
import { RumErrorStatus } from '../../../generated/prisma/enums';

export class UpdateRumErrorDto {
    @ApiPropertyOptional({
        enum: RumErrorStatus,
        description:
            'UNRESOLVED clears the resolution, RESOLVED stamps resolvedAt/resolvedBy, IGNORED suppresses alerts until ignoredUntil',
    })
    @IsOptional()
    @IsEnum(RumErrorStatus)
    status?: RumErrorStatus;

    @ApiPropertyOptional({
        nullable: true,
        description:
            'End of the ignore window. Omit or null to ignore until manually reopened.',
    })
    @IsOptional()
    @ValidateIf((value: UpdateRumErrorDto) => value.ignoredUntil !== null)
    @IsDateString()
    ignoredUntil?: string | null;

    @ApiPropertyOptional({
        nullable: true,
        description:
            'Organization member to assign. Assigning another member requires app.manage.',
    })
    @IsOptional()
    @ValidateIf((value: UpdateRumErrorDto) => value.assigneeId !== null)
    @IsString()
    @MaxLength(64)
    assigneeId?: string | null;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { RumAlertIncidentStatus } from '../../../generated/prisma/enums';

export class QueryRumAlertIncidentsDto {
    @ApiPropertyOptional({ default: 1 })
    @IsOptional()
    @IsInt()
    @Min(1)
    page = 1;

    @ApiPropertyOptional({ default: 20, maximum: 100 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100)
    limit = 20;

    @ApiPropertyOptional({ enum: RumAlertIncidentStatus })
    @IsOptional()
    @IsEnum(RumAlertIncidentStatus)
    status?: RumAlertIncidentStatus;
}

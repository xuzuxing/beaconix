import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsDateString,
    IsIn,
    IsInt,
    IsOptional,
    Max,
    Min,
} from 'class-validator';
import { IsCuid } from '../../../common/decorators/is-cuid.decorator';

export class AlertPageDto {
    @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 1000000 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(1000000)
    page = 1;

    @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit = 25;
}

export class QueryAlertEventsDto extends AlertPageDto {
    @ApiPropertyOptional({
        enum: ['CONNECTIVITY', 'AVAILABILITY', 'SSL', 'NO_DATA'],
    })
    @IsOptional()
    @IsIn(['CONNECTIVITY', 'AVAILABILITY', 'SSL', 'NO_DATA'])
    kind?: string;

    @ApiPropertyOptional({ enum: ['ongoing', 'resolved'] })
    @IsOptional()
    @IsIn(['ongoing', 'resolved'])
    status?: string;

    @ApiPropertyOptional({ enum: ['warning', 'critical'] })
    @IsOptional()
    @IsIn(['warning', 'critical'])
    level?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsCuid()
    monitorId?: string;

    @ApiPropertyOptional({
        description: 'Event start time, inclusive ISO 8601',
    })
    @IsOptional()
    @IsDateString({ strict: true })
    from?: string;

    @ApiPropertyOptional({
        description: 'Event start time, inclusive ISO 8601',
    })
    @IsOptional()
    @IsDateString({ strict: true })
    to?: string;
}

export class QueryEventDeliveriesDto extends AlertPageDto {
    @ApiPropertyOptional({
        enum: ['PENDING', 'QUEUED', 'SENDING', 'SUCCESS', 'FAILED', 'SKIPPED'],
    })
    @IsOptional()
    @IsIn(['PENDING', 'QUEUED', 'SENDING', 'SUCCESS', 'FAILED', 'SKIPPED'])
    status?: string;

    @ApiPropertyOptional({ enum: ['OPEN', 'RECOVERY'] })
    @IsOptional()
    @IsIn(['OPEN', 'RECOVERY'])
    phase?: string;
}

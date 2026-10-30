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

export class QueryAlertDeliveriesDto {
    @ApiPropertyOptional({
        enum: ['FAILED', 'PENDING', 'QUEUED', 'SENDING', 'SUCCESS', 'SKIPPED'],
        default: 'FAILED',
    })
    @IsOptional()
    @IsIn(['FAILED', 'PENDING', 'QUEUED', 'SENDING', 'SUCCESS', 'SKIPPED'])
    status = 'FAILED';

    @ApiPropertyOptional()
    @IsOptional()
    @IsCuid()
    organizationId?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsCuid()
    projectId?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsCuid()
    monitorId?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsCuid()
    channelId?: string;

    @ApiPropertyOptional({ enum: ['OPEN', 'RECOVERY'] })
    @IsOptional()
    @IsIn(['OPEN', 'RECOVERY'])
    phase?: string;

    @ApiPropertyOptional({
        description: 'Delivery creation time, inclusive ISO 8601',
    })
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional({
        description: 'Delivery creation time, inclusive ISO 8601',
    })
    @IsOptional()
    @IsDateString()
    to?: string;

    @ApiPropertyOptional({ default: 1, minimum: 1 })
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

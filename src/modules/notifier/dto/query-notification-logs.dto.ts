import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { NotificationStatus } from '../../../generated/prisma/enums';

export class QueryNotificationLogsDto {
    @ApiPropertyOptional({
        enum: NotificationStatus,
        description: 'Filter by delivery result',
        example: NotificationStatus.FAILED,
    })
    @IsOptional()
    @IsEnum(NotificationStatus)
    status?: NotificationStatus;

    @ApiPropertyOptional({
        description: 'Filter by monitor CUID',
        example: 'cmgu92m5x0005p8l4h8z6s3k6',
    })
    @IsOptional()
    @IsString()
    monitorId?: string;

    @ApiPropertyOptional({ default: 1, minimum: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;

    @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number;
}

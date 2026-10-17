import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { IsCuid } from '../../../common/decorators/is-cuid.decorator';
import { TicketStatus } from '../../../generated/prisma/enums';

export class QueryTicketsDto {
    @ApiPropertyOptional({ enum: TicketStatus, example: 'OPEN' })
    @IsOptional()
    @IsEnum(TicketStatus)
    status?: TicketStatus;

    @ApiPropertyOptional({ example: 'cmgu92m5x0002p8l4h8z6s3k3' })
    @IsOptional()
    @IsCuid()
    categoryId?: string;

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

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { QueryTimezoneDto } from '../../../common/dto/query-timezone.dto';

export type MonitorInsightRange = '1h' | '24h' | '7d' | '30d';

export class QueryMonitorInsightsDto extends QueryTimezoneDto {
    @ApiPropertyOptional({ enum: ['1h', '24h', '7d', '30d'], default: '24h' })
    @IsIn(['1h', '24h', '7d', '30d'])
    range: MonitorInsightRange = '24h';
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { MonitoringTimezoneDto } from './query-monitoring.dto';

export type MonitorInsightRange = '1h' | '24h' | '7d' | '30d';

export class QueryMonitorInsightsDto extends MonitoringTimezoneDto {
    @ApiPropertyOptional({ enum: ['1h', '24h', '7d', '30d'], default: '24h' })
    @IsIn(['1h', '24h', '7d', '30d'])
    range: MonitorInsightRange = '24h';
}

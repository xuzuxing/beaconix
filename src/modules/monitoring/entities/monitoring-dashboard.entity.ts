import { ApiProperty } from '@nestjs/swagger';
import type { MonitoringDashboardService } from '../monitoring-dashboard.service';
import {
    ApiSchema,
    alertSchema,
    distributionSchema,
    historySchema,
    kpisSchema,
    metricBasisSchema,
    simpleHistorySchema,
    slowSchema,
    sparklineSchema,
    statusBucketsSchema,
    summarySchema,
    timelineSchema,
} from './monitoring-schemas';

type Dashboard = Awaited<ReturnType<MonitoringDashboardService['dashboard']>>;
type Availability = Awaited<
    ReturnType<MonitoringDashboardService['availability']>
>;
type StatusCodes = Awaited<
    ReturnType<MonitoringDashboardService['statusCodes']>
>;

export class MonitoringDashboardEntity {
    @ApiProperty({ enum: ['1h', 'today', '7d', '30d'] })
    range: Dashboard['range'];
    @ApiProperty() tz: string;
    @ApiProperty({ format: 'date-time' }) asOf: string;
    @ApiProperty({ format: 'date-time' }) from: string;
    @ApiProperty({ format: 'date-time' }) to: string;
    @ApiProperty({ nullable: true, type: String }) previousFrom: string | null;
    @ApiProperty({ nullable: true, type: String }) previousTo: string | null;
    @ApiSchema(metricBasisSchema) metricBasis: Dashboard['metricBasis'];
    @ApiSchema(historySchema) history: Dashboard['history'];
    @ApiSchema(summarySchema) summary: Dashboard['summary'];
    @ApiSchema(kpisSchema) kpis: Dashboard['kpis'];
    @ApiSchema(timelineSchema) timeline: Dashboard['timeline'];
    @ApiSchema(sparklineSchema) sparklines: Dashboard['sparklines'];
    @ApiSchema(distributionSchema) distribution: Dashboard['distribution'];
    @ApiSchema(slowSchema) slowestMonitors: Dashboard['slowestMonitors'];
    @ApiSchema(alertSchema) recentAlerts: Dashboard['recentAlerts'];
}

export class MonitoringAvailabilityEntity {
    @ApiProperty() tz: string;
    @ApiProperty() asOf: string;
    @ApiProperty() from: string;
    @ApiProperty() to: string;
    @ApiSchema(simpleHistorySchema) history: Availability['history'];
    @ApiProperty({ type: [Number] }) hours: number[];
    @ApiProperty({ type: [String] }) days: string[];
    @ApiProperty({
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
    })
    cells: number[][];
    @ApiProperty({
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
    })
    unavailableCells: number[][];
    @ApiProperty({ type: Object, nullable: true }) worst: Availability['worst'];
}

export class MonitoringStatusCodesEntity {
    @ApiProperty() tz: string;
    @ApiProperty() asOf: string;
    @ApiProperty() from: string;
    @ApiProperty() to: string;
    @ApiSchema(simpleHistorySchema) history: StatusCodes['history'];
    @ApiProperty() unclassifiedChecks: number;
    @ApiProperty({ type: [String] }) unavailableBuckets: string[];
    @ApiSchema(statusBucketsSchema) buckets: StatusCodes['buckets'];
}

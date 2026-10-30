import { ApiProperty } from '@nestjs/swagger';
import type { MonitorInsightsService } from '../monitor-insights.service';
import {
    ApiSchema,
    alertSchema,
    metricBasisSchema,
} from './monitoring-schemas';

type Insights = Awaited<ReturnType<MonitorInsightsService['get']>>;
const number = { type: 'number' as const, nullable: true };
const numbers = (names: string) =>
    Object.fromEntries(names.split(' ').map((name) => [name, number]));
const object = (properties: Record<string, object>) => ({
    type: 'object' as const,
    properties,
    required: Object.keys(properties),
});
const string = { type: 'string' as const };
const timestamp = { type: 'string' as const, format: 'date-time' };
const nullableString = { ...string, nullable: true };

export class MonitorInsightsEntity {
    @ApiProperty() monitorId: string;
    @ApiProperty({ enum: ['1h', '24h', '7d', '30d'] }) range: Insights['range'];
    @ApiProperty() tz: string;
    @ApiProperty({ format: 'date-time' }) asOf: string;
    @ApiProperty({ format: 'date-time' }) from: string;
    @ApiProperty({ format: 'date-time' }) to: string;
    @ApiSchema(metricBasisSchema) metricBasis: Insights['metricBasis'];
    @ApiSchema(
        object({
            retentionDays: { type: 'integer', enum: [90] },
            availableFrom: timestamp,
            alertsAvailableFrom: timestamp,
            status: { ...string, enum: ['AVAILABLE', 'EMPTY', 'TRUNCATED'] },
            alertsStatus: {
                ...string,
                enum: ['AVAILABLE', 'EMPTY', 'TRUNCATED'],
            },
        }),
    )
    history: Insights['history'];
    @ApiSchema(
        object({
            status: {
                ...string,
                enum: ['UP', 'DOWN', 'DEGRADED', 'PAUSED', 'UNKNOWN'],
            },
            failCount: { type: 'integer' },
            lastCheckAt: { ...timestamp, nullable: true },
            noDataSince: { ...timestamp, nullable: true },
            executionBlockedReason: nullableString,
            lastLatency: number,
            lastError: nullableString,
            ongoingCount: { type: 'integer' },
        }),
    )
    latest: Insights['latest'];
    @ApiSchema(
        object(
            numbers(
                'totalChecks failedChecks rescuedChecks uptimePercent avgLatencyMs p50LatencyMs p95LatencyMs p99LatencyMs',
            ),
        ),
    )
    metrics: Insights['metrics'];
    @ApiSchema(
        object({
            interval: { ...string, enum: ['2m', '1h', '6h', '24h'] },
            points: {
                type: 'array',
                items: object({
                    time: timestamp,
                    durationSeconds: { type: 'number' },
                    ...numbers(
                        'checks failures avgLatencyMs latencyP50Ms latencyP95Ms latencyP99Ms uptimePercent',
                    ),
                }),
            },
        }),
    )
    timeline: Insights['timeline'];
    @ApiSchema({
        type: 'array',
        items: object({
            id: string,
            roundId: nullableString,
            success: { type: 'boolean' },
            localSuccess: { type: 'boolean', nullable: true },
            rescuedByProbe: { type: 'boolean' },
            latency: { type: 'integer' },
            statusCode: number,
            error: nullableString,
            source: { ...string, enum: ['LOCAL'] },
            checkedAt: timestamp,
        }),
    })
    checks: Insights['checks'];
    @ApiProperty({ enum: [50] }) checksLimit: number;
    @ApiProperty({ enum: [20] }) eventsLimit: number;
    @ApiSchema({
        ...alertSchema,
        items: {
            ...alertSchema.items,
            properties: {
                ...('properties' in (alertSchema.items ?? {})
                    ? (
                          alertSchema.items as {
                              properties: Record<string, object>;
                          }
                      ).properties
                    : {}),
                origin: { type: 'string', enum: ['BASELINE', 'OBSERVED'] },
            },
        },
    })
    events: Insights['events'];
}

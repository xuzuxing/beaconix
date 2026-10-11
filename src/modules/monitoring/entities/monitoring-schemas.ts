import { ApiProperty, type ApiPropertyOptions } from '@nestjs/swagger';
import { MonitorType } from '../../../generated/prisma/enums';

type SchemaObject = Exclude<
    NonNullable<ApiPropertyOptions['items']>,
    { $ref: string }
>;

// Swagger accepts raw OpenAPI schemas; ApiProperty's nested metadata type is narrower.
export const ApiSchema = (schema: SchemaObject) =>
    ApiProperty(schema as ApiPropertyOptions);

const string = { type: 'string' } satisfies SchemaObject;
const timestamp = { ...string, format: 'date-time' };
const integer = { type: 'integer', minimum: 0 } satisfies SchemaObject;
const number = { type: 'number', nullable: true } satisfies SchemaObject;
const boolean = { type: 'boolean' } satisfies SchemaObject;
const nullableString = { ...string, nullable: true };
const array = (items: SchemaObject): SchemaObject => ({ type: 'array', items });
const object = (properties: Record<string, SchemaObject>): SchemaObject => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
});
const fields = (names: string, value: SchemaObject) =>
    Object.fromEntries(names.split(' ').map((name) => [name, value]));
const historyStatus: SchemaObject = {
    type: 'string',
    enum: ['AVAILABLE', 'EMPTY', 'TRUNCATED', 'UNAVAILABLE'],
};
export const metricBasisSchema: SchemaObject = object({
    sampleSource: { type: 'string', enum: ['LOCAL'] },
    availability: { type: 'string', enum: ['EFFECTIVE_SUCCESS'] },
    latency: { type: 'string', enum: ['LOCAL_DURATION'] },
});
export const historySchema: SchemaObject = object({
    retentionDays: { type: 'integer', enum: [90] },
    ...fields(
        'availableFrom countsAvailableFrom probeAvailableFrom alertsAvailableFrom',
        timestamp,
    ),
    ...fields(
        'current previous countsCurrent countsPrevious probeCurrent probePrevious alertsCurrent alertsPrevious',
        historyStatus,
    ),
});
export const simpleHistorySchema: SchemaObject = object({
    retentionDays: integer,
    availableFrom: timestamp,
    status: historyStatus,
});
export const summarySchema: SchemaObject = object({
    monitors: object(fields('total up down degraded paused unknown', integer)),
    probes: object({
        scope: { type: 'string', enum: ['PROJECT_ASSIGNED'] },
        total: integer,
        online: integer,
    }),
    alertingCount: integer,
    sslExpiringCount: integer,
    expiringCertificates: array(
        object({
            monitorId: string,
            host: string,
            expiresAt: timestamp,
            daysLeft: integer,
            issuer: nullableString,
        }),
    ),
});
export const kpisSchema: SchemaObject = object(
    fields(
        'totalChecks failedChecks uptimePercent uptimeDeltaPercent avgLatencyMs avgLatencyDeltaMs p95LatencyMs p95LatencyDeltaMs failureRatePercent failureRateDeltaPercent monitorCount monitorDelta failingCount failingDelta',
        number,
    ),
);
export const timelineSchema: SchemaObject = object({
    interval: { type: 'string', enum: ['2m', '1h', '6h', '24h'] },
    points: array(
        object({
            time: timestamp,
            durationSeconds: {
                type: 'number',
                exclusiveMinimum: true,
                minimum: 0,
            },
            ...fields(
                'checks failures checksPerMinute avgLatencyMs latencyP50Ms latencyP95Ms latencyP99Ms uptimePercent monitorCount failingCount',
                number,
            ),
        }),
    ),
});
export const sparklineSchema: SchemaObject = object(
    fields(
        'uptime avgLatency p95Latency failureRate monitorCount failing',
        array(number),
    ),
);
export const distributionSchema: SchemaObject = object({
    protocols: array(
        object({
            type: { type: 'string', enum: Object.values(MonitorType) },
            count: integer,
        }),
    ),
    probes: array(
        object({
            id: string,
            scope: { type: 'string', enum: ['SYSTEM', 'TENANT'] },
            name: string,
            region: string,
            enabled: boolean,
            online: boolean,
            latencyMs: number,
        }),
    ),
    latencyHistogram: object({
        unit: { type: 'string', enum: ['ms'] },
        buckets: array(
            object({
                from: integer,
                to: { ...integer, nullable: true },
                count: integer,
            }),
        ),
    }),
});
export const slowSchema: SchemaObject = array(
    object({
        id: string,
        name: string,
        target: string,
        type: { type: 'string', enum: Object.values(MonitorType) },
        avgLatencyMs: number,
        p95LatencyMs: number,
        uptimePercent: number,
        sparkline: array(number),
    }),
);
export const alertSchema: SchemaObject = array(
    object({
        id: string,
        monitorId: string,
        monitorName: string,
        target: string,
        monitorDeleted: boolean,
        kind: { type: 'string', enum: ['CONNECTIVITY', 'AVAILABILITY', 'SSL'] },
        level: { type: 'string', enum: ['warning', 'critical'] },
        status: { type: 'string', enum: ['ongoing', 'resolved'] },
        suppressedReason: {
            type: 'string',
            nullable: true,
            enum: ['PAUSED', 'DELETED', 'CONFIG_DISABLED'],
        },
        reason: string,
        threshold: number,
        actual: number,
        unit: nullableString,
        message: nullableString,
        startedAt: timestamp,
        resolvedAt: { ...timestamp, nullable: true },
        updatedAt: timestamp,
        durationSeconds: { ...integer, nullable: true },
        notified: boolean,
    }),
);
export const statusBucketsSchema: SchemaObject = array(
    object({
        time: timestamp,
        ...fields(
            'httpChecks success2xx redirect3xx clientError4xx serverError5xx otherStatusCode noStatusCode',
            integer,
        ),
    }),
);

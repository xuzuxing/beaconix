import { Injectable } from '@nestjs/common';
import type { MetricObservation, MetricsRecorder } from './metrics.constants';
import {
    collectDefaultMetrics,
    Counter,
    type CounterConfiguration,
    Gauge,
    type GaugeConfiguration,
    Histogram,
    type HistogramConfiguration,
    register,
} from '@prometheus-io/client';

const DEFAULT_METRIC_PREFIX = 'beaconix_';

/**
 * Prometheus 指标收集服务
 *
 * @description 提供 HTTP 请求指标、业务指标的收集和管理
 */
@Injectable()
export class MetricsService implements MetricsRecorder {
    private readonly snapshotSources = new Set<string>();
    private readonly cacheErrors = this.getOrCreateCounter({
        name: DEFAULT_METRIC_PREFIX + 'cache_errors_total',
        help: 'Cache read failures, excluded from hit rate',
        labelNames: ['cache_name'],
    });
    private readonly queueDuration = this.getOrCreateHistogram({
        name: DEFAULT_METRIC_PREFIX + 'queue_job_duration_seconds',
        help: 'Duration of each worker execution attempt',
        labelNames: ['queue_name', 'job_name', 'status'],
        buckets: [0.01, 0.1, 0.5, 1, 5, 15, 60, 300],
    });
    private readonly queueRetries = this.getOrCreateCounter({
        name: DEFAULT_METRIC_PREFIX + 'queue_job_retries_total',
        help: 'Worker attempts after the first attempt',
        labelNames: ['queue_name', 'job_name'],
    });
    private readonly queueWait = this.getOrCreateHistogram({
        name: DEFAULT_METRIC_PREFIX + 'queue_job_wait_seconds',
        help: 'Time since enqueueing, including delay and previous attempts',
        labelNames: ['queue_name', 'job_name'],
        buckets: [0.01, 0.1, 1, 5, 30, 60, 300, 1800],
    });
    private readonly queueDepth = this.getOrCreateGauge({
        name: DEFAULT_METRIC_PREFIX + 'queue_jobs',
        help: 'Shared BullMQ queue state snapshot (do not sum worker replicas)',
        labelNames: ['queue_name', 'status'],
    });
    private readonly snapshotTimestamp = this.getOrCreateGauge({
        name:
            DEFAULT_METRIC_PREFIX +
            'metrics_snapshot_last_success_timestamp_seconds',
        help: 'Last successful snapshot per source',
        labelNames: ['source'],
    });
    private readonly snapshotErrors = this.getOrCreateCounter({
        name: DEFAULT_METRIC_PREFIX + 'metrics_snapshot_errors_total',
        help: 'Snapshot collection errors per source',
        labelNames: ['source'],
    });
    private readonly notificationResults = this.getOrCreateCounter({
        name: DEFAULT_METRIC_PREFIX + 'notification_recipients_total',
        help: 'Persisted notification recipient dispatch outcomes',
        labelNames: ['channel', 'provider', 'result', 'retryable'],
    });
    private readonly notificationDuration = this.getOrCreateHistogram({
        name: DEFAULT_METRIC_PREFIX + 'notification_dispatch_duration_seconds',
        help: 'Recipient dispatch duration including persistence',
        labelNames: ['channel', 'provider', 'result'],
        buckets: [0.01, 0.1, 0.5, 1, 5, 15, 60],
    });
    private readonly storageResults = this.getOrCreateCounter({
        name: DEFAULT_METRIC_PREFIX + 'file_operations_total',
        help: 'Storage facade operation outcomes',
        labelNames: ['operation', 'driver', 'result'],
    });
    private readonly storageDuration = this.getOrCreateHistogram({
        name: DEFAULT_METRIC_PREFIX + 'file_operation_duration_seconds',
        help: 'Storage facade operation duration',
        labelNames: ['operation', 'driver', 'result'],
        buckets: [0.001, 0.01, 0.1, 0.5, 1, 5, 15, 60],
    });
    private readonly storageBytes = this.getOrCreateCounter({
        name: DEFAULT_METRIC_PREFIX + 'file_upload_bytes_total',
        help: 'Bytes successfully stored (before file metadata persistence)',
        labelNames: ['driver'],
    });
    private readonly outboxResults = this.getOrCreateCounter({
        name: DEFAULT_METRIC_PREFIX + 'outbox_dispatch_total',
        help: 'Outbox dispatch attempts and persisted outcomes',
        labelNames: ['event_type', 'result'],
    });
    private readonly outboxDuration = this.getOrCreateHistogram({
        name: DEFAULT_METRIC_PREFIX + 'outbox_dispatch_duration_seconds',
        help: 'Outbox dispatch attempt duration',
        labelNames: ['event_type', 'result'],
        buckets: [0.001, 0.01, 0.1, 0.5, 1, 5, 15, 60],
    });
    private readonly handlerResults = this.getOrCreateCounter({
        name: DEFAULT_METRIC_PREFIX + 'event_handler_total',
        help: 'Event consumption outcomes',
        labelNames: ['event_type', 'consumer', 'result'],
    });
    private readonly handlerDuration = this.getOrCreateHistogram({
        name: DEFAULT_METRIC_PREFIX + 'event_handler_duration_seconds',
        help: 'Event consumption duration including transaction',
        labelNames: ['event_type', 'consumer', 'result'],
        buckets: [0.001, 0.01, 0.1, 0.5, 1, 5, 15, 60],
    });
    // HTTP 请求指标
    public readonly httpRequestsTotal: Counter<string>;
    public readonly httpRequestDuration: Histogram<string>;
    public readonly httpRequestsInFlight: Gauge<string>;

    // 业务指标
    public readonly loginAttemptsTotal: Counter<string>;
    public readonly cacheHitRate: Gauge<string>;
    public readonly cacheHits: Counter<string>;
    public readonly cacheMisses: Counter<string>;

    // 系统指标
    public readonly activeConnections: Gauge<string>;
    public readonly queueJobsTotal: Counter<string>;

    // 数据库指标
    public readonly dbQueryTotal: Counter<string>;
    public readonly dbQueryDuration: Histogram<string>;
    public readonly dbSlowQueryTotal: Counter<string>;

    constructor() {
        this.registerDefaultMetrics();

        this.httpRequestsTotal = this.getOrCreateCounter({
            name: DEFAULT_METRIC_PREFIX + 'http_requests_total',
            help: 'Total number of HTTP requests',
            labelNames: ['method', 'path', 'status_code'],
        });

        this.httpRequestDuration = this.getOrCreateHistogram({
            name: DEFAULT_METRIC_PREFIX + 'http_request_duration_seconds',
            help: 'HTTP request duration in seconds',
            labelNames: ['method', 'path', 'status_code'],
            buckets: [
                0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
            ],
        });

        this.httpRequestsInFlight = this.getOrCreateGauge({
            name: DEFAULT_METRIC_PREFIX + 'http_requests_in_flight',
            help: 'Number of HTTP requests currently being processed',
            labelNames: ['method', 'path'],
        });

        this.loginAttemptsTotal = this.getOrCreateCounter({
            name: DEFAULT_METRIC_PREFIX + 'login_attempts_total',
            help: 'Total number of login attempts',
            labelNames: ['actor_type', 'method', 'result', 'failure_reason'],
        });

        this.cacheHitRate = this.getOrCreateGauge({
            name: DEFAULT_METRIC_PREFIX + 'cache_hit_rate',
            help: 'Cache hit rate (0-1)',
            labelNames: ['cache_name'],
            collect: async () => this.updateCacheHitRates(),
        });

        this.cacheHits = this.getOrCreateCounter({
            name: DEFAULT_METRIC_PREFIX + 'cache_hits_total',
            help: 'Total number of cache hits',
            labelNames: ['cache_name'],
        });

        this.cacheMisses = this.getOrCreateCounter({
            name: DEFAULT_METRIC_PREFIX + 'cache_misses_total',
            help: 'Total number of cache misses',
            labelNames: ['cache_name'],
        });

        this.activeConnections = this.getOrCreateGauge({
            name: DEFAULT_METRIC_PREFIX + 'active_connections',
            help: 'Number of ready service-managed client connections (not server pool size)',
            labelNames: ['type'],
        });

        this.queueJobsTotal = this.getOrCreateCounter({
            name: DEFAULT_METRIC_PREFIX + 'queue_jobs_total',
            help: 'Total number of queue jobs',
            labelNames: ['queue_name', 'job_name', 'status'],
        });

        this.dbQueryTotal = this.getOrCreateCounter({
            name: DEFAULT_METRIC_PREFIX + 'db_query_total',
            help: 'Total number of database queries',
            labelNames: ['model', 'action', 'status'],
        });

        this.dbQueryDuration = this.getOrCreateHistogram({
            name: DEFAULT_METRIC_PREFIX + 'db_query_duration_seconds',
            help: 'Database query duration in seconds',
            labelNames: ['model', 'action'],
            buckets: [
                0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
            ],
        });

        this.dbSlowQueryTotal = this.getOrCreateCounter({
            name: DEFAULT_METRIC_PREFIX + 'db_slow_query_total',
            help: 'Total number of slow database queries',
            labelNames: ['model', 'action'],
        });
    }

    /**
     * 获取所有指标（Prometheus 格式）
     */
    async getMetrics(): Promise<string> {
        return register.metrics();
    }

    getContentType(): string {
        return register.contentType;
    }

    /**
     * 记录 HTTP 请求
     */
    recordHttpRequest(
        method: string,
        path: string,
        statusCode: number,
        durationSeconds: number,
    ): void {
        const normalizedPath = this.normalizePath(path);
        const labels = {
            method,
            path: normalizedPath,
            status_code: String(statusCode),
        };

        this.httpRequestsTotal.inc(labels);
        this.httpRequestDuration.observe(labels, durationSeconds);
    }

    startHttpRequest(method: string, path: string): () => void {
        const labels = {
            method,
            path: this.normalizePath(path),
        };

        this.httpRequestsInFlight.inc(labels);
        return () => this.httpRequestsInFlight.dec(labels);
    }

    /**
     * 记录登录尝试
     */
    recordLoginAttempt(input: {
        actorType: 'admin_user' | 'app_user' | 'unknown';
        method: string;
        result: 'success' | 'failed';
        failureReason?: string;
    }): void {
        this.loginAttemptsTotal.inc({
            actor_type: input.actorType,
            method: input.method || 'unknown',
            result: input.result,
            failure_reason: input.failureReason || 'none',
        });
    }

    /**
     * 记录缓存命中
     */
    recordCacheHit(cacheName: string): void {
        this.cacheHits.inc({ cache_name: cacheName });
        this.cacheMisses.inc({ cache_name: cacheName }, 0);
    }

    /**
     * 记录缓存未命中
     */
    recordCacheMiss(cacheName: string): void {
        this.cacheMisses.inc({ cache_name: cacheName });
        this.cacheHits.inc({ cache_name: cacheName }, 0);
    }

    /**
     * 更新缓存命中率
     *
     * 使用 Prometheus client 直接 API 获取 metric 值，避免低效的正则解析
     */
    private async updateCacheHitRates(): Promise<void> {
        try {
            const hitsMetric = register.getSingleMetric(
                DEFAULT_METRIC_PREFIX + 'cache_hits_total',
            );
            const missesMetric = register.getSingleMetric(
                DEFAULT_METRIC_PREFIX + 'cache_misses_total',
            );

            if (!hitsMetric || !missesMetric) return;

            const hitsValues = await (hitsMetric as Counter<string>).get();
            const missesValues = await (missesMetric as Counter<string>).get();

            const cacheNames = new Set(
                [...hitsValues.values, ...missesValues.values].map((v) =>
                    String(v.labels.cache_name),
                ),
            );
            for (const cacheName of cacheNames) {
                const hits =
                    hitsValues.values.find(
                        (v) => v.labels.cache_name === cacheName,
                    )?.value ?? 0;
                const misses =
                    missesValues.values.find(
                        (v) => v.labels.cache_name === cacheName,
                    )?.value ?? 0;
                const total = hits + misses;
                if (total > 0)
                    this.cacheHitRate.set(
                        { cache_name: cacheName },
                        hits / total,
                    );
            }
        } catch {
            // 指标获取失败时静默处理，不影响业务逻辑
        }
    }

    /**
     * 设置活跃连接数
     */
    setActiveConnections(type: string, count: number): void {
        this.activeConnections.set({ type }, count);
    }

    /**
     * 记录队列任务
     */
    recordQueueJob(
        queueName: string,
        jobName: string,
        status: 'completed' | 'failed' | 'active' | 'canceled' | 'discarded',
    ): void {
        this.queueJobsTotal.inc({
            queue_name: queueName,
            job_name: jobName || 'unknown',
            status,
        });
    }

    recordQueueAttempt(
        queueName: string,
        jobName: string,
        status: 'completed' | 'failed' | 'canceled' | 'discarded',
        durationSeconds: number,
    ): void {
        try {
            this.recordQueueJob(queueName, jobName, status);
            this.queueDuration.observe(
                { queue_name: queueName, job_name: jobName, status },
                durationSeconds,
            );
        } catch {
            // Collection failures must not replace a job result or its original error.
        }
    }

    recordQueueStart(
        queueName: string,
        jobName: string,
        retry: boolean,
        ageSeconds: number,
    ): void {
        try {
            this.recordQueueJob(queueName, jobName, 'active');
            const labels = { queue_name: queueName, job_name: jobName };
            if (retry) this.queueRetries.inc(labels);
            if (Number.isFinite(ageSeconds))
                this.queueWait.observe(labels, Math.max(0, ageSeconds));
        } catch {
            // Collection failures must not prevent job execution.
        }
    }

    setQueueSnapshot(queueName: string, counts: Record<string, number>): void {
        for (const [status, count] of Object.entries(counts)) {
            this.queueDepth.set({ queue_name: queueName, status }, count);
        }
        this.recordSnapshot(`queue:${queueName}`, true);
    }

    recordSnapshot(source: string, success: boolean): void {
        if (!this.snapshotSources.has(source)) {
            this.snapshotSources.add(source);
            this.snapshotTimestamp.set({ source }, 0);
        }
        if (success) this.snapshotTimestamp.set({ source }, Date.now() / 1000);
        else {
            this.snapshotErrors.inc({ source });
        }
    }

    record(observation: MetricObservation): void {
        // Metrics must never change a database, delivery or storage outcome.
        try {
            switch (observation.kind) {
                case 'db':
                    this.recordDbQuery(
                        observation.model,
                        observation.action,
                        observation.durationSeconds,
                        observation.success,
                    );
                    if (observation.durationSeconds >= 0.5)
                        this.recordSlowQuery(
                            observation.model,
                            observation.action,
                        );
                    break;
                case 'cache':
                    if (observation.result === 'hit')
                        this.recordCacheHit(observation.cacheName);
                    else if (observation.result === 'miss')
                        this.recordCacheMiss(observation.cacheName);
                    else
                        this.cacheErrors.inc({
                            cache_name: observation.cacheName,
                        });
                    break;
                case 'connection':
                    this.setActiveConnections(
                        observation.type,
                        observation.ready ? 1 : 0,
                    );
                    break;
            }
        } catch {
            // Collection failure cannot interrupt the business operation.
        }
    }

    /**
     * 记录数据库查询
     */
    recordDbQuery(
        model: string,
        action: string,
        durationSeconds: number,
        success: boolean,
    ): void {
        const labels = {
            model: model || 'unknown',
            action: action || 'unknown',
        };
        this.dbQueryTotal.inc({
            ...labels,
            status: success ? 'success' : 'error',
        });
        this.dbQueryDuration.observe(labels, durationSeconds);
    }

    /**
     * 记录慢查询
     */
    recordSlowQuery(model: string, action: string): void {
        this.dbSlowQueryTotal.inc({
            model: model || 'unknown',
            action: action || 'unknown',
        });
    }

    /**
     * 规范化路径，移除动态参数
     * 例如: /api/users/123 -> /api/users/:id
     */
    private normalizePath(path: string): string {
        if (!path) return 'unknown';

        return (
            path
                // 移除查询参数
                .split('?')[0]
                // 替换 UUID (必须在数字 ID 之前处理)
                .replace(
                    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
                    '/:uuid',
                )
                // 替换长数字字符串
                .replace(/\/[0-9]{6,}/g, '/:id')
                // 替换数字 ID
                .replace(/\/\d+/g, '/:id')
        );
    }

    private getOrCreateCounter<T extends string>(
        configuration: CounterConfiguration<T>,
    ): Counter<T> {
        const existing = register.getSingleMetric<T>(configuration.name);
        return (
            (existing as Counter<T> | undefined) ?? new Counter(configuration)
        );
    }

    private getOrCreateGauge<T extends string>(
        configuration: GaugeConfiguration<T>,
    ): Gauge<T> {
        const existing = register.getSingleMetric<T>(configuration.name);
        return (existing as Gauge<T> | undefined) ?? new Gauge(configuration);
    }

    private getOrCreateHistogram<T extends string>(
        configuration: HistogramConfiguration<T>,
    ): Histogram<T> {
        const existing = register.getSingleMetric<T>(configuration.name);
        return (
            (existing as Histogram<T> | undefined) ??
            new Histogram(configuration)
        );
    }

    private registerDefaultMetrics(): void {
        const hasDefaultMetrics = register
            .getMetricsAsArray()
            .some((metric) =>
                [
                    `${DEFAULT_METRIC_PREFIX}process_`,
                    `${DEFAULT_METRIC_PREFIX}nodejs_`,
                ].some((prefix) => metric.name.startsWith(prefix)),
            );

        if (!hasDefaultMetrics) {
            collectDefaultMetrics({ prefix: DEFAULT_METRIC_PREFIX });
        }
    }
}

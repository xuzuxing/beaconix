import { register } from '@prometheus-io/client';
import { MetricsService } from './metrics.service';

describe('Scheduler metrics contract', () => {
    beforeEach(() => register.clear());
    afterEach(() => register.clear());

    it('does not manufacture success samples on startup or registration failure', async () => {
        const metrics = new MetricsService();
        metrics.recordSchedulerRegistration('monitor-no-data-sweep', false);
        metrics.recordSchedulerBoundary('monitor-no-data-sweep', 'start');
        metrics.recordSchedulerBoundary('monitor-no-data-sweep', 'failure');
        metrics.recordSchedulerBoundary('monitor-no-data-sweep', 'complete');
        const runs = await register
            .getSingleMetric('beaconix_scheduler_run_timestamp_seconds')!
            .get();
        expect(
            runs.values.some((row) => row.labels.boundary === 'success'),
        ).toBe(false);
        expect(runs.values.map((row) => row.labels.boundary).sort()).toEqual([
            'complete',
            'failure',
            'start',
        ]);
        const failures = await register
            .getSingleMetric('beaconix_scheduler_failures_total')!
            .get();
        expect(failures.values.map((row) => row.labels.phase).sort()).toEqual([
            'execution',
            'registration',
        ]);
    });

    it('keeps failed snapshots stale and exposes due work separately from execution', async () => {
        const metrics = new MetricsService();
        metrics.recordSnapshot('alert-deliveries', false);
        let snapshot = await register
            .getSingleMetric(
                'beaconix_metrics_snapshot_last_success_timestamp_seconds',
            )!
            .get();
        expect(snapshot.values[0].value).toBe(0);
        metrics.setWorkBacklog('alert-deliveries', 3, 180);
        snapshot = await register
            .getSingleMetric(
                'beaconix_metrics_snapshot_last_success_timestamp_seconds',
            )!
            .get();
        const timestamp = snapshot.values[0].value;
        expect(timestamp).toBeGreaterThan(0);
        metrics.recordSnapshot('alert-deliveries', false);
        snapshot = await register
            .getSingleMetric(
                'beaconix_metrics_snapshot_last_success_timestamp_seconds',
            )!
            .get();
        expect(snapshot.values[0].value).toBe(timestamp);
        const backlog = await register
            .getSingleMetric('beaconix_work_backlog')!
            .get();
        expect(
            backlog.values
                .map((row) => row.value)
                .sort((a, b) => Number(a) - Number(b)),
        ).toEqual([3, 180]);
    });
});

import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { ScheduledJobRegistry } from './scheduled-job.registry';
import { ScheduledJobsRegistrar } from './scheduled-jobs.registrar';
import { ScheduledJobsProcessor } from './scheduled-jobs.processor';
import { CheckerScheduler } from '../../modules/checker/checker.scheduler';
import { MonitorScanProcessor } from '../../modules/checker/monitor-scan.processor';
import { SchedulerHealthCollector } from './scheduler-health.collector';

describe('Scheduler failures and recovery', () => {
    afterEach(() => jest.useRealTimers());
    function fixture() {
        const registry = new ScheduledJobRegistry();
        const handler = jest.fn().mockResolvedValue(undefined);
        registry.register({
            name: 'monitor-no-data-sweep',
            pattern: '* * * * *',
            handler,
        });
        const metrics = {
            recordSchedulerRegistration: jest.fn(),
            recordSchedulerBoundary: jest.fn(),
        };
        const schedulers = new Map();
        const queue = {
            getJobScheduler: jest.fn((id) =>
                Promise.resolve(schedulers.get(id)),
            ),
            upsertJobScheduler: jest.fn((id, repeat) => {
                schedulers.set(id, repeat);
                return Promise.resolve();
            }),
        };
        const registrar = new ScheduledJobsRegistrar(
            registry,
            queue as never,
            new ConfigService(),
            metrics as never,
        );
        return { registry, handler, metrics, schedulers, queue, registrar };
    }

    it('retries startup registration failures on the timer and upserts without duplicates', async () => {
        jest.useFakeTimers();
        const f = fixture();
        f.queue.upsertJobScheduler.mockRejectedValueOnce(
            new Error('Redis disconnected'),
        );
        await f.registrar.onApplicationBootstrap();
        expect(f.schedulers.size).toBe(0);
        expect(f.metrics.recordSchedulerRegistration).toHaveBeenLastCalledWith(
            'monitor-no-data-sweep',
            false,
        );
        await jest.advanceTimersByTimeAsync(60_000);
        expect(f.schedulers.size).toBe(1);
        // The first attempt failed and the second created the definition. A
        // later verification must not replace a waiting/delayed cron tick.
        expect(f.queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
        f.schedulers.clear();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(f.queue.upsertJobScheduler).toHaveBeenCalledTimes(3);
        expect(f.metrics.recordSchedulerRegistration).toHaveBeenLastCalledWith(
            'monitor-no-data-sweep',
            true,
        );
        await jest.advanceTimersByTimeAsync(60_000);
        expect(f.schedulers.size).toBe(1);
        expect(f.queue.upsertJobScheduler).toHaveBeenCalledTimes(3);
        f.registrar.onModuleDestroy();
        expect(jest.getTimerCount()).toBe(0);
    });

    it('does not overlap a stalled reconciliation and bounds its registration wait', async () => {
        jest.useFakeTimers();
        const f = fixture();
        f.queue.upsertJobScheduler.mockImplementationOnce(
            () => new Promise(() => undefined),
        );
        const pending = f.registrar.reconcile();
        await f.registrar.reconcile();
        await jest.advanceTimersByTimeAsync(0);
        expect(f.queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(2000);
        await pending;
        await f.registrar.reconcile();
        expect(f.schedulers.size).toBe(1);
    });

    it('preserves the original handler exception even if metrics throw, then resumes processing', async () => {
        const f = fixture();
        const failure = new Error('database unavailable');
        f.handler.mockRejectedValueOnce(failure);
        f.metrics.recordSchedulerBoundary.mockImplementation(() => {
            throw new Error('metrics unavailable');
        });
        const processor = new ScheduledJobsProcessor(
            f.registry,
            f.metrics as never,
        );
        await expect(
            processor.process({ name: 'monitor-no-data-sweep' } as Job),
        ).rejects.toBe(failure);
        await expect(
            processor.process({ name: 'monitor-no-data-sweep' } as Job),
        ).resolves.toBeUndefined();
        expect(
            f.metrics.recordSchedulerBoundary.mock.calls.map((call) => call[1]),
        ).toEqual([
            'start',
            'failure',
            'complete',
            'start',
            'success',
            'complete',
        ]);
    });

    it('restores the scan scheduler and records execution independently from registration', async () => {
        jest.useFakeTimers();
        const f = fixture();
        f.queue.upsertJobScheduler.mockRejectedValueOnce(
            new Error('Redis disconnected'),
        );
        const scheduler = new CheckerScheduler(
            f.queue as never,
            f.metrics as never,
        );
        await scheduler.onModuleInit();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(f.schedulers.size).toBe(1);
        const error = new Error('SQL failed');
        const checker = {
            enqueueDueChecks: jest
                .fn()
                .mockRejectedValueOnce(error)
                .mockResolvedValue({ due: 1, enqueued: 1 }),
        };
        const scan = new MonitorScanProcessor(
            checker as never,
            {} as never,
            f.metrics as never,
        );
        await expect(scan.process()).rejects.toBe(error);
        await scan.process();
        expect(f.metrics.recordSchedulerBoundary).toHaveBeenLastCalledWith(
            'monitor-scan',
            'complete',
        );
        scheduler.onModuleDestroy();
        expect(jest.getTimerCount()).toBe(0);
    });

    it('retains unknown queue samples on failure and refreshes snapshots after recovery', async () => {
        const queue = {
            getJobCounts: jest.fn().mockRejectedValue(new Error('offline')),
        };
        const prisma = {
            $queryRaw: jest.fn().mockRejectedValue(new Error('offline')),
        };
        const metrics = {
            setQueueSnapshot: jest.fn(),
            recordSnapshot: jest.fn(),
            setWorkBacklog: jest.fn(),
        };
        const collector = new SchedulerHealthCollector(
            prisma as never,
            metrics as never,
            queue as never,
            queue as never,
            queue as never,
            queue as never,
        );
        await collector.collect();
        expect(metrics.setQueueSnapshot).not.toHaveBeenCalled();
        expect(metrics.setWorkBacklog).not.toHaveBeenCalled();
        expect(metrics.recordSnapshot).toHaveBeenCalledWith(
            'alert-deliveries',
            false,
        );
        queue.getJobCounts.mockResolvedValue({ failed: 2, waiting: 1 });
        prisma.$queryRaw.mockResolvedValue([
            { source: 'alert-deliveries', count: 1, age: 180 },
        ]);
        await collector.collect();
        expect(metrics.setQueueSnapshot).toHaveBeenCalledTimes(4);
        expect(metrics.setWorkBacklog).toHaveBeenCalledWith(
            'alert-deliveries',
            1,
            180,
        );
    });
});

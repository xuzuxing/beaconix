import { RumAlertMetric, RumAlertScope } from '../../../generated/prisma/enums';
import { RumAlertEvaluatorService } from './rum-alert-evaluator.service';

describe('RumAlertEvaluatorService', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-11-03T12:34:56.000Z'));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function rule(overrides: Record<string, unknown> = {}) {
        return {
            id: 'rule-1',
            appId: 'app-1',
            metric: RumAlertMetric.ERROR_COUNT,
            scope: RumAlertScope.APP,
            groupId: null,
            eventName: null,
            threshold: 5,
            windowMinutes: 5,
            confirmWindows: 1,
            consecutiveHits: 0,
            silenceUntil: null,
            active: false,
            ...overrides,
        };
    }

    function setup(ruleOverrides: Record<string, unknown> = {}) {
        const tx = {
            $queryRaw: jest.fn().mockResolvedValue([]),
            rumAlertRule: {
                findFirst: jest.fn().mockResolvedValue(rule(ruleOverrides)),
                update: jest.fn().mockResolvedValue({}),
            },
            rumMetricBucket: {
                aggregate: jest.fn().mockResolvedValue({ _sum: { count: 6 } }),
            },
            rumErrorOccurrence: {
                count: jest.fn().mockResolvedValue(0),
            },
            rumErrorGroup: {
                count: jest.fn().mockResolvedValue(0),
                findFirst: jest.fn().mockResolvedValue(null),
            },
            rumAlertIncident: {
                findFirst: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'incident-1' }),
                update: jest.fn(),
                updateMany: jest.fn(),
                findMany: jest.fn().mockResolvedValue([]),
            },
        };
        const prisma = {
            $transaction: jest.fn((work) => work(tx)),
            rumAlertRule: {
                findMany: jest.fn().mockResolvedValue([]),
            },
            rumAlertIncident: {
                findMany: jest.fn().mockResolvedValue([]),
                updateMany: jest.fn(),
            },
        };
        const notifications = {
            projectRecipients: jest.fn().mockResolvedValue(['user-1']),
            publish: jest.fn().mockResolvedValue(undefined),
        };
        const notifier = {
            notifyRumAlert: jest
                .fn()
                .mockResolvedValue({ failed: 0, enqueued: 1 }),
        };
        const service = new RumAlertEvaluatorService(
            prisma as never,
            {} as never,
            notifications as never,
            notifier as never,
        );
        return { service, tx, prisma, notifications, notifier };
    }

    it('opens an incident when the metric reaches the threshold', async () => {
        const { service, tx } = setup();

        await service.evaluateRule('rule-1');

        expect(tx.rumAlertIncident.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                ruleId: 'rule-1',
                appId: 'app-1',
                value: 6,
                threshold: 5,
            }),
        });
        expect(tx.rumAlertRule.update).toHaveBeenCalledWith({
            where: { id: 'rule-1' },
            data: expect.objectContaining({
                active: true,
                lastValue: 6,
                consecutiveHits: 1,
            }),
        });
        expect(tx.rumMetricBucket.aggregate).toHaveBeenCalledWith({
            where: {
                appId: 'app-1',
                kind: 'ERROR',
                name: '*',
                bucketStart: {
                    gte: new Date('2026-11-03T12:30:00.000Z'),
                },
            },
            _sum: { count: true },
        });
    });

    it('waits for confirmWindows consecutive matches before opening', async () => {
        const { service, tx } = setup({ confirmWindows: 2 });

        await service.evaluateRule('rule-1');

        expect(tx.rumAlertIncident.create).not.toHaveBeenCalled();
        expect(tx.rumAlertRule.update).toHaveBeenCalledWith({
            where: { id: 'rule-1' },
            data: expect.objectContaining({ consecutiveHits: 1 }),
        });
    });

    it('opens once the confirmation window is satisfied', async () => {
        const { service, tx } = setup({
            confirmWindows: 2,
            consecutiveHits: 1,
        });

        await service.evaluateRule('rule-1');

        expect(tx.rumAlertIncident.create).toHaveBeenCalled();
        expect(tx.rumAlertRule.update).toHaveBeenCalledWith({
            where: { id: 'rule-1' },
            data: expect.objectContaining({ active: true, consecutiveHits: 2 }),
        });
    });

    it('resets the confirmation counter when the window is missed', async () => {
        const { service, tx } = setup({
            confirmWindows: 3,
            consecutiveHits: 2,
            active: false,
        });
        tx.rumMetricBucket.aggregate.mockResolvedValue({ _sum: { count: 0 } });

        await service.evaluateRule('rule-1');

        expect(tx.rumAlertRule.update).toHaveBeenCalledWith({
            where: { id: 'rule-1' },
            data: expect.objectContaining({
                active: false,
                consecutiveHits: 0,
            }),
        });
    });

    it('scopes ERROR_COUNT to a single error group through occurrences', async () => {
        const { service, tx } = setup({
            scope: RumAlertScope.ERROR_GROUP,
            groupId: 'group-1',
            threshold: 3,
        });
        tx.rumErrorOccurrence.count.mockResolvedValue(4);

        await service.evaluateRule('rule-1');

        expect(tx.rumErrorOccurrence.count).toHaveBeenCalledWith({
            where: {
                appId: 'app-1',
                groupId: 'group-1',
                receivedAt: { gte: new Date('2026-11-03T12:30:00.000Z') },
            },
        });
        expect(tx.rumMetricBucket.aggregate).not.toHaveBeenCalled();
        expect(tx.rumAlertIncident.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ value: 4, threshold: 3 }),
        });
    });

    it('fires NEW_ERROR when a fingerprint first appeared in the window', async () => {
        const { service, tx } = setup({
            metric: RumAlertMetric.NEW_ERROR,
            threshold: 1,
        });
        tx.rumErrorGroup.count.mockResolvedValue(2);

        await service.evaluateRule('rule-1');

        expect(tx.rumErrorGroup.count).toHaveBeenCalledWith({
            where: {
                appId: 'app-1',
                firstSeenAt: { gte: new Date('2026-11-03T12:30:00.000Z') },
            },
        });
        expect(tx.rumAlertIncident.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ value: 2 }),
        });
    });

    it('computes ERROR_RATE with the event denominator', async () => {
        const { service, tx } = setup({
            metric: RumAlertMetric.ERROR_RATE,
            threshold: 10,
        });
        tx.rumMetricBucket.aggregate
            .mockResolvedValueOnce({ _sum: { count: 12 } })
            .mockResolvedValueOnce({ _sum: { count: 100 } });

        await service.evaluateRule('rule-1');

        expect(tx.rumAlertIncident.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ value: 12, threshold: 10 }),
        });
    });

    it('never fires ERROR_RATE without an event denominator', async () => {
        const { service, tx } = setup({
            metric: RumAlertMetric.ERROR_RATE,
            threshold: 10,
        });
        tx.rumMetricBucket.aggregate
            .mockResolvedValueOnce({ _sum: { count: 12 } })
            .mockResolvedValueOnce({ _sum: { count: 0 } });

        await service.evaluateRule('rule-1');

        expect(tx.rumAlertIncident.create).not.toHaveBeenCalled();
        expect(tx.rumAlertRule.update).toHaveBeenCalledWith({
            where: { id: 'rule-1' },
            data: expect.objectContaining({ active: false, lastValue: 0 }),
        });
    });

    it('compares SPIKE against the previous equal-length window', async () => {
        const { service, tx } = setup({
            metric: RumAlertMetric.SPIKE,
            threshold: 50,
        });
        tx.rumMetricBucket.aggregate
            .mockResolvedValueOnce({ _sum: { count: 30 } })
            .mockResolvedValueOnce({ _sum: { count: 10 } });

        await service.evaluateRule('rule-1');

        // 10 -> 30 is +200%, above the 50% growth threshold.
        expect(tx.rumAlertIncident.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ value: 30 }),
        });
        expect(tx.rumMetricBucket.aggregate).toHaveBeenNthCalledWith(2, {
            where: {
                appId: 'app-1',
                kind: 'ERROR',
                name: '*',
                bucketStart: {
                    gte: new Date('2026-11-03T12:25:00.000Z'),
                    lt: new Date('2026-11-03T12:30:00.000Z'),
                },
            },
            _sum: { count: true },
        });
    });

    it('does not fire SPIKE when the previous window was empty', async () => {
        const { service, tx } = setup({
            metric: RumAlertMetric.SPIKE,
            threshold: 50,
        });
        tx.rumMetricBucket.aggregate
            .mockResolvedValueOnce({ _sum: { count: 30 } })
            .mockResolvedValueOnce({ _sum: { count: 0 } });

        await service.evaluateRule('rule-1');

        expect(tx.rumAlertIncident.create).not.toHaveBeenCalled();
    });

    it('suppresses notifications while the rule is silenced', async () => {
        const { service, prisma, notifications, notifier } = setup();
        prisma.rumAlertIncident.findMany.mockResolvedValue([
            {
                id: 'incident-1',
                status: 'OPEN',
                value: 9,
                threshold: 5,
                startedAt: new Date('2026-11-03T12:00:00.000Z'),
                openedNotifiedAt: null,
                resolvedNotifiedAt: null,
                rule: rule({
                    silenceUntil: new Date('2026-11-03T13:00:00.000Z'),
                }),
                app: {
                    id: 'app-1',
                    name: 'Portal',
                    projectId: 'project-1',
                    organizationId: 'org-1',
                },
            },
        ]);

        await service.handleEvaluation();

        expect(notifications.publish).not.toHaveBeenCalled();
        expect(notifier.notifyRumAlert).not.toHaveBeenCalled();
        // Marked as notified so it is not back-filled after the silence ends.
        expect(prisma.rumAlertIncident.updateMany).toHaveBeenCalledWith({
            where: { id: 'incident-1', openedNotifiedAt: null },
            data: { openedNotifiedAt: expect.any(Date) },
        });
    });
});

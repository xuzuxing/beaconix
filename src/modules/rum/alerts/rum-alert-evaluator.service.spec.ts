import { RumAlertMetric } from '../../../generated/prisma/enums';
import { RumAlertEvaluatorService } from './rum-alert-evaluator.service';

describe('RumAlertEvaluatorService', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-11-03T12:34:56.000Z'));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('opens an incident when the metric reaches the threshold', async () => {
        const tx = {
            $queryRaw: jest.fn().mockResolvedValue([]),
            rumAlertRule: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'rule-1',
                    appId: 'app-1',
                    metric: RumAlertMetric.ERROR_COUNT,
                    eventName: null,
                    threshold: 5,
                    windowMinutes: 5,
                    active: false,
                }),
                update: jest.fn().mockResolvedValue({}),
            },
            rumMetricBucket: {
                aggregate: jest.fn().mockResolvedValue({ _sum: { count: 6 } }),
            },
            rumAlertIncident: {
                findFirst: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'incident-1' }),
                update: jest.fn(),
                updateMany: jest.fn(),
            },
        };
        const prisma = {
            $transaction: jest.fn((work) => work(tx)),
        };
        const service = new RumAlertEvaluatorService(
            prisma as never,
            {} as never,
            {} as never,
            {} as never,
        );

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
            data: expect.objectContaining({ active: true, lastValue: 6 }),
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
});

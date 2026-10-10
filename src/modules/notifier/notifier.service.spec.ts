import { NotFoundException } from '@nestjs/common';
import { NotifierService } from './notifier.service';
import {
    MONITOR_AVAILABILITY_JOB,
    MONITOR_TRANSITION_JOB,
} from './notifier.queue';
import type { PrismaService } from '../../infra/database/prisma.service';

const monitorRow = {
    id: 'monitor-1',
    organizationId: 'org-1',
    name: 'Production API',
    type: 'HTTP',
    target: 'https://api.example.com/health',
    interval: 60,
    timeout: 5000,
    expectedStatus: 200,
    failureThreshold: 3,
    checkSsl: false,
    sslExpiryThreshold: 30,
    enabled: true,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    deletedAt: null,
};

const stateRow = {
    monitorId: 'monitor-1',
    status: 'DOWN',
    failCount: 3,
    lastCheckAt: new Date('2026-03-05T12:00:00.000Z'),
    lastError: 'connect ECONNREFUSED',
    lastLatency: 30,
    lastNotifiedStatus: null,
    sslExpiresAt: null,
    sslDaysRemaining: null,
    sslIssuer: null,
    sslSubject: null,
    sslLastNotifiedAt: null,
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

const channelRow = {
    id: 'channel-1',
    organizationId: 'org-1',
    type: 'FEISHU',
    name: 'Platform alerts',
    config: { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' },
    enabled: true,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

const transition = {
    previousStatus: 'UP',
    previousFailCount: 0,
    status: 'DOWN',
    failCount: 3,
    changed: true,
} as const;

function createService() {
    const prisma = {
        monitor: { findFirst: jest.fn() },
        notificationChannel: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
        },
        notificationLog: { create: jest.fn() },
        monitorNotificationChannel: { findMany: jest.fn() },
    };
    const stateService = {
        markNotified: jest.fn(),
        markSslNotified: jest.fn(),
    };

    const senders = {
        feishu: { send: jest.fn() },
        wecom: { send: jest.fn() },
        dingtalk: { send: jest.fn() },
        wechat: { send: jest.fn() },
        email: { send: jest.fn() },
    };

    const queue = { add: jest.fn() };

    const service = new NotifierService(
        prisma as unknown as PrismaService,
        senders.feishu as never,
        senders.wecom as never,
        senders.dingtalk as never,
        senders.wechat as never,
        senders.email as never,
        queue as never,
    );

    return { service, prisma, stateService, senders, queue };
}

describe('NotifierService.shouldNotify', () => {
    it('announces an UP -> DOWN transition', () => {
        expect(NotifierService.shouldNotify(transition as never, null)).toBe(
            true,
        );
    });

    it('does not announce the first successful check', () => {
        expect(
            NotifierService.shouldNotify(
                {
                    ...transition,
                    previousStatus: 'UNKNOWN',
                    status: 'UP',
                    failCount: 0,
                } as never,
                null,
            ),
        ).toBe(false);
    });

    it('does not announce the first failed check', () => {
        expect(
            NotifierService.shouldNotify(
                {
                    ...transition,
                    previousStatus: 'UNKNOWN',
                    status: 'DOWN',
                } as never,
                null,
            ),
        ).toBe(false);
    });

    it('does not announce the DEGRADED buffer state', () => {
        expect(
            NotifierService.shouldNotify(
                {
                    ...transition,
                    status: 'DEGRADED',
                    failCount: 1,
                } as never,
                null,
            ),
        ).toBe(false);
    });

    it('announces recovery only after a delivered DOWN alert', () => {
        expect(
            NotifierService.shouldNotify(
                {
                    ...transition,
                    previousStatus: 'DOWN',
                    status: 'UP',
                    failCount: 0,
                } as never,
                'DOWN',
            ),
        ).toBe(true);
        expect(
            NotifierService.shouldNotify(
                {
                    ...transition,
                    previousStatus: 'DOWN',
                    status: 'UP',
                    failCount: 0,
                } as never,
                null,
            ),
        ).toBe(false);
    });

    it('does not repeat a status that was already announced', () => {
        expect(NotifierService.shouldNotify(transition as never, 'DOWN')).toBe(
            false,
        );
    });

    it('ignores paused monitors', () => {
        expect(
            NotifierService.shouldNotify(
                { ...transition, status: 'PAUSED' } as never,
                null,
            ),
        ).toBe(false);
    });
});

describe('NotifierService', () => {
    describe('notifyTransition', () => {
        it('enqueues one job per enabled channel without sending synchronously', async () => {
            const { service, prisma, queue, stateService, senders } =
                createService();
            prisma.notificationChannel.findMany.mockResolvedValue([channelRow]);
            queue.add.mockResolvedValue({ id: 'job-1' });

            const result = await service.notifyTransition(
                monitorRow as never,
                { ...stateRow, status: 'DOWN' } as never,
                transition,
            );

            expect(prisma.notificationChannel.findMany).toHaveBeenCalledWith({
                where: { organizationId: 'org-1', enabled: true },
                orderBy: { createdAt: 'asc' },
            });
            expect(queue.add).toHaveBeenCalledWith(
                MONITOR_TRANSITION_JOB,
                {
                    channelId: 'channel-1',
                    payload: expect.objectContaining({
                        monitorId: 'monitor-1',
                        previousStatus: 'UP',
                        status: 'DOWN',
                        event: 'DOWN',
                        error: 'connect ECONNREFUSED',
                    }),
                    transitionStatus: 'DOWN',
                    sslAlert: false,
                },
                expect.objectContaining({
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 5000 },
                }),
            );
            expect(senders.feishu.send).not.toHaveBeenCalled();
            expect(stateService.markNotified).not.toHaveBeenCalled();
            expect(result).toEqual({ skipped: false, sent: 1, failed: 0 });
        });

        it('reports enqueue failures without throwing', async () => {
            const { service, prisma, queue, stateService } = createService();
            prisma.notificationChannel.findMany.mockResolvedValue([channelRow]);
            queue.add.mockRejectedValue(new Error('redis down'));

            const result = await service.notifyTransition(
                monitorRow as never,
                { ...stateRow, status: 'DOWN' } as never,
                transition,
            );

            expect(result).toEqual({ skipped: false, sent: 0, failed: 1 });
            expect(stateService.markNotified).not.toHaveBeenCalled();
        });

        it('flags SSL alerts in the job data', async () => {
            const { service, prisma, queue } = createService();
            prisma.notificationChannel.findMany.mockResolvedValue([channelRow]);
            queue.add.mockResolvedValue({ id: 'job-1' });

            await service.notifyTransition(
                monitorRow as never,
                {
                    ...stateRow,
                    status: 'DOWN',
                    lastError:
                        'SSL certificate expires in 5 day(s) on 2026-03-10T12:00:00.000Z',
                    sslExpiresAt: new Date('2026-03-10T12:00:00.000Z'),
                    sslDaysRemaining: 5,
                } as never,
                transition,
            );

            expect(queue.add).toHaveBeenCalledWith(
                MONITOR_TRANSITION_JOB,
                expect.objectContaining({ sslAlert: true }),
                expect.anything(),
            );
        });

        it('skips the fan-out when the organization has no channel', async () => {
            const { service, prisma, queue, stateService } = createService();
            prisma.notificationChannel.findMany.mockResolvedValue([]);

            const result = await service.notifyTransition(
                monitorRow as never,
                {} as never,
                transition,
            );

            expect(result).toEqual({ skipped: true, sent: 0, failed: 0 });
            expect(queue.add).not.toHaveBeenCalled();
            expect(stateService.markNotified).not.toHaveBeenCalled();
        });

        it('skips the fan-out when the transition is not notifiable', async () => {
            const { service, prisma, queue } = createService();

            const result = await service.notifyTransition(
                monitorRow as never,
                { ...stateRow, status: 'UP' } as never,
                {
                    ...transition,
                    previousStatus: 'UNKNOWN',
                    status: 'UP',
                } as never,
            );

            expect(result.skipped).toBe(true);
            expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
            expect(queue.add).not.toHaveBeenCalled();
        });
    });

    describe('notifyAvailabilityAlert', () => {
        const alert = {
            availabilityPercent: 25,
            threshold: 90,
            window: 10,
            sampleSize: 4,
        };

        it('delivers to the channels bound to the monitor', async () => {
            const { service, prisma, queue } = createService();
            prisma.monitorNotificationChannel.findMany.mockResolvedValue([
                {
                    monitorId: 'monitor-1',
                    channelId: 'channel-1',
                    channel: channelRow,
                },
            ]);
            queue.add.mockResolvedValue({ id: 'job-1' });

            const result = await service.notifyAvailabilityAlert(
                monitorRow as never,
                { ...stateRow, status: 'DOWN' } as never,
                alert,
            );

            expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
            expect(queue.add).toHaveBeenCalledWith(
                MONITOR_AVAILABILITY_JOB,
                {
                    channelId: 'channel-1',
                    payload: expect.objectContaining({
                        event: 'AVAILABILITY_ALERT',
                        availabilityPercent: 25,
                        availabilityThreshold: 90,
                        availabilityWindow: 10,
                        availabilitySampleSize: 4,
                    }),
                    transitionStatus: 'DOWN',
                    sslAlert: false,
                },
                expect.objectContaining({ attempts: 3 }),
            );
            expect(result).toEqual({ skipped: false, sent: 1, failed: 0 });
        });

        it('falls back to every organization channel when there is no binding', async () => {
            const { service, prisma, queue } = createService();
            prisma.monitorNotificationChannel.findMany.mockResolvedValue([]);
            prisma.notificationChannel.findMany.mockResolvedValue([channelRow]);
            queue.add.mockResolvedValue({ id: 'job-1' });

            const result = await service.notifyAvailabilityAlert(
                monitorRow as never,
                { ...stateRow, status: 'DOWN' } as never,
                alert,
            );

            expect(prisma.notificationChannel.findMany).toHaveBeenCalledWith({
                where: { organizationId: 'org-1', enabled: true },
                orderBy: { createdAt: 'asc' },
            });
            expect(result).toEqual({ skipped: false, sent: 1, failed: 0 });
        });

        it('sends nothing when every bound channel is disabled', async () => {
            const { service, prisma, queue } = createService();
            prisma.monitorNotificationChannel.findMany.mockResolvedValue([
                {
                    monitorId: 'monitor-1',
                    channelId: 'channel-1',
                    channel: { ...channelRow, enabled: false },
                },
            ]);

            const result = await service.notifyAvailabilityAlert(
                monitorRow as never,
                { ...stateRow, status: 'DOWN' } as never,
                alert,
            );

            expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
            expect(queue.add).not.toHaveBeenCalled();
            expect(result).toEqual({ skipped: true, sent: 0, failed: 0 });
        });
    });

    describe('deliver', () => {
        it('skips stale or paused monitor notification jobs before channel delivery', async () => {
            const { service, prisma, senders } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);
            expect(
                await service.deliver('channel-1', {
                    monitorId: 'monitor-1',
                    monitorRevision: 1,
                    organizationId: 'org-1',
                } as never),
            ).toBe(false);
            expect(
                prisma.notificationChannel.findUnique,
            ).not.toHaveBeenCalled();
            expect(senders.feishu.send).not.toHaveBeenCalled();
        });
        it('sends synchronously and writes a SUCCESS log', async () => {
            const { service, prisma, senders } = createService();
            prisma.notificationChannel.findUnique.mockResolvedValue(channelRow);
            prisma.notificationLog.create.mockResolvedValue({ id: 'log-1' });
            senders.feishu.send.mockResolvedValue(undefined);

            await service.deliver('channel-1', {
                monitorId: 'monitor-1',
                monitorName: 'Production API',
                monitorType: 'HTTP',
                target: 'https://api.example.com/health',
                organizationId: 'org-1',
                previousStatus: 'UP',
                status: 'DOWN',
                event: 'DOWN',
                failCount: 3,
                latency: 30,
                error: 'connect ECONNREFUSED',
                checkedAt: new Date('2026-03-05T12:00:00.000Z'),
            });

            expect(senders.feishu.send).toHaveBeenCalledWith(
                channelRow,
                expect.objectContaining({ monitorId: 'monitor-1' }),
            );
            expect(prisma.notificationLog.create).toHaveBeenCalledWith({
                data: {
                    channelId: 'channel-1',
                    monitorId: 'monitor-1',
                    status: 'SUCCESS',
                    error: null,
                },
            });
        });

        it('writes a FAILED log and rethrows so BullMQ can retry', async () => {
            const { service, prisma, senders } = createService();
            prisma.notificationChannel.findUnique.mockResolvedValue(channelRow);
            prisma.notificationLog.create.mockResolvedValue({ id: 'log-1' });
            senders.feishu.send.mockRejectedValue(new Error('HTTP 500'));

            await expect(
                service.deliver('channel-1', {
                    monitorId: 'monitor-1',
                    monitorName: 'Production API',
                    monitorType: 'HTTP',
                    target: 'https://api.example.com/health',
                    organizationId: 'org-1',
                    previousStatus: 'UP',
                    status: 'DOWN',
                    event: 'DOWN',
                    failCount: 3,
                    latency: 30,
                    error: 'connect ECONNREFUSED',
                    checkedAt: new Date('2026-03-05T12:00:00.000Z'),
                }),
            ).rejects.toThrow('HTTP 500');

            expect(prisma.notificationLog.create).toHaveBeenCalledWith({
                data: {
                    channelId: 'channel-1',
                    monitorId: 'monitor-1',
                    status: 'FAILED',
                    error: 'HTTP 500',
                },
            });
        });
    });

    describe('sendTestMessage', () => {
        it('delivers a test payload without touching monitor state', async () => {
            const { service, prisma, senders } = createService();
            prisma.notificationChannel.findFirst.mockResolvedValue(channelRow);
            senders.feishu.send.mockResolvedValue(undefined);

            const result = await service.sendTestMessage('org-1', 'channel-1');

            expect(senders.feishu.send).toHaveBeenCalledWith(
                channelRow,
                expect.objectContaining({
                    monitorName: 'Beacon test notification',
                    event: 'DOWN',
                }),
            );
            expect(result).toEqual({ delivered: true, error: null });
        });

        it('reports the failure instead of throwing', async () => {
            const { service, prisma, senders } = createService();
            prisma.notificationChannel.findFirst.mockResolvedValue(channelRow);
            senders.feishu.send.mockRejectedValue(new Error('boom'));

            const result = await service.sendTestMessage('org-1', 'channel-1');

            expect(result).toEqual({ delivered: false, error: 'boom' });
        });

        it('throws when the channel is not in the organization', async () => {
            const { service, prisma } = createService();
            prisma.notificationChannel.findFirst.mockResolvedValue(null);

            await expect(
                service.sendTestMessage('org-1', 'channel-1'),
            ).rejects.toThrow(NotFoundException);
        });
    });
});

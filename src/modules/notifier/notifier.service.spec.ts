import { NotFoundException } from '@nestjs/common';
import { NotifierService } from './notifier.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { StateService } from '../state/state.service';

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
        notificationChannel: { findMany: jest.fn(), findFirst: jest.fn() },
        notificationLog: { create: jest.fn() },
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

    const service = new NotifierService(
        prisma as unknown as PrismaService,
        stateService as unknown as StateService,
        senders.feishu as never,
        senders.wecom as never,
        senders.dingtalk as never,
        senders.wechat as never,
        senders.email as never,
    );

    return { service, prisma, stateService, senders };
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
        it('fans out to every enabled channel and remembers the status', async () => {
            const { service, prisma, stateService, senders } = createService();
            prisma.notificationChannel.findMany.mockResolvedValue([channelRow]);
            prisma.notificationLog.create.mockResolvedValue({ id: 'log-1' });
            senders.feishu.send.mockResolvedValue(undefined);
            stateService.markNotified.mockResolvedValue(undefined);

            const result = await service.notifyTransition(
                monitorRow as never,
                { ...stateRow, status: 'DOWN' } as never,
                transition,
            );

            expect(prisma.notificationChannel.findMany).toHaveBeenCalledWith({
                where: { organizationId: 'org-1', enabled: true },
                orderBy: { createdAt: 'asc' },
            });
            expect(senders.feishu.send).toHaveBeenCalledWith(
                channelRow,
                expect.objectContaining({
                    monitorId: 'monitor-1',
                    previousStatus: 'UP',
                    status: 'DOWN',
                    event: 'DOWN',
                    error: 'connect ECONNREFUSED',
                }),
            );
            expect(prisma.notificationLog.create).toHaveBeenCalledWith({
                data: {
                    channelId: 'channel-1',
                    monitorId: 'monitor-1',
                    status: 'SUCCESS',
                    error: null,
                },
            });
            expect(stateService.markNotified).toHaveBeenCalledWith(
                'monitor-1',
                'DOWN',
            );
            expect(result).toEqual({ skipped: false, sent: 1, failed: 0 });
        });

        it('remembers successful SSL alert delivery', async () => {
            const { service, prisma, stateService, senders } = createService();
            prisma.notificationChannel.findMany.mockResolvedValue([channelRow]);
            prisma.notificationLog.create.mockResolvedValue({ id: 'log-1' });
            senders.feishu.send.mockResolvedValue(undefined);
            stateService.markNotified.mockResolvedValue(undefined);
            stateService.markSslNotified.mockResolvedValue(undefined);

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

            expect(stateService.markSslNotified).toHaveBeenCalledWith(
                'monitor-1',
            );
        });

        it('logs a failed delivery and keeps the status unannounced', async () => {
            const { service, prisma, stateService, senders } = createService();
            prisma.notificationChannel.findMany.mockResolvedValue([channelRow]);
            prisma.notificationLog.create.mockResolvedValue({ id: 'log-1' });
            senders.feishu.send.mockRejectedValue(new Error('HTTP 500'));

            const result = await service.notifyTransition(
                monitorRow as never,
                {} as never,
                transition,
            );

            expect(prisma.notificationLog.create).toHaveBeenCalledWith({
                data: {
                    channelId: 'channel-1',
                    monitorId: 'monitor-1',
                    status: 'FAILED',
                    error: 'HTTP 500',
                },
            });
            expect(stateService.markNotified).not.toHaveBeenCalled();
            expect(result).toEqual({ skipped: false, sent: 0, failed: 1 });
        });

        it('skips the fan-out when the organization has no channel', async () => {
            const { service, prisma, stateService } = createService();
            prisma.notificationChannel.findMany.mockResolvedValue([]);

            const result = await service.notifyTransition(
                monitorRow as never,
                {} as never,
                transition,
            );

            expect(result).toEqual({ skipped: true, sent: 0, failed: 0 });
            expect(stateService.markNotified).not.toHaveBeenCalled();
        });

        it('skips the fan-out when the transition is not notifiable', async () => {
            const { service, prisma } = createService();

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

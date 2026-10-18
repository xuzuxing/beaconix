import { mockProjectAccess } from '../../common/authorization/access-test.fixture';
import {
    BadRequestException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { MonitorsService } from './monitors.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import { MonitorSecretsService } from './monitor-secrets.service';
import { ConfigService } from '@nestjs/config';

const monitorRow = {
    id: 'monitor-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    name: 'Production API',
    type: 'HTTP',
    target: 'https://api.example.com/health',
    interval: 60,
    timeout: 5000,
    expectedStatus: 200,
    failureThreshold: 3,
    probeSuccessRatio: 1,
    checkSsl: false,
    sslExpiryThreshold: 30,
    enabled: true,
    config: {},
    configVersion: 1,
    revision: 1,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    deletedAt: null,
};

const projectRow = {
    id: 'project-1',
    organizationId: 'org-1',
    name: 'Platform',
    description: null,
    status: 'ACTIVE',
    key: 'PLAT',
    createdById: 'user-1',
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
    deletedAt: null,
};

/** The include clause single-monitor endpoints use (state, channels, probes). */
const MONITOR_INCLUDE_WITH_PROBES = {
    state: true,
    notificationChannels: true,
    probes: {
        include: {
            probe: {
                select: {
                    id: true,
                    name: true,
                    provider: true,
                    region: true,
                    status: true,
                    enabled: true,
                    lastHeartbeat: true,
                },
            },
        },
    },
};

const stateRow = {
    monitorId: 'monitor-1',
    status: 'UP',
    failCount: 0,
    lastCheckAt: null,
    lastError: null,
    lastLatency: 128,
    lastNotifiedStatus: null,
    sslExpiresAt: null,
    sslDaysRemaining: null,
    sslIssuer: null,
    sslSubject: null,
    sslLastNotifiedAt: null,
    updatedAt: new Date('2026-03-05T12:00:00.000Z'),
};

function createService() {
    const prisma = {
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        monitor: {
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findFirstOrThrow: jest.fn(),
            update: jest.fn(),
        },
        monitorProbe: {
            createMany: jest.fn(),
            deleteMany: jest.fn(),
            findMany: jest.fn().mockResolvedValue([]),
        },
        probe: { count: jest.fn().mockResolvedValue(0) },
        project: { findFirst: jest.fn().mockResolvedValue(projectRow) },
        notificationChannel: { count: jest.fn().mockResolvedValue(0) },
        checkLog: { findMany: jest.fn() },
    };
    const systemProbeScheduler = { rebalance: jest.fn().mockResolvedValue({}) };
    const quotaService = {
        assertCanCreate: jest.fn().mockResolvedValue(undefined),
        assertIntervalAllowed: jest.fn().mockResolvedValue(undefined),
        assertMonitorTypeAllowed: jest.fn().mockResolvedValue(undefined),
        assertProbesAssignable: jest.fn().mockResolvedValue(undefined),
        getProbeAssignmentLimit: jest.fn().mockResolvedValue(10),
        monitorEligibility: jest
            .fn()
            .mockResolvedValue({ eligible: true, reason: null }),
        getMonitorPolicy: jest.fn().mockResolvedValue({
            allowedMonitorTypes: ['HTTP', 'TCP', 'PING', 'DNS'],
            minInterval: 10,
            maxProbes: 10,
            maxProbesPerMonitor: 10,
        }),
    };

    const notifierService = {
        notifyAvailabilityAlert: jest
            .fn()
            .mockResolvedValue({ skipped: false, sent: 1, failed: 0 }),
    };

    const service = new MonitorsService(
        prisma as unknown as PrismaService,
        systemProbeScheduler as never,
        quotaService as never,
        notifierService as never,
        new MonitorSecretsService(
            new ConfigService({
                monitor: { secretKey: Buffer.alloc(32, 7).toString('base64') },
            }),
        ),
        mockProjectAccess(prisma),
    );

    return {
        service,
        prisma,
        systemProbeScheduler,
        quotaService,
        notifierService,
    };
}

describe('MonitorsService', () => {
    describe('application credentials and revisions', () => {
        const crypto = new MonitorSecretsService(
            new ConfigService({
                monitor: { secretKey: Buffer.alloc(32, 7).toString('base64') },
            }),
        );
        const context = {
            organizationId: 'org-1',
            type: 'REDIS' as const,
            target: 'cache.example.com:6379',
        };
        const definition = { password: 'private-password', tls: true, db: 0 };
        const existing = {
            ...monitorRow,
            ...context,
            ...crypto.seal(definition, context),
        };

        it('preserves credentials and revision on a metadata-only update', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockImplementation(({ data }) => ({
                ...existing,
                ...data,
            }));
            const response = await service.update(
                'project-1',
                'monitor-1',
                {
                    name: 'Renamed',
                },
                { type: 'USER', userId: 'user-1' },
            );
            const data = prisma.monitor.update.mock.calls[0][0].data;
            expect(data.revision).toBeUndefined();
            expect(data.credentialsEnc).toBe(existing.credentialsEnc);
            expect(crypto.open({ ...existing, ...data }).password).toBe(
                'private-password',
            );
            expect(JSON.stringify(response)).not.toContain('private-password');
            expect(response).not.toHaveProperty('credentialsEnc');
        });
        it('revises and resets the monitor when credentials change', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockImplementation(({ data }) => ({
                ...existing,
                ...data,
            }));
            await service.update(
                'project-1',
                'monitor-1',
                {
                    config: { password: 'replacement-password' },
                },
                { type: 'USER', userId: 'user-1' },
            );
            const data = prisma.monitor.update.mock.calls[0][0].data;
            expect(data.revision).toEqual({ increment: 1 });
            expect(crypto.open({ ...existing, ...data }).password).toBe(
                'replacement-password',
            );
            expect(data.config).toEqual({ tls: true, db: 0 });
            expect(data.state.upsert.update).toMatchObject({
                connectivityFailCount: 0,
                lastAppliedObservationAt: null,
                lastAppliedObservationId: null,
            });
        });
        it('does not revise an equivalent full config despite randomized ciphertext', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockResolvedValue(existing);
            await service.update(
                'project-1',
                'monitor-1',
                {
                    config: { password: 'private-password' },
                },
                { type: 'USER', userId: 'user-1' },
            );
            expect(
                prisma.monitor.update.mock.calls[0][0].data.revision,
            ).toBeUndefined();
            expect(
                prisma.monitor.update.mock.calls[0][0].data.credentialsEnc,
            ).toBe(existing.credentialsEnc);
        });
        it('requires credential re-entry on retargeting and clears omitted replacement credentials', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockResolvedValue(existing);
            await expect(
                service.update(
                    'project-1',
                    'monitor-1',
                    {
                        target: 'other.example.com:6379',
                    },
                    { type: 'USER', userId: 'user-1' },
                ),
            ).rejects.toThrow('re-entered');
            expect(prisma.monitor.update).not.toHaveBeenCalled();
            await service.update(
                'project-1',
                'monitor-1',
                {
                    target: 'other.example.com:6379',
                    config: definition,
                },
                { type: 'USER', userId: 'user-1' },
            );
            const data = prisma.monitor.update.mock.calls[0][0].data;
            expect(crypto.open({ ...existing, ...data }).password).toBe(
                'private-password',
            );
            expect(() =>
                crypto.open({
                    ...existing,
                    credentialsEnc: data.credentialsEnc,
                }),
            ).toThrow();
            await service.update(
                'project-1',
                'monitor-1',
                { config: {} },
                { type: 'USER', userId: 'user-1' },
            );
            expect(
                prisma.monitor.update.mock.calls[1][0].data.credentialsEnc,
            ).toBeNull();
        });
    });
    describe('create', () => {
        it('creates the companion state row and flattens it into the response', async () => {
            const { service, prisma, systemProbeScheduler } = createService();
            prisma.monitor.create.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
            });

            const result = await service.create(
                'project-1',
                {
                    name: 'Production API',
                    type: 'HTTP',
                    target: 'https://api.example.com/health',
                },
                { type: 'USER', userId: 'user-1' },
            );

            expect(prisma.monitor.create).toHaveBeenCalledWith({
                data: {
                    name: 'Production API',
                    type: 'HTTP',
                    target: 'https://api.example.com/health',
                    organizationId: 'org-1',
                    projectId: 'project-1',
                    config: {},
                    configVersion: 1,
                    state: { create: {} },
                },
                include: MONITOR_INCLUDE_WITH_PROBES,
            });
            expect(result.status).toBe('UP');
            expect(result.lastLatency).toBe(128);
            expect(result).not.toHaveProperty('state');
            expect(systemProbeScheduler.rebalance).toHaveBeenCalledTimes(1);
        });

        it('rejects an HTTP target without an http(s) scheme', async () => {
            const { service, prisma } = createService();

            await expect(
                service.create(
                    'project-1',
                    {
                        name: 'Production API',
                        type: 'HTTP',
                        target: 'api.example.com/health',
                    },
                    { type: 'USER', userId: 'user-1' },
                ),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.monitor.create).not.toHaveBeenCalled();
        });

        it('rejects HTTP userinfo before persisting or scheduling', async () => {
            const { service, prisma, systemProbeScheduler } = createService();
            await expect(
                service.create(
                    'project-1',
                    {
                        name: 'Production API',
                        type: 'HTTP',
                        target: 'https://user:private-password@example.com/check',
                    },
                    { type: 'USER', userId: 'user-1' },
                ),
            ).rejects.toThrow('must not contain URL credentials');
            expect(prisma.monitor.create).not.toHaveBeenCalled();
            expect(systemProbeScheduler.rebalance).not.toHaveBeenCalled();
        });

        it('rejects a TCP target without a valid port', async () => {
            const { service, prisma } = createService();

            await expect(
                service.create(
                    'project-1',
                    {
                        name: 'Database',
                        type: 'TCP',
                        target: 'db.internal:not-a-port',
                    },
                    { type: 'USER', userId: 'user-1' },
                ),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.monitor.create).not.toHaveBeenCalled();
        });

        it('binds notification channels that belong to the organization', async () => {
            const { service, prisma } = createService();
            prisma.notificationChannel.count.mockResolvedValue(1);
            prisma.monitor.create.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
                notificationChannels: [{ channelId: 'channel-1' }],
            });

            const result = await service.create(
                'project-1',
                {
                    name: 'Production API',
                    type: 'HTTP',
                    target: 'https://api.example.com/health',
                    notificationChannelIds: ['channel-1'],
                },
                { type: 'USER', userId: 'user-1' },
            );

            expect(prisma.notificationChannel.count).toHaveBeenCalledWith({
                where: { id: { in: ['channel-1'] }, organizationId: 'org-1' },
            });
            expect(prisma.monitor.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    notificationChannels: {
                        create: [{ channelId: 'channel-1' }],
                    },
                }),
                include: MONITOR_INCLUDE_WITH_PROBES,
            });
            expect(result.notificationChannelIds).toEqual(['channel-1']);
        });

        it('rejects notification channels from another organization', async () => {
            const { service, prisma } = createService();
            prisma.notificationChannel.count.mockResolvedValue(0);

            await expect(
                service.create(
                    'project-1',
                    {
                        name: 'Production API',
                        type: 'HTTP',
                        target: 'https://api.example.com/health',
                        notificationChannelIds: ['foreign-channel'],
                    },
                    { type: 'USER', userId: 'user-1' },
                ),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.monitor.create).not.toHaveBeenCalled();
        });
    });

    describe('update', () => {
        it('keeps revision for equivalent HTTP assertion defaults', async () => {
            const { service, prisma } = createService();
            const existing = { ...monitorRow, config: { keyword: 'healthy' } };
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockResolvedValue(existing);
            await service.update(
                'project-1',
                'monitor-1',
                {
                    config: {
                        maxBodyBytes: 65536,
                        keywordMode: 'contains',
                        keyword: 'healthy',
                    },
                },
                { type: 'USER', userId: 'user-1' },
            );
            const data = prisma.monitor.update.mock.calls[0][0].data;
            expect(data.revision).toBeUndefined();
            expect(data.state).toBeUndefined();
        });

        it.each([
            {},
            { keyword: 'ready' },
            { keyword: 'healthy', keywordMode: 'notContains' },
            { keyword: 'healthy', maxBodyBytes: 1024 },
            {
                jsonAssertions: [
                    { path: '/status', operator: 'eq', value: 'ok' },
                ],
            },
        ])(
            'revises and resets state for HTTP semantic changes %#',
            async (config) => {
                const { service, prisma } = createService();
                const existing = {
                    ...monitorRow,
                    config: { keyword: 'healthy' },
                    state: stateRow,
                };
                prisma.monitor.findFirst.mockResolvedValue(existing);
                prisma.monitor.update.mockResolvedValue(existing);
                await service.update(
                    'project-1',
                    'monitor-1',
                    { config },
                    { type: 'USER', userId: 'user-1' },
                );
                expect(prisma.monitor.update).toHaveBeenCalledWith(
                    expect.objectContaining({
                        data: expect.objectContaining({
                            revision: { increment: 1 },
                            state: expect.objectContaining({
                                upsert: expect.objectContaining({
                                    update: expect.objectContaining({
                                        status: 'UNKNOWN',
                                        failCount: 0,
                                        lastLocalCheckAt: null,
                                        availabilityAlertPendingId: null,
                                    }),
                                }),
                            }),
                        }),
                    }),
                );
            },
        );

        it('revises and resets state when the probe success ratio changes', async () => {
            const { service, prisma } = createService();
            const existing = {
                ...monitorRow,
                probeSuccessRatio: 1,
                state: stateRow,
            };
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockResolvedValue(existing);

            await service.update(
                'project-1',
                'monitor-1',
                { probeSuccessRatio: 60 },
                { type: 'USER', userId: 'user-1' },
            );

            expect(prisma.monitor.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        probeSuccessRatio: 60,
                        revision: { increment: 1 },
                        state: expect.objectContaining({
                            upsert: expect.objectContaining({
                                update: expect.objectContaining({
                                    status: 'UNKNOWN',
                                    failCount: 0,
                                }),
                            }),
                        }),
                    }),
                }),
            );
        });

        it('keeps the revision and state for the same or an omitted ratio', async () => {
            const { service, prisma } = createService();
            const existing = {
                ...monitorRow,
                probeSuccessRatio: 60,
                state: stateRow,
            };
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockResolvedValue(existing);

            await service.update(
                'project-1',
                'monitor-1',
                { probeSuccessRatio: 60 },
                { type: 'USER', userId: 'user-1' },
            );
            await service.update(
                'project-1',
                'monitor-1',
                { name: 'Renamed' },
                { type: 'USER', userId: 'user-1' },
            );

            for (const call of prisma.monitor.update.mock.calls) {
                expect(call[0].data.revision).toBeUndefined();
                expect(call[0].data.state).toBeUndefined();
            }
        });

        it('keeps a paused monitor paused when the ratio changes', async () => {
            const { service, prisma } = createService();
            const existing = {
                ...monitorRow,
                enabled: false,
                probeSuccessRatio: 1,
                state: { ...stateRow, status: 'PAUSED' },
            };
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockResolvedValue(existing);

            await service.update(
                'project-1',
                'monitor-1',
                { probeSuccessRatio: 100 },
                { type: 'USER', userId: 'user-1' },
            );

            expect(
                prisma.monitor.update.mock.calls[0][0].data.state.upsert.update
                    .status,
            ).toBe('PAUSED');
        });

        it('does not change revision for reordered but semantically identical DNS config', async () => {
            const { service, prisma } = createService();
            const existing = {
                ...monitorRow,
                type: 'DNS',
                target: 'example.com',
                config: { expectedValues: ['1.1.1.1'], recordType: 'A' },
            };
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockResolvedValue(existing);
            await service.update(
                'project-1',
                'monitor-1',
                {
                    config: { recordType: 'A', expectedValues: ['1.1.1.1'] },
                },
                { type: 'USER', userId: 'user-1' },
            );
            expect(
                prisma.monitor.update.mock.calls[0][0].data.revision,
            ).toBeUndefined();
        });
        it('requires explicit replacement config when changing type', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            await expect(
                service.update(
                    'project-1',
                    'monitor-1',
                    {
                        type: 'DNS',
                        target: 'example.com',
                    },
                    { type: 'USER', userId: 'user-1' },
                ),
            ).rejects.toThrow('complete config');
            expect(prisma.monitor.update).not.toHaveBeenCalled();
        });

        it('replaces DNS config instead of preserving omitted nested fields', async () => {
            const { service, prisma } = createService();
            const existing = {
                ...monitorRow,
                type: 'DNS',
                target: 'example.com',
                config: { recordType: 'A', expectedValues: ['1.1.1.1'] },
            };
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockResolvedValue(existing);
            await service.update(
                'project-1',
                'monitor-1',
                {
                    config: { recordType: 'AAAA' },
                },
                { type: 'USER', userId: 'user-1' },
            );
            expect(prisma.monitor.update).toHaveBeenCalledWith({
                where: {
                    id: 'monitor-1',
                    projectId: 'project-1',
                    organizationId: 'org-1',
                    revision: 1,
                    deletedAt: null,
                },
                data: expect.objectContaining({
                    config: { recordType: 'AAAA' },
                    revision: { increment: 1 },
                    state: expect.objectContaining({
                        upsert: expect.objectContaining({
                            update: expect.objectContaining({
                                lastLocalCheckAt: null,
                                availabilityAlertActive: false,
                                availabilityAlertPendingId: null,
                            }),
                        }),
                    }),
                }),
                include: MONITOR_INCLUDE_WITH_PROBES,
            });
        });

        it('checks new type entitlement before switching and enabling', async () => {
            const { service, prisma, quotaService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            quotaService.assertMonitorTypeAllowed.mockRejectedValue(
                new Error('not entitled'),
            );
            await expect(
                service.update(
                    'project-1',
                    'monitor-1',
                    {
                        type: 'DNS',
                        target: 'example.com',
                        config: {},
                    },
                    { type: 'USER', userId: 'user-1' },
                ),
            ).rejects.toThrow('not entitled');
            expect(prisma.monitor.update).not.toHaveBeenCalled();
        });

        it('does not block an explicit disable after plan downgrade', async () => {
            const { service, prisma, quotaService } = createService();
            const existing = {
                ...monitorRow,
                type: 'DNS',
                target: 'example.com',
                config: { recordType: 'A' },
            };
            prisma.monitor.findFirst.mockResolvedValue(existing);
            prisma.monitor.update.mockResolvedValue({
                ...existing,
                enabled: false,
            });
            quotaService.monitorEligibility.mockResolvedValue({
                eligible: false,
                reason: 'MONITOR_TYPE_NOT_ALLOWED',
            });
            const result = await service.update(
                'project-1',
                'monitor-1',
                {
                    enabled: false,
                },
                { type: 'USER', userId: 'user-1' },
            );
            expect(
                quotaService.assertMonitorTypeAllowed,
            ).not.toHaveBeenCalled();
            expect(result.executionEligible).toBe(false);
            expect(result.executionBlockedReason).toBe('PAUSED');
        });
        it('resets state when the target changes', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
            });
            prisma.monitor.update.mockResolvedValue({
                ...monitorRow,
                target: 'https://api.example.com/ready',
                state: { ...stateRow, status: 'UNKNOWN', failCount: 0 },
            });

            await service.update(
                'project-1',
                'monitor-1',
                {
                    target: 'https://api.example.com/ready',
                },
                { type: 'USER', userId: 'user-1' },
            );

            expect(prisma.monitor.update).toHaveBeenCalledWith({
                where: {
                    id: 'monitor-1',
                    projectId: 'project-1',
                    organizationId: 'org-1',
                    revision: 1,
                    deletedAt: null,
                },
                data: {
                    target: 'https://api.example.com/ready',
                    config: {},
                    revision: { increment: 1 },
                    state: {
                        upsert: {
                            create: { status: 'UNKNOWN' },
                            update: {
                                status: 'UNKNOWN',
                                failCount: 0,
                                lastCheckAt: null,
                                connectivityFailCount: 0,
                                lastAppliedObservationAt: null,
                                lastAppliedObservationId: null,
                                lastLocalCheckAt: null,
                                executionBlockedReason: null,
                                lastError: null,
                                lastLatency: null,
                                lastNotifiedStatus: null,
                                sslExpiresAt: null,
                                sslDaysRemaining: null,
                                sslIssuer: null,
                                sslSubject: null,
                                sslLastNotifiedAt: null,
                                availabilityAlertActive: false,
                                availabilityAlertPendingId: null,
                                lastAvailabilityAlertAt: null,
                            },
                        },
                    },
                },
                include: MONITOR_INCLUDE_WITH_PROBES,
            });
        });

        it('does not reset state for metadata-only changes', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
            });
            prisma.monitor.update.mockResolvedValue({
                ...monitorRow,
                name: 'Renamed API',
                state: stateRow,
            });

            await service.update(
                'project-1',
                'monitor-1',
                {
                    name: 'Renamed API',
                },
                { type: 'USER', userId: 'user-1' },
            );

            expect(prisma.monitor.update).toHaveBeenCalledWith({
                where: {
                    id: 'monitor-1',
                    projectId: 'project-1',
                    organizationId: 'org-1',
                    revision: 1,
                    deletedAt: null,
                },
                data: {
                    name: 'Renamed API',
                    config: {},
                    state: undefined,
                },
                include: MONITOR_INCLUDE_WITH_PROBES,
            });
        });
    });

    describe('findAll', () => {
        it('falls back to UNKNOWN when a monitor has no state row', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findMany.mockResolvedValue([
                { ...monitorRow, state: null },
            ]);

            const [result] = await service.findAll('project-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(prisma.monitor.findMany).toHaveBeenCalledWith({
                where: { projectId: 'project-1', deletedAt: null },
                include: { state: true, notificationChannels: true },
                orderBy: { createdAt: 'desc' },
            });
            expect(result.status).toBe('UNKNOWN');
            expect(result.failCount).toBe(0);
            expect(result.lastLatency).toBeNull();
            expect(result.sslExpiresAt).toBeNull();
        });
    });

    describe('pause / resume', () => {
        it('disables the monitor and marks its state PAUSED', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
            });
            prisma.monitor.update.mockResolvedValue({
                ...monitorRow,
                enabled: false,
                state: { ...stateRow, status: 'PAUSED' },
            });

            const result = await service.pause('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(prisma.monitor.update).toHaveBeenCalledWith({
                where: {
                    id: 'monitor-1',
                    projectId: 'project-1',
                    deletedAt: null,
                    revision: 1,
                },
                data: {
                    enabled: false,
                    revision: { increment: 1 },
                    state: {
                        upsert: {
                            create: { status: 'PAUSED' },
                            update: {
                                status: 'PAUSED',
                                availabilityAlertPendingId: null,
                            },
                        },
                    },
                },
                include: MONITOR_INCLUDE_WITH_PROBES,
            });
            expect(result.enabled).toBe(false);
            expect(result.status).toBe('PAUSED');
        });

        it('rejects pausing an already paused monitor', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                enabled: false,
                state: stateRow,
            });

            await expect(
                service.pause('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                }),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.monitor.update).not.toHaveBeenCalled();
        });

        it('re-enables the monitor and resets its status to UNKNOWN', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                enabled: false,
                state: { ...stateRow, status: 'PAUSED' },
            });
            prisma.monitor.update.mockResolvedValue({
                ...monitorRow,
                state: { ...stateRow, status: 'UNKNOWN' },
            });

            const result = await service.resume('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });

            expect(prisma.monitor.update).toHaveBeenCalledWith({
                where: {
                    id: 'monitor-1',
                    projectId: 'project-1',
                    deletedAt: null,
                    revision: 1,
                },
                data: {
                    enabled: true,
                    revision: { increment: 1 },
                    state: {
                        upsert: {
                            create: {},
                            update: {
                                status: 'UNKNOWN',
                                failCount: 0,
                                connectivityFailCount: 0,
                                lastAppliedObservationAt: null,
                                lastAppliedObservationId: null,
                                lastLocalCheckAt: null,
                                executionBlockedReason: null,
                                availabilityAlertActive: false,
                                availabilityAlertPendingId: null,
                            },
                        },
                    },
                },
                include: MONITOR_INCLUDE_WITH_PROBES,
            });
            expect(result.enabled).toBe(true);
        });
    });

    describe('restore', () => {
        it('rechecks quota, type and interval when restoring', async () => {
            const { service, prisma, quotaService } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                deletedAt: new Date(),
            });
            prisma.monitor.update.mockResolvedValue(monitorRow);
            await service.restore('project-1', 'monitor-1', {
                type: 'USER',
                userId: 'user-1',
            });
            expect(quotaService.assertCanCreate).toHaveBeenCalledWith(
                'org-1',
                'monitors',
            );
            expect(quotaService.assertMonitorTypeAllowed).toHaveBeenCalledWith(
                'org-1',
                'HTTP',
            );
            expect(quotaService.assertIntervalAllowed).toHaveBeenCalledWith(
                'org-1',
                60,
            );
        });
        it('rejects restoring a monitor that is not deleted', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                state: stateRow,
            });

            await expect(
                service.restore('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                }),
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('tenant scoping', () => {
        it('throws when the monitor is not in the project', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            await expect(
                service.findOne('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                }),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('sendTestAlert', () => {
        it('sends a flagged test alert using the current availability', async () => {
            const { service, prisma, notifierService } = createService();
            prisma.monitor.findFirst.mockResolvedValue({
                ...monitorRow,
                availabilityThreshold: 90,
                availabilityWindow: 10,
                state: stateRow,
                notificationChannels: [{ channelId: 'channel-1' }],
            });
            prisma.checkLog.findMany.mockResolvedValue([
                { success: true },
                { success: false },
            ]);

            const result = await service.sendTestAlert(
                'project-1',
                'monitor-1',
                { type: 'USER', userId: 'user-1' },
            );

            expect(prisma.checkLog.findMany).toHaveBeenCalledWith({
                where: { monitorId: 'monitor-1', evaluated: true, revision: 1 },
                orderBy: { checkedAt: 'desc' },
                take: 10,
                select: { success: true },
            });
            expect(
                notifierService.notifyAvailabilityAlert,
            ).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'monitor-1' }),
                stateRow,
                {
                    availabilityPercent: 50,
                    threshold: 90,
                    window: 10,
                    sampleSize: 2,
                    isTest: true,
                },
            );
            expect(result.availabilityPercent).toBe(50);
            expect(result.delivery).toEqual({
                skipped: false,
                sent: 1,
                failed: 0,
            });
        });

        it('throws when the monitor is not in the project', async () => {
            const { service, prisma, notifierService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(null);

            await expect(
                service.sendTestAlert('project-1', 'monitor-1', {
                    type: 'USER',
                    userId: 'user-1',
                }),
            ).rejects.toThrow(NotFoundException);
            expect(
                notifierService.notifyAvailabilityAlert,
            ).not.toHaveBeenCalled();
        });
    });

    describe('probe assignment', () => {
        const monitorWithProbes = {
            ...monitorRow,
            state: stateRow,
            notificationChannels: [],
            probes: [
                {
                    probe: {
                        id: 'probe-1',
                        name: 'Tokyo probe',
                        provider: 'TENCENT',
                        region: 'ap-northeast-1',
                        status: 'ONLINE',
                        enabled: true,
                        lastHeartbeat: null,
                    },
                },
            ],
        };

        it('replaces the probe set and rebalances the scheduler', async () => {
            const { service, prisma, quotaService, systemProbeScheduler } =
                createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.probe.count.mockResolvedValue(2);
            prisma.monitor.findFirstOrThrow.mockResolvedValue(
                monitorWithProbes,
            );

            const result = await service.setProbes(
                'project-1',
                'monitor-1',
                { probeIds: ['probe-1', 'probe-2', 'probe-1'] },
                { type: 'USER', userId: 'user-1' },
            );

            expect(quotaService.assertProbesAssignable).toHaveBeenCalledWith(
                'org-1',
                2,
            );
            expect(prisma.monitorProbe.deleteMany).toHaveBeenCalledWith({
                where: { monitorId: 'monitor-1' },
            });
            expect(prisma.monitorProbe.createMany).toHaveBeenCalledWith({
                data: [
                    { monitorId: 'monitor-1', probeId: 'probe-1' },
                    { monitorId: 'monitor-1', probeId: 'probe-2' },
                ],
                skipDuplicates: true,
            });
            expect(systemProbeScheduler.rebalance).toHaveBeenCalledTimes(1);
            expect(result.probes?.map((probe) => probe.id)).toEqual([
                'probe-1',
            ]);
            expect(result.maxProbes).toBe(10);
        });

        it('clears every assignment for an empty set', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.monitor.findFirstOrThrow.mockResolvedValue({
                ...monitorWithProbes,
                probes: [],
            });

            await service.setProbes(
                'project-1',
                'monitor-1',
                { probeIds: [] },
                { type: 'USER', userId: 'user-1' },
            );

            expect(prisma.probe.count).not.toHaveBeenCalled();
            expect(prisma.monitorProbe.deleteMany).toHaveBeenCalled();
            expect(prisma.monitorProbe.createMany).not.toHaveBeenCalled();
        });

        it('rejects probes from another organization before writing', async () => {
            const { service, prisma } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.probe.count.mockResolvedValue(0);

            await expect(
                service.setProbes(
                    'project-1',
                    'monitor-1',
                    { probeIds: ['probe-x'] },
                    { type: 'USER', userId: 'user-1' },
                ),
            ).rejects.toThrow(BadRequestException);
            expect(prisma.monitorProbe.deleteMany).not.toHaveBeenCalled();
        });

        it('propagates the plan limit rejection', async () => {
            const { service, prisma, quotaService } = createService();
            prisma.monitor.findFirst.mockResolvedValue(monitorRow);
            prisma.probe.count.mockResolvedValue(1);
            quotaService.assertProbesAssignable.mockRejectedValueOnce(
                new ForbiddenException({
                    code: 'QUOTA_EXCEEDED',
                    resource: 'probesPerMonitor',
                    limit: 0,
                }),
            );

            await expect(
                service.setProbes(
                    'project-1',
                    'monitor-1',
                    { probeIds: ['probe-1'] },
                    { type: 'USER', userId: 'user-1' },
                ),
            ).rejects.toMatchObject({
                response: { code: 'QUOTA_EXCEEDED' },
            });
            expect(prisma.monitorProbe.deleteMany).not.toHaveBeenCalled();
        });
    });
});

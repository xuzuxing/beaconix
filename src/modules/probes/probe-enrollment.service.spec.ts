import {
    ForbiddenException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import {
    GlobalRole,
    ProbeProvider,
    ProbeScope,
} from '../../generated/prisma/enums';
import { ProbeEnrollmentService } from './probe-enrollment.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import type { ProbesService } from './probes.service';

function createService() {
    const prisma = {
        membership: { findFirst: jest.fn() },
        probe: { create: jest.fn() },
    };
    const redis = {
        get: jest.fn(),
        set: jest.fn(),
        getJson: jest.fn(),
        setJson: jest.fn(),
        consumeJson: jest.fn(),
    };
    const probesService = {
        create: jest.fn(),
    };

    const service = new ProbeEnrollmentService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        probesService as unknown as ProbesService,
    );

    return { service, prisma, redis, probesService };
}

const deviceState = (overrides: Record<string, unknown> = {}) => ({
    status: 'pending',
    userCodeHash: 'hash',
    client: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

describe('ProbeEnrollmentService', () => {
    describe('startDeviceAuthorization', () => {
        it('issues a device code and a user code, and stores the request', async () => {
            const { service, redis } = createService();

            const result = await service.startDeviceAuthorization({
                hostname: 'host-01',
                platform: 'linux/x64',
            });

            expect(result.deviceCode).toMatch(/^[0-9a-f]{64}$/);
            expect(result.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
            expect(result.verificationUriComplete).toContain(
                encodeURIComponent(result.userCode),
            );
            expect(result.interval).toBeGreaterThan(0);
            expect(result.expiresIn).toBe(600);

            expect(redis.setJson).toHaveBeenCalledWith(
                expect.stringContaining('probe:enroll:dc:'),
                expect.objectContaining({ status: 'pending' }),
                600,
            );
            expect(redis.set).toHaveBeenCalledWith(
                expect.stringContaining('probe:enroll:uc:'),
                result.deviceCode,
                600,
            );
        });
    });

    describe('pollDeviceToken', () => {
        it('reports pending while the request is unsettled', async () => {
            const { service, redis } = createService();
            redis.getJson.mockResolvedValue(deviceState());

            await expect(service.pollDeviceToken('dc')).resolves.toEqual({
                status: 'pending',
            });
        });

        it('hands the credential over exactly once', async () => {
            const { service, redis } = createService();
            redis.getJson.mockResolvedValue(
                deviceState({ status: 'approved' }),
            );
            redis.consumeJson.mockResolvedValueOnce({
                probeId: 'probe-1',
                secret: 'tnt-x',
                apiUrl: 'https://api.beaconix.app/api',
            });

            await expect(service.pollDeviceToken('dc')).resolves.toEqual({
                status: 'approved',
                credential: {
                    probeId: 'probe-1',
                    secret: 'tnt-x',
                    apiUrl: 'https://api.beaconix.app/api',
                },
            });
            // The credential is already collected, so the probe no longer gets it.
            await expect(service.pollDeviceToken('dc')).resolves.toEqual({
                status: 'approved',
            });
        });

        it('reports expired when the request is gone', async () => {
            const { service, redis } = createService();
            redis.getJson.mockResolvedValue(null);

            await expect(service.pollDeviceToken('dc')).resolves.toEqual({
                status: 'expired',
            });
        });

        it('reports denied when the user rejected it', async () => {
            const { service, redis } = createService();
            redis.getJson.mockResolvedValue(deviceState({ status: 'denied' }));

            await expect(service.pollDeviceToken('dc')).resolves.toEqual({
                status: 'denied',
            });
        });
    });

    describe('describeActivation', () => {
        it('returns the pending request for a known user code', async () => {
            const { service, redis } = createService();
            redis.get.mockResolvedValue('dc-1');
            redis.getJson.mockResolvedValue(
                deviceState({ client: { hostname: 'host-01' } }),
            );

            const result = await service.describeActivation('abcd-efgh');

            expect(result.status).toBe('pending');
            expect(result.client.hostname).toBe('host-01');
        });

        it('throws for an unknown user code', async () => {
            const { service, redis } = createService();
            redis.get.mockResolvedValue(null);

            await expect(service.describeActivation('nope')).rejects.toThrow(
                NotFoundException,
            );
        });
    });

    describe('approve', () => {
        it('creates the probe and hands the credential to the poller', async () => {
            const { service, prisma, redis, probesService } = createService();
            prisma.membership.findFirst.mockResolvedValue({ id: 'm1' });
            redis.get.mockResolvedValue('dc-1');
            redis.getJson.mockResolvedValue(
                deviceState({
                    client: { hostname: 'host-01', platform: 'linux/x64' },
                }),
            );
            probesService.create.mockResolvedValue({
                id: 'probe-1',
                secret: 'tnt-secret',
            });

            const result = await service.approve('user-1', GlobalRole.USER, {
                userCode: 'ABCD-EFGH',
                organizationId: 'org-1',
            });

            expect(prisma.membership.findFirst).toHaveBeenCalledWith({
                where: {
                    userId: 'user-1',
                    organizationId: 'org-1',
                    role: { in: ['OWNER', 'ADMIN'] },
                },
                select: { id: true },
            });
            expect(probesService.create).toHaveBeenCalledWith(
                'org-1',
                expect.objectContaining({
                    name: expect.stringContaining('host-01'),
                    provider: ProbeProvider.CUSTOM,
                }),
                'user-1',
            );
            expect(redis.setJson).toHaveBeenCalledWith(
                expect.stringContaining('probe:enroll:cred:'),
                expect.objectContaining({
                    probeId: 'probe-1',
                    secret: 'tnt-secret',
                }),
                60,
            );
            expect(result).toMatchObject({
                probeId: 'probe-1',
                organizationId: 'org-1',
                status: 'approved',
            });
        });

        it('rejects a user who is not an admin of the organization', async () => {
            const { service, prisma } = createService();
            prisma.membership.findFirst.mockResolvedValue(null);

            await expect(
                service.approve('user-1', GlobalRole.USER, {
                    userCode: 'ABCD',
                    organizationId: 'org-1',
                }),
            ).rejects.toThrow(ForbiddenException);
        });

        it('lets a super admin approve without membership', async () => {
            const { service, prisma, redis, probesService } = createService();
            redis.get.mockResolvedValue('dc-1');
            redis.getJson.mockResolvedValue(deviceState());
            probesService.create.mockResolvedValue({
                id: 'probe-1',
                secret: 'tnt-secret',
            });

            await service.approve('admin', GlobalRole.SUPER_ADMIN, {
                userCode: 'ABCD',
                organizationId: 'org-1',
            });

            expect(prisma.membership.findFirst).not.toHaveBeenCalled();
        });

        it('lets a super admin enroll a system probe', async () => {
            const { service, prisma, redis, probesService } = createService();
            redis.get.mockResolvedValue('dc-1');
            redis.getJson.mockResolvedValue(
                deviceState({
                    client: { hostname: 'host-01', platform: 'linux/x64' },
                }),
            );
            prisma.probe.create.mockResolvedValue({ id: 'sys-1' });

            const result = await service.approve(
                'admin',
                GlobalRole.SUPER_ADMIN,
                {
                    userCode: 'ABCD',
                    scope: ProbeScope.SYSTEM,
                },
            );

            expect(probesService.create).not.toHaveBeenCalled();
            expect(prisma.probe.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        scope: ProbeScope.SYSTEM,
                        organizationId: null,
                        name: expect.stringContaining('host-01'),
                    }),
                }),
            );
            expect(redis.setJson).toHaveBeenCalledWith(
                expect.stringContaining('probe:enroll:cred:'),
                expect.objectContaining({ probeId: 'sys-1' }),
                60,
            );
            expect(result).toMatchObject({
                probeId: 'sys-1',
                organizationId: null,
                scope: ProbeScope.SYSTEM,
                status: 'approved',
            });
        });

        it('rejects a system probe from a non-super-admin', async () => {
            const { service, prisma } = createService();

            await expect(
                service.approve('user-1', GlobalRole.USER, {
                    userCode: 'ABCD',
                    scope: ProbeScope.SYSTEM,
                }),
            ).rejects.toThrow(ForbiddenException);

            expect(prisma.probe.create).not.toHaveBeenCalled();
        });
    });

    describe('createEnrollToken', () => {
        it('mints a one-time token and an install command', async () => {
            const { service, prisma, redis } = createService();
            prisma.membership.findFirst.mockResolvedValue({ id: 'm1' });

            const result = await service.createEnrollToken(
                'user-1',
                GlobalRole.USER,
                'org-1',
                { name: 'Tokyo' },
            );

            expect(result.token).toMatch(/^bet_[0-9a-f]{48}$/);
            expect(result.command).toContain(result.token);
            expect(result.command).toContain('sudo sh');
            expect(redis.setJson).toHaveBeenCalledWith(
                expect.stringContaining('probe:enroll:tok:'),
                expect.objectContaining({
                    organizationId: 'org-1',
                    createdById: 'user-1',
                    name: 'Tokyo',
                }),
                900,
            );
        });
    });

    describe('redeem', () => {
        it('consumes the token and returns a credential', async () => {
            const { service, redis, probesService } = createService();
            redis.consumeJson.mockResolvedValue({
                organizationId: 'org-1',
                createdById: 'user-1',
            });
            probesService.create.mockResolvedValue({
                id: 'probe-9',
                secret: 'tnt-9',
            });

            const result = await service.redeem({
                token: 'bet_x',
                hostname: 'host-9',
            });

            expect(result).toEqual({
                probeId: 'probe-9',
                secret: 'tnt-9',
                apiUrl: expect.any(String),
            });
            expect(probesService.create).toHaveBeenCalledWith(
                'org-1',
                expect.objectContaining({
                    name: expect.stringContaining('host-9'),
                }),
                'user-1',
            );
        });

        it('rejects an already used token', async () => {
            const { service, redis } = createService();
            redis.consumeJson.mockResolvedValue(null);

            await expect(service.redeem({ token: 'bet_x' })).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });
});

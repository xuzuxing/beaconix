import { NotFoundException } from '@nestjs/common';
import { MultiLevelCacheService } from '../../infra/cache/multi-level-cache.service';
import { MonitoringDashboardService } from './monitoring-dashboard.service';
import {
    monitoringProjection,
    sanitizeMonitoringDiagnostic,
    sanitizeMonitoringTarget,
} from '../../common/authorization/monitoring-projection';
import type { ProjectRole } from '../../generated/prisma/enums';

describe('Monitoring cached snapshot authorization', () => {
    it('sanitizes before writing L1/L2, reprojects on both replicas, and denies both after revocation', async () => {
        const values = new Map<string, unknown>();
        const redis = {
            getJson: jest
                .fn()
                .mockImplementation((key) =>
                    Promise.resolve(values.get(key) ?? null),
                ),
            setJson: jest.fn().mockImplementation((key, value) => {
                values.set(key, value);
                return Promise.resolve();
            }),
        };
        const caches = [
            new MultiLevelCacheService(redis as never),
            new MultiLevelCacheService(redis as never),
        ];
        let role: ProjectRole = 'ADMIN';
        let revoked = false;
        const access = {
            project: jest.fn().mockImplementation(() => {
                if (revoked) return Promise.reject(new NotFoundException());
                return Promise.resolve({ effectiveRole: role });
            }),
        };
        const tx = {
            $executeRaw: jest.fn().mockResolvedValue(0),
            $queryRaw: jest.fn().mockResolvedValue([{ at: new Date() }]),
        };
        const prisma = {
            $transaction: jest.fn().mockImplementation((work) => work(tx)),
        };
        const services = caches.map(
            (cache) =>
                new MonitoringDashboardService(
                    prisma as never,
                    cache,
                    {} as never,
                    access as never,
                ),
        );
        const snapshot = {
            slowMonitors: [
                {
                    target: 'https://user:password@internal.test/check?access_token=secret',
                },
            ],
            recentAlerts: [
                {
                    target: 'https://old:pass@internal.test/check?customCredential=historical-secret#private',
                    message:
                        "Request cannot be constructed from a URL that includes credentials: https://old:historical'password@internal.test/check?custom=diagnostic-secret",
                },
            ],
            credentialsEnc: 'never-cache',
            total: 2,
        };
        try {
            new Request(
                "https://old:historical'password@internal.test/check?custom=diagnostic-secret",
            );
            throw new Error(
                'Expected a credentialed URL to fail Request construction',
            );
        } catch (error) {
            const failure = error as { name?: string; message?: string };
            if (
                failure.name !== 'TypeError' ||
                typeof failure.message !== 'string'
            )
                throw error;
            snapshot.recentAlerts[0].message = failure.message;
        }
        const build = jest.fn().mockResolvedValue(snapshot);
        const load = (service: MonitoringDashboardService) =>
            service['cached']<typeof snapshot>(
                'project',
                { type: 'USER', userId: 'member' },
                'security-test',
                {},
                30,
                build,
            );
        try {
            // An existing v1 response must not be reused.
            values.set('monitoring:project:security-test:{}', {
                target: 'v1-secret',
            });
            const admin = await load(services[0]);
            const cached = redis.setJson.mock.calls[0][1];
            const encoded = JSON.stringify(cached);
            for (const secret of [
                'password',
                'historical-secret',
                'access_token=secret',
                'never-cache',
                'v1-secret',
                "historical'password",
                'diagnostic-secret',
            ]) {
                expect(encoded).not.toContain(secret);
                expect(JSON.stringify(admin)).not.toContain(secret);
            }
            expect(redis.setJson.mock.calls[0][0]).toBe(
                'monitoring:v2:project:security-test:{}',
            );
            expect(snapshot.slowMonitors[0].target).toContain(
                'access_token=secret',
            );
            const replicaAdmin = await load(services[1]);
            expect(JSON.stringify(replicaAdmin)).not.toContain(
                "historical'password",
            );
            expect(JSON.stringify(replicaAdmin)).not.toContain(
                'diagnostic-secret',
            );
            role = 'VIEWER';
            for (const service of services) {
                const lower = await load(service);
                expect(lower.slowMonitors[0].target).toBe('[REDACTED]');
                expect(lower.total).toBe(2);
            }
            expect(build).toHaveBeenCalledTimes(1);
            expect(caches[0].getStats().l1Hits).toBe(1);
            expect(caches[1].getStats().l2Hits).toBe(1);
            revoked = true;
            const reads = redis.getJson.mock.calls.length;
            for (const service of services) {
                await expect(load(service)).rejects.toThrow(NotFoundException);
            }
            expect(redis.getJson).toHaveBeenCalledTimes(reads);
        } finally {
            for (const cache of caches) cache.onModuleDestroy();
        }
    });

    it.each(['MEMBER', 'VIEWER'] as const)(
        'omits HTTP response snippets for %s',
        (role) => {
            const result = monitoringProjection(
                {
                    result: {
                        success: false,
                        statusCode: 401,
                        bodyContains: 'sensitive body',
                    },
                    state: { lastError: 'private failure' },
                },
                role,
            );
            expect(result.result.success).toBe(false);
            expect(result.result.statusCode).toBe(401);
            expect(result.result).not.toHaveProperty('bodyContains');
            expect(result.state.lastError).toBe('[REDACTED]');
        },
    );

    it.each(['https://internal.test/api', 'example.test:443', '192.0.2.1'])(
        'preserves non-credentialed execution target %s',
        (target) => {
            expect(sanitizeMonitoringTarget(target)).toBe(target);
        },
    );

    it('fails closed on an ambiguous diagnostic URL', () => {
        expect(
            sanitizeMonitoringDiagnostic(
                'Cannot construct URL https://old:private password@internal.test/check?key=secret',
            ),
        ).toBe('[REDACTED]');
    });
});

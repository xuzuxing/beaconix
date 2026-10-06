import { MonitorDataCleanupService } from './monitor-data-cleanup.service';
import type { PrismaService } from '../../../infra/database/prisma.service';

function createService() {
    const prisma = { $executeRawUnsafe: jest.fn() };
    const registry = { register: jest.fn() };

    return {
        service: new MonitorDataCleanupService(
            prisma as unknown as PrismaService,
            registry as never,
        ),
        prisma,
        registry,
    };
}

describe('MonitorDataCleanupService', () => {
    it('trims every history table once when nothing is left', async () => {
        const { service, prisma } = createService();
        prisma.$executeRawUnsafe.mockResolvedValue(0);

        await service.handleCleanup();

        expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(3);

        const statements = prisma.$executeRawUnsafe.mock.calls.map(
            (call) => call[0] as string,
        );

        expect(statements[0]).toContain('FROM "check_logs"');
        expect(statements[0]).toContain('"checkedAt" < $1');
        expect(statements[1]).toContain('FROM "probe_executions"');
        expect(statements[1]).toContain('"executedAt" < $1');
        expect(statements[2]).toContain('FROM "probe_results"');
    });

    it('keeps deleting in batches until a table is drained', async () => {
        const { service, prisma } = createService();
        prisma.$executeRawUnsafe
            .mockResolvedValueOnce(5000)
            .mockResolvedValueOnce(10)
            .mockResolvedValue(0);

        await service.handleCleanup();

        // check_logs took two batches, the other two tables one each.
        expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(4);
    });

    it('carries on with the other tables when one cleanup fails', async () => {
        const { service, prisma } = createService();
        prisma.$executeRawUnsafe
            .mockRejectedValueOnce(new Error('deadlock'))
            .mockResolvedValue(0);

        await expect(service.handleCleanup()).resolves.toBeUndefined();

        expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(3);
    });
});

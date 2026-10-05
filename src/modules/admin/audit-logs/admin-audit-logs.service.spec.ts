import { AdminAuditLogsService } from './admin-audit-logs.service';
import type { PrismaService } from '../../../infra/database/prisma.service';

const auditLogRow = {
    id: 'log-1',
    actorId: 'user-1',
    organizationId: 'org-1',
    projectId: null,
    action: 'UPDATE',
    entity: 'Task',
    entityId: 'task-1',
    before: {},
    after: {},
    ipAddress: null,
    userAgent: null,
    createdAt: new Date('2026-03-05T12:00:00.000Z'),
    actor: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
};

function createService() {
    const prisma = {
        auditLog: {
            findMany: jest.fn(),
            count: jest.fn(),
        },
    };

    const service = new AdminAuditLogsService(
        prisma as unknown as PrismaService,
    );

    return { service, prisma };
}

describe('AdminAuditLogsService', () => {
    it('queries across tenants when no organization filter is provided', async () => {
        const { service, prisma } = createService();
        prisma.auditLog.findMany.mockResolvedValue([auditLogRow]);
        prisma.auditLog.count.mockResolvedValue(1);

        const result = await service.findAll({ page: 1, limit: 25 });

        expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: {} }),
        );
        expect(result.total).toBe(1);
        expect(result.items[0].entity).toBe('Task');
    });

    it('applies opt-in filters without forcing an organization scope', async () => {
        const { service, prisma } = createService();
        prisma.auditLog.findMany.mockResolvedValue([]);
        prisma.auditLog.count.mockResolvedValue(0);

        await service.findAll({
            organizationId: 'org-1',
            action: 'CREATE',
            entity: 'Project',
        });

        expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    organizationId: 'org-1',
                    action: 'CREATE',
                    entity: 'Project',
                },
            }),
        );
    });
});

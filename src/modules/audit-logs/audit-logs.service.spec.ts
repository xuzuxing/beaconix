import { ValidationPipe } from '@nestjs/common';
import { AuditLogsService } from './audit-logs.service';
import { QueryAuditLogsDto } from './dto';

function setup() {
    const prisma = {
        auditLog: {
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
        },
    };
    return { prisma, service: new AuditLogsService(prisma as any) };
}

describe('AuditLogsService.findAll', () => {
    it('scopes the query to the path organization', async () => {
        const { prisma, service } = setup();

        await service.findAll('org-path', { page: 1, limit: 25 });

        expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { organizationId: 'org-path' },
            }),
        );
        expect(prisma.auditLog.count).toHaveBeenCalledWith({
            where: { organizationId: 'org-path' },
        });
    });

    it('ignores any organization id smuggled into the query object', async () => {
        const { prisma, service } = setup();

        // Defence in depth: the DTO no longer carries `organizationId`, but a
        // caller that bypasses validation must still not widen the tenant scope.
        await service.findAll('org-path', {
            organizationId: 'org-victim',
            page: 1,
            limit: 25,
        } as unknown as QueryAuditLogsDto);

        const where = prisma.auditLog.findMany.mock.calls[0][0].where;
        expect(where.organizationId).toBe('org-path');
        expect(where).not.toHaveProperty('organizationId', 'org-victim');
    });

    it('keeps the other filters alongside the tenant scope', async () => {
        const { prisma, service } = setup();

        await service.findAll('org-path', {
            actorId: 'actor-1',
            entity: 'Task',
            page: 2,
            limit: 10,
        });

        expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    organizationId: 'org-path',
                    actorId: 'actor-1',
                    entity: 'Task',
                },
                take: 10,
                skip: 10,
            }),
        );
    });
});

describe('QueryAuditLogsDto', () => {
    it('drops a client-supplied organizationId before the service sees it', async () => {
        // 生产配置是 `whitelist` + 非 `forbidNonWhitelisted`（见 main.ts）：多余
        // 字段被静默剥离而不是 400。这正是「服务端只认路径 orgId」成立的前提。
        const pipe = new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: false,
            transform: true,
        });

        const result = await pipe.transform(
            { organizationId: 'ckvictim0000000000000000', page: 1 },
            { type: 'query', metatype: QueryAuditLogsDto },
        );

        expect(result).toBeInstanceOf(QueryAuditLogsDto);
        expect(result).not.toHaveProperty('organizationId');
    });
});

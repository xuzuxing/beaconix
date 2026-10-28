import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { QueryAdminAuditLogsDto } from './dto/query-admin-audit-logs.dto';
import { AuditLogEntity } from '../../audit-logs/entities';

const actorSelect = {
    id: true,
    name: true,
    email: true,
} as const;

@Injectable()
export class AdminAuditLogsService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Explicit cross-tenant audit log query for SUPER_ADMIN. Unlike the
     * tenant-scoped AuditLogsService, this applies no forced organizationId
     * filter; every filter is opt-in from the query.
     */
    async findAll(dto: QueryAdminAuditLogsDto) {
        const {
            actorId,
            organizationId,
            projectId,
            action,
            entity,
            entityId,
            from,
            to,
            page = 1,
            limit = 25,
        } = dto;

        const where: Record<string, unknown> = {};

        if (actorId) where.actorId = actorId;
        if (organizationId) where.organizationId = organizationId;
        if (projectId) where.projectId = projectId;
        if (action) where.action = action;
        if (entity) where.entity = entity;
        if (entityId) where.entityId = entityId;

        if (from || to) {
            const createdAt: Record<string, Date> = {};
            if (from) createdAt.gte = new Date(from);
            if (to) createdAt.lte = new Date(to);
            where.createdAt = createdAt;
        }

        const skip = (page - 1) * limit;

        const [items, total] = await Promise.all([
            this.prisma.auditLog.findMany({
                where,
                include: { actor: { select: actorSelect } },
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip,
            }),
            this.prisma.auditLog.count({ where }),
        ]);

        return {
            items: items.map((item) => new AuditLogEntity(item)),
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    }
}

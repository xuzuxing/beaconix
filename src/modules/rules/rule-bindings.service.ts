import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import { monitoringProjection } from '../../common/authorization/monitoring-projection';

@Injectable()
export class RuleBindingsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    async bind(
        input: {
            monitorId: string;
            ruleGroupId: string;
            priority?: number;
        },
        projectId: string,
        principal: AccessPrincipal,
    ) {
        return this.access.withProject(
            principal,
            projectId,
            'rule.manage',
            async (tx, access) => {
                const monitor = await tx.monitor.findFirst({
                    where: {
                        id: input.monitorId,
                        projectId,
                        organizationId: access.organizationId,
                        deletedAt: null,
                    },
                    select: { id: true, organizationId: true, projectId: true },
                });
                if (!monitor) throw new NotFoundException('Monitor not found');

                const ruleGroup = await tx.ruleGroup.findFirst({
                    where: { id: input.ruleGroupId, deletedAt: null },
                    select: { id: true, organizationId: true, projectId: true },
                });
                if (!ruleGroup)
                    throw new NotFoundException('Rule group not found');

                // 规则组必须与 monitor 同组织；项目级规则组还须同项目
                if (ruleGroup.organizationId !== monitor.organizationId) {
                    throw new BadRequestException(
                        'Rule group belongs to a different organization',
                    );
                }
                if (
                    ruleGroup.projectId &&
                    ruleGroup.projectId !== monitor.projectId
                ) {
                    throw new BadRequestException(
                        'Project-level rule group can only bind monitors in the same project',
                    );
                }

                return tx.monitorRuleBinding.upsert({
                    where: {
                        monitorId_ruleGroupId: {
                            monitorId: input.monitorId,
                            ruleGroupId: input.ruleGroupId,
                        },
                    },
                    update: {
                        priority: input.priority ?? 0,
                        enabled: true,
                    },
                    create: {
                        monitorId: input.monitorId,
                        ruleGroupId: input.ruleGroupId,
                        priority: input.priority ?? 0,
                    },
                });
            },
        );
    }

    async unbind(
        monitorId: string,
        ruleGroupId: string,
        projectId: string,
        principal: AccessPrincipal,
    ) {
        return this.access.withProject(
            principal,
            projectId,
            'rule.manage',
            async (tx, access) =>
                tx.monitorRuleBinding.delete({
                    where: {
                        monitorId_ruleGroupId: { monitorId, ruleGroupId },
                        monitor: {
                            projectId,
                            organizationId: access.organizationId,
                            deletedAt: null,
                        },
                        ruleGroup: {
                            organizationId: access.organizationId,
                            OR: [{ projectId }, { projectId: null }],
                        },
                    },
                }),
        );
    }

    async listByMonitor(
        monitorId: string,
        projectId: string,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'monitor.read',
        );
        const monitor = await this.prisma.monitor.findFirst({
            where: {
                id: monitorId,
                projectId,
                organizationId: access.organizationId,
                deletedAt: null,
            },
            select: { id: true },
        });
        if (!monitor) throw new NotFoundException('Monitor not found');
        const bindings = await this.prisma.monitorRuleBinding.findMany({
            where: {
                monitorId,
                ruleGroup: {
                    organizationId: access.organizationId,
                    deletedAt: null,
                    OR: [{ projectId }, { projectId: null }],
                },
            },
            include: { ruleGroup: true },
            orderBy: { priority: 'desc' },
        });
        return bindings.map((binding) => {
            const group = binding.ruleGroup;
            const shared = !group.projectId && !access.canManageOrganization;
            return {
                ...binding,
                ruleGroup: shared
                    ? {
                          id: group.id,
                          name: group.name,
                          description: group.description,
                          enabled: group.enabled,
                      }
                    : monitoringProjection(group, access.effectiveRole),
            };
        });
    }
}

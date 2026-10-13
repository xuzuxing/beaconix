import {
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { RuleEvaluatorService } from './rule-evaluator.service';
import type { RuleNode } from './types';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import type { AccessDb } from '../../common/authorization/access-locks';
import { monitoringProjection } from '../../common/authorization/monitoring-projection';

@Injectable()
export class RuleGroupsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly evaluator: RuleEvaluatorService,
        private readonly access: ProjectAccessService,
    ) {}

    async create(
        input: {
            organizationId: string;
            projectId?: string;
            name: string;
            description?: string;
            tree: RuleNode;
        },
        principal: AccessPrincipal,
    ) {
        this.evaluator.validate(input.tree);

        if (input.projectId) {
            const project = await this.prisma.project.findFirst({
                where: {
                    id: input.projectId,
                    organizationId: input.organizationId,
                    deletedAt: null,
                },
                select: { id: true },
            });
            if (!project) throw new NotFoundException('Project not found');
        }

        return this.withScope(
            input.organizationId,
            input.projectId ?? null,
            principal,
            (tx) =>
                tx.ruleGroup.create({
                    data: {
                        organizationId: input.organizationId,
                        projectId: input.projectId,
                        name: input.name,
                        description: input.description,
                        tree: input.tree as never,
                        fieldsUsed: this.evaluator.extractFields(input.tree),
                    },
                }),
        );
    }

    async update(
        id: string,
        input: {
            name?: string;
            description?: string;
            tree?: RuleNode;
            enabled?: boolean;
        },
        organizationId: string,
        principal: AccessPrincipal,
    ) {
        const data: Record<string, unknown> = {};
        if (input.name !== undefined) data.name = input.name;
        if (input.description !== undefined) {
            data.description = input.description;
        }
        if (input.enabled !== undefined) data.enabled = input.enabled;
        if (input.tree) {
            this.evaluator.validate(input.tree);
            data.tree = input.tree;
            data.fieldsUsed = this.evaluator.extractFields(input.tree);
        }

        const group = await this.load(organizationId, id);
        return this.withScope(
            organizationId,
            group.projectId,
            principal,
            (tx) =>
                tx.ruleGroup.update({
                    where: {
                        id,
                        organizationId,
                        projectId: group.projectId,
                        deletedAt: null,
                    },
                    data,
                }),
        );
    }

    async listByOrganization(
        organizationId: string,
        principal: AccessPrincipal,
    ) {
        const org = await this.access.organization(principal, organizationId);
        const project = await this.access.projectFilter(
            principal,
            organizationId,
        );
        const groups = await this.prisma.ruleGroup.findMany({
            where: {
                organizationId,
                deletedAt: null,
                ...(org.canManageOrganization ? {} : { project }),
            },
            orderBy: { createdAt: 'desc' },
        });
        if (org.canManageOrganization) return groups;
        return Promise.all(
            groups.map(async (group) => {
                const access = await this.access.project(
                    principal,
                    group.projectId!,
                    'monitor.read',
                    organizationId,
                );
                return monitoringProjection(group, access.effectiveRole);
            }),
        );
    }

    async findOne(
        organizationId: string,
        id: string,
        principal: AccessPrincipal,
    ) {
        const group = await this.load(organizationId, id);
        if (group.projectId) {
            const access = await this.access.project(
                principal,
                group.projectId,
                'monitor.read',
                organizationId,
            );
            return monitoringProjection(group, access.effectiveRole);
        }
        const org = await this.access.organization(principal, organizationId);
        if (!org.canManageOrganization)
            throw new ForbiddenException('Organization administrator required');
        return group;
    }

    private async load(organizationId: string, id: string) {
        const group = await this.prisma.ruleGroup.findFirst({
            where: { id, organizationId, deletedAt: null },
        });
        if (!group) throw new NotFoundException('Rule group not found');
        return group;
    }

    async softDelete(
        id: string,
        organizationId: string,
        principal: AccessPrincipal,
    ) {
        const group = await this.load(organizationId, id);
        return this.withScope(
            organizationId,
            group.projectId,
            principal,
            (tx) =>
                tx.ruleGroup.update({
                    where: {
                        id,
                        organizationId,
                        projectId: group.projectId,
                        deletedAt: null,
                    },
                    data: { deletedAt: new Date() },
                }),
        );
    }

    /**
     * 某 monitor 绑定的、启用的规则组，按优先级降序。
     * 这是求值入口，每轮检查都会调用。
     */
    async findBindingsForMonitor(monitorId: string) {
        return this.prisma.monitorRuleBinding.findMany({
            where: {
                monitorId,
                enabled: true,
                ruleGroup: { enabled: true, deletedAt: null },
            },
            include: { ruleGroup: true },
            orderBy: { priority: 'desc' },
        });
    }

    private withScope<T>(
        organizationId: string,
        projectId: string | null,
        principal: AccessPrincipal,
        work: (tx: AccessDb) => Promise<T>,
    ) {
        return projectId
            ? this.access.withProjectWrite(
                  principal,
                  organizationId,
                  projectId,
                  'rule.manage',
                  work,
              )
            : this.access.withOrganization(principal, organizationId, work);
    }
}

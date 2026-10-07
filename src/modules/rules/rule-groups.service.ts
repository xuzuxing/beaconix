import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { RuleEvaluatorService } from './rule-evaluator.service';
import type { RuleNode } from './types';

@Injectable()
export class RuleGroupsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly evaluator: RuleEvaluatorService,
    ) {}

    async create(input: {
        organizationId: string;
        projectId?: string;
        name: string;
        description?: string;
        tree: RuleNode;
    }) {
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

        return this.prisma.ruleGroup.create({
            data: {
                organizationId: input.organizationId,
                projectId: input.projectId,
                name: input.name,
                description: input.description,
                tree: input.tree as never,
                fieldsUsed: this.evaluator.extractFields(input.tree),
            },
        });
    }

    async update(
        id: string,
        input: {
            name?: string;
            description?: string;
            tree?: RuleNode;
            enabled?: boolean;
        },
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

        return this.prisma.ruleGroup.update({ where: { id }, data });
    }

    async listByOrganization(organizationId: string) {
        return this.prisma.ruleGroup.findMany({
            where: { organizationId, deletedAt: null },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findOne(organizationId: string, id: string) {
        const group = await this.prisma.ruleGroup.findFirst({
            where: { id, organizationId, deletedAt: null },
        });
        if (!group) throw new NotFoundException('Rule group not found');
        return group;
    }

    async softDelete(id: string) {
        return this.prisma.ruleGroup.update({
            where: { id },
            data: { deletedAt: new Date() },
        });
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
}

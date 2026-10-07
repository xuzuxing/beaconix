import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { RuleAction } from '../../generated/prisma/enums';

@Injectable()
export class RuleBindingsService {
    constructor(private readonly prisma: PrismaService) {}

    async bind(input: {
        monitorId: string;
        ruleGroupId: string;
        action?: RuleAction;
        priority?: number;
    }) {
        const monitor = await this.prisma.monitor.findFirst({
            where: { id: input.monitorId, deletedAt: null },
            select: { id: true, organizationId: true, projectId: true },
        });
        if (!monitor) throw new NotFoundException('Monitor not found');

        const ruleGroup = await this.prisma.ruleGroup.findFirst({
            where: { id: input.ruleGroupId, deletedAt: null },
            select: { id: true, organizationId: true, projectId: true },
        });
        if (!ruleGroup) throw new NotFoundException('Rule group not found');

        // 规则组必须与 monitor 同组织；项目级规则组还须同项目
        if (ruleGroup.organizationId !== monitor.organizationId) {
            throw new BadRequestException(
                'Rule group belongs to a different organization',
            );
        }
        if (ruleGroup.projectId && ruleGroup.projectId !== monitor.projectId) {
            throw new BadRequestException(
                'Project-level rule group can only bind monitors in the same project',
            );
        }

        return this.prisma.monitorRuleBinding.upsert({
            where: {
                monitorId_ruleGroupId: {
                    monitorId: input.monitorId,
                    ruleGroupId: input.ruleGroupId,
                },
            },
            update: {
                action: input.action ?? RuleAction.ALERT,
                priority: input.priority ?? 0,
                enabled: true,
            },
            create: {
                monitorId: input.monitorId,
                ruleGroupId: input.ruleGroupId,
                action: input.action ?? RuleAction.ALERT,
                priority: input.priority ?? 0,
            },
        });
    }

    async unbind(monitorId: string, ruleGroupId: string) {
        return this.prisma.monitorRuleBinding.delete({
            where: { monitorId_ruleGroupId: { monitorId, ruleGroupId } },
        });
    }

    async listByMonitor(monitorId: string) {
        return this.prisma.monitorRuleBinding.findMany({
            where: { monitorId },
            include: { ruleGroup: true },
            orderBy: { priority: 'desc' },
        });
    }
}

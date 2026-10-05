import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { ProbeScope } from '../../generated/prisma/enums';
import type { PlanModel } from '../../generated/prisma/models';
import { EffectivePlanService } from '../subscription/effective-plan.service';

export type QuotaResource = 'monitors' | 'probes' | 'members' | 'channels';
export type QuotaFeature = 'tenantProbe' | 'statusPage';

const RESOURCE_LABELS: Record<QuotaResource, string> = {
    monitors: '监控',
    probes: '探针',
    members: '成员',
    channels: '通知渠道',
};

const FEATURE_LABELS: Record<QuotaFeature, string> = {
    tenantProbe: '租户探针',
    statusPage: '状态页',
};

const FREE_FALLBACK = {
    maxMonitors: 5,
    maxProbes: 0,
    maxMembers: 3,
    maxChannels: 1,
    minInterval: 300,
    allowTenantProbe: false,
    allowStatusPage: false,
};

@Injectable()
export class QuotaService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly effectivePlanService: EffectivePlanService,
    ) {}

    async getUsage(organizationId: string) {
        const [monitors, probes, members, channels] = await Promise.all([
            this.prisma.monitor.count({
                where: { organizationId, deletedAt: null },
            }),
            this.prisma.probe.count({
                where: { organizationId, scope: ProbeScope.TENANT },
            }),
            this.prisma.membership.count({ where: { organizationId } }),
            this.prisma.notificationChannel.count({
                where: { organizationId },
            }),
        ]);

        return { monitors, probes, members, channels };
    }

    async assertCanCreate(
        organizationId: string,
        resource: QuotaResource,
    ): Promise<void> {
        const plan = await this.getPlan(organizationId);
        const usage = await this.getUsage(organizationId);
        const limit = this.getLimit(plan, resource);

        if (usage[resource] >= limit) {
            throw new ForbiddenException({
                code: 'QUOTA_EXCEEDED',
                resource,
                current: usage[resource],
                limit,
                message: `${RESOURCE_LABELS[resource]}已达上限（${limit}），请升级套餐`,
            });
        }
    }

    async assertIntervalAllowed(
        organizationId: string,
        interval: number,
    ): Promise<void> {
        const plan = await this.getPlan(organizationId);

        if (interval < plan.minInterval) {
            throw new ForbiddenException({
                code: 'INTERVAL_TOO_SHORT',
                minInterval: plan.minInterval,
                message: `当前套餐最小检测间隔为 ${plan.minInterval} 秒，请升级套餐`,
            });
        }
    }

    async assertFeatureAllowed(
        organizationId: string,
        feature: QuotaFeature,
    ): Promise<void> {
        const plan = await this.getPlan(organizationId);
        const allowed =
            feature === 'tenantProbe'
                ? plan.allowTenantProbe
                : plan.allowStatusPage;

        if (!allowed) {
            throw new ForbiddenException({
                code: 'FEATURE_NOT_AVAILABLE',
                feature,
                message: `当前套餐未开放${FEATURE_LABELS[feature]}功能，请升级套餐`,
            });
        }
    }

    async getUsageSummary(organizationId: string) {
        const plan = await this.getPlan(organizationId);
        const usage = await this.getUsage(organizationId);

        const buildQuota = (used: number, limit: number) => ({
            used,
            limit,
            percent:
                limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
        });

        return {
            plan: { code: plan.code, name: plan.name, price: plan.price },
            resources: {
                monitors: buildQuota(usage.monitors, plan.maxMonitors),
                probes: buildQuota(usage.probes, plan.maxProbes),
                members: buildQuota(usage.members, plan.maxMembers),
                channels: buildQuota(usage.channels, plan.maxChannels),
            },
            features: {
                allowTenantProbe: plan.allowTenantProbe,
                allowStatusPage: plan.allowStatusPage,
            },
            minInterval: plan.minInterval,
        };
    }

    async checkOverLimit(organizationId: string) {
        const plan = await this.getPlan(organizationId);
        const usage = await this.getUsage(organizationId);

        const violations: QuotaResource[] = [];
        if (usage.monitors > plan.maxMonitors) violations.push('monitors');
        if (usage.probes > plan.maxProbes) violations.push('probes');
        if (usage.members > plan.maxMembers) violations.push('members');
        if (usage.channels > plan.maxChannels) violations.push('channels');

        return {
            plan: { code: plan.code, name: plan.name },
            usage,
            violations,
            overLimit: violations.length > 0,
        };
    }

    // -- Helpers ---------------------------------------------------------

    private async getPlan(organizationId: string): Promise<PlanModel> {
        const plan =
            await this.effectivePlanService.getEffectivePlan(organizationId);

        if (!plan) {
            return FREE_FALLBACK as PlanModel;
        }

        return plan;
    }

    private getLimit(plan: PlanModel, resource: QuotaResource): number {
        if (resource === 'monitors') return plan.maxMonitors;
        if (resource === 'probes') return plan.maxProbes;
        if (resource === 'members') return plan.maxMembers;
        return plan.maxChannels;
    }
}

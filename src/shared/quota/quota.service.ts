import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { MonitorType, ProbeScope } from '../../generated/prisma/enums';
import type { PlanModel } from '../../generated/prisma/models';
import type { Prisma } from '../../generated/prisma/client';
import { EffectivePlanService } from '../subscription/effective-plan.service';

export type QuotaResource =
    'monitors' | 'probes' | 'members' | 'channels' | 'apiKeys';
export type QuotaFeature = 'tenantProbe' | 'statusPage';

const RESOURCE_LABELS: Record<QuotaResource, string> = {
    monitors: '监控',
    probes: '探针',
    members: '成员',
    channels: '通知渠道',
    apiKeys: 'API Key',
};

const FEATURE_LABELS: Record<QuotaFeature, string> = {
    tenantProbe: '租户探针',
    statusPage: '状态页',
};

const FREE_FALLBACK = {
    maxMonitors: 5,
    maxProbes: 0,
    maxProbesPerMonitor: 0,
    maxMembers: 3,
    maxChannels: 1,
    maxApiKeys: 5,
    minInterval: 300,
    allowTenantProbe: false,
    allowStatusPage: false,
    allowedMonitorTypes: [MonitorType.HTTP, MonitorType.TCP, MonitorType.PING],
    code: 'FREE',
    name: 'Free',
    price: 0,
};

type QuotaPlan = Pick<PlanModel, keyof typeof FREE_FALLBACK>;
export type MonitorPolicy = Pick<
    PlanModel,
    'allowedMonitorTypes' | 'minInterval' | 'maxProbes' | 'maxProbesPerMonitor'
>;

/**
 * How many tenant probes one monitor may bind: the organization probe
 * allowance. `maxProbesPerMonitor` sizes the system probe pool instead, so it no
 * longer caps manual binding - a tenant can bind as many of its own probes as
 * the plan's `maxProbes` allows.
 */
export function probeAssignmentLimit(plan: { maxProbes: number }): number {
    return Math.max(0, plan.maxProbes);
}

@Injectable()
export class QuotaService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly effectivePlanService: EffectivePlanService,
    ) {}

    // Caller must hold Organization FOR UPDATE in this same transaction.
    async assertCanAddMember(
        organizationId: string,
        tx: Prisma.TransactionClient,
    ) {
        const plan =
            (await this.effectivePlanService.getEffectivePlanInTransaction(
                organizationId,
                tx,
            )) ?? FREE_FALLBACK;
        const current = await tx.membership.count({
            where: { organizationId },
        });
        if (current >= plan.maxMembers) {
            throw new ForbiddenException({
                code: 'QUOTA_EXCEEDED',
                resource: 'members',
                current,
                limit: plan.maxMembers,
                message: `${RESOURCE_LABELS.members}已达上限（${plan.maxMembers}），请升级套餐`,
            });
        }
    }

    async getUsage(organizationId: string) {
        const [monitors, probes, members, channels, apiKeys] =
            await Promise.all([
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
                this.prisma.apiKey.count({
                    where: {
                        organizationId,
                        revokedAt: null,
                        OR: [
                            { expiresAt: null },
                            { expiresAt: { gt: new Date() } },
                        ],
                    },
                }),
            ]);

        return { monitors, probes, members, channels, apiKeys };
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

    async assertMonitorTypeAllowed(
        organizationId: string,
        type: MonitorType,
    ): Promise<void> {
        const plan = await this.getPlan(organizationId);
        if (!plan.allowedMonitorTypes.includes(type)) {
            throw new ForbiddenException({
                code: 'MONITOR_TYPE_NOT_ALLOWED',
                type,
                message: `当前套餐不支持 ${type} 监控，请升级套餐`,
            });
        }
    }

    async monitorEligibility(
        organizationId: string,
        type: MonitorType,
        interval: number,
        policy?: MonitorPolicy,
    ): Promise<{ eligible: boolean; reason: string | null }> {
        const plan = policy ?? (await this.getPlan(organizationId));
        const reason = !plan.allowedMonitorTypes.includes(type)
            ? 'MONITOR_TYPE_NOT_ALLOWED'
            : interval < plan.minInterval
              ? 'INTERVAL_TOO_SHORT'
              : null;
        return { eligible: reason === null, reason };
    }

    async getMonitorPolicy(organizationId: string): Promise<MonitorPolicy> {
        const plan = await this.getPlan(organizationId);
        return {
            allowedMonitorTypes: plan.allowedMonitorTypes,
            minInterval: plan.minInterval,
            maxProbes: plan.maxProbes,
            maxProbesPerMonitor: plan.maxProbesPerMonitor,
        };
    }

    /**
     * Effective number of tenant probes a single monitor may bind on the
     * organization's current plan (`min(maxProbes, maxProbesPerMonitor)`).
     */
    async getProbeAssignmentLimit(
        organizationId: string,
        policy?: MonitorPolicy,
    ): Promise<number> {
        const plan = policy ?? (await this.getPlan(organizationId));
        return probeAssignmentLimit(plan);
    }

    /** Rejects a probe set larger than the organization probe allowance. */
    async assertProbesAssignable(
        organizationId: string,
        count: number,
        policy?: MonitorPolicy,
    ): Promise<void> {
        const limit = await this.getProbeAssignmentLimit(
            organizationId,
            policy,
        );

        if (count > limit) {
            throw new ForbiddenException({
                code: 'QUOTA_EXCEEDED',
                resource: 'probesPerMonitor',
                current: count,
                limit,
                message: `当前套餐最多可分配 ${limit} 个探针，请升级套餐`,
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
                apiKeys: buildQuota(usage.apiKeys, plan.maxApiKeys),
            },
            features: {
                allowTenantProbe: plan.allowTenantProbe,
                allowStatusPage: plan.allowStatusPage,
            },
            minInterval: plan.minInterval,
            allowedMonitorTypes: plan.allowedMonitorTypes,
            // Per-monitor probe budget the assignment UI must honour.
            maxProbesPerMonitor: probeAssignmentLimit(plan),
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
        if (usage.apiKeys > plan.maxApiKeys) violations.push('apiKeys');

        return {
            plan: { code: plan.code, name: plan.name },
            usage,
            violations,
            overLimit: violations.length > 0,
        };
    }

    // -- Helpers ---------------------------------------------------------

    private async getPlan(organizationId: string): Promise<QuotaPlan> {
        const plan =
            await this.effectivePlanService.getEffectivePlan(organizationId);

        if (!plan) {
            return FREE_FALLBACK;
        }

        return plan;
    }

    private getLimit(plan: QuotaPlan, resource: QuotaResource): number {
        if (resource === 'monitors') return plan.maxMonitors;
        if (resource === 'probes') return plan.maxProbes;
        if (resource === 'members') return plan.maxMembers;
        if (resource === 'apiKeys') return plan.maxApiKeys;
        return plan.maxChannels;
    }
}

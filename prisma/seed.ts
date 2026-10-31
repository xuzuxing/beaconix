import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { MonitorType, PlanCycle } from '../src/generated/prisma/enums';
import { missingSettingSeedRows } from '../src/modules/settings/settings.seed';
import { missingTicketCategorySeeds } from '../src/modules/tickets/ticket-categories.seed';

const FREE_SUBSCRIPTION_EXPIRY = new Date('2099-12-31T23:59:59.000Z');

interface DefaultRuleGroup {
    name: string;
    description: string;
    tree: Record<string, unknown>;
}

/**
 * 默认规则组：覆盖常规检测场景，组织级（projectId = null）。
 * 只创建、不自动绑定 —— 由用户在监控上按需绑定。
 */
const DEFAULT_RULE_GROUPS: DefaultRuleGroup[] = [
    {
        name: '请求失败',
        description: '任意一次检测失败（success = false）',
        tree: {
            type: 'condition',
            id: 'request-failed',
            field: 'success',
            operator: 'eq',
            value: false,
        },
    },
    {
        name: '响应缓慢',
        description: '响应时间超过 3000ms',
        tree: {
            type: 'condition',
            id: 'slow-response',
            field: 'latency',
            operator: 'gt',
            value: 3000,
        },
    },
    {
        name: '证书即将过期',
        description: 'HTTPS 证书剩余有效期不足 7 天',
        tree: {
            type: 'condition',
            id: 'cert-expiring',
            field: 'certDaysRemaining',
            operator: 'lte',
            value: 7,
        },
    },
    {
        name: '证书已过期',
        description: 'HTTPS 证书已过期',
        tree: {
            type: 'condition',
            id: 'cert-expired',
            field: 'certDaysRemaining',
            operator: 'lt',
            value: 0,
        },
    },
];

/** 从规则树提取用到的字段名（与 RuleEvaluatorService.extractFields 一致）。 */
function extractRuleFields(node: unknown, acc = new Set<string>()): string[] {
    const n = node as {
        type?: string;
        field?: string;
        children?: unknown[];
    };
    if (n.type === 'condition' && n.field) {
        acc.add(n.field);
    } else if (Array.isArray(n.children)) {
        for (const child of n.children) extractRuleFields(child, acc);
    }
    return [...acc];
}

async function main() {
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });

    // 默认商业套餐：金额单位为分，周期按 30 / 90 / 365 天计算。
    // maxProbesPerMonitor 是每个监控的平台系统探针数，maxProbes 是自建探针数。
    // 下列价格尚未绑定已核价的微信虚拟支付商品；发布商品后通过管理端配置。
    const plans = [
        {
            code: 'FREE',
            allowedMonitorTypes: [
                MonitorType.HTTP,
                MonitorType.TCP,
                MonitorType.PING,
            ],
            name: '免费版',
            description: '体验基础监控、故障通知与状态页',
            price: 0,
            sortOrder: 1,
            durationDays: 36500,
            maxMonitors: 3,
            maxProbes: 0,
            maxProbesPerMonitor: 0,
            maxApiKeys: 1,
            maxMembers: 1,
            maxChannels: 1,
            minInterval: 300,
            allowTenantProbe: false,
            allowStatusPage: true,
            // FREE 不过期：一条「永久」档位，仅作为无订阅组织的兜底。
            terms: [
                {
                    cycle: PlanCycle.YEARLY,
                    durationDays: 36500,
                    price: 0,
                },
            ],
        },
        {
            code: 'PRO',
            allowedMonitorTypes: Object.values(MonitorType),
            name: '专业版',
            description: '适合个人开发者的生产服务监控',
            price: 3900,
            sortOrder: 2,
            durationDays: 30,
            maxMonitors: 20,
            maxProbes: 2,
            maxProbesPerMonitor: 1,
            maxApiKeys: 3,
            maxMembers: 3,
            maxChannels: 3,
            minInterval: 60,
            allowTenantProbe: true,
            allowStatusPage: true,
            // 月 / 季 / 年三档，季付与年付带折扣。
            terms: [
                {
                    cycle: PlanCycle.MONTHLY,
                    durationDays: 30,
                    price: 3900,
                    wechatProductId: null,
                    sortOrder: 1,
                },
                {
                    cycle: PlanCycle.QUARTERLY,
                    durationDays: 90,
                    price: 10900,
                    wechatProductId: null,
                    sortOrder: 2,
                },
                {
                    cycle: PlanCycle.YEARLY,
                    durationDays: 365,
                    price: 39000,
                    wechatProductId: null,
                    sortOrder: 3,
                },
            ],
        },
        {
            code: 'TEAM',
            allowedMonitorTypes: Object.values(MonitorType),
            name: '团队版',
            description: '适合中小团队的协作与多节点监控',
            price: 12900,
            sortOrder: 3,
            durationDays: 30,
            maxMonitors: 60,
            maxProbes: 5,
            maxProbesPerMonitor: 2,
            maxApiKeys: 10,
            maxMembers: 10,
            maxChannels: 8,
            minInterval: 60,
            allowTenantProbe: true,
            allowStatusPage: true,
            terms: [
                {
                    cycle: PlanCycle.MONTHLY,
                    durationDays: 30,
                    price: 12900,
                    wechatProductId: null,
                    sortOrder: 1,
                },
                {
                    cycle: PlanCycle.QUARTERLY,
                    durationDays: 90,
                    price: 35900,
                    wechatProductId: null,
                    sortOrder: 2,
                },
                {
                    cycle: PlanCycle.YEARLY,
                    durationDays: 365,
                    price: 129000,
                    wechatProductId: null,
                    sortOrder: 3,
                },
            ],
        },
        {
            code: 'BUSINESS',
            allowedMonitorTypes: Object.values(MonitorType),
            name: '商业版',
            description: '适合多项目规模化运维的高容量监控',
            price: 39900,
            sortOrder: 4,
            durationDays: 30,
            maxMonitors: 150,
            maxProbes: 15,
            maxProbesPerMonitor: 3,
            maxApiKeys: 20,
            maxMembers: 30,
            maxChannels: 15,
            minInterval: 30,
            allowTenantProbe: true,
            allowStatusPage: true,
            terms: [
                {
                    cycle: PlanCycle.MONTHLY,
                    durationDays: 30,
                    price: 39900,
                    wechatProductId: null,
                    sortOrder: 1,
                },
                {
                    cycle: PlanCycle.QUARTERLY,
                    durationDays: 90,
                    price: 109900,
                    wechatProductId: null,
                    sortOrder: 2,
                },
                {
                    cycle: PlanCycle.YEARLY,
                    durationDays: 365,
                    price: 399000,
                    wechatProductId: null,
                    sortOrder: 3,
                },
            ],
        },
    ];

    // 平台基础配置（settings）：真源是 src/modules/settings/settings.defaults.ts，
    // 这里只补库里还没有的行 —— 幂等，且绝不覆盖管理端改过的值。
    const existingSettingKeys = await prisma.setting.findMany({
        select: { key: true },
    });
    const missingSettings = missingSettingSeedRows(
        existingSettingKeys.map((row) => row.key),
    );

    if (missingSettings.length > 0) {
        await prisma.setting.createMany({
            data: missingSettings.map((row) => ({
                ...row,
                value: row.value as Prisma.InputJsonValue,
            })),
            skipDuplicates: true,
        });
        console.log(`settings: added ${missingSettings.length} rows`);
    } else {
        console.log('settings: nothing to add');
    }

    // 显式应用默认目录：重跑会更新同编码套餐的价格、权益与商品映射。
    for (const { terms, ...plan } of plans) {
        const saved = await prisma.plan.upsert({
            where: { code: plan.code },
            update: plan,
            create: plan,
        });

        for (const term of terms) {
            await prisma.planTerm.upsert({
                where: {
                    planId_cycle: { planId: saved.id, cycle: term.cycle },
                },
                update: term,
                create: { planId: saved.id, ...term },
            });
        }
    }

    // 工单分类（平台级字典）：只补库里还没有的分类名 —— 幂等，且绝不覆盖
    // 管理端改过的名字、描述、排序与启停状态。
    const existingTicketCategoryNames = await prisma.ticketCategory.findMany({
        select: { name: true },
    });
    const missingTicketCategories = missingTicketCategorySeeds(
        existingTicketCategoryNames.map((row) => row.name),
    );

    if (missingTicketCategories.length > 0) {
        await prisma.ticketCategory.createMany({
            data: missingTicketCategories,
            skipDuplicates: true,
        });
        console.log(
            `ticket categories: added ${missingTicketCategories.length} rows`,
        );
    } else {
        console.log('ticket categories: nothing to add');
    }

    // Ensure every organization has the FREE fallback subscription.
    const freePlan = await prisma.plan.findUniqueOrThrow({
        where: { code: 'FREE' },
    });
    const organizations = await prisma.organization.findMany({
        select: { id: true },
    });

    for (const organization of organizations) {
        const existingFree = await prisma.subscription.findFirst({
            where: {
                organizationId: organization.id,
                planId: freePlan.id,
            },
        });

        if (!existingFree) {
            await prisma.subscription.create({
                data: {
                    organizationId: organization.id,
                    planId: freePlan.id,
                    status: 'ACTIVE',
                    startsAt: new Date(),
                    expiresAt: FREE_SUBSCRIPTION_EXPIRY,
                },
            });
        }

        // 默认规则组（组织级，不绑定）—— 幂等：同名已存在则跳过。
        for (const ruleGroup of DEFAULT_RULE_GROUPS) {
            const existingRuleGroup = await prisma.ruleGroup.findFirst({
                where: {
                    organizationId: organization.id,
                    name: ruleGroup.name,
                },
                select: { id: true },
            });

            if (existingRuleGroup) continue;

            await prisma.ruleGroup.create({
                data: {
                    organizationId: organization.id,
                    name: ruleGroup.name,
                    description: ruleGroup.description,
                    tree: ruleGroup.tree as never,
                    fieldsUsed: extractRuleFields(ruleGroup.tree),
                },
            });
        }
    }

    await prisma.$disconnect();
    await pool.end();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { MonitorType } from '../src/generated/prisma/enums';
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

    const plans = [
        {
            code: 'FREE',
            allowedMonitorTypes: [
                MonitorType.HTTP,
                MonitorType.TCP,
                MonitorType.PING,
            ],
            name: '免费版',
            description: 'For trying out Beacon monitoring',
            price: 0,
            sortOrder: 1,
            durationDays: 36500,
            maxMonitors: 10,
            maxProbes: 0,
            maxApiKeys: 3,
            maxMembers: 5,
            maxChannels: 1,
            minInterval: 60,
            allowTenantProbe: false,
            allowStatusPage: true,
        },
        {
            code: 'PRO',
            allowedMonitorTypes: Object.values(MonitorType),
            name: '专业版',
            description: 'For small teams',
            price: 2900,
            sortOrder: 2,
            durationDays: 30,
            maxMonitors: 50,
            maxProbes: 10,
            maxApiKeys: 10,
            maxMembers: 10,
            maxChannels: 5,
            minInterval: 30,
            allowTenantProbe: true,
            allowStatusPage: true,
        },
        {
            code: 'TEAM',
            allowedMonitorTypes: Object.values(MonitorType),
            name: '团队版',
            description: 'For growing businesses',
            price: 9900,
            sortOrder: 3,
            durationDays: 30,
            maxMonitors: 200,
            maxProbes: 50,
            maxApiKeys: 50,
            maxMembers: 999,
            maxChannels: 99,
            minInterval: 10,
            allowTenantProbe: true,
            allowStatusPage: true,
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

    for (const plan of plans) {
        await prisma.plan.upsert({
            where: { code: plan.code },
            update: plan,
            create: plan,
        });
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

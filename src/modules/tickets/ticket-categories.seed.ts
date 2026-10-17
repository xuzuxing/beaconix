/**
 * 工单分类的内置默认值（平台级字典，全局共享）。
 *
 * 真源是这里的常量，`prisma/seed.ts` 只负责把库里还没有的分类名补上 ——
 * 已存在的分类（管理端改过名字、描述、排序或停用过的）一律不动。
 */
export interface TicketCategorySeed {
    name: string;
    description: string;
    sortOrder: number;
}

export const DEFAULT_TICKET_CATEGORIES: TicketCategorySeed[] = [
    {
        name: '故障与不可用',
        description: '平台、监控或探针出现异常与中断，需要尽快排查',
        sortOrder: 10,
    },
    {
        name: '告警与通知',
        description: '告警未触发、重复触发，或邮件/Webhook 等通知渠道收发异常',
        sortOrder: 20,
    },
    {
        name: '探针与部署',
        description: '探针安装注册、心跳离线、版本升级与网络连通性问题',
        sortOrder: 30,
    },
    {
        name: '计费与订阅',
        description: '套餐变更、订单支付、发票与配额相关问题',
        sortOrder: 40,
    },
    {
        name: '账号与权限',
        description: '登录、二次验证、团队成员、角色与项目权限问题',
        sortOrder: 50,
    },
    {
        name: 'API 与集成',
        description: '开放 API、API Key、Webhook 联调与鉴权问题',
        sortOrder: 60,
    },
    {
        name: '功能建议',
        description: '新功能需求与产品改进建议',
        sortOrder: 70,
    },
    {
        name: '其他问题',
        description: '不属于以上分类的咨询与反馈',
        sortOrder: 80,
    },
];

/**
 * 只挑出库里还没有的分类（按唯一名比对）—— 幂等补齐的关键。
 * 已存在的分类保持管理端当前状态，seed 不覆盖。
 */
export function missingTicketCategorySeeds(
    existingNames: Iterable<string>,
): TicketCategorySeed[] {
    const known = new Set(existingNames);

    return DEFAULT_TICKET_CATEGORIES.filter(
        (category) => !known.has(category.name),
    );
}

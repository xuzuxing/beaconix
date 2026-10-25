/**
 * 平台自留名字（保留 slug）策略。
 *
 * 组织 slug、状态页 slug、项目 key 都是用户可选的短标识，而其中一部分名字
 * 与平台自身的路由、品牌或运维语义重合（`admin`、`api`、`status`……）。这类
 * 名字一旦被租户抢注，前端 `/:orgSlug`、`/status/:slug` 这类路由就会和平台
 * 页面撞车，且事后改名成本很高——所以统一在这里判为不可用。
 *
 * 清单本身是可运维的：默认值写在 `DEFAULT_RESERVED_SLUGS`，管理页可通过
 * `slug.reserved`（settings 表，SUPER_ADMIN 可改）覆盖。比较一律小写、去空白，
 * 因此 `ADMIN` 与 `admin` 等价（项目 key 本身是大写）。
 */

/** settings 表里存保留字清单的 key */
export const RESERVED_SLUGS_SETTING_KEY = 'slug.reserved';

/**
 * 内置默认保留字：平台路由 / 品牌 / 运维语义 + 常见歧义词。
 *
 * 前端若把 slug 用作 URL 首段，命中这里就等于占用平台页面；不在清单里的词
 * 由管理员按需追加。故意保持小写——比较时双方都走 `toLowerCase()`。
 */
export const DEFAULT_RESERVED_SLUGS: readonly string[] = [
    // 平台 / 系统
    'admin',
    'administrator',
    'root',
    'system',
    'sys',
    'internal',
    'private',
    'public',
    'api',
    'apis',
    'graphql',
    'webhook',
    'webhooks',
    'callback',
    'callbacks',
    'ws',
    'sse',
    'cron',
    'queue',
    'health',
    'healthz',
    'metrics',
    // 站点 / 资源
    'app',
    'www',
    'web',
    'static',
    'assets',
    'img',
    'images',
    'media',
    'files',
    'upload',
    'uploads',
    'download',
    'cdn',
    // 账号 / 认证
    'login',
    'logout',
    'signin',
    'signup',
    'register',
    'auth',
    'oauth',
    'sso',
    'account',
    'accounts',
    'user',
    'users',
    'profile',
    'member',
    'members',
    // 平台后台
    'settings',
    'config',
    'console',
    'dashboard',
    'manage',
    'management',
    'panel',
    // 文档 / 支持
    'docs',
    'doc',
    'documentation',
    'reference',
    'api-docs',
    'swagger',
    'help',
    'support',
    'contact',
    'about',
    'blog',
    'news',
    'feedback',
    // 商业化
    'pricing',
    'plans',
    'billing',
    'pay',
    'payment',
    'payments',
    'order',
    'orders',
    'invoice',
    'invoices',
    // 监控领域
    'status',
    'status-page',
    'statuspage',
    'monitor',
    'monitoring',
    'probe',
    'probes',
    'alert',
    'alerts',
    'check',
    'checks',
    // 品牌 / 法务
    'beacon',
    'beaconix',
    'official',
    'legal',
    'terms',
    'privacy',
    'security',
    'abuse',
    // 通用歧义 / 环境
    'home',
    'index',
    'new',
    'create',
    'edit',
    'delete',
    'test',
    'testing',
    'dev',
    'develop',
    'staging',
    'prod',
    'production',
    'demo',
    'sample',
    'example',
    'null',
    'undefined',
    'true',
    'false',
];

/**
 * 把 settings 里读到的值规范成可比较的清单。
 *
 * 读写两套宽严规则与 `settings.util` 一致：写入口已由 `stringArray` 校验挡住，
 * 这里再兜一次——非数组 / 全空白 → 回退内置默认（宁可多拦，不可漏拦）。
 */
export function normalizeReservedSlugs(value: unknown): string[] {
    if (!Array.isArray(value)) return [...DEFAULT_RESERVED_SLUGS];

    const result: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const normalized = entry.trim().toLowerCase();
        if (normalized && !result.includes(normalized)) {
            result.push(normalized);
        }
    }

    return result.length ? result : [...DEFAULT_RESERVED_SLUGS];
}

/** 是否命中保留字：不区分大小写，两端的空白不算内容 */
export function isReservedSlug(
    slug: string,
    reserved: Iterable<string>,
): boolean {
    const needle = slug.trim().toLowerCase();
    if (!needle) return false;

    for (const entry of reserved) {
        if (entry.trim().toLowerCase() === needle) return true;
    }

    return false;
}

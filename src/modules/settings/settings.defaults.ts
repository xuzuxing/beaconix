import { SettingValueType } from '../../generated/prisma/enums';

/** DB 里存在但不在内置清单中的配置行（理论上不会出现）统一归入该分组 */
export const CUSTOM_SETTING_GROUP = 'custom';

export interface SettingDefinition {
    key: string;
    name: string;
    /**
     * 平台配置页的 tab 归属。只由代码定义、不入库：新增分组改这里即可，无需迁移。
     * tab 的清单与顺序另由 `develop.configGroup` 的值决定。
     */
    group: string;
    value: string | number | boolean | Record<string, unknown> | unknown[];
    valueType: SettingValueType;
    description: string;
    isSecret?: boolean;
    min?: number;
    max?: number;
    integer?: boolean;
    /** 候选值；下发为 `options` 供前端渲染下拉 */
    allowedValues?: readonly string[];
    /** `allowedValues` 的展示文案，缺省回退为候选值本身 */
    optionLabels?: Readonly<Record<string, string>>;
    url?: boolean;
    /** 非空时必须是合法的邮箱地址 */
    email?: boolean;
    /** 值必须是「非空且不重复的字符串数组」 */
    stringArray?: boolean;
}

/**
 * 平台自身的运行参数：站点展示、系统邮件（SMTP）、开发调试、存储与附件。
 *
 * 这里不放业务策略——成员数 / 项目数 / 监控项上限之类按套餐（billing）处理，
 * 业务模块自己的默认值也留在各自模块里。
 * 数组顺序即管理页同一 tab 内的展示顺序，分组首次出现的顺序即 tab 顺序。
 */
const BASE_SETTING_DEFINITIONS: readonly SettingDefinition[] = [
    // ── 站点配置 ────────────────────────────────────────────────────────
    {
        key: 'system.siteName',
        name: '站点名称',
        group: 'system',
        value: 'Beacon',
        valueType: SettingValueType.STRING,
        description: '浏览器标题、系统邮件与状态页上展示的产品名。',
    },
    {
        key: 'system.siteDescription',
        name: '站点描述',
        group: 'system',
        value: '云监控与状态页平台',
        valueType: SettingValueType.STRING,
        description: '登录页与状态页上的站点简介。',
    },
    {
        key: 'system.logoUrl',
        name: '站点 Logo',
        group: 'system',
        value: '',
        valueType: SettingValueType.STRING,
        description: '顶栏与登录页使用的 Logo 地址，留空则用内置图标。',
        url: true,
    },
    {
        key: 'system.faviconUrl',
        name: '浏览器图标',
        group: 'system',
        value: '',
        valueType: SettingValueType.STRING,
        description: '浏览器标签页图标地址，留空则用内置图标。',
        url: true,
    },
    {
        key: 'system.footerCopyright',
        name: '页脚版权',
        group: 'system',
        value: '© 2026 Beacon',
        valueType: SettingValueType.STRING,
        description: '页面底部展示的版权文案。',
    },
    {
        key: 'system.icpLicense',
        name: 'ICP 备案号',
        group: 'system',
        value: '',
        valueType: SettingValueType.STRING,
        description: '中国大陆部署时展示在页脚的备案号。',
    },
    {
        key: 'system.supportEmail',
        name: '客服邮箱',
        group: 'system',
        value: 'support@beacon.example.com',
        valueType: SettingValueType.STRING,
        description: '页脚与系统邮件里对外提供的联系邮箱。',
        email: true,
    },
    {
        key: 'system.defaultLocale',
        name: '默认语言',
        group: 'system',
        value: 'zh-CN',
        valueType: SettingValueType.STRING,
        description: '新访客与注册用户的默认界面语言。',
        allowedValues: ['zh-CN', 'en-US'],
        optionLabels: { 'zh-CN': '简体中文', 'en-US': 'English' },
    },
    {
        key: 'system.maintenanceMode',
        name: '维护模式',
        group: 'system',
        value: false,
        valueType: SettingValueType.BOOLEAN,
        description: '开启后除平台超级管理员外的访问一律被挡在维护页。',
    },
    // ── SMTP 发信通道 ───────────────────────────────────────────────────
    {
        key: 'smtp.host',
        name: 'SMTP 服务器',
        group: 'smtp',
        value: '',
        valueType: SettingValueType.STRING,
        description: '系统邮件使用的 SMTP 主机地址，留空表示未配置 SMTP。',
    },
    {
        key: 'smtp.port',
        name: 'SMTP 端口',
        group: 'smtp',
        value: 587,
        valueType: SettingValueType.NUMBER,
        description: 'SMTP 端口：587 为 STARTTLS 提交端口，465 为隐式 TLS。',
        min: 1,
        max: 65535,
        integer: true,
    },
    {
        key: 'smtp.secure',
        name: 'SMTP 加密',
        group: 'smtp',
        value: false,
        valueType: SettingValueType.BOOLEAN,
        description:
            '开启后使用隐式 TLS（对应 465 端口）；587 端口请保持关闭以走 STARTTLS。',
    },
    {
        key: 'smtp.account',
        name: 'SMTP 账号',
        group: 'smtp',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            'SMTP 登录账号，通常为完整邮箱地址（部分服务商填 API Key）。',
    },
    {
        key: 'smtp.password',
        name: 'SMTP 密码',
        group: 'smtp',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            'SMTP 登录密码或授权码，保存后不回显；不修改时不要提交该项。',
        isSecret: true,
    },
    {
        key: 'smtp.fromAddress',
        name: '发件人地址',
        group: 'smtp',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '邮件信封发件人地址；留空时依次回退到 SMTP 账号与 RESEND_FROM_EMAIL。',
        email: true,
    },

    // ── 开发与调试 ──────────────────────────────────────────────────────
    {
        key: 'develop.debugMode',
        name: '调试模式',
        group: 'develop',
        value: false,
        valueType: SettingValueType.BOOLEAN,
        description:
            '开启后服务端 5xx 响应会附带错误详情，仅建议在测试环境使用。',
    },
    {
        key: 'develop.apiDocsUrl',
        name: '接口文档地址',
        group: 'develop',
        value: '/reference',
        valueType: SettingValueType.STRING,
        description: '顶栏「接口文档」入口指向的地址。',
    },
    {
        key: 'develop.rateLimitPerMinute',
        name: '每分钟请求上限',
        group: 'develop',
        value: 120,
        valueType: SettingValueType.NUMBER,
        description: '单个账号每分钟允许的 API 调用次数。',
        min: 1,
        integer: true,
    },
    {
        key: 'develop.seedDemoData',
        name: '填充示例数据',
        group: 'develop',
        value: true,
        valueType: SettingValueType.BOOLEAN,
        description: '新建租户时自动生成示例监控项与状态页。',
    },

    // ── 存储 / 附件（会被运行时真实消费的部分）──────────────────────────
    {
        key: 'storage.driver',
        name: '存储驱动',
        group: 'storage',
        value: 'local',
        valueType: SettingValueType.STRING,
        description: '启用中的附件存储驱动：local 或 oss。',
        allowedValues: ['local', 'oss'],
        optionLabels: { local: '本地存储', oss: 'OSS 对象存储' },
    },
    {
        key: 'storage.publicBaseUrl',
        name: '本地存储公网地址',
        group: 'storage',
        value: '',
        valueType: SettingValueType.STRING,
        description: '可选：本地附件对象的公网基础地址，留空则由接口流式下载。',
        url: true,
    },
    {
        key: 'storage.oss.publicBaseUrl',
        name: 'OSS 公网地址',
        group: 'storage',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '可选：OSS 对象的公网/CDN 基础地址，留空则使用签名下载地址。',
        url: true,
    },
    {
        key: 'storage.oss.signedUrlTtlSeconds',
        name: 'OSS 签名地址有效期（秒）',
        group: 'storage',
        value: 300,
        valueType: SettingValueType.NUMBER,
        description:
            '生成的 OSS 签名下载地址有效期（秒）。实际签发时上限为 300 秒。',
        min: 30,
        max: 86400,
        integer: true,
    },
    {
        key: 'attachments.maxImageSizeMb',
        name: '图片上传上限（MB）',
        group: 'attachments',
        value: 8,
        valueType: SettingValueType.NUMBER,
        description: '单个图片附件的最大体积（MB）。',
        min: 1,
        max: 500,
        integer: true,
    },
    {
        key: 'attachments.maxPdfSizeMb',
        name: 'PDF 上传上限（MB）',
        group: 'attachments',
        value: 16,
        valueType: SettingValueType.NUMBER,
        description: '单个 PDF 附件的最大体积（MB）。',
        min: 1,
        max: 500,
        integer: true,
    },
    {
        key: 'attachments.maxBlobSizeMb',
        name: '其他文件上传上限（MB）',
        group: 'attachments',
        value: 32,
        valueType: SettingValueType.NUMBER,
        description: '其他允许类型附件的最大体积（MB）。',
        min: 1,
        max: 500,
        integer: true,
    },
    {
        key: 'attachments.maxFilesPerRequest',
        name: '单次请求文件数上限',
        group: 'attachments',
        value: 5,
        valueType: SettingValueType.NUMBER,
        description: '预留给批量上传的单次文件数上限（当前上传路径尚未消费）。',
        min: 1,
        max: 20,
        integer: true,
    },
];

/**
 * 平台配置页的 tab 清单与顺序：由上面各项的 `group` 按定义顺序派生。
 * 新增分组只改 `BASE_SETTING_DEFINITIONS`，这里不用动。
 */
const DEFAULT_CONFIG_GROUPS: readonly string[] = [
    ...new Set(BASE_SETTING_DEFINITIONS.map((definition) => definition.group)),
];

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
    ...BASE_SETTING_DEFINITIONS,
    {
        key: 'develop.configGroup',
        name: '平台配置分组',
        group: 'develop',
        value: [...DEFAULT_CONFIG_GROUPS],
        valueType: SettingValueType.JSON,
        description:
            '平台配置页的 tab 清单与顺序，填字符串数组，可任意增删分组。',
        stringArray: true,
    },
];

export const SETTING_DEFINITION_MAP: ReadonlyMap<string, SettingDefinition> =
    new Map(
        SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
    );

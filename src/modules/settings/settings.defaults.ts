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
    /**
     * tab 内的二级分组（小标题 / 折叠面板），同样只由代码定义、不入库。
     * 项数多的 tab（例如 `wechat`）靠它把平铺的长表单切成若干块；
     * 同一 group 内首次出现的顺序即二级分组顺序，未声明则回到 tab 顶层。
     * 取值是稳定的英文标识（与 `group` 同风格），展示文案由前端按 key 做 i18n，
     * 这样改文案不会动到已经存量的前端映射。
     */
    section?: string;
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
    /**
     * 是否通过公开端点 `GET /api/settings/public` 暴露给前端。
     * 只有展示型配置才是公开的；`isSecret` 的项即使标了也会被过滤掉。
     */
    isPublic?: boolean;
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
        isPublic: true,
        value: 'Beacon',
        valueType: SettingValueType.STRING,
        description: '浏览器标题、系统邮件与状态页上展示的产品名。',
    },
    {
        key: 'system.siteDescription',
        name: '站点描述',
        group: 'system',
        isPublic: true,
        value: '云监控与状态页平台',
        valueType: SettingValueType.STRING,
        description: '登录页与状态页上的站点简介。',
    },
    {
        key: 'system.logoUrl',
        name: '站点 Logo',
        group: 'system',
        isPublic: true,
        value: '',
        valueType: SettingValueType.STRING,
        description: '顶栏与登录页使用的 Logo 地址，留空则用内置图标。',
        url: true,
    },
    {
        key: 'system.faviconUrl',
        name: '浏览器图标',
        group: 'system',
        isPublic: true,
        value: '',
        valueType: SettingValueType.STRING,
        description: '浏览器标签页图标地址，留空则用内置图标。',
        url: true,
    },
    {
        key: 'system.footerCopyright',
        name: '页脚版权',
        group: 'system',
        isPublic: true,
        value: '© 2026 Beacon',
        valueType: SettingValueType.STRING,
        description: '页面底部展示的版权文案。',
    },
    {
        key: 'system.icpLicense',
        name: 'ICP 备案号',
        group: 'system',
        isPublic: true,
        value: '',
        valueType: SettingValueType.STRING,
        description: '中国大陆部署时展示在页脚的备案号。',
    },
    {
        key: 'system.supportEmail',
        name: '客服邮箱',
        group: 'system',
        isPublic: true,
        value: 'support@beacon.example.com',
        valueType: SettingValueType.STRING,
        description: '页脚与系统邮件里对外提供的联系邮箱。',
        email: true,
    },
    {
        key: 'system.defaultLocale',
        name: '默认语言',
        group: 'system',
        isPublic: true,
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
        isPublic: true,
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
        key: 'storage.oss.endpoint',
        name: 'OSS Endpoint',
        group: 'storage',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            'OSS / S3 兼容服务的访问端点，例如 https://oss-cn-hangzhou.aliyuncs.com；留空使用云厂商默认端点。',
        url: true,
    },
    {
        key: 'storage.oss.region',
        name: 'OSS 区域',
        group: 'storage',
        value: 'auto',
        valueType: SettingValueType.STRING,
        description:
            '区域标识，例如 oss-cn-hangzhou；自建 S3 兼容服务通常填 auto。',
    },
    {
        key: 'storage.oss.bucket',
        name: 'OSS 公开 Bucket',
        group: 'storage',
        value: '',
        valueType: SettingValueType.STRING,
        description: '存放公开附件（头像、工单附件等）的 bucket 名称。',
    },
    {
        key: 'storage.oss.privateBucket',
        name: 'OSS 私有 Bucket',
        group: 'storage',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '存放任务私有附件的 bucket 名称，必须与公开 bucket 不同且不可公开读。',
    },
    {
        key: 'storage.oss.accessKeyId',
        name: 'OSS Access Key ID',
        group: 'storage',
        value: '',
        valueType: SettingValueType.STRING,
        isSecret: true,
        description:
            '留空则回退到环境变量 STORAGE_OSS_ACCESS_KEY_ID；填过之后不会再回显。',
    },
    {
        key: 'storage.oss.accessKeySecret',
        name: 'OSS Access Key Secret',
        group: 'storage',
        value: '',
        valueType: SettingValueType.STRING,
        isSecret: true,
        description:
            '留空则回退到环境变量 STORAGE_OSS_ACCESS_KEY_SECRET；填过之后不会再回显。',
    },
    {
        key: 'storage.oss.forcePathStyle',
        name: 'OSS 强制 Path Style',
        group: 'storage',
        value: false,
        valueType: SettingValueType.BOOLEAN,
        description:
            '自建 MinIO 等兼容服务通常需要开启；云厂商 OSS/COS 保持关闭。',
    },
    {
        key: 'storage.publicBaseUrl',
        name: '本地存储公网地址',
        group: 'storage',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '可选：站点根地址（如 https://api.example.com）。公开附件 URL = ' +
            '该地址 + /storage/public/<key>；留空则返回相对路径 ' +
            '/storage/public/<key>。',
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

    // ── 微信支付 ──────────────────────────────────────────────────────
    // 微信整组的取值规则统一：DB 覆盖过就用 DB，留空/未覆盖则回退同名环境
    // 变量（见 `WechatRuntimeConfigService`），因此升级不会改变既有部署行为。
    {
        key: 'wechat.pay.mchId',
        name: '支付商户号',
        group: 'wechat',
        section: 'pay',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '微信支付商户号（mchid）。留空则回退环境变量 WECHAT_PAY_MCHID。',
    },
    {
        key: 'wechat.pay.appId',
        name: '支付 AppID',
        group: 'wechat',
        section: 'pay',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '与商户号绑定的 AppID（小程序或网站应用），与登录用的 AppID 不是一套。留空则回退 WECHAT_PAY_APPID。',
    },
    {
        key: 'wechat.pay.serialNo',
        name: '商户证书序列号',
        group: 'wechat',
        section: 'pay',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '商户 API 证书序列号，请求签名时写入 Wechatpay-Serial 头。留空则回退 WECHAT_PAY_SERIAL_NO。',
    },
    {
        key: 'wechat.pay.privateKey',
        name: '商户私钥',
        group: 'wechat',
        section: 'pay',
        value: '',
        valueType: SettingValueType.STRING,
        isSecret: true,
        description:
            '商户私钥：可粘贴 PEM 全文，也可填服务器上的私钥文件路径。保存后不回显；留空则回退 WECHAT_PAY_PRIVATE_KEY。',
    },
    {
        key: 'wechat.pay.apiV3Key',
        name: 'APIv3 密钥',
        group: 'wechat',
        section: 'pay',
        value: '',
        valueType: SettingValueType.STRING,
        isSecret: true,
        description:
            '32 位 APIv3 密钥，用于回调报文解密。保存后不回显；留空则回退 WECHAT_PAY_APIV3_KEY。',
    },
    {
        key: 'wechat.pay.publicKey',
        name: '微信支付公钥',
        group: 'wechat',
        section: 'pay',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '微信支付公钥（新商户模式）：可粘贴 PEM 全文，也可填文件路径。留空则回退 WECHAT_PAY_PUBLIC_KEY。',
    },
    {
        key: 'wechat.pay.publicKeyId',
        name: '微信支付公钥 ID',
        group: 'wechat',
        section: 'pay',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '公钥 ID（形如 PUB_KEY_ID_xxx），写入请求的 Wechatpay-Serial 头。留空则回退 WECHAT_PAY_PUBLIC_KEY_ID。',
    },
    {
        key: 'wechat.pay.notifyUrl',
        name: '支付回调地址',
        group: 'wechat',
        section: 'pay',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '微信支付完成后回调的公网 HTTPS 地址，需与网关放行路径一致。留空则回退 WECHAT_PAY_NOTIFY_URL。',
        url: true,
    },
    {
        key: 'wechat.pay.mock',
        name: '模拟支付',
        group: 'wechat',
        section: 'pay',
        value: true,
        valueType: SettingValueType.BOOLEAN,
        description:
            '开启后计费模块不调用真实支付，直接返回模拟支付参数，便于无商户号时联调；开始真实收款前必须关闭。对应 WECHAT_PAY_MOCK。',
    },

    // ── 小程序 ────────────────────────────────────────────────────────
    {
        key: 'wechat.miniprogram.appId',
        name: '小程序 AppID',
        group: 'wechat',
        section: 'miniProgram',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '小程序登录、扫码登录与订阅消息共用的小程序 AppID。留空则回退 WECHAT_MINI_APPID。',
    },
    {
        key: 'wechat.miniprogram.appSecret',
        name: '小程序 AppSecret',
        group: 'wechat',
        section: 'miniProgram',
        value: '',
        valueType: SettingValueType.STRING,
        isSecret: true,
        description:
            '小程序密钥，用于换取会话与 access_token。保存后不回显；留空则回退 WECHAT_MINI_APPSECRET。',
    },

    // ── 网站应用 ──────────────────────────────────────────────────────
    {
        key: 'wechat.website.appId',
        name: '网站应用 AppID',
        group: 'wechat',
        section: 'website',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '微信开放平台网站应用 AppID，用于网页扫码登录。留空则回退 WECHAT_WEB_APPID。',
    },
    {
        key: 'wechat.website.appSecret',
        name: '网站应用 AppSecret',
        group: 'wechat',
        section: 'website',
        value: '',
        valueType: SettingValueType.STRING,
        isSecret: true,
        description:
            '网站应用密钥，用于换取授权令牌。保存后不回显；留空则回退 WECHAT_WEB_APPSECRET。',
    },

    // ── 扫码登录 ──────────────────────────────────────────────────────
    {
        key: 'wechat.scanLogin.page',
        name: '二维码落地页',
        group: 'wechat',
        section: 'scanLogin',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '扫码后打开的小程序页面路径（如 pages/login/login），留空为小程序首页。对应 WECHAT_SCAN_LOGIN_PAGE。',
    },
    {
        key: 'wechat.scanLogin.envVersion',
        name: '小程序版本',
        group: 'wechat',
        section: 'scanLogin',
        value: 'release',
        valueType: SettingValueType.STRING,
        description:
            '生成小程序码时指定的版本，测试期可切到体验版/开发版。对应 WECHAT_SCAN_LOGIN_ENV_VERSION。',
        allowedValues: ['release', 'trial', 'develop'],
        optionLabels: {
            release: '正式版',
            trial: '体验版',
            develop: '开发版',
        },
    },
    {
        key: 'wechat.scanLogin.ttlSeconds',
        name: '登录票据有效期（秒）',
        group: 'wechat',
        section: 'scanLogin',
        value: 300,
        valueType: SettingValueType.NUMBER,
        description:
            '扫码票据在缓存中的存活时间，超时后需重新生成二维码。对应 WECHAT_SCAN_LOGIN_TTL_SECONDS。',
        min: 30,
        max: 86400,
        integer: true,
    },
    {
        key: 'wechat.scanLogin.pollTimeoutMs',
        name: '扫码轮询超时（毫秒）',
        group: 'wechat',
        section: 'scanLogin',
        value: 25000,
        valueType: SettingValueType.NUMBER,
        description:
            '网页端长轮询等待扫码结果的最长时间，需小于网关超时。对应 WECHAT_SCAN_LOGIN_POLL_TIMEOUT_MS。',
        min: 1000,
        max: 60000,
        integer: true,
    },

    // ── 公众号 ────────────────────────────────────────────────────────
    {
        key: 'wechat.officialAccount.appId',
        name: '公众号 AppID',
        group: 'wechat',
        section: 'officialAccount',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '公众号 AppID，用于网页授权、模板/客服消息与安全模式回调。留空则回退 WECHAT_OA_APPID。',
    },
    {
        key: 'wechat.officialAccount.appSecret',
        name: '公众号 AppSecret',
        group: 'wechat',
        section: 'officialAccount',
        value: '',
        valueType: SettingValueType.STRING,
        isSecret: true,
        description:
            '公众号密钥，用于换取 access_token。保存后不回显；留空则回退 WECHAT_OA_APPSECRET。',
    },
    {
        key: 'wechat.officialAccount.token',
        name: '服务器配置 Token',
        group: 'wechat',
        section: 'officialAccount',
        value: '',
        valueType: SettingValueType.STRING,
        isSecret: true,
        description:
            '公众号后台「服务器配置」里的 Token，用于回调地址的 SHA1 验签；泄露可被伪造回调。保存后不回显；留空则回退 WECHAT_OA_TOKEN。',
    },
    {
        key: 'wechat.officialAccount.aesKey',
        name: '消息加解密密钥',
        group: 'wechat',
        section: 'officialAccount',
        value: '',
        valueType: SettingValueType.STRING,
        isSecret: true,
        description:
            '43 位 EncodingAESKey，安全模式下加解密回调消息。保存后不回显；留空则回退 WECHAT_OA_AES_KEY。',
    },

    // ── 企业微信 ──────────────────────────────────────────────────────
    {
        key: 'wechat.work.corpId',
        name: '企业 CorpID',
        group: 'wechat',
        section: 'work',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '企业微信 CorpID。当前企业微信客户端尚未被业务模块消费，仅作预留。留空则回退 WECHAT_WORK_CORPID。',
    },
    {
        key: 'wechat.work.corpSecret',
        name: '企业 CorpSecret',
        group: 'wechat',
        section: 'work',
        value: '',
        valueType: SettingValueType.STRING,
        isSecret: true,
        description:
            '企业微信应用密钥，用于获取 access_token。保存后不回显；留空则回退 WECHAT_WORK_CORPSECRET。',
    },
    {
        key: 'wechat.work.agentId',
        name: '应用 AgentID',
        group: 'wechat',
        section: 'work',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            '企业微信应用 AgentID，发应用消息时必填。留空则回退 WECHAT_WORK_AGENTID。',
    },

    // ── 微信接口客户端 ────────────────────────────────────────────────
    {
        key: 'wechat.http.timeoutMs',
        name: '接口超时（毫秒）',
        group: 'wechat',
        section: 'http',
        value: 8000,
        valueType: SettingValueType.NUMBER,
        description:
            '调用微信接口的 HTTP 超时。由启动时构造的客户端读取，改动需重启生效。对应 WECHAT_HTTP_TIMEOUT_MS。',
        min: 500,
        max: 60000,
        integer: true,
    },
    {
        key: 'wechat.http.maxRetries',
        name: '接口重试次数',
        group: 'wechat',
        section: 'http',
        value: 2,
        valueType: SettingValueType.NUMBER,
        description:
            '微信接口失败后的重试次数（仅幂等请求）。改动需重启生效。对应 WECHAT_HTTP_MAX_RETRIES。',
        min: 0,
        max: 5,
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

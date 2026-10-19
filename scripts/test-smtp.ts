// SMTP 发信自检脚本：验证一组 SMTP 配置能不能通过认证，并真的投递一封测试邮件。
// 排查 526 / 535 这类「Authentication failure」时先跑 --verify-only，再发信。
//
//   pnpm test:smtp -- --host smtp.qiye.aliyun.com --port 465 --secure \
//       --account noreply@example.com --password '***' --to you@example.com
//
//   pnpm test:smtp -- --from-db --to you@example.com   # 直接用平台配置里的 smtp.*
//
// 完整参数：pnpm test:smtp -- --help

import 'dotenv/config';
import { format } from 'node:util';
import { createTransport, type SendMailOptions } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { Pool } from 'pg';

/** 目标 SMTP 的一组配置；来源可以是 CLI、环境变量或数据库 */
interface SmtpConfig {
    host: string;
    port: number;
    secure: boolean;
    account: string;
    password: string;
    /** 发件地址，缺省回退到 account */
    from: string;
    fromName: string;
    /** 收件地址；为空表示只做认证测试 */
    to: string;
    subject: string;
}

interface Options {
    config: Partial<SmtpConfig>;
    fromDb: boolean;
    verifyOnly: boolean;
    debug: boolean;
    insecure: boolean;
    timeoutMs: number;
    help: boolean;
}

/** 环境变量兜底，方便把密码放在 shell 变量里而不是命令行历史里 */
const ENV_KEYS: Record<string, string> = {
    SMTP_HOST: 'host',
    SMTP_PORT: 'port',
    SMTP_SECURE: 'secure',
    SMTP_ACCOUNT: 'account',
    SMTP_PASSWORD: 'password',
    SMTP_FROM: 'from',
    SMTP_FROM_NAME: 'fromName',
    SMTP_TO: 'to',
};

const HELP = `
SMTP 发信自检：先做 AUTH 认证，再投递一封测试邮件。

用法
  pnpm test:smtp -- --host <host> --account <mailbox> --password <pwd> --to <mailbox>
  pnpm test:smtp -- --from-db --to <mailbox>        # 读平台配置（settings 表 smtp.*）
  pnpm test:smtp -- --help

参数
  --host <host>         SMTP 主机，例如 smtp.qiye.aliyun.com
  --port <port>         端口；缺省按加密方式推：--secure → 465，否则 587
  --secure / --no-secure
                        隐式 TLS（465 用这个）；587 用 --no-secure 走 STARTTLS
  --account <email>     SMTP 登录账号，必须是完整邮箱地址
  --password <pwd>      登录密码或客户端专用密码（阿里邮箱开启"三方客户端安全
                        密码"后必须用专用密码，用网页登录密码会 526）
  --from <email>        发件地址，缺省等于 --account
  --from-name <name>    发件人显示名，缺省 "Beacon SMTP Test"
  --to <email>          测试邮件收件人；不填则只验证认证，不发信
  --subject <text>      主题，缺省 "Beacon – SMTP test email"
  --from-db             从 DATABASE_URL 指向的库读 settings 表里的 smtp.*，
                        CLI / 环境变量仍可覆盖其中单项
  --verify-only         只验证认证，不发送邮件
  --debug               打印 SMTP 交互过程（AUTH 凭据已脱敏）
  --insecure            跳过 TLS 证书校验（仅自建/内网服务器用）
  --timeout <ms>        连接与握手超时，缺省 15000

环境变量（可替代同名参数，命令行优先）
  SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_ACCOUNT / SMTP_PASSWORD
  SMTP_FROM / SMTP_FROM_NAME / SMTP_TO

退出码：0 成功，1 配置或发送失败。
`.trim();

function parseBoolean(raw: string | undefined, name: string): boolean {
    if (raw === undefined) return true;
    const normalized = raw.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    throw new Error(`${name} expects true/false, got "${raw}"`);
}

function parseArgs(argv: string[]): Options {
    const options: Options = {
        config: {},
        fromDb: false,
        verifyOnly: false,
        debug: false,
        insecure: false,
        timeoutMs: 15000,
        help: false,
    };

    for (let index = 0; index < argv.length; index++) {
        const raw = argv[index];
        const eq = raw.indexOf('=');
        const name = eq === -1 ? raw : raw.slice(0, eq);
        const inline = eq === -1 ? undefined : raw.slice(eq + 1);
        const takeValue = (): string => {
            if (inline !== undefined) return inline;
            const next = argv[++index];
            if (next === undefined) {
                throw new Error(`${name} requires a value`);
            }
            return next;
        };

        switch (name) {
            case '--host':
                options.config.host = takeValue().trim();
                break;
            case '--port': {
                const port = Number(takeValue());
                if (!Number.isInteger(port) || port < 1 || port > 65535) {
                    throw new Error(`--port must be 1-65535, got "${raw}"`);
                }
                options.config.port = port;
                break;
            }
            case '--secure':
                options.config.secure = parseBoolean(inline, name);
                break;
            case '--no-secure':
                options.config.secure = false;
                break;
            case '--account':
                options.config.account = takeValue().trim();
                break;
            case '--password':
                options.config.password = takeValue();
                break;
            case '--from':
                options.config.from = takeValue().trim();
                break;
            case '--from-name':
                options.config.fromName = takeValue();
                break;
            case '--to':
                options.config.to = takeValue().trim();
                break;
            case '--subject':
                options.config.subject = takeValue();
                break;
            case '--from-db':
                options.fromDb = true;
                break;
            case '--verify-only':
                options.verifyOnly = true;
                break;
            case '--debug':
                options.debug = true;
                break;
            case '--insecure':
                options.insecure = true;
                break;
            case '--timeout': {
                const timeoutMs = Number(takeValue());
                if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                    throw new Error(
                        '--timeout expects a positive number of ms',
                    );
                }
                options.timeoutMs = timeoutMs;
                break;
            }
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                throw new Error(`unknown argument "${raw}" (see --help)`);
        }
    }

    return options;
}

/** 环境变量 → 部分配置；非法值直接报错，不静默忽略 */
function configFromEnv(): Partial<SmtpConfig> {
    const config: Partial<SmtpConfig> = {};
    for (const [envKey, field] of Object.entries(ENV_KEYS)) {
        const raw = process.env[envKey];
        if (raw === undefined || raw.trim() === '') continue;

        if (field === 'port') {
            const port = Number(raw);
            if (!Number.isInteger(port)) {
                throw new Error(`${envKey} must be an integer, got "${raw}"`);
            }
            config.port = port;
        } else if (field === 'secure') {
            config.secure = parseBoolean(raw, envKey);
        } else {
            config[field as keyof SmtpConfig] = raw as never;
        }
    }
    return config;
}

/**
 * 读平台配置里的 `smtp.*`：线上排障时不必手抄密码。
 * 只 read-only 查 settings 表，不启动 Nest；用 pg 直连而不是 Prisma client，
 * 免得脚本启动还要依赖 prisma:generate 的产物。
 */
async function configFromDatabase(): Promise<Partial<SmtpConfig>> {
    const raw = process.env.DATABASE_URL;
    if (!raw) {
        throw new Error('--from-db needs DATABASE_URL in the environment');
    }

    // 项目里的 URL 带 `?schema=public`（Prisma 专用），pg 不认这个参数
    const url = new URL(raw);
    url.searchParams.delete('schema');

    const pool = new Pool({
        connectionString: url.toString(),
        connectionTimeoutMillis: 10000,
    });

    try {
        const { rows } = await pool.query<{ key: string; value: unknown }>(
            `SELECT key, value FROM settings WHERE key LIKE 'smtp.%'`,
        );
        const values = new Map(rows.map((row) => [row.key, row.value]));

        const asString = (key: string): string | undefined => {
            const value = values.get(key);
            if (typeof value === 'string') return value;
            if (typeof value === 'number' || typeof value === 'boolean') {
                return String(value);
            }
            return undefined;
        };

        const config: Partial<SmtpConfig> = {
            host: asString('smtp.host')?.trim(),
            account: asString('smtp.account')?.trim(),
            password: asString('smtp.password'),
            from: asString('smtp.fromAddress')?.trim(),
        };

        const port = Number(asString('smtp.port'));
        if (Number.isInteger(port) && port > 0) config.port = port;

        const secure = asString('smtp.secure')?.toLowerCase();
        if (secure === 'true' || secure === 'false') {
            config.secure = secure === 'true';
        }

        // 空字符串在配置里表示"没配"，不能当成有效值覆盖后面的端口推断
        for (const key of Object.keys(config) as (keyof SmtpConfig)[]) {
            if (config[key] === '') delete config[key];
        }

        return config;
    } finally {
        await pool.end();
    }
}

function titleWithHost(config: SmtpConfig): string {
    return `${config.host}:${config.port} (${config.secure ? 'implicit TLS' : 'STARTTLS/plain'})`;
}

function describeConfig(config: SmtpConfig, fromDb: boolean): void {
    console.log('SMTP 配置');
    console.log(`  host:     ${titleWithHost(config)}`);
    console.log(`  account:  ${config.account}`);
    console.log(`  password: ${config.password ? '******' : '(empty)'}`);
    console.log(`  from:     ${config.fromName} <${config.from}>`);
    console.log(`  to:       ${config.to || '(verify only)'}`);
    if (fromDb) {
        console.log('  source:   settings 表 smtp.*（CLI / 环境变量可覆盖）');
    }

    if (config.port === 465 && !config.secure) {
        console.warn('  warn:     465 端口必须开隐式 TLS，请加 --secure');
    }
    if (config.port === 587 && config.secure) {
        console.warn('  warn:     587 通常是 STARTTLS，请用 --no-secure');
    }
    if (config.port === 25) {
        console.warn('  warn:     25 端口多数服务商已关闭，认证失败常与此有关');
    }
    if (!config.password) {
        console.warn('  warn:     密码为空，服务端必定拒绝认证');
    }
    const accountDomain = config.account.split('@')[1];
    const fromDomain = config.from.split('@')[1];
    if (accountDomain && fromDomain && accountDomain !== fromDomain) {
        console.warn(
            `  warn:     发件域 ${fromDomain} 与账号域 ${accountDomain} 不同，多数服务商会拒绝代发`,
        );
    }
    console.log('');
}

/** nodemailer 的 debug 会把 AUTH 的 base64（内含账号密码）原样打出来 */
function redact(line: string): string {
    return (
        line
            // 只吃掉同一行内的凭据：服务端的 `250-AUTH PLAIN` 宣告行没有参数，
            // 不会被误伤
            .replace(
                /\b(AUTH[ \t]+(?:PLAIN|LOGIN|XOAUTH2)[ \t]+)[^\r\n]+/gi,
                '$1<redacted>',
            )
            .replace(
                /\b(pass(?:word)?[ \t]*[:=][ \t]*)[^\r\n]+/gi,
                '$1<redacted>',
            )
    );
}

/**
 * nodemailer 的 logger 接口是 `logger.debug(meta, format, ...args)`，
 * 这里拼成一行并脱敏，避免把 AUTH 凭据打到终端/CI 日志里。
 */
function debugLogger(): Record<string, (...args: never[]) => void> {
    const write = (args: unknown[]): void => {
        const [, ...rest] = args;
        const text =
            rest.length > 0
                ? format(...(rest as [unknown, ...unknown[]]))
                : format(args[0]);
        console.error(`  [smtp] ${redact(text)}`);
    };

    return {
        debug: (...args: unknown[]) => write(args),
        info: (...args: unknown[]) => write(args),
        warn: (...args: unknown[]) => write(args),
        error: (...args: unknown[]) => write(args),
    } as Record<string, (...args: never[]) => void>;
}

function createSmtpTransport(
    config: SmtpConfig,
    options: Options,
): Transporter {
    return createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.account
            ? { user: config.account, pass: config.password }
            : undefined,
        connectionTimeout: options.timeoutMs,
        greetingTimeout: options.timeoutMs,
        socketTimeout: options.timeoutMs,
        tls: options.insecure ? { rejectUnauthorized: false } : undefined,
        debug: options.debug,
        logger: options.debug ? debugLogger() : undefined,
    } as Parameters<typeof createTransport>[0]);
}

function errorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string') return code;
    }
    return '';
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 把服务商返回的裸错误码翻译成可执行的排查步骤 */
function hintsFor(error: unknown): string[] {
    const code = errorCode(error);
    const message = errorText(error);

    if (
        code === 'EAUTH' ||
        /Invalid login|Authentication (failure|failed|rejected)/i.test(message)
    ) {
        return [
            '服务端拒绝了登录凭据（526 / 535 一类）。按顺序核对：',
            '  1. --account 必须是完整邮箱地址，不能带空格或引号；',
            '  2. 密码是"网页登录密码"还是"客户端专用密码"？阿里邮箱一旦开启',
            '     【三方客户端安全密码】，只能用专用密码，填登录密码就是 526；',
            '  3. 该账号的 SMTP 发信协议是否被关闭：阿里邮箱标准协议（SMTP/IMAP/POP）',
            '     近一个月未登录会自动关闭，需要到域管理后台重新开启；',
            '  4. 账号是否已停用/欠费，或设置了登录 IP 白名单限制；',
            '  5. 密码刚从后台重置过时，SMTP 鉴权可能滞后，稍等再试。',
        ];
    }

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return ['域名解析失败：确认 --host 拼写，以及本机 DNS 是否可用。'];
    }

    if (code === 'ETIMEDOUT' || /timeout/i.test(message)) {
        return [
            '连接超时：出网 465 / 587 可能被防火墙或云安全组拦住；',
            '能 ping 通域名不代表端口可达，可先用 telnet/nc 探端口。',
        ];
    }

    if (
        code === 'ECONNECTION' ||
        code === 'ECONNREFUSED' ||
        code === 'ESOCKET' ||
        code === 'EDNS'
    ) {
        return [
            '连接被拒绝或中断：多半是端口与加密方式不匹配 ——',
            '  465 用 --secure（隐式 TLS），587 用 --no-secure（STARTTLS），25 多数已关闭。',
        ];
    }

    if (/certificate|self.signed|CERT_/i.test(message)) {
        return [
            'TLS 证书校验失败：确认 --host 与服务商文档一致；',
            '自建或内网自签证书可加 --insecure（仅调试用）。',
        ];
    }

    if (code === 'EENVELOPE') {
        return [
            '信封被拒：检查 --from 是否属于 SMTP 账号所在的域，以及收件地址是否有效。',
        ];
    }

    return [];
}

function printFailure(stage: string, error: unknown): void {
    console.error(`✗ ${stage}失败：${errorText(error)}`);
    const code = errorCode(error);
    if (code) console.error(`  code: ${code}`);
    for (const hint of hintsFor(error)) console.error(`  ${hint}`);
}

function buildMessage(config: SmtpConfig): SendMailOptions {
    const sentAt = new Date().toISOString();
    const from = config.fromName
        ? `${config.fromName} <${config.from}>`
        : config.from;

    return {
        from,
        to: config.to,
        subject: config.subject,
        text: [
            'SMTP test email from Beacon.',
            '',
            `sent at:  ${sentAt}`,
            `host:     ${titleWithHost(config)}`,
            `account:  ${config.account}`,
            `from:     ${config.from}`,
        ].join('\n'),
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #4F46E5 0%, #6366F1 100%); padding: 28px 24px; color: #ffffff;">
                    <h1 style="margin: 0; font-size: 20px; font-weight: 600;">SMTP Test</h1>
                </div>
                <div style="padding: 24px;">
                    <p style="color: #374151; line-height: 1.6; margin-top: 0;">
                        看到这封邮件，说明 SMTP 认证与投递都通过了。
                    </p>
                    <table style="color: #374151; font-size: 14px; line-height: 1.8;">
                        <tr><td style="color: #9ca3af; padding-right: 12px;">sent at</td><td>${sentAt}</td></tr>
                        <tr><td style="color: #9ca3af; padding-right: 12px;">host</td><td>${titleWithHost(config)}</td></tr>
                        <tr><td style="color: #9ca3af; padding-right: 12px;">account</td><td>${config.account}</td></tr>
                        <tr><td style="color: #9ca3af; padding-right: 12px;">from</td><td>${config.from}</td></tr>
                    </table>
                </div>
            </div>
        `,
    };
}

async function main(): Promise<number> {
    let options: Options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`✗ ${errorText(error)}`);
        console.error('\n' + HELP);
        return 1;
    }

    if (options.help) {
        console.log(HELP);
        return 0;
    }

    // 优先级：CLI > 环境变量 > 数据库 > 端口推断默认值
    let resolved: Partial<SmtpConfig> = {};
    try {
        resolved = { ...resolved, ...configFromEnv() };
        if (options.fromDb) {
            resolved = { ...resolved, ...(await configFromDatabase()) };
        }
    } catch (error) {
        console.error(`✗ 读取配置失败：${errorText(error)}`);
        if (options.fromDb) {
            console.error(
                '  提示：本地跑 --from-db 时 DATABASE_URL 要指向可达的库 —— docker-compose\n' +
                    '  里的 postgres 是容器内主机名，本地请改用 localhost:<映射端口>。',
            );
        }
        return 1;
    }
    resolved = { ...resolved, ...options.config };

    const secure = resolved.secure ?? false;
    const config: SmtpConfig = {
        host: (resolved.host ?? '').trim(),
        port: resolved.port ?? (secure ? 465 : 587),
        secure,
        account: (resolved.account ?? '').trim(),
        // 从后台复制来的密码常带首尾空白，服务商对此只回认证失败
        password: (resolved.password ?? '').trim(),
        from: (resolved.from ?? resolved.account ?? '').trim(),
        fromName: resolved.fromName ?? 'Beacon SMTP Test',
        to: (resolved.to ?? '').trim(),
        subject: resolved.subject ?? 'Beacon – SMTP test email',
    };

    if (!config.host) {
        console.error(
            '✗ 缺少 SMTP 主机：请给 --host，或用 --from-db 读平台配置。',
        );
        return 1;
    }
    if (!config.account) {
        console.error('✗ 缺少 SMTP 账号：请给 --account。');
        return 1;
    }

    describeConfig(config, options.fromDb);

    const transporter = createSmtpTransport(config, options);
    try {
        try {
            await transporter.verify();
            console.log('✓ SMTP 认证通过（AUTH 成功）');
        } catch (error) {
            printFailure('SMTP 连接与认证', error);
            return 1;
        }

        if (options.verifyOnly || !config.to) {
            if (!config.to) {
                console.log(
                    '\n未给 --to，跳过投递；要真发一封测试邮件请加 --to <mailbox>。',
                );
            }
            return 0;
        }

        console.log(`\n正在投递测试邮件到 ${config.to} ...`);
        try {
            const info = await transporter.sendMail(buildMessage(config));
            console.log('✓ 邮件已投递');
            console.log(`  messageId: ${info.messageId ?? '(none)'}`);
            console.log(`  response:  ${info.response ?? '(none)'}`);
            console.log(
                `  accepted:  ${info.accepted?.join(', ') || '(none)'}`,
            );
            console.log(
                `  rejected:  ${info.rejected?.length ? info.rejected.join(', ') : '(none)'}`,
            );
            console.log(
                '\n若收件箱没收到，检查垃圾邮件目录与 SPF/DKIM/DMARC 配置。',
            );
            return 0;
        } catch (error) {
            printFailure('邮件投递', error);
            return 1;
        }
    } finally {
        transporter.close();
    }
}

void main().then((code) => {
    process.exitCode = code;
});

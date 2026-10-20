/**
 * 把当前所有邮件模板渲染成一个静态 HTML，用于人工核对版式。
 *
 * 用法（在仓库根目录执行）：
 *   npx tsx scripts/render-email-preview.ts
 *
 * 产物：`docs/email-preview.html`（`/docs` 已被 .gitignore 忽略，不会进版本库）。
 * 预览里的品牌信息取自「系统设置」的默认值，Logo 用内置的那张，不碰数据库。
 */
import { writeFileSync } from 'node:fs';
import { EmailService } from '../src/modules/email/email.service';
import { EmailTemplate } from '../src/modules/email/email.types';
import { BUILTIN_LOGO_DATA_URI } from '../src/modules/email/email-logo';

const service = new EmailService(
    {} as never,
    {
        get: (key: string) =>
            key === 'app'
                ? {
                      name: 'beaconix',
                      port: 3000,
                      env: 'production',
                      isProduction: true,
                      isDevelopment: false,
                      isTest: false,
                      corsOrigins: [],
                      webUrl: 'https://beaconix.example.com',
                  }
                : {
                      apiKey: 're_x',
                      fromEmail: 'noreply@beaconix.example.com',
                      fromName: 'Beaconix',
                  },
    } as never,
    {} as never,
);

/** 与后台「系统设置」默认值一致的品牌信息 */
const branding = {
    siteName: 'Beaconix',
    supportEmail: 'contacts@beaconix.app',
    logoUrl: BUILTIN_LOGO_DATA_URI,
};

const build = (template: EmailTemplate, payload: Record<string, unknown>) =>
    (
        service as unknown as {
            buildEmail: (
                t: EmailTemplate,
                p: unknown,
                b: unknown,
            ) => { subject: string; html: string };
        }
    ).buildEmail(template, payload, branding);

const monitor = {
    to: 'zhangwei@example.com',
    monitorName: '官网首页',
    target: 'https://www.beaconix.com/health',
    status: 'DOWN',
    previousStatus: 'UP',
    error: 'connect ETIMEDOUT 104.21.6.1:443',
    latency: '-',
    checkedAt: '2026-10-20T10:12:00.000Z',
};

const cases: Array<[EmailTemplate, string, Record<string, unknown>]> = [
    [
        EmailTemplate.NOTIFICATION,
        '通用通知（工作区动态）',
        {
            to: 'zhangwei@example.com',
            title: '项目「北斗」有 3 条新动态',
            body: '张三 评论了任务 BEA-12：接口超时阈值建议调到 5s\n李四 完成了任务 BEA-9\n王五 把 BEA-15 指派给了你',
        },
    ],
    [
        EmailTemplate.TASK_ASSIGNED,
        '任务指派',
        {
            to: 'zhangwei@example.com',
            name: '张伟',
            taskTitle: '修复登录页验证码失效问题',
            taskUrl: 'https://beaconix.example.com/tasks/1',
        },
    ],
    [
        EmailTemplate.TASK_DUE_SOON,
        '任务即将到期',
        {
            to: 'zhangwei@example.com',
            name: '张伟',
            taskTitle: '完成监控告警规则配置',
            taskNumber: 42,
            dueDate: '2026-10-22 18:00',
            projectKey: 'BEA',
        },
    ],
    [
        EmailTemplate.TASK_OVERDUE,
        '任务已逾期',
        {
            to: 'zhangwei@example.com',
            name: '张伟',
            taskTitle: '补充状态页 SEO 元信息',
            taskNumber: 17,
            dueDate: '2026-10-18 09:00',
            projectKey: 'BEA',
        },
    ],
    [EmailTemplate.MONITOR_DOWN, '监控告警', monitor],
    [
        EmailTemplate.MONITOR_RECOVER,
        '监控恢复',
        {
            ...monitor,
            status: 'UP',
            previousStatus: 'DOWN',
            error: '-',
            latency: '182ms',
            checkedAt: '2026-10-20T10:31:00.000Z',
        },
    ],
    [
        EmailTemplate.TICKET_REPLIED,
        '工单有新回复',
        {
            to: 'zhangwei@example.com',
            name: '张伟',
            ticketNumber: 1042,
            subject: '监控数据延迟偏高',
            body: '您好，我们已定位到采集队列积压的问题，预计今天 18:00 前修复完成。\n如仍有异常请随时回复。',
            ticketUrl: 'https://beaconix.example.com/tickets/1042',
        },
    ],
    [
        EmailTemplate.TICKET_STATUS_CHANGED,
        '工单状态变更',
        {
            to: 'zhangwei@example.com',
            name: '张伟',
            ticketNumber: 1042,
            subject: '监控数据延迟偏高',
            status: 'RESOLVED',
            ticketUrl: 'https://beaconix.example.com/tickets/1042',
        },
    ],
    [
        EmailTemplate.TWO_FACTOR_ENABLED,
        '两步验证已开启',
        {
            to: 'zhangwei@example.com',
            name: '张伟',
            changedAt: '2026-10-20T09:41:00.000Z',
        },
    ],
    [
        EmailTemplate.TWO_FACTOR_DISABLED,
        '两步验证已关闭',
        {
            to: 'zhangwei@example.com',
            name: '张伟',
            changedAt: '2026-10-20T09:41:00.000Z',
        },
    ],
    [
        EmailTemplate.TWO_FACTOR_RECOVERY_CODE_USED,
        '恢复码被使用',
        {
            to: 'zhangwei@example.com',
            name: '张伟',
            usedAt: '2026-10-20T09:41:00.000Z',
            ipAddress: '203.0.113.24',
        },
    ],
    [
        EmailTemplate.EMAIL_VERIFICATION,
        '邮箱验证码',
        {
            to: 'zhangwei@example.com',
            name: '张伟',
            code: '482913',
            expiresInMinutes: 10,
        },
    ],
    [
        EmailTemplate.PASSWORD_RESET_OTP,
        '密码重置验证码',
        {
            to: 'zhangwei@example.com',
            name: '张伟',
            code: '731504',
            expiresInMinutes: 10,
        },
    ],
    [
        EmailTemplate.INVITATION,
        '组织邀请',
        {
            to: 'newbie@example.com',
            orgName: '北斗团队',
            token: 'cmv81drjl000200uztk9bnw6n',
            inviterName: '张三',
        },
    ],
    [
        EmailTemplate.WELCOME,
        '欢迎加入',
        {
            to: 'newbie@example.com',
            name: '李四',
            orgName: '北斗团队',
        },
    ],
    [
        EmailTemplate.PASSWORD_RESET,
        '重置密码链接',
        {
            to: 'zhangwei@example.com',
            name: '张伟',
            resetUrl:
                'https://beaconix.example.com/reset-password?token=abc123',
        },
    ],
];

const nav = cases
    .map(
        ([template, label], index) =>
            `<a href="#t-${index}" style="display:block;padding:6px 10px;color:#0f7af5;text-decoration:none;font-size:13px;border-radius:6px;">${index + 1}. ${label} <span style="color:#98a2b3;">· ${template}</span></a>`,
    )
    .join('');

const sections = cases
    .map(([template, label, payload], index) => {
        const built = build(template, payload);
        const kind = [
            'invitation',
            'welcome',
            'email-verification',
            'password-reset-otp',
            'password-reset',
        ].includes(template)
            ? '交互'
            : '通知';
        return `
<section id="t-${index}" style="margin:0 0 40px;">
    <div style="max-width:660px;margin:0 auto 10px;font-family:-apple-system,'Segoe UI',Arial,sans-serif;">
        <div style="font-size:13px;color:#667085;">
            <strong style="color:#101828;font-size:14px;">${index + 1}. ${label}</strong>
            <span style="margin-left:8px;padding:1px 8px;border-radius:10px;background:#eef4ff;color:#0f7af5;font-size:11px;">${kind}</span>
            <code style="margin-left:6px;color:#98a2b3;font-size:11px;">${template}</code>
        </div>
        <div style="margin-top:4px;font-size:12px;color:#98a2b3;">主题：${built.subject}</div>
    </div>
    ${built.html}
</section>`;
    })
    .join('\n');

writeFileSync(
    './docs/email-preview.html',
    `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>邮件模板预览 · Beaconix</title>
<style>
    body { margin: 0; padding: 0; background: #eceff3; font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', Arial, sans-serif; }
    .page { display: flex; align-items: flex-start; gap: 24px; padding: 24px; }
    .nav { position: sticky; top: 24px; width: 300px; flex: 0 0 300px; background: #fff; border: 1px solid #e4e7ec; border-radius: 10px; padding: 14px 10px; max-height: calc(100vh - 48px); overflow: auto; }
    .nav h1 { margin: 4px 10px 2px; font-size: 15px; color: #101828; }
    .nav p { margin: 0 10px 10px; font-size: 12px; line-height: 18px; color: #667085; }
    .nav a:hover { background: #f5f8ff; }
    .content { flex: 1 1 auto; min-width: 0; }
    .legend { max-width: 660px; margin: 0 auto 24px; background: #fff; border: 1px solid #e4e7ec; border-radius: 10px; padding: 14px 18px; font-size: 12px; line-height: 20px; color: #475467; }
    .legend b { color: #101828; }
</style>
</head>
<body>
<div class="page">
    <nav class="nav">
        <h1>邮件模板预览</h1>
        <p>共 ${cases.length} 个模板，直接用 <code>EmailService</code> 渲染的真实 HTML。</p>
        ${nav}
    </nav>
    <div class="content">
        <div class="legend">
            <b>品牌配置</b>：站点名 <code>${branding.siteName}</code> · 支持邮箱 <code>${branding.supportEmail}</code> · Logo 为内置 Beaconix 图（内联 data URI）<br />
            <b>版式</b>：16 个模板共用同一套版式（浅灰底 + 品牌头 + 蓝色细线 + 白色内容卡 + 落款 + 居中页脚）；区别只在正文内容——标记「通知」的是事件告知，标记「交互」的是需要用户操作的（按钮 / 验证码 / 邀请码）。<br />
            <b>说明</b>：示例数据仅用于预览，实际内容由各业务场景填充。
        </div>
        ${sections}
    </div>
</div>
</body>
</html>
`,
);
console.log('written: docs/email-preview.html');

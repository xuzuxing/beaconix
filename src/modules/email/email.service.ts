import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Resend } from 'resend';
import { EmailTemplate } from './email.types';
import type { EmailPayloadMap } from './email.types';
import {
    MailTransport,
    ResendMailTransport,
    SmtpMailTransport,
    SmtpSettings,
} from './mail-transport';
import type { AppConfig, ResendConfig } from '../../config';
import { escapeHtml } from '../../common/utils/otp.util';
import { SettingsService } from '../settings';
import { BUILTIN_LOGO_DATA_URI } from './email-logo';

/** 邮件版式使用的站点品牌信息，来自平台配置的 `system.*` */
export interface EmailBranding {
    siteName: string;
    supportEmail: string;
    /** 站点 Logo 地址；`system.logoUrl` 为空时是内置 PNG 的 data URI */
    logoUrl: string;
}

/** 一次发送选定的通道与发件人 */
export interface MailRoute {
    transport: MailTransport;
    fromAddress: string;
}

/** 邮件版式共用的配色 */
const NOTIFY_COLORS = {
    primary: '#00a4ff',
    heading: '#13181d',
    text: '#333333',
    muted: '#999999',
    border: '#cccccc',
    danger: '#e54545',
} as const;

@Injectable()
export class EmailService {
    private readonly logger = new Logger(EmailService.name);
    private readonly fromEmail: string;
    /** `system.siteName` 缺失时的兜底显示名（`RESEND_FROM_NAME`） */
    private readonly defaultSiteName: string;
    private readonly isDevelopment: boolean;
    /** Web client base URL, without a trailing slash. */
    private readonly webUrl: string;

    constructor(
        @Inject('RESEND_CLIENT') private readonly resend: Resend,
        private readonly configService: ConfigService,
        private readonly settingsService: SettingsService,
    ) {
        const appCfg = this.configService.get<AppConfig>('app')!;
        const resendCfg = this.configService.get<ResendConfig>('resend')!;
        this.fromEmail = resendCfg.fromEmail;
        this.defaultSiteName = resendCfg.fromName;
        this.isDevelopment = appCfg.isDevelopment;
        this.webUrl = appCfg.webUrl.replace(/\/+$/, '');

        if (this.isDevelopment) {
            this.logger.log(
                'Email dev mode is enabled; emails will be printed to stdout.',
            );
        }
    }

    async send<T extends EmailTemplate>(
        template: T,
        payload: EmailPayloadMap[T],
        idempotencyKey?: string,
    ): Promise<void> {
        const to = (payload as Record<string, unknown>).to as string;
        const branding = await this.branding();
        const { subject, html } = this.buildEmail(template, payload, branding);
        const masked = to.replace(/^(..)[^@]*/, '$1***');
        const route = await this.route(branding);

        if (this.isDevelopment) {
            this.printToConsole(template, to, subject, html, payload, {
                from: route.fromAddress,
                transport: route.transport.name,
            });
            return;
        }

        this.logger.log(
            `Sending "${template}" email to "${masked}" via ${route.transport.name}`,
        );

        let messageId: string | undefined;
        try {
            messageId = await route.transport.send(
                {
                    from: route.fromAddress,
                    to,
                    subject,
                    html,
                },
                idempotencyKey,
            );
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error);
            this.logger.error(
                `Failed to send "${template}" email to "${masked}" via ${route.transport.name}: ${reason}`,
            );
            throw new Error(`Email send failed: ${reason}`, { cause: error });
        }

        this.logger.log(
            `Email "${template}" sent to "${masked}" via ${route.transport.name}${messageId ? ` (id: ${messageId})` : ''}`,
        );
    }

    /**
     * Dev mode: never hits Resend — prints the rendered email to the console so
     * it can be inspected (e.g. to grab a verification code or an invite link).
     */
    private printToConsole<T extends EmailTemplate>(
        template: T,
        to: string,
        subject: string,
        html: string,
        payload: EmailPayloadMap[T],
        route: { from: string; transport: MailTransport['name'] },
    ): void {
        const divider = '-'.repeat(72);
        // Use console.log directly so dev-mode emails are visible even when
        // Nest logger output is filtered or redirected by the runner.
        console.log(
            [
                '',
                divider,
                `[DEV] "${template}" email NOT sent — console output instead`,
                divider,
                `To:      ${to}`,
                `From:    ${route.from}`,
                `Via:     ${route.transport}`,
                `Subject: ${subject}`,
                `Payload: ${JSON.stringify(payload)}`,
                divider,
                html,
                divider,
                '',
            ].join('\n'),
        );
    }

    /**
     * 站点品牌信息：平台配置优先，未配置或读取失败时回退到环境变量兜底，
     * 不让「读配置失败」把发信整条链路带崩。
     */
    private async branding(): Promise<EmailBranding> {
        try {
            const [siteName, supportEmail, logoUrl] = await Promise.all([
                this.settingsService.getString(
                    'system.siteName',
                    this.defaultSiteName,
                ),
                this.settingsService.getString('system.supportEmail', ''),
                this.settingsService.getString('system.logoUrl', ''),
            ]);

            return {
                siteName: siteName.trim() || this.defaultSiteName,
                supportEmail: supportEmail.trim(),
                logoUrl: logoUrl.trim() || BUILTIN_LOGO_DATA_URI,
            };
        } catch (error) {
            this.logger.warn(
                `Failed to resolve email branding, falling back to environment defaults: ${String(error)}`,
            );
            return {
                siteName: this.defaultSiteName,
                supportEmail: '',
                logoUrl: BUILTIN_LOGO_DATA_URI,
            };
        }
    }

    /**
     * 通道选择：`smtp.host` 非空即走自建 SMTP，否则用 Resend。
     * 读配置失败（例如库不可用）时回退 Resend，不让发信整条链路断掉。
     */
    private async route(branding: EmailBranding): Promise<MailRoute> {
        let smtp: SmtpSettings | null = null;
        try {
            smtp = await this.smtpSettings();
        } catch (error) {
            this.logger.warn(
                `Failed to read SMTP settings, falling back to Resend: ${String(error)}`,
            );
        }

        if (!smtp) {
            return {
                transport: new ResendMailTransport(this.resend),
                fromAddress: this.formatFrom(branding.siteName, this.fromEmail),
            };
        }

        return {
            transport: new SmtpMailTransport(smtp),
            fromAddress: this.formatFrom(
                branding.siteName,
                smtp.fromAddress || smtp.account || this.fromEmail,
            ),
        };
    }

    /** 读取 `smtp.*`；`smtp.host` 留空表示没有配置自建 SMTP */
    private async smtpSettings(): Promise<SmtpSettings | null> {
        const host = (
            await this.settingsService.getString('smtp.host', '')
        ).trim();
        if (!host) return null;

        const [port, secure, account, password, fromAddress] =
            await Promise.all([
                this.settingsService.getNumber('smtp.port', 587),
                this.settingsService.getBoolean('smtp.secure', false),
                this.settingsService.getString('smtp.account', ''),
                this.settingsService.getString('smtp.password', ''),
                this.settingsService.getString('smtp.fromAddress', ''),
            ]);

        return {
            host,
            port,
            secure,
            account: account.trim(),
            // 密码只可能是从服务商后台复制粘贴来的；带上首尾空白（尤其末尾
            // 换行）时，服务商统一回 526/535 认证失败，从日志里完全看不出是
            // 空格导致的，所以在使用前去掉。
            password: password.trim(),
            fromAddress: fromAddress.trim(),
        };
    }

    /**
     * 组装 `显示名 <地址>`。两部分都来自可编辑配置，先剥掉 CR/LF，
     * 避免邮件头注入。
     */
    private formatFrom(siteName: string, email: string): string {
        const safeName = siteName.replace(/[\r\n]+/g, ' ').trim();
        const safeEmail = email.replace(/[\r\n]+/g, '').trim();
        return `${safeName} <${safeEmail}>`;
    }

    /**
     * 全站邮件统一的版式：浅灰底 (#f7f8fa) + 品牌头 + 蓝色细线 + 白色内容卡
     * + 居中页脚。全部用表格 + 内联样式，兼容主流邮件客户端。
     * 左右留白靠 3% / 3.2% 的空单元格，而不是 margin —— QQ 邮箱、Outlook
     * 对 `margin:auto` 的居中支持不一致，用表格天然可靠。
     */
    private wrapNotificationLayout(
        body: string,
        branding: EmailBranding,
    ): string {
        const siteName = escapeHtml(branding.siteName);
        const supportEmail = escapeHtml(branding.supportEmail);
        const contact = supportEmail
            ? `如需帮助，请联系 <a href="mailto:${supportEmail}" style="color: ${NOTIFY_COLORS.primary}; text-decoration: none;">${supportEmail}</a>。`
            : '';
        const fontFamily =
            "'helvetica neue', PingFangSC-Light, arial, 'microsoft yahei ui', 'microsoft yahei', simsun, sans-serif";

        return `
            <div style="word-break: break-all; box-sizing: border-box; text-align: center; min-width: 320px; max-width: 660px; border: 1px solid #f6f6f6; background-color: #f7f8fa; margin: 0 auto; padding: 20px 0 30px; font-family: ${fontFamily};">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-weight: 300; margin-bottom: 10px; border-collapse: collapse;">
                    <tr>
                        <td style="width: 3%; max-width: 30px;"></td>
                        <td style="max-width: 600px;">
                            <a href="${escapeHtml(this.webUrl)}" target="_blank" style="text-decoration: none;">
                                <img border="0" src="${escapeHtml(branding.logoUrl)}" alt="${siteName}" height="36" style="height: 36px; max-width: 200px; width: auto; display: block;" />
                            </a>
                            <p style="height: 2px; background-color: ${NOTIFY_COLORS.primary}; border: 0; font-size: 0; padding: 0; width: 100%; margin: 20px 0 0;"></p>
                            <div style="background-color: #ffffff; padding: 23px 0 20px; box-shadow: 0 1px 1px 0 rgba(122, 55, 55, 0.2); text-align: left;">
                                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-weight: 300; margin-bottom: 10px; border-collapse: collapse; text-align: left;">
                                    <tr>
                                        <td style="width: 3.2%; max-width: 30px;"></td>
                                        <td style="max-width: 480px; text-align: left;">${body}</td>
                                        <td style="width: 3.2%; max-width: 30px;"></td>
                                    </tr>
                                </table>
                            </div>
                            <div style="text-align: center; font-size: 12px; line-height: 18px; color: ${NOTIFY_COLORS.muted};">
                                <p style="text-align: center; margin: 20px auto 14px; font-size: 12px; color: ${NOTIFY_COLORS.muted};">此为系统邮件，请勿直接回复。${contact}</p>
                                <p style="max-width: 100%; margin: 0 auto; font-size: 12px; color: ${NOTIFY_COLORS.muted}; text-align: center; line-height: 22px;">Copyright &copy; ${new Date().getFullYear()} ${siteName}.<br />All Rights Reserved.</p>
                            </div>
                        </td>
                        <td style="width: 3%; max-width: 30px;"></td>
                    </tr>
                </table>
            </div>`;
    }

    /** 通知正文标题（20px 粗体，与卡片上沿留出 16px） */
    private noticeTitle(text: string): string {
        return `<h1 style="font-weight: bold; font-size: 20px; line-height: 36px; margin: 0 0 16px; color: ${NOTIFY_COLORS.heading};">${text}</h1>`;
    }

    /** 通知正文称呼行 */
    private greeting(name?: string): string {
        const who = name ? `，${name}` : '';
        return `<p style="font-size: 14px; color: ${NOTIFY_COLORS.text}; line-height: 24px; margin: 0;">您好${who}！</p>`;
    }

    /** 通知正文段落，段间距 6px、长串强制断行 */
    private paragraph(html: string): string {
        return `<p style="font-size: 14px; color: ${NOTIFY_COLORS.text}; line-height: 24px; margin: 6px 0 0; overflow-wrap: break-word; word-break: break-all;">${html}</p>`;
    }

    /** 次要提示（12px 灰）/ 风险提示（12px 红） */
    private noticeHint(
        html: string,
        tone: 'muted' | 'danger' = 'muted',
    ): string {
        const color =
            tone === 'danger' ? NOTIFY_COLORS.danger : NOTIFY_COLORS.muted;
        return `<p style="font-size: 12px; color: ${color}; line-height: 22px; margin: 12px 0 0;">${html}</p>`;
    }

    /** 键值数据表：1px 灰边、标签列浅灰底 */
    private dataTable(rows: Array<[string, string]>): string {
        const cells = rows
            .map(
                ([label, value]) =>
                    `<tr><td style="padding: 5px; border: 1px solid ${NOTIFY_COLORS.border}; background-color: #f7f8fa; color: #666666; width: 32%;">${label}</td><td style="padding: 5px; border: 1px solid ${NOTIFY_COLORS.border};">${value}</td></tr>`,
            )
            .join('');
        return `<table cellpadding="5" cellspacing="0" border="1" bordercolor="${NOTIFY_COLORS.border}" style="font-size: 14px; table-layout: fixed; word-break: break-word; width: 100%; border-collapse: collapse; margin-top: 16px;">${cells}</table>`;
    }

    /** 通栏主按钮：16px / 45px 行高 / 3px 圆角 */
    private button(label: string, url: string): string {
        return `<p style="margin: 20px 0 0;"><a href="${url}" target="_blank" style="font-size: 16px; line-height: 45px; display: block; background-color: ${NOTIFY_COLORS.primary}; color: #ffffff; text-align: center; text-decoration: none; border-radius: 3px;">${label}</a></p>`;
    }

    /** 引用块，用于工单回复等引用内容 */
    private quote(html: string): string {
        return `<div style="font-size: 14px; line-height: 24px; color: ${NOTIFY_COLORS.text}; margin: 16px 0 0; padding: 12px 16px; background-color: #f7f8fa; border-left: 3px solid ${NOTIFY_COLORS.primary}; overflow-wrap: break-word; word-break: break-all;">${html}</div>`;
    }

    /** 正文落款，通知类邮件统一追加在正文末尾 */
    private signOff(siteName: string): string {
        return `<p style="font-size: 14px; line-height: 26px; margin: 32px 0 0; word-wrap: break-word; word-break: break-all;">此致<br /><strong>${siteName} 团队</strong></p>`;
    }

    /** 分割线：正文里区分「主操作」与「备用方式」 */
    private divider(): string {
        return `<p style="height: 1px; background-color: ${NOTIFY_COLORS.border}; border: 0; font-size: 0; padding: 0; width: 100%; margin: 20px 0 0; opacity: 0.6;"></p>`;
    }

    /** 验证码：居中大号等宽数字块 */
    private codeBlock(code: string): string {
        return `<div style="margin: 16px 0 0; padding: 16px 0; background-color: #f7f8fa; border: 1px solid #eaedf0; border-radius: 3px; text-align: center;"><span style="font-family: Consolas, Menlo, 'Courier New', monospace; font-size: 26px; font-weight: bold; letter-spacing: 6px; color: ${NOTIFY_COLORS.heading};">${code}</span></div>`;
    }

    /** 长文本块（邀请链接、邀请码）：等宽小字 + 强断行 */
    private plainBlock(text: string): string {
        return `<div style="margin: 8px 0 0; padding: 10px 12px; background-color: #f7f8fa; border: 1px solid #eaedf0; border-radius: 3px; font-family: Consolas, Menlo, 'Courier New', monospace; font-size: 13px; line-height: 22px; color: #475467; overflow-wrap: break-word; word-break: break-all;">${text}</div>`;
    }

    private buildEmail<T extends EmailTemplate>(
        template: T,
        payload: EmailPayloadMap[T],
        branding: EmailBranding,
    ): { subject: string; html: string } {
        let result: { subject: string; html: string };

        switch (template) {
            case EmailTemplate.NOTIFICATION: {
                const notice =
                    payload as EmailPayloadMap[EmailTemplate.NOTIFICATION];
                result = {
                    subject: notice.title,
                    html: [
                        this.noticeTitle(escapeHtml(notice.title)),
                        this.greeting(),
                        this.paragraph(
                            escapeHtml(notice.body).replace(/\n/g, '<br />'),
                        ),
                    ].join(''),
                };
                break;
            }
            case EmailTemplate.INVITATION:
                result = this.buildInvitationEmail(
                    payload as EmailPayloadMap[EmailTemplate.INVITATION],
                    escapeHtml(branding.siteName),
                );
                break;
            case EmailTemplate.WELCOME:
                result = this.buildWelcomeEmail(
                    payload as EmailPayloadMap[EmailTemplate.WELCOME],
                    escapeHtml(branding.siteName),
                );
                break;
            case EmailTemplate.PASSWORD_RESET:
                result = this.buildPasswordResetEmail(
                    payload as EmailPayloadMap[EmailTemplate.PASSWORD_RESET],
                );
                break;
            case EmailTemplate.TASK_ASSIGNED:
                result = this.buildTaskAssignedEmail(
                    payload as EmailPayloadMap[EmailTemplate.TASK_ASSIGNED],
                );
                break;
            case EmailTemplate.TASK_DUE_SOON:
                result = this.buildTaskDueSoonEmail(
                    payload as EmailPayloadMap[EmailTemplate.TASK_DUE_SOON],
                );
                break;
            case EmailTemplate.TASK_OVERDUE:
                result = this.buildTaskOverdueEmail(
                    payload as EmailPayloadMap[EmailTemplate.TASK_OVERDUE],
                );
                break;
            case EmailTemplate.EMAIL_VERIFICATION:
                result = this.buildEmailVerificationEmail(
                    payload as EmailPayloadMap[EmailTemplate.EMAIL_VERIFICATION],
                    escapeHtml(branding.siteName),
                );
                break;
            case EmailTemplate.PASSWORD_RESET_OTP:
                result = this.buildPasswordResetOtpEmail(
                    payload as EmailPayloadMap[EmailTemplate.PASSWORD_RESET_OTP],
                );
                break;
            case EmailTemplate.MONITOR_DOWN:
                result = this.buildMonitorDownEmail(
                    payload as EmailPayloadMap[EmailTemplate.MONITOR_DOWN],
                );
                break;
            case EmailTemplate.MONITOR_RECOVER:
                result = this.buildMonitorRecoverEmail(
                    payload as EmailPayloadMap[EmailTemplate.MONITOR_RECOVER],
                );
                break;
            case EmailTemplate.TWO_FACTOR_ENABLED:
                result = this.buildTwoFactorEnabledEmail(
                    payload as EmailPayloadMap[EmailTemplate.TWO_FACTOR_ENABLED],
                );
                break;
            case EmailTemplate.TWO_FACTOR_DISABLED:
                result = this.buildTwoFactorDisabledEmail(
                    payload as EmailPayloadMap[EmailTemplate.TWO_FACTOR_DISABLED],
                );
                break;
            case EmailTemplate.TWO_FACTOR_RECOVERY_CODE_USED:
                result = this.buildRecoveryCodeUsedEmail(
                    payload as EmailPayloadMap[EmailTemplate.TWO_FACTOR_RECOVERY_CODE_USED],
                );
                break;
            case EmailTemplate.TICKET_REPLIED:
                result = this.buildTicketRepliedEmail(
                    payload as EmailPayloadMap[EmailTemplate.TICKET_REPLIED],
                );
                break;
            case EmailTemplate.TICKET_STATUS_CHANGED:
                result = this.buildTicketStatusChangedEmail(
                    payload as EmailPayloadMap[EmailTemplate.TICKET_STATUS_CHANGED],
                );
                break;
            default:
                throw new Error(`Unknown email template: ${String(template)}`);
        }

        return {
            subject: result.subject,
            html: this.wrapNotificationLayout(
                result.html + this.signOff(escapeHtml(branding.siteName)),
                branding,
            ),
        };
    }

    private buildInvitationEmail(
        payload: EmailPayloadMap[EmailTemplate.INVITATION],
        siteName: string,
    ) {
        const orgName = escapeHtml(payload.orgName);
        const inviterName = escapeHtml(payload.inviterName);
        const token = escapeHtml(payload.token);
        const inviteUrl = escapeHtml(
            `${this.webUrl}/invitations/${payload.token}`,
        );
        return {
            subject: `邀请你加入「${payload.orgName}」`,
            html: [
                this.noticeTitle('组织邀请'),
                this.greeting(),
                this.paragraph(
                    `<strong>${inviterName}</strong> 邀请你加入 <strong>${orgName}</strong>，接受后即可参与该组织的项目与协作。`,
                ),
                this.button('接受邀请', inviteUrl),
                this.divider(),
                this.paragraph(
                    '如果按钮无法点击，请复制以下链接到浏览器打开：',
                ),
                this.plainBlock(inviteUrl),
                this.paragraph('也可以使用以下邀请码接受邀请：'),
                this.plainBlock(token),
                this.noticeHint(
                    `本邀请由 ${siteName} 发出。如果这不是你预期的邀请，忽略这封邮件即可。`,
                ),
            ].join(''),
        };
    }

    private buildWelcomeEmail(
        payload: EmailPayloadMap[EmailTemplate.WELCOME],
        siteName: string,
    ) {
        const name = escapeHtml(payload.name);
        const orgName = escapeHtml(payload.orgName);
        return {
            subject: `欢迎加入「${payload.orgName}」`,
            html: [
                this.noticeTitle('欢迎加入'),
                this.greeting(name),
                this.paragraph(
                    `你已成功加入 <strong>${orgName}</strong>，现在可以协同管理项目、跟踪任务进度，并查看监控与告警。`,
                ),
                this.noticeHint(
                    `如需帮助，可随时联系 ${siteName} 的支持团队。`,
                ),
            ].join(''),
        };
    }

    private buildPasswordResetEmail(
        payload: EmailPayloadMap[EmailTemplate.PASSWORD_RESET],
    ) {
        const name = escapeHtml(payload.name);
        const resetUrl = escapeHtml(payload.resetUrl);
        return {
            subject: '重置密码',
            html: [
                this.noticeTitle('重置密码'),
                this.greeting(name),
                this.paragraph(
                    '我们收到了重置账号密码的请求。点击下方按钮即可设置新密码：',
                ),
                this.button('重置密码', resetUrl),
                this.divider(),
                this.paragraph(
                    '如果按钮无法点击，请复制以下链接到浏览器打开：',
                ),
                this.plainBlock(resetUrl),
                this.noticeHint(
                    '如果不是你本人操作，忽略这封邮件即可，账号密码不会发生变更。',
                    'danger',
                ),
            ].join(''),
        };
    }

    private buildTaskAssignedEmail(
        payload: EmailPayloadMap[EmailTemplate.TASK_ASSIGNED],
    ) {
        const name = escapeHtml(payload.name);
        const taskTitle = escapeHtml(payload.taskTitle);
        const taskUrl = escapeHtml(payload.taskUrl);
        return {
            subject: `新任务指派：${payload.taskTitle}`,
            html: [
                this.noticeTitle('新任务指派'),
                this.greeting(name),
                this.paragraph(
                    `有一项新任务已指派给您：<strong>${taskTitle}</strong>。`,
                ),
                this.button('查看任务详情', taskUrl),
                this.noticeHint(
                    '请登录工作台查看任务要求与截止时间，并及时更新任务状态。',
                ),
            ].join(''),
        };
    }

    private buildTaskDueSoonEmail(
        payload: EmailPayloadMap[EmailTemplate.TASK_DUE_SOON],
    ) {
        const name = escapeHtml(payload.name);
        const taskTitle = escapeHtml(payload.taskTitle);
        const projectKey = escapeHtml(payload.projectKey);
        const dueDate = escapeHtml(payload.dueDate);
        return {
            subject: `任务即将到期：${payload.taskTitle}`,
            html: [
                this.noticeTitle('任务即将到期'),
                this.greeting(name),
                this.paragraph('您有一项任务即将到达截止时间，请及时处理。'),
                this.dataTable([
                    ['任务编号', `${projectKey}-${payload.taskNumber}`],
                    ['任务名称', taskTitle],
                    ['到期时间', dueDate],
                ]),
                this.noticeHint(
                    '如无法按期完成，建议提前与项目负责人沟通并调整排期。',
                ),
            ].join(''),
        };
    }

    private buildTaskOverdueEmail(
        payload: EmailPayloadMap[EmailTemplate.TASK_OVERDUE],
    ) {
        const name = escapeHtml(payload.name);
        const taskTitle = escapeHtml(payload.taskTitle);
        const projectKey = escapeHtml(payload.projectKey);
        const dueDate = escapeHtml(payload.dueDate);
        return {
            subject: `任务已逾期：${payload.taskTitle}`,
            html: [
                this.noticeTitle('任务已逾期'),
                this.greeting(name),
                this.paragraph(
                    '您有一项任务已超过截止时间仍未完成，请尽快处理。',
                ),
                this.dataTable([
                    ['任务编号', `${projectKey}-${payload.taskNumber}`],
                    ['任务名称', taskTitle],
                    ['到期时间', dueDate],
                ]),
                this.noticeHint(
                    '若任务已完成，请及时在系统中更新状态，以免影响项目进度统计。',
                    'danger',
                ),
            ].join(''),
        };
    }

    private buildEmailVerificationEmail(
        payload: EmailPayloadMap[EmailTemplate.EMAIL_VERIFICATION],
        siteName: string,
    ) {
        const name = escapeHtml(payload.name);
        const code = escapeHtml(payload.code);
        return {
            subject: '邮箱验证码',
            html: [
                this.noticeTitle('邮箱验证'),
                this.greeting(name),
                this.paragraph(
                    `感谢注册 ${siteName}。请使用以下验证码完成邮箱验证：`,
                ),
                this.codeBlock(code),
                this.noticeHint(
                    `验证码 ${payload.expiresInMinutes} 分钟内有效。如果不是你本人操作，忽略这封邮件即可。`,
                ),
            ].join(''),
        };
    }

    private buildPasswordResetOtpEmail(
        payload: EmailPayloadMap[EmailTemplate.PASSWORD_RESET_OTP],
    ) {
        const name = escapeHtml(payload.name);
        const code = escapeHtml(payload.code);
        return {
            subject: '密码重置验证码',
            html: [
                this.noticeTitle('重置密码'),
                this.greeting(name),
                this.paragraph(
                    '我们收到了重置账号密码的请求。请使用以下验证码继续操作：',
                ),
                this.codeBlock(code),
                this.noticeHint(
                    `验证码 ${payload.expiresInMinutes} 分钟内有效。如果不是你本人操作，忽略这封邮件即可，账号密码不会发生变更。`,
                    'danger',
                ),
            ].join(''),
        };
    }

    private buildMonitorDownEmail(
        payload: EmailPayloadMap[EmailTemplate.MONITOR_DOWN],
    ) {
        const monitorName = escapeHtml(payload.monitorName);
        const target = escapeHtml(payload.target);
        const previousStatus = escapeHtml(payload.previousStatus);
        const status = escapeHtml(payload.status);
        const error = escapeHtml(payload.error);
        const latency = escapeHtml(payload.latency);
        const checkedAt = escapeHtml(payload.checkedAt);
        return {
            subject: `【${payload.status}】${payload.monitorName} 监控告警`,
            html: [
                this.noticeTitle('监控告警'),
                this.greeting(),
                this.paragraph(
                    `监控项 <strong>${monitorName}</strong> 状态异常（当前 <strong>${status}</strong>，此前为 ${previousStatus}）。`,
                ),
                this.dataTable([
                    ['监控目标', target],
                    ['响应耗时', latency],
                    ['错误信息', error],
                    ['检测时间', checkedAt],
                ]),
                this.noticeHint(
                    '请尽快排查服务可用性；恢复正常后系统会再次发送通知。',
                ),
            ].join(''),
        };
    }

    private buildMonitorRecoverEmail(
        payload: EmailPayloadMap[EmailTemplate.MONITOR_RECOVER],
    ) {
        const monitorName = escapeHtml(payload.monitorName);
        const target = escapeHtml(payload.target);
        const previousStatus = escapeHtml(payload.previousStatus);
        const status = escapeHtml(payload.status);
        const latency = escapeHtml(payload.latency);
        const checkedAt = escapeHtml(payload.checkedAt);
        return {
            subject: `【恢复】${payload.monitorName} 已恢复正常`,
            html: [
                this.noticeTitle('服务已恢复'),
                this.greeting(),
                this.paragraph(
                    `监控项 <strong>${monitorName}</strong> 已恢复正常（当前 <strong>${status}</strong>，此前为 ${previousStatus}）。`,
                ),
                this.dataTable([
                    ['监控目标', target],
                    ['响应耗时', latency],
                    ['检测时间', checkedAt],
                ]),
                this.noticeHint(
                    '本条为恢复通知，如仍有异常请复核监控配置与目标服务。',
                ),
            ].join(''),
        };
    }

    private buildTwoFactorEnabledEmail(
        payload: EmailPayloadMap[EmailTemplate.TWO_FACTOR_ENABLED],
    ) {
        const name = escapeHtml(payload.name);
        const changedAt = escapeHtml(payload.changedAt);
        return {
            subject: '两步验证已开启',
            html: [
                this.noticeTitle('两步验证已开启'),
                this.greeting(name),
                this.paragraph(
                    '您的账号已成功开启两步验证，登录时将需要额外的动态验证码。',
                ),
                this.dataTable([['操作时间', changedAt]]),
                this.noticeHint(
                    '如果这不是您本人的操作，请立即重置密码并联系管理员。',
                    'danger',
                ),
            ].join(''),
        };
    }

    private buildTwoFactorDisabledEmail(
        payload: EmailPayloadMap[EmailTemplate.TWO_FACTOR_DISABLED],
    ) {
        const name = escapeHtml(payload.name);
        const changedAt = escapeHtml(payload.changedAt);
        return {
            subject: '两步验证已关闭',
            html: [
                this.noticeTitle('两步验证已关闭'),
                this.greeting(name),
                this.paragraph(
                    '您的账号已关闭两步验证，账号安全等级将随之降低。',
                ),
                this.dataTable([['操作时间', changedAt]]),
                this.noticeHint(
                    '如果这不是您本人的操作，请立即重置密码并重新开启两步验证。',
                    'danger',
                ),
            ].join(''),
        };
    }

    private buildRecoveryCodeUsedEmail(
        payload: EmailPayloadMap[EmailTemplate.TWO_FACTOR_RECOVERY_CODE_USED],
    ) {
        const name = escapeHtml(payload.name);
        const usedAt = escapeHtml(payload.usedAt);
        const ipAddress = escapeHtml(payload.ipAddress);
        return {
            subject: '两步验证恢复码已被使用',
            html: [
                this.noticeTitle('恢复码已被使用'),
                this.greeting(name),
                this.paragraph(
                    '您的账号刚刚使用了一次两步验证恢复码登录，请确认是否为本人操作。',
                ),
                this.dataTable([
                    ['使用时间', usedAt],
                    ['IP 地址', ipAddress],
                ]),
                this.noticeHint(
                    '如果这不是您本人的操作，请立即重置密码并重新生成恢复码。',
                    'danger',
                ),
            ].join(''),
        };
    }

    private buildTicketRepliedEmail(
        payload: EmailPayloadMap[EmailTemplate.TICKET_REPLIED],
    ) {
        const name = escapeHtml(payload.name);
        const subject = escapeHtml(payload.subject);
        const body = escapeHtml(payload.body).replace(/\n/g, '<br />');
        const ticketUrl = escapeHtml(payload.ticketUrl);
        return {
            subject: `工单 #${payload.ticketNumber} 有新回复`,
            html: [
                this.noticeTitle('工单有新回复'),
                this.greeting(name),
                this.paragraph(
                    `支持团队回复了您的工单 <strong>#${payload.ticketNumber} ${subject}</strong>：`,
                ),
                this.quote(body),
                this.button('查看工单', ticketUrl),
                this.noticeHint('如需继续沟通，请直接在工单页面回复。'),
            ].join(''),
        };
    }

    private buildTicketStatusChangedEmail(
        payload: EmailPayloadMap[EmailTemplate.TICKET_STATUS_CHANGED],
    ) {
        const name = escapeHtml(payload.name);
        const subject = escapeHtml(payload.subject);
        const status = escapeHtml(payload.status);
        const statusText =
            payload.status === 'RESOLVED'
                ? '已解决'
                : payload.status === 'CLOSED'
                  ? '已关闭'
                  : status;
        const ticketUrl = escapeHtml(payload.ticketUrl);
        return {
            subject: `工单 #${payload.ticketNumber} ${statusText}`,
            html: [
                this.noticeTitle('工单状态更新'),
                this.greeting(name),
                this.paragraph(
                    `您的工单状态已变更为 <strong>${statusText}</strong>。`,
                ),
                this.dataTable([
                    ['工单编号', `<strong>#${payload.ticketNumber}</strong>`],
                    ['工单标题', subject],
                    ['当前状态', statusText],
                ]),
                this.button('查看工单', ticketUrl),
                this.noticeHint(
                    '如果问题仍未解决，可在工单中继续回复，工单将重新打开。',
                ),
            ].join(''),
        };
    }
}

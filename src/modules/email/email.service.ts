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

/** 邮件版式使用的站点品牌信息，来自平台配置的 `system.*` */
export interface EmailBranding {
    siteName: string;
    supportEmail: string;
}

/** 一次发送选定的通道与发件人 */
export interface MailRoute {
    transport: MailTransport;
    fromAddress: string;
}

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
            const [siteName, supportEmail] = await Promise.all([
                this.settingsService.getString(
                    'system.siteName',
                    this.defaultSiteName,
                ),
                this.settingsService.getString('system.supportEmail', ''),
            ]);

            return {
                siteName: siteName.trim() || this.defaultSiteName,
                supportEmail: supportEmail.trim(),
            };
        } catch (error) {
            this.logger.warn(
                `Failed to resolve email branding, falling back to environment defaults: ${String(error)}`,
            );
            return { siteName: this.defaultSiteName, supportEmail: '' };
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

    private readonly logoUrl =
        'https://0dmx1q3s0v.ufs.sh/f/FhSkiVUnN75kwe9Bf1c3QUqFZpGr2Xd9WySPfb4NCtVKmcJv';

    private wrapInLayout(body: string, branding: EmailBranding): string {
        const siteName = escapeHtml(branding.siteName);
        const contact = branding.supportEmail
            ? `<p style="color: #9ca3af; font-size: 12px; margin: 8px 0 0;">Contact: <a href="mailto:${escapeHtml(branding.supportEmail)}" style="color: #6366F1;">${escapeHtml(branding.supportEmail)}</a></p>`
            : '';
        return `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb;">
                <div style="background: linear-gradient(135deg, #4F46E5 0%, #6366F1 100%); padding: 32px 24px; text-align: center;">
                    <img src="${this.logoUrl}" alt="${siteName}" width="48" height="48" style="border-radius: 10px; margin-bottom: 12px;" />
                    <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 600;">${siteName}</h1>
                </div>
                <div style="padding: 32px 24px;">
                    ${body}
                </div>
                <div style="padding: 16px 24px; background: #f9fafb; text-align: center; border-top: 1px solid #e5e7eb;">
                    <p style="color: #9ca3af; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} ${siteName}. All rights reserved.</p>
                    ${contact}
                </div>
            </div>`;
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
                    html: `<h2>${escapeHtml(notice.title)}</h2><p>${escapeHtml(notice.body).replace(/\n/g, '<br/>')}</p>`,
                };
                break;
            }
            case EmailTemplate.INVITATION:
                result = this.buildInvitationEmail(
                    payload as EmailPayloadMap[EmailTemplate.INVITATION],
                );
                break;
            case EmailTemplate.WELCOME:
                result = this.buildWelcomeEmail(
                    payload as EmailPayloadMap[EmailTemplate.WELCOME],
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
            html: this.wrapInLayout(result.html, branding),
        };
    }

    private buildInvitationEmail(
        payload: EmailPayloadMap[EmailTemplate.INVITATION],
    ) {
        const orgName = escapeHtml(payload.orgName);
        const inviterName = escapeHtml(payload.inviterName);
        const token = escapeHtml(payload.token);
        const inviteUrl = escapeHtml(
            `${this.webUrl}/invitations/${payload.token}`,
        );
        return {
            subject: `You've been invited to join ${payload.orgName}`,
            html: `
                <h2>You're invited!</h2>
                <p><strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> on Beacon.</p>
                <p><a href="${inviteUrl}" style="background:#4F46E5; color:#fff; padding:10px 20px; text-decoration:none; border-radius:6px; display:inline-block;">Accept Invitation</a></p>
                <p>Or open this link in your browser:<br/><span style="word-break:break-all;">${inviteUrl}</span></p>
                <p>You can also use the following token to accept your invitation:</p>
                <p style="font-size:18px; font-weight:bold; background:#f4f4f4; padding:12px; border-radius:6px; display:inline-block;">${token}</p>
                <br/><p>If you didn't expect this invitation, you can safely ignore this email.</p>
            `,
        };
    }

    private buildWelcomeEmail(payload: EmailPayloadMap[EmailTemplate.WELCOME]) {
        const name = escapeHtml(payload.name);
        const orgName = escapeHtml(payload.orgName);
        return {
            subject: `Welcome to ${payload.orgName}!`,
            html: `
                <h2>Welcome, ${name}!</h2>
                <p>You've successfully joined <strong>${orgName}</strong> on Beacon.</p>
                <p>You can now collaborate with your team, manage projects, and track tasks.</p>
            `,
        };
    }

    private buildPasswordResetEmail(
        payload: EmailPayloadMap[EmailTemplate.PASSWORD_RESET],
    ) {
        const name = escapeHtml(payload.name);
        const resetUrl = escapeHtml(payload.resetUrl);
        return {
            subject: 'Reset your password',
            html: `
                <h2>Password Reset Request</h2>
                <p>Hi ${name},</p>
                <p>We received a request to reset your password. Click the link below to set a new password:</p>
                <p><a href="${resetUrl}" style="background:#4F46E5; color:#fff; padding:10px 20px; text-decoration:none; border-radius:6px; display:inline-block;">Reset Password</a></p>
                <p>If you didn't request this, you can safely ignore this email.</p>
            `,
        };
    }

    private buildTaskAssignedEmail(
        payload: EmailPayloadMap[EmailTemplate.TASK_ASSIGNED],
    ) {
        const name = escapeHtml(payload.name);
        const taskTitle = escapeHtml(payload.taskTitle);
        const taskUrl = escapeHtml(payload.taskUrl);
        return {
            subject: `Task assigned: ${payload.taskTitle}`,
            html: `
                <h2>New Task Assigned</h2>
                <p>Hi ${name},</p>
                <p>You've been assigned a new task: <strong>${taskTitle}</strong></p>
                <p><a href="${taskUrl}" style="background:#4F46E5; color:#fff; padding:10px 20px; text-decoration:none; border-radius:6px; display:inline-block;">View Task</a></p>
            `,
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
            subject: `Task due soon: ${payload.taskTitle}`,
            html: `
                <h2>Task Due Soon</h2>
                <p>Hi ${name},</p>
                <p>Your task <strong>${projectKey}-${payload.taskNumber} ${taskTitle}</strong> is due on <strong>${dueDate}</strong>.</p>
                <p>Please make sure to complete it before the deadline.</p>
            `,
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
            subject: `Task overdue: ${payload.taskTitle}`,
            html: `
                <h2>Task Overdue</h2>
                <p>Hi ${name},</p>
                <p>Your task <strong>${projectKey}-${payload.taskNumber} ${taskTitle}</strong> was due on <strong>${dueDate}</strong> and is now overdue.</p>
                <p>Please complete it as soon as possible.</p>
            `,
        };
    }

    private buildEmailVerificationEmail(
        payload: EmailPayloadMap[EmailTemplate.EMAIL_VERIFICATION],
    ) {
        const name = escapeHtml(payload.name);
        const code = escapeHtml(payload.code);
        return {
            subject: 'Verify your email address',
            html: `
                <h2>Email Verification</h2>
                <p>Hi ${name},</p>
                <p>Thank you for signing up for Beacon. Use the following code to verify your email address:</p>
                <div style="text-align: center; margin: 24px 0;">
                    <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; background: #f4f4f5; padding: 16px 32px; border-radius: 8px; display: inline-block; font-family: monospace;">${code}</span>
                </div>
                <p style="color: #6b7280; font-size: 14px;">This code expires in ${payload.expiresInMinutes} minutes. If you didn't create an account, you can safely ignore this email.</p>
            `,
        };
    }

    private buildPasswordResetOtpEmail(
        payload: EmailPayloadMap[EmailTemplate.PASSWORD_RESET_OTP],
    ) {
        const name = escapeHtml(payload.name);
        const code = escapeHtml(payload.code);
        return {
            subject: 'Reset your password',
            html: `
                <h2>Password Reset</h2>
                <p>Hi ${name},</p>
                <p>We received a request to reset your password. Use the following code to proceed:</p>
                <div style="text-align: center; margin: 24px 0;">
                    <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; background: #f4f4f5; padding: 16px 32px; border-radius: 8px; display: inline-block; font-family: monospace;">${code}</span>
                </div>
                <p style="color: #6b7280; font-size: 14px;">This code expires in ${payload.expiresInMinutes} minutes. If you didn't request a password reset, you can safely ignore this email.</p>
            `,
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
            subject: `[${payload.status}] ${payload.monitorName} is not healthy`,
            html: `
                <h2>Monitor alert</h2>
                <p><strong>${monitorName}</strong> reported <strong>${status}</strong> (was ${previousStatus}).</p>
                <table style="width:100%; border-collapse:collapse; font-size:14px;">
                    <tr><td style="padding:6px 0; color:#6b7280;">Target</td><td style="padding:6px 0;">${target}</td></tr>
                    <tr><td style="padding:6px 0; color:#6b7280;">Latency</td><td style="padding:6px 0;">${latency}</td></tr>
                    <tr><td style="padding:6px 0; color:#6b7280;">Error</td><td style="padding:6px 0;">${error}</td></tr>
                    <tr><td style="padding:6px 0; color:#6b7280;">Checked at</td><td style="padding:6px 0;">${checkedAt}</td></tr>
                </table>
            `,
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
            subject: `[RECOVERED] ${payload.monitorName} is back up`,
            html: `
                <h2>Monitor recovered</h2>
                <p><strong>${monitorName}</strong> is healthy again (<strong>${status}</strong>, was ${previousStatus}).</p>
                <table style="width:100%; border-collapse:collapse; font-size:14px;">
                    <tr><td style="padding:6px 0; color:#6b7280;">Target</td><td style="padding:6px 0;">${target}</td></tr>
                    <tr><td style="padding:6px 0; color:#6b7280;">Latency</td><td style="padding:6px 0;">${latency}</td></tr>
                    <tr><td style="padding:6px 0; color:#6b7280;">Checked at</td><td style="padding:6px 0;">${checkedAt}</td></tr>
                </table>
            `,
        };
    }

    private buildTwoFactorEnabledEmail(
        payload: EmailPayloadMap[EmailTemplate.TWO_FACTOR_ENABLED],
    ) {
        const name = escapeHtml(payload.name);
        const changedAt = escapeHtml(payload.changedAt);
        return {
            subject: 'Two-factor authentication enabled',
            html: `
                <h2>Two-factor authentication enabled</h2>
                <p>Hi ${name},</p>
                <p>Two-factor authentication was just <strong>enabled</strong> on your Beacon account.</p>
                <p style="color:#6b7280; font-size:14px;">Time: ${changedAt}</p>
                <p style="color:#dc2626; font-size:14px;">If this wasn't you, disable 2FA immediately and reset your password.</p>
            `,
        };
    }

    private buildTwoFactorDisabledEmail(
        payload: EmailPayloadMap[EmailTemplate.TWO_FACTOR_DISABLED],
    ) {
        const name = escapeHtml(payload.name);
        const changedAt = escapeHtml(payload.changedAt);
        return {
            subject: 'Two-factor authentication disabled',
            html: `
                <h2>Two-factor authentication disabled</h2>
                <p>Hi ${name},</p>
                <p>Two-factor authentication was just <strong>disabled</strong> on your Beacon account.</p>
                <p style="color:#6b7280; font-size:14px;">Time: ${changedAt}</p>
                <p style="color:#dc2626; font-size:14px;">If this wasn't you, re-enable 2FA and reset your password immediately.</p>
            `,
        };
    }

    private buildRecoveryCodeUsedEmail(
        payload: EmailPayloadMap[EmailTemplate.TWO_FACTOR_RECOVERY_CODE_USED],
    ) {
        const name = escapeHtml(payload.name);
        const usedAt = escapeHtml(payload.usedAt);
        const ipAddress = escapeHtml(payload.ipAddress);
        return {
            subject: 'A two-factor recovery code was used',
            html: `
                <h2>Recovery code used</h2>
                <p>Hi ${name},</p>
                <p>One of your two-factor recovery codes was just used to sign in. Please confirm this was you.</p>
                <table style="width:100%; border-collapse:collapse; font-size:14px;">
                    <tr><td style="padding:6px 0; color:#6b7280;">Time</td><td style="padding:6px 0;">${usedAt}</td></tr>
                    <tr><td style="padding:6px 0; color:#6b7280;">IP address</td><td style="padding:6px 0;">${ipAddress}</td></tr>
                </table>
                <p style="color:#dc2626; font-size:14px;">If this wasn't you, reset your password and regenerate your recovery codes immediately.</p>
            `,
        };
    }

    private buildTicketRepliedEmail(
        payload: EmailPayloadMap[EmailTemplate.TICKET_REPLIED],
    ) {
        const name = escapeHtml(payload.name);
        const subject = escapeHtml(payload.subject);
        const body = escapeHtml(payload.body).replace(/\n/g, '<br/>');
        const ticketUrl = escapeHtml(payload.ticketUrl);
        return {
            subject: `New reply on ticket #${payload.ticketNumber}`,
            html: `
                <h2>New reply on your ticket</h2>
                <p>Hi ${name},</p>
                <p>The support team replied to <strong>#${payload.ticketNumber} ${subject}</strong>:</p>
                <blockquote style="margin:16px 0; padding:12px 16px; background:#f9fafb; border-left:3px solid #4F46E5; color:#374151;">${body}</blockquote>
                <p><a href="${ticketUrl}" style="background:#4F46E5; color:#fff; padding:10px 20px; text-decoration:none; border-radius:6px; display:inline-block;">View Ticket</a></p>
                <p style="color:#6b7280; font-size:14px;">Reply from the ticket page if you still need help.</p>
            `,
        };
    }

    private buildTicketStatusChangedEmail(
        payload: EmailPayloadMap[EmailTemplate.TICKET_STATUS_CHANGED],
    ) {
        const name = escapeHtml(payload.name);
        const subject = escapeHtml(payload.subject);
        const status = escapeHtml(payload.status);
        const ticketUrl = escapeHtml(payload.ticketUrl);
        return {
            subject: `Ticket #${payload.ticketNumber} is now ${payload.status}`,
            html: `
                <h2>Ticket ${status}</h2>
                <p>Hi ${name},</p>
                <p>Your ticket <strong>#${payload.ticketNumber} ${subject}</strong> was marked as <strong>${status}</strong>.</p>
                <p><a href="${ticketUrl}" style="background:#4F46E5; color:#fff; padding:10px 20px; text-decoration:none; border-radius:6px; display:inline-block;">View Ticket</a></p>
                <p style="color:#6b7280; font-size:14px;">If you need more help, reply on the ticket and it will be reopened.</p>
            `,
        };
    }
}

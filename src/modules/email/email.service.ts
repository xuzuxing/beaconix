import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Resend } from 'resend';
import { EmailTemplate } from './email.types';
import type { EmailPayloadMap } from './email.types';
import type { AppConfig, ResendConfig } from '../../config';
import { escapeHtml } from '../../common/utils/otp.util';

@Injectable()
export class EmailService {
    private readonly logger = new Logger(EmailService.name);
    private readonly from: string;
    private readonly isDevelopment: boolean;

    constructor(
        @Inject('RESEND_CLIENT') private readonly resend: Resend,
        private readonly configService: ConfigService,
    ) {
        const appCfg = this.configService.get<AppConfig>('app')!;
        const resendCfg = this.configService.get<ResendConfig>('resend')!;
        this.from = `${resendCfg.fromName} <${resendCfg.fromEmail}>`;
        this.isDevelopment = appCfg.isDevelopment;

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
        const { subject, html } = this.buildEmail(template, payload);
        const masked = to.replace(/^(..)[^@]*/, '$1***');

        if (this.isDevelopment) {
            this.printToConsole(template, to, subject, html, payload);
            return;
        }

        this.logger.log(`Payload: ${JSON.stringify(payload)}`);

        this.logger.log(`Sending "${template}" email to "${masked}"`);

        const message = {
            from: this.from,
            to,
            subject,
            html,
        };
        const { data, error } = idempotencyKey
            ? await this.resend.emails.send(message, { idempotencyKey })
            : await this.resend.emails.send(message);

        if (error) {
            this.logger.error(
                `Failed to send "${template}" email to "${masked}": ${error.message}`,
            );
            throw new Error(`Email send failed: ${error.message}`);
        }

        this.logger.log(
            `Email "${template}" sent to "${masked}" (id: ${data?.id})`,
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
                `From:    ${this.from}`,
                `Subject: ${subject}`,
                `Payload: ${JSON.stringify(payload)}`,
                divider,
                html,
                divider,
                '',
            ].join('\n'),
        );
    }

    private readonly logoUrl =
        'https://0dmx1q3s0v.ufs.sh/f/FhSkiVUnN75kwe9Bf1c3QUqFZpGr2Xd9WySPfb4NCtVKmcJv';

    private wrapInLayout(body: string): string {
        return `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb;">
                <div style="background: linear-gradient(135deg, #4F46E5 0%, #6366F1 100%); padding: 32px 24px; text-align: center;">
                    <img src="${this.logoUrl}" alt="Beacon" width="48" height="48" style="border-radius: 10px; margin-bottom: 12px;" />
                    <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 600;">Beacon</h1>
                </div>
                <div style="padding: 32px 24px;">
                    ${body}
                </div>
                <div style="padding: 16px 24px; background: #f9fafb; text-align: center; border-top: 1px solid #e5e7eb;">
                    <p style="color: #9ca3af; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Beacon. All rights reserved.</p>
                </div>
            </div>`;
    }

    private buildEmail<T extends EmailTemplate>(
        template: T,
        payload: EmailPayloadMap[T],
    ): { subject: string; html: string } {
        let result: { subject: string; html: string };

        switch (template) {
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
            default:
                throw new Error(`Unknown email template: ${String(template)}`);
        }

        return {
            subject: result.subject,
            html: this.wrapInLayout(result.html),
        };
    }

    private buildInvitationEmail(
        payload: EmailPayloadMap[EmailTemplate.INVITATION],
    ) {
        const orgName = escapeHtml(payload.orgName);
        const inviterName = escapeHtml(payload.inviterName);
        const token = escapeHtml(payload.token);
        return {
            subject: `You've been invited to join ${payload.orgName}`,
            html: `
                <h2>You're invited!</h2>
                <p><strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> on Beacon.</p>
                <p>Use the following token to accept your invitation:</p>
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
}

import { createTransport } from 'nodemailer';
import type { Resend } from 'resend';

/** 一封已经渲染好的邮件 */
export interface MailMessage {
    from: string;
    to: string;
    subject: string;
    html: string;
}

/** 发信通道名，仅用于日志 */
export type MailTransportName = 'resend' | 'smtp';

/**
 * 发信通道。系统邮件默认走 Resend；一旦平台配置里的 `smtp.host` 非空，
 * 就切换到自建 SMTP（见 `EmailService`）。
 */
export interface MailTransport {
    readonly name: MailTransportName;
    /** 发送成功时返回通道侧的消息 id；拿不到则返回 undefined */
    send(
        message: MailMessage,
        idempotencyKey?: string,
    ): Promise<string | undefined>;
}

/** 自建 SMTP 的连接参数，来自平台配置的 `smtp.*` */
export interface SmtpSettings {
    host: string;
    port: number;
    secure: boolean;
    account: string;
    password: string;
    /** 发件人地址；留空时由调用方回退到 account / RESEND_FROM_EMAIL */
    fromAddress: string;
}

export class ResendMailTransport implements MailTransport {
    readonly name = 'resend';

    constructor(private readonly resend: Resend) {}

    async send(
        message: MailMessage,
        idempotencyKey?: string,
    ): Promise<string | undefined> {
        const { data, error } = idempotencyKey
            ? await this.resend.emails.send(message, { idempotencyKey })
            : await this.resend.emails.send(message);

        if (error) {
            throw new Error(error.message);
        }

        return data?.id;
    }
}

export class SmtpMailTransport implements MailTransport {
    readonly name = 'smtp';

    constructor(private readonly settings: SmtpSettings) {}

    async send(message: MailMessage): Promise<string | undefined> {
        // 每次按当前配置建 transporter：nodemailer 只在 sendMail 时才真正建连，
        // 所以这里没有连接池成本，也就省掉了「配置变了要失效重建」的处理。
        const transporter = createTransport({
            host: this.settings.host,
            port: this.settings.port,
            secure: this.settings.secure,
            auth: this.settings.account
                ? {
                      user: this.settings.account,
                      pass: this.settings.password,
                  }
                : undefined,
        });

        try {
            const info = await transporter.sendMail({
                from: message.from,
                to: message.to,
                subject: message.subject,
                html: message.html,
            });

            return typeof info.messageId === 'string'
                ? info.messageId
                : undefined;
        } catch (error) {
            throw this.describeFailure(error);
        } finally {
            transporter.close();
        }
    }

    /**
     * 认证失败时服务商只回一句 `Invalid login: 526 Authentication failure`，
     * 看不出该改哪一项配置：这里补上排查方向（账号、客户端专用密码、
     * 主机/端口/加密三项）。其它错误原样抛出。
     */
    private describeFailure(error: unknown): unknown {
        if (!(error instanceof Error)) return error;
        if ((error as { code?: string }).code !== 'EAUTH') return error;

        error.message = `${error.message} (SMTP authentication rejected: check smtp.account is the full mailbox address, smtp.password is the mailbox/app-specific password — Alibaba Mail requires a "client-specific password" once that feature is on — and smtp.host / smtp.port / smtp.secure match the provider)`;
        return error;
    }
}

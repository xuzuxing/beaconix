import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import type { Resend } from 'resend';
import { EmailService } from './email.service';
import { EmailTemplate } from './email.types';
import type { AppConfig, ResendConfig } from '../../config';
import type { SettingsService } from '../settings';

jest.mock('nodemailer', () => ({
    createTransport: jest.fn(),
}));

const baseConfig: ResendConfig = {
    apiKey: 're_test_key',
    fromEmail: 'noreply@test.dev',
    fromName: 'Beacon',
};

const baseAppConfig: AppConfig = {
    name: 'beaconix',
    host: '0.0.0.0',
    port: 3000,
    env: 'production',
    isProduction: true,
    isDevelopment: false,
    isTest: false,
    corsOrigins: [],
    webUrl: 'http://localhost:3000',
};

function createService({
    resendConfig = {},
    appConfig = {},
    settings = {},
}: {
    resendConfig?: Partial<ResendConfig>;
    appConfig?: Partial<AppConfig>;
    settings?: Record<string, string | boolean | number>;
} = {}) {
    const configService = {
        get: jest.fn((key: string) => {
            if (key === 'app') return { ...baseAppConfig, ...appConfig };
            if (key === 'resend') return { ...baseConfig, ...resendConfig };
            return undefined;
        }),
    } as unknown as ConfigService;

    // 未显式给出的 key 一律回退到调用方传入的 fallback，模拟内置默认
    const settingsService = {
        getString: jest.fn((key: string, fallback: string) =>
            Promise.resolve(
                typeof settings[key] === 'string' ? settings[key] : fallback,
            ),
        ),
        getBoolean: jest.fn((key: string, fallback: boolean) =>
            Promise.resolve(
                typeof settings[key] === 'boolean' ? settings[key] : fallback,
            ),
        ),
        getNumber: jest.fn((key: string, fallback: number) =>
            Promise.resolve(
                typeof settings[key] === 'number' ? settings[key] : fallback,
            ),
        ),
    } as unknown as SettingsService;

    const emails = {
        send: jest.fn().mockResolvedValue({ data: { id: 'id' } }),
    };
    const resend = { emails } as unknown as Resend;

    return {
        service: new EmailService(resend, configService, settingsService),
        emails,
    };
}

const payload = {
    to: 'zuxing@example.com',
    name: 'Zuxing',
    code: '123456',
    expiresInMinutes: 10,
};

describe('EmailService', () => {
    it('renders capacity notification actions and escapes their label and URL', async () => {
        const { service, emails } = createService();
        await service.send(EmailTemplate.NOTIFICATION, {
            to: 'owner@example.test',
            title: '监控数量宽限期',
            body: '72 小时后限制运行',
            actionUrl:
                'https://beacon.example/?organizationId=org&source=email',
            actionLabel: '<管理套餐>',
        });
        const html = emails.send.mock.calls[0][0].html;
        expect(html).toContain(
            'href="https://beacon.example/?organizationId=org&amp;source=email"',
        );
        expect(html).toContain('&lt;管理套餐&gt;');
        expect(html).toContain('72 小时后限制运行');
    });
    beforeEach(() => {
        (createTransport as jest.Mock).mockReset();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('dev mode', () => {
        it('does not call Resend', async () => {
            const { service, emails } = createService({
                appConfig: { isDevelopment: true },
            });

            await service.send(EmailTemplate.EMAIL_VERIFICATION, payload);

            expect(emails.send).not.toHaveBeenCalled();
        });

        it('prints the email to the console', async () => {
            const logSpy = jest
                .spyOn(console, 'log')
                .mockImplementation(() => undefined);
            const { service } = createService({
                appConfig: { isDevelopment: true },
            });

            await service.send(EmailTemplate.EMAIL_VERIFICATION, payload);

            const output = logSpy.mock.calls
                .map((call) => String(call[0]))
                .join('\n');

            expect(output).toContain('[DEV]');
            expect(output).toContain(payload.to);
            expect(output).toContain('邮箱验证码');
            expect(output).toContain(payload.code);
        });
    });

    describe('normal mode', () => {
        it('sends the email through Resend', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            const { service, emails } = createService();

            await service.send(EmailTemplate.EMAIL_VERIFICATION, payload);

            expect(emails.send).toHaveBeenCalledTimes(1);
            expect(emails.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    from: 'Beacon <noreply@test.dev>',
                    to: payload.to,
                    subject: '邮箱验证码',
                }),
            );
        });

        it('uses the configured site branding for the sender and footer', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            const { service, emails } = createService({
                settings: {
                    'system.siteName': 'Acme Monitor',
                    'system.supportEmail': 'ops@acme.test',
                },
            });

            await service.send(EmailTemplate.EMAIL_VERIFICATION, payload);

            const message = emails.send.mock.calls[0][0] as {
                from: string;
                html: string;
            };
            expect(message.from).toBe('Acme Monitor <noreply@test.dev>');
            expect(message.html).toContain('Acme Monitor');
            expect(message.html).toContain('mailto:ops@acme.test');
        });

        it('inlines the built-in logo when no logo URL is configured', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            const { service, emails } = createService();

            await service.send(EmailTemplate.NOTIFICATION, {
                to: 'zuxing@example.com',
                title: '项目有新的动态',
                body: '张三 评论了任务 BEA-1',
            });

            const { html } = emails.send.mock.calls[0][0] as { html: string };
            expect(html).toContain('src="data:image/png;base64,');
        });

        it('uses the configured logo URL instead of the inlined one', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            const { service, emails } = createService({
                settings: {
                    'system.logoUrl': 'https://cdn.example.test/logo.png',
                },
            });

            await service.send(EmailTemplate.NOTIFICATION, {
                to: 'zuxing@example.com',
                title: '项目有新的动态',
                body: '张三 评论了任务 BEA-1',
            });

            const { html } = emails.send.mock.calls[0][0] as { html: string };
            expect(html).toContain('src="https://cdn.example.test/logo.png"');
            expect(html).not.toContain('data:image/png;base64,');
        });

        describe('notice tone colors', () => {
            const bannerColor = (html: string): string | undefined =>
                html.match(
                    /height: 2px; background-color: (#[0-9a-f]{6});/,
                )?.[1];

            const overduePayload = {
                to: 'zuxing@example.com',
                name: 'Zuxing',
                taskTitle: '修复登录',
                taskNumber: 12,
                dueDate: '2026-03-01 10:00',
                projectKey: 'BEA',
            };

            it('keeps the banner blue for informational notices', async () => {
                jest.spyOn(Logger.prototype, 'log').mockImplementation(
                    () => undefined,
                );
                const { service, emails } = createService();

                await service.send(EmailTemplate.NOTIFICATION, {
                    to: 'zuxing@example.com',
                    title: '项目有新的动态',
                    body: '张三 评论了任务 BEA-1',
                });

                const { html } = emails.send.mock.calls[0][0] as {
                    html: string;
                };
                expect(bannerColor(html)).toBe('#00a4ff');
            });

            it('paints the banner orange for warnings', async () => {
                jest.spyOn(Logger.prototype, 'log').mockImplementation(
                    () => undefined,
                );
                const { service, emails } = createService();

                await service.send(EmailTemplate.TASK_DUE_SOON, overduePayload);

                const { html } = emails.send.mock.calls[0][0] as {
                    html: string;
                };
                expect(bannerColor(html)).toBe('#faa224');
                expect(html).toContain('color: #faa224; line-height: 22px');
            });

            it('paints the banner and hint red for errors', async () => {
                jest.spyOn(Logger.prototype, 'log').mockImplementation(
                    () => undefined,
                );
                const { service, emails } = createService();

                await service.send(EmailTemplate.TASK_OVERDUE, overduePayload);

                const { html } = emails.send.mock.calls[0][0] as {
                    html: string;
                };
                expect(bannerColor(html)).toBe('#fa3824');
                expect(html).toContain('color: #fa3824; line-height: 22px');
            });

            it('paints the error row of the data table red', async () => {
                jest.spyOn(Logger.prototype, 'log').mockImplementation(
                    () => undefined,
                );
                const { service, emails } = createService();

                await service.send(EmailTemplate.MONITOR_DOWN, {
                    to: 'ops@acme.test',
                    monitorName: 'Acme API',
                    target: 'https://api.acme.test/health',
                    status: 'DOWN',
                    previousStatus: 'UP',
                    error: 'connect ETIMEDOUT',
                    latency: '30001ms',
                    checkedAt: '2026-03-01 10:00',
                });

                const { html } = emails.send.mock.calls[0][0] as {
                    html: string;
                };
                expect(bannerColor(html)).toBe('#fa3824');
                expect(html).toContain('color: #fa3824;">connect ETIMEDOUT');
                // 其余行不染色，避免整张表都变红
                expect(html).not.toContain('color: #fa3824;">Acme API');
            });
        });

        it('links the invitation email to the web client with its token', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            const { service, emails } = createService();

            await service.send(EmailTemplate.INVITATION, {
                to: 'invitee@example.com',
                orgName: 'Beacon',
                token: 'cmv81drjl000200uztk9bnw6n',
                inviterName: 'Jane',
            });

            const { html } = emails.send.mock.calls[0][0] as { html: string };
            expect(html).toContain(
                'href="http://localhost:3000/invitations/cmv81drjl000200uztk9bnw6n"',
            );
            expect(html).toContain(
                'http://localhost:3000/invitations/cmv81drjl000200uztk9bnw6n',
            );
        });

        it('does not double the slash when the web URL ends with one', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            const { service, emails } = createService({
                appConfig: { webUrl: 'https://beaconix.example.com/' },
            });

            await service.send(EmailTemplate.INVITATION, {
                to: 'invitee@example.com',
                orgName: 'Beacon',
                token: 'token-1',
                inviterName: 'Jane',
            });

            const { html } = emails.send.mock.calls[0][0] as { html: string };
            expect(html).toContain(
                'https://beaconix.example.com/invitations/token-1',
            );
            expect(html).not.toContain('example.com//invitations');
        });

        it('throws when Resend returns an error', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            jest.spyOn(Logger.prototype, 'error').mockImplementation(
                () => undefined,
            );
            const { service, emails } = createService();
            emails.send.mockResolvedValue({
                data: null,
                error: { message: 'boom' },
            });

            await expect(
                service.send(EmailTemplate.EMAIL_VERIFICATION, payload),
            ).rejects.toThrow('Email send failed: boom');
        });

        it('uses SMTP once smtp.host is configured', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            const sendMail = jest
                .fn()
                .mockResolvedValue({ messageId: 'smtp-1' });
            const close = jest.fn();
            (createTransport as jest.Mock).mockReturnValue({ sendMail, close });

            const { service, emails } = createService({
                settings: {
                    'smtp.host': 'smtp.example.com',
                    'smtp.port': 465,
                    'smtp.secure': true,
                    'smtp.account': 'bot@example.com',
                    'smtp.password': 'secret',
                },
            });

            await service.send(EmailTemplate.EMAIL_VERIFICATION, payload);

            expect(emails.send).not.toHaveBeenCalled();
            expect(createTransport).toHaveBeenCalledWith({
                host: 'smtp.example.com',
                port: 465,
                secure: true,
                auth: { user: 'bot@example.com', pass: 'secret' },
            });
            expect(sendMail).toHaveBeenCalledWith(
                expect.objectContaining({
                    from: 'Beacon <bot@example.com>',
                    to: payload.to,
                    subject: '邮箱验证码',
                }),
            );
            expect(close).toHaveBeenCalled();
        });

        it('resolves the SMTP sender from fromAddress, then account, then Resend', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            const sendMail = jest
                .fn()
                .mockResolvedValue({ messageId: 'smtp-1' });
            (createTransport as jest.Mock).mockReturnValue({
                sendMail,
                close: jest.fn(),
            });

            const cases: [Record<string, string | boolean>, string][] = [
                [
                    { 'smtp.fromAddress': 'noreply@acme.test' },
                    'Beacon <noreply@acme.test>',
                ],
                [{}, 'Beacon <bot@example.com>'],
                [{ 'smtp.account': '' }, 'Beacon <noreply@test.dev>'],
            ];

            for (const [extra, expected] of cases) {
                const { service } = createService({
                    settings: {
                        'smtp.host': 'smtp.example.com',
                        'smtp.account': 'bot@example.com',
                        ...extra,
                    },
                });

                await service.send(EmailTemplate.EMAIL_VERIFICATION, payload);

                const last = sendMail.mock.calls.at(-1)?.[0] as {
                    from: string;
                };
                expect(last.from).toBe(expected);
            }
        });

        it('trims whitespace around SMTP credentials', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            (createTransport as jest.Mock).mockReturnValue({
                sendMail: jest.fn().mockResolvedValue({ messageId: 'smtp-1' }),
                close: jest.fn(),
            });

            const { service } = createService({
                settings: {
                    'smtp.host': 'smtp.example.com',
                    'smtp.account': ' bot@example.com ',
                    'smtp.password': '  app-password\r\n',
                },
            });

            await service.send(EmailTemplate.EMAIL_VERIFICATION, payload);

            expect(createTransport).toHaveBeenCalledWith(
                expect.objectContaining({
                    auth: { user: 'bot@example.com', pass: 'app-password' },
                }),
            );
        });

        it('adds a troubleshooting hint to SMTP authentication failures', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            jest.spyOn(Logger.prototype, 'error').mockImplementation(
                () => undefined,
            );
            const authError = Object.assign(
                new Error('Invalid login: 526 Authentication failure[0]'),
                { code: 'EAUTH', responseCode: 526 },
            );
            (createTransport as jest.Mock).mockReturnValue({
                sendMail: jest.fn().mockRejectedValue(authError),
                close: jest.fn(),
            });

            const { service } = createService({
                settings: {
                    'smtp.host': 'smtp.qiye.aliyun.com',
                    'smtp.port': 465,
                    'smtp.secure': true,
                    'smtp.account': 'noreply@example.com',
                    'smtp.password': 'wrong',
                },
            });

            await expect(
                service.send(EmailTemplate.EMAIL_VERIFICATION, payload),
            ).rejects.toThrow(
                /526 Authentication failure\[0\].*client-specific password/,
            );
        });

        it('reports the failing transport when SMTP rejects the message', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            const errorSpy = jest
                .spyOn(Logger.prototype, 'error')
                .mockImplementation(() => undefined);
            (createTransport as jest.Mock).mockReturnValue({
                sendMail: jest.fn().mockRejectedValue(new Error('auth failed')),
                close: jest.fn(),
            });

            const { service } = createService({
                settings: { 'smtp.host': 'smtp.example.com' },
            });

            await expect(
                service.send(EmailTemplate.EMAIL_VERIFICATION, payload),
            ).rejects.toThrow('Email send failed: auth failed');
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('via smtp'),
            );
        });
    });
});

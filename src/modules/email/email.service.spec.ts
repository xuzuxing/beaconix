import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Resend } from 'resend';
import { EmailService } from './email.service';
import { EmailTemplate } from './email.types';
import type { AppConfig, ResendConfig } from '../../config';

const baseConfig: ResendConfig = {
    apiKey: 're_test_key',
    fromEmail: 'noreply@test.dev',
    fromName: 'Beacon',
};

const baseAppConfig: AppConfig = {
    name: 'beaconix',
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
}: {
    resendConfig?: Partial<ResendConfig>;
    appConfig?: Partial<AppConfig>;
} = {}) {
    const configService = {
        get: jest.fn((key: string) => {
            if (key === 'app') return { ...baseAppConfig, ...appConfig };
            if (key === 'resend') return { ...baseConfig, ...resendConfig };
            return undefined;
        }),
    } as unknown as ConfigService;

    const emails = {
        send: jest.fn().mockResolvedValue({ data: { id: 'id' } }),
    };
    const resend = { emails } as unknown as Resend;

    return { service: new EmailService(resend, configService), emails };
}

const payload = {
    to: 'zuxing@example.com',
    name: 'Zuxing',
    code: '123456',
    expiresInMinutes: 10,
};

describe('EmailService', () => {
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
            expect(output).toContain('Verify your email address');
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
                    subject: 'Verify your email address',
                }),
            );
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
    });
});

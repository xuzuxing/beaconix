import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Resend } from 'resend';
import { EmailService } from './email.service';
import { EmailTemplate } from './email.types';
import type { ResendConfig } from '../../config';

const baseConfig: ResendConfig = {
    apiKey: 're_test_key',
    fromEmail: 'noreply@test.dev',
    fromName: 'Beacon',
    devMode: false,
};

function createService(resendConfig: Partial<ResendConfig> = {}) {
    const configService = {
        get: jest.fn(() => ({ ...baseConfig, ...resendConfig })),
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
            const { service, emails } = createService({ devMode: true });

            await service.send(EmailTemplate.EMAIL_VERIFICATION, payload);

            expect(emails.send).not.toHaveBeenCalled();
        });

        it('prints the email to the console', async () => {
            const logSpy = jest
                .spyOn(Logger.prototype, 'log')
                .mockImplementation(() => undefined);
            const { service } = createService({ devMode: true });

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
            const { service, emails } = createService({ devMode: false });

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

        it('throws when Resend returns an error', async () => {
            jest.spyOn(Logger.prototype, 'log').mockImplementation(
                () => undefined,
            );
            jest.spyOn(Logger.prototype, 'error').mockImplementation(
                () => undefined,
            );
            const { service, emails } = createService({ devMode: false });
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

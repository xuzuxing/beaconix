import type { NotificationChannelModel } from '../../../generated/prisma/models';
import type { EmailService } from '../../email/email.service';
import { EmailTemplate } from '../../email/email.types';
import type { NotificationPayload } from '../notifier.types';
import { EmailSender } from './email.sender';

const iso = '2026-10-10T13:30:49.009Z';
const payload: NotificationPayload = {
    monitorId: 'monitor-1',
    monitorName: 'Production API',
    monitorType: 'HTTP',
    target: 'https://api.example.com/health',
    organizationId: 'org-1',
    previousStatus: 'UP',
    status: 'DOWN',
    event: 'DOWN',
    failCount: 3,
    latency: 30,
    error: 'connect ECONNREFUSED',
    checkedAt: new Date(iso),
    idempotencyKey: 'delivery-1',
};
const channel = {
    config: { to: ['alerts@example.com'] },
} as unknown as NotificationChannelModel;

function createSender() {
    const emailService = { send: jest.fn().mockResolvedValue(undefined) };
    const sender = new EmailSender(emailService as unknown as EmailService);
    return { sender, emailService };
}

describe('EmailSender', () => {
    it.each(['NO_DATA', 'NO_DATA_RECOVERED'] as const)(
        'sends %s with an explicit generic notification template',
        async (event) => {
            const { sender, emailService } = createSender();
            await sender.send(channel, {
                ...payload,
                event,
                status: event === 'NO_DATA' ? 'UNKNOWN' : 'DOWN',
                latency: null,
            });
            expect(emailService.send).toHaveBeenCalledWith(
                EmailTemplate.NOTIFICATION,
                expect.objectContaining({
                    title: expect.stringContaining(
                        event === 'NO_DATA'
                            ? '[NO DATA]'
                            : '[OBSERVATIONS RESUMED]',
                    ),
                }),
                'delivery-1:alerts@example.com',
            );
        },
    );
    it.each([new Date(iso), iso, '2026-10-10T21:30:49.009+08:00'])(
        'formats the checked date and preserves the idempotency key: %s',
        async (checkedAt) => {
            const { sender, emailService } = createSender();
            await sender.send(channel, { ...payload, checkedAt });
            expect(emailService.send).toHaveBeenCalledWith(
                EmailTemplate.MONITOR_DOWN,
                expect.objectContaining({ checkedAt: iso }),
                'delivery-1:alerts@example.com',
            );
        },
    );

    it('uses the recovery template with a serialized date', async () => {
        const { sender, emailService } = createSender();
        await sender.send(channel, {
            ...payload,
            event: 'RECOVER',
            checkedAt: iso,
        });
        expect(emailService.send).toHaveBeenCalledWith(
            EmailTemplate.MONITOR_RECOVER,
            expect.objectContaining({ checkedAt: iso }),
            'delivery-1:alerts@example.com',
        );
    });

    it('rejects invalid dates without sending an email', async () => {
        const { sender, emailService } = createSender();
        await expect(
            sender.send(channel, { ...payload, checkedAt: 'invalid-date' }),
        ).rejects.toThrow(RangeError);
        expect(emailService.send).not.toHaveBeenCalled();
    });
});

import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { verifyOtp } from '../../common/utils/otp.util';

jest.mock('bcrypt', () => ({ compare: jest.fn(), hash: jest.fn() }));
jest.mock('../../common/utils/otp.util', () => ({
    ...jest.requireActual('../../common/utils/otp.util'),
    verifyOtp: jest.fn(),
}));

const user = {
    id: 'user-1',
    email: 'person@example.com',
    name: 'Person',
    password: 'stored-hash',
    globalRole: 'USER',
    emailVerified: false,
};

function createService() {
    const prisma = {
        user: {
            findUnique: jest.fn().mockResolvedValue(user),
            findUniqueOrThrow: jest.fn().mockResolvedValue(user),
            update: jest.fn(),
        },
        otpCode: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'otp-1',
                attempts: 0,
                codeHash: 'otp-hash',
            }),
            update: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        refreshToken: { updateMany: jest.fn(), create: jest.fn() },
        $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        syncPendingInvitations: jest.fn().mockResolvedValue(undefined),
    };
    const email = { send: jest.fn() };
    const organizations = { provisionForUser: jest.fn() };
    const service = new AuthService(
        prisma as never,
        { signAsync: jest.fn().mockResolvedValue('access') } as never,
        { get: jest.fn().mockReturnValue({ refreshExpiresIn: '7d' }) } as never,
        email as never,
        organizations as never,
        {} as never,
        notifications as never,
    );
    return { service, prisma, notifications, email, organizations };
}

describe('AuthService security notifications', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        (bcrypt.compare as jest.Mock)
            .mockResolvedValueOnce(true)
            .mockResolvedValue(false);
        (bcrypt.hash as jest.Mock).mockResolvedValue('new-hash');
        (verifyOtp as jest.Mock).mockResolvedValue(true);
    });

    it('persists password-change notice and session revocation in one transaction', async () => {
        const { service, prisma, notifications, email } = createService();
        await service.changePassword(user.id, {
            currentPassword: 'current-password',
            newPassword: 'new-password',
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'PASSWORD_CHANGED',
                recipients: [user.id],
                actorId: user.id,
                includeActor: true,
                email: true,
            }),
            prisma,
        );
        const notice = notifications.publish.mock.calls[0][0];
        expect(notice.organizationId).toBeUndefined();
        expect(JSON.stringify(notice)).not.toMatch(
            /current-password|new-password|stored-hash|new-hash/,
        );
        expect(email.send).not.toHaveBeenCalled();
    });

    it('does not notify or mutate when the password is unchanged', async () => {
        const { service, prisma, notifications } = createService();
        (bcrypt.compare as jest.Mock).mockReset().mockResolvedValue(true);
        await service.changePassword(user.id, {
            currentPassword: 'same',
            newPassword: 'same',
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('consumes the reset OTP with the password and completion notice', async () => {
        const { service, prisma, notifications, email } = createService();
        await service.resetPassword({
            email: user.email,
            code: '123456',
            newPassword: 'new-password',
        });
        expect(prisma.otpCode.update).not.toHaveBeenCalled();
        expect(prisma.otpCode.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'otp-1',
                usedAt: null,
                expiresAt: { gt: expect.any(Date) },
            },
            data: { usedAt: expect.any(Date) },
        });
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                eventKey: 'password-reset:otp-1',
                type: 'PASSWORD_RESET_COMPLETED',
                recipients: [user.id],
                includeActor: true,
                email: true,
            }),
            prisma,
        );
        expect(
            JSON.stringify(notifications.publish.mock.calls[0][0]),
        ).not.toMatch(/123456|otp-hash|new-password/);
        expect(email.send).not.toHaveBeenCalled();
    });

    it('does not mutate or notify when another request already used the reset code', async () => {
        const { service, prisma, notifications } = createService();
        prisma.otpCode.updateMany.mockResolvedValue({ count: 0 });
        await expect(
            service.resetPassword({
                email: user.email,
                code: '123456',
                newPassword: 'new-password',
            }),
        ).rejects.toThrow('Invalid or expired code');
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('propagates notification persistence failure to the password transaction', async () => {
        const { service, notifications } = createService();
        notifications.publish.mockRejectedValue(
            new Error('outbox unavailable'),
        );
        await expect(
            service.changePassword(user.id, {
                currentPassword: 'current-password',
                newPassword: 'new-password',
            }),
        ).rejects.toThrow('outbox unavailable');
    });

    it('discovers invitations after verification inside the provisioning transaction', async () => {
        const { service, prisma, notifications, organizations } =
            createService();
        await service.verifyEmail({ email: user.email, code: '123456' });
        expect(organizations.provisionForUser).toHaveBeenCalledWith(
            user,
            prisma,
        );
        expect(notifications.syncPendingInvitations).toHaveBeenCalledWith(
            user.id,
            prisma,
        );
        expect(prisma.user.update.mock.invocationCallOrder[0]).toBeLessThan(
            notifications.syncPendingInvitations.mock.invocationCallOrder[0],
        );
    });
});

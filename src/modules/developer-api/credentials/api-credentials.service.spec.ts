import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiCredentialsService } from './api-credentials.service';
import type { PrismaService } from '../../../infra/database/prisma.service';
import { API_KEY_PREFIX, PAT_PREFIX } from '../common/credentials.util';
import { API_SCOPES } from '../common/scopes';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';

const user: JwtPayload = {
    sub: 'user-1',
    email: 'dev@example.com',
    globalRole: 'USER',
};

function createService() {
    const prisma = {
        apiKey: {
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        personalAccessToken: {
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    };
    const transaction = jest.fn((callback) => callback(prisma));
    Object.assign(prisma, { $transaction: transaction });
    const jwtService = { signAsync: jest.fn() };
    const quotaService = {
        assertCanCreate: jest.fn(),
        assertCanCreateInTransaction: jest.fn(),
    };
    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        organizationRecipients: jest.fn().mockResolvedValue(['owner', 'admin']),
    };

    const service = new ApiCredentialsService(
        prisma as unknown as PrismaService,
        jwtService as any,
        quotaService as any,
        notifications as any,
    );

    return {
        service,
        prisma,
        jwtService,
        quotaService,
        notifications,
        transaction,
    };
}

describe('ApiCredentialsService', () => {
    describe('createApiKey', () => {
        it('stores only the hash and returns the raw key once', async () => {
            const { service, prisma, quotaService, notifications } =
                createService();
            quotaService.assertCanCreate.mockResolvedValue(undefined);
            prisma.apiKey.create.mockImplementation(({ data }: any) => ({
                id: 'key-1',
                organizationId: data.organizationId,
                name: data.name,
                keyPrefix: data.keyPrefix,
                keyHash: data.keyHash,
                scopes: data.scopes,
                expiresAt: data.expiresAt,
                createdById: data.createdById,
                createdAt: new Date(),
                updatedAt: new Date(),
                revokedAt: null,
                lastUsedAt: null,
            }));

            const result = await service.createApiKey('org-1', 'user-1', {
                name: 'CI',
                scopes: ['monitors:read'],
            });

            expect(
                quotaService.assertCanCreateInTransaction,
            ).toHaveBeenCalledWith('org-1', 'apiKeys', expect.anything());
            expect(result.key).toMatch(new RegExp(`^${API_KEY_PREFIX}`));
            expect(prisma.apiKey.create).toHaveBeenCalledTimes(1);

            const created = prisma.apiKey.create.mock.calls[0][0].data;
            expect(created.keyHash).not.toContain(result.key);
            expect(created.keyHash).toBe(
                createHash('sha256').update(result.key!).digest('hex'),
            );
            expect(notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'API_KEY_CREATED',
                    organizationId: 'org-1',
                    recipients: ['user-1', 'owner', 'admin'],
                    includeActor: true,
                }),
                prisma,
            );
            const notice = JSON.stringify(
                notifications.publish.mock.calls[0][0],
            );
            expect(notice).not.toContain(result.key);
            expect(notice).not.toContain(created.keyHash);
        });

        it('rejects an expiry in the past', async () => {
            const { service } = createService();
            const past = new Date(Date.now() - 1000).toISOString();

            await expect(
                service.createApiKey('org-1', 'user-1', {
                    name: 'CI',
                    scopes: ['monitors:read'],
                    expiresAt: past,
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('revokeApiKey', () => {
        it('notifies the creator, actor and org administrators transactionally', async () => {
            const { service, prisma, notifications } = createService();
            prisma.apiKey.findFirst.mockResolvedValue({
                id: 'key-1',
                createdById: 'creator',
                revokedAt: null,
                keyHash: 'secret-key-hash',
            });
            prisma.apiKey.update.mockResolvedValue({
                id: 'key-1',
                createdById: 'creator',
                revokedAt: new Date(),
            });
            await service.revokeApiKey('org-1', 'key-1', 'actor');
            expect(prisma.apiKey.update).toHaveBeenCalledWith({
                where: { id: 'key-1', revokedAt: null },
                data: { revokedAt: expect.any(Date) },
            });
            expect(notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'API_KEY_REVOKED',
                    includeActor: true,
                    actorId: 'actor',
                    recipients: ['creator', 'actor', 'owner', 'admin'],
                }),
                prisma,
            );
            expect(
                JSON.stringify(notifications.publish.mock.calls[0][0]),
            ).not.toContain('secret-key-hash');
        });

        it('filters a missing creator from the revoked-key recipients', async () => {
            const { service, prisma, notifications } = createService();
            prisma.apiKey.findFirst.mockResolvedValue({
                id: 'key-1',
                createdById: null,
                revokedAt: null,
            });
            prisma.apiKey.update.mockResolvedValue({
                id: 'key-1',
                revokedAt: new Date(),
            });
            await service.revokeApiKey('org-1', 'key-1');
            expect(notifications.publish.mock.calls[0][0].recipients).toEqual([
                'owner',
                'admin',
            ]);
        });

        it('rejects revoking an already revoked key', async () => {
            const { service, prisma, notifications } = createService();
            prisma.apiKey.findFirst.mockResolvedValue({
                id: 'key-1',
                revokedAt: new Date(),
            });

            await expect(
                service.revokeApiKey('org-1', 'key-1'),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(notifications.publish).not.toHaveBeenCalled();
        });

        it('throws when the key is not in the org', async () => {
            const { service, prisma } = createService();
            prisma.apiKey.findFirst.mockResolvedValue(null);

            await expect(
                service.revokeApiKey('org-1', 'missing'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('personal token revocation', () => {
        it('notifies only the token owner', async () => {
            const { service, prisma, notifications } = createService();
            prisma.personalAccessToken.findFirst.mockResolvedValue({
                id: 'pat-1',
                revokedAt: null,
            });
            prisma.personalAccessToken.update.mockResolvedValue({
                id: 'pat-1',
                revokedAt: new Date(),
            });
            await service.revokePersonalAccessToken('user-1', 'pat-1');
            const event = notifications.publish.mock.calls[0][0];
            expect(event).toMatchObject({
                type: 'PERSONAL_ACCESS_TOKEN_REVOKED',
                recipients: ['user-1'],
                includeActor: true,
                email: true,
            });
            expect(event.organizationId).toBeUndefined();
            expect(notifications.publish.mock.calls[0][1]).toBe(prisma);
            expect(notifications.organizationRecipients).not.toHaveBeenCalled();
        });

        it('propagates notice failure instead of committing a silent revocation', async () => {
            const { service, prisma, notifications } = createService();
            prisma.personalAccessToken.findFirst.mockResolvedValue({
                id: 'pat-1',
                revokedAt: null,
            });
            prisma.personalAccessToken.update.mockResolvedValue({
                id: 'pat-1',
                revokedAt: new Date(),
            });
            notifications.publish.mockRejectedValue(
                new Error('outbox unavailable'),
            );
            await expect(
                service.revokePersonalAccessToken('user-1', 'pat-1'),
            ).rejects.toThrow('outbox unavailable');
        });
    });

    describe('findValidApiKey', () => {
        it('returns null for non-API-key tokens', async () => {
            const { service } = createService();
            await expect(
                service.findValidApiKey(`${PAT_PREFIX}abc`),
            ).resolves.toBeNull();
        });

        it('returns null for revoked keys', async () => {
            const { service, prisma } = createService();
            prisma.apiKey.findUnique.mockResolvedValue({
                id: 'key-1',
                revokedAt: new Date(),
                expiresAt: null,
            });

            await expect(
                service.findValidApiKey(`${API_KEY_PREFIX}abc`),
            ).resolves.toBeNull();
        });

        it('returns the key when valid', async () => {
            const { service, prisma } = createService();
            const key = { id: 'key-1', revokedAt: null, expiresAt: null };
            prisma.apiKey.findUnique.mockResolvedValue(key);

            await expect(
                service.findValidApiKey(`${API_KEY_PREFIX}abc`),
            ).resolves.toEqual(key);
        });
    });

    describe('findValidPatById', () => {
        it('returns null for revoked tokens', async () => {
            const { service, prisma } = createService();
            prisma.personalAccessToken.findUnique.mockResolvedValue({
                id: 'pat-1',
                revokedAt: new Date(),
                expiresAt: null,
            });

            await expect(service.findValidPatById('pat-1')).resolves.toBeNull();
        });

        it('returns the token when valid', async () => {
            const { service, prisma } = createService();
            const token = { id: 'pat-1', revokedAt: null, expiresAt: null };
            prisma.personalAccessToken.findUnique.mockResolvedValue(token);

            await expect(service.findValidPatById('pat-1')).resolves.toEqual(
                token,
            );
        });
    });

    describe('createPersonalAccessToken', () => {
        it('signs a revocable JWT containing kind and patId', async () => {
            const { service, prisma, jwtService, notifications } =
                createService();
            prisma.personalAccessToken.create.mockResolvedValue({
                id: 'pat-1',
                userId: user.sub,
                name: 'Laptop',
                tokenHash: 'hash',
                scopes: [...API_SCOPES],
                expiresAt: new Date(Date.now() + 1000 * 60 * 60),
                revokedAt: null,
                lastUsedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            jwtService.signAsync.mockResolvedValue('signed.jwt');

            const result = await service.createPersonalAccessToken(user, {
                name: 'Laptop',
            });

            expect(result.token).toBe('signed.jwt');
            expect(jwtService.signAsync).toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'pat', patId: 'pat-1' }),
                expect.objectContaining({
                    expiresIn: expect.any(Number),
                }),
            );

            const created =
                prisma.personalAccessToken.create.mock.calls[0][0].data;
            expect(created.scopes).toEqual([...API_SCOPES]);
            expect(notifications.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'PERSONAL_ACCESS_TOKEN_CREATED',
                    recipients: ['user-1'],
                    includeActor: true,
                }),
                prisma,
            );
            const notice = notifications.publish.mock.calls[0][0];
            expect(notice.organizationId).toBeUndefined();
            expect(JSON.stringify(notice)).not.toContain('signed.jwt');
            expect(notifications.organizationRecipients).not.toHaveBeenCalled();
        });

        it('rejects an expiry more than one year out', async () => {
            const { service } = createService();
            const twoYears = new Date(
                Date.now() + 2 * 365 * 24 * 60 * 60 * 1000,
            ).toISOString();

            await expect(
                service.createPersonalAccessToken(user, {
                    name: 'Laptop',
                    expiresAt: twoYears,
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });
});

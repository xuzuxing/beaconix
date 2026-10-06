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
    const jwtService = { signAsync: jest.fn() };
    const quotaService = { assertCanCreate: jest.fn() };

    const service = new ApiCredentialsService(
        prisma as unknown as PrismaService,
        jwtService as any,
        quotaService as any,
    );

    return { service, prisma, jwtService, quotaService };
}

describe('ApiCredentialsService', () => {
    describe('createApiKey', () => {
        it('stores only the hash and returns the raw key once', async () => {
            const { service, prisma, quotaService } = createService();
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

            expect(quotaService.assertCanCreate).toHaveBeenCalledWith(
                'org-1',
                'apiKeys',
            );
            expect(result.key).toMatch(new RegExp(`^${API_KEY_PREFIX}`));
            expect(prisma.apiKey.create).toHaveBeenCalledTimes(1);

            const created = prisma.apiKey.create.mock.calls[0][0].data;
            expect(created.keyHash).not.toContain(result.key);
            expect(created.keyHash).toBe(
                createHash('sha256').update(result.key!).digest('hex'),
            );
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
        it('rejects revoking an already revoked key', async () => {
            const { service, prisma } = createService();
            prisma.apiKey.findFirst.mockResolvedValue({
                id: 'key-1',
                revokedAt: new Date(),
            });

            await expect(
                service.revokeApiKey('org-1', 'key-1'),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('throws when the key is not in the org', async () => {
            const { service, prisma } = createService();
            prisma.apiKey.findFirst.mockResolvedValue(null);

            await expect(
                service.revokeApiKey('org-1', 'missing'),
            ).rejects.toBeInstanceOf(NotFoundException);
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
            const { service, prisma, jwtService } = createService();
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

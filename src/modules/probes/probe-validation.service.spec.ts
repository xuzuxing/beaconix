import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    hkdfSync,
    randomBytes,
} from 'node:crypto';
import { ProbeValidationService } from './probe-validation.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';

const VALIDATION_INFO = 'beacon-probe-validation-v1';
const RAW_SECRET = 'tnt_good';

function hashSecret(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * The backend only stores sha256(secret), so both it and the probe key the
 * challenge off the hash — never the plaintext.
 */
function deriveKey(secretHash: string): Buffer {
    return Buffer.from(
        hkdfSync(
            'sha256',
            Buffer.from(secretHash, 'utf8'),
            Buffer.alloc(0),
            Buffer.from(VALIDATION_INFO, 'utf8'),
            32,
        ),
    );
}

const probeRow = { id: 'probe-1' };

const secretRow = {
    id: 'secret-1',
    probeId: 'probe-1',
    secretHash: hashSecret(RAW_SECRET),
    revokedAt: null as Date | null,
    expiresAt: null as Date | null,
    probe: { id: 'probe-1', enabled: true },
};

function encryptJson(key: Buffer, value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: data.toString('base64'),
    };
}

function decryptJson(
    key: Buffer,
    payload: { iv: string; tag: string; data: string },
) {
    const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(payload.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.data, 'base64')),
        decipher.final(),
    ]);

    return JSON.parse(plaintext.toString('utf8'));
}

function pendingValidation() {
    return {
        probeId: 'probe-1',
        nonce: 'nonce-123',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
}

function createService() {
    const prisma = {
        probe: {
            findFirst: jest.fn(),
            update: jest.fn(),
        },
        probeSecret: {
            findUnique: jest.fn(),
        },
        probeExecution: {
            create: jest.fn(),
        },
    };
    const redis = {
        getJson: jest.fn(),
        setJson: jest.fn(),
        del: jest.fn(),
    };

    const service = new ProbeValidationService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
    );

    return { service, prisma, redis };
}

describe('ProbeValidationService', () => {
    describe('triggerForTenant', () => {
        it('records a pending challenge without encrypting it up front', async () => {
            const { service, prisma, redis } = createService();
            prisma.probe.findFirst.mockResolvedValue(probeRow);

            const result = await service.triggerForTenant('org-1', 'probe-1');

            expect(prisma.probe.findFirst).toHaveBeenCalledWith({
                where: {
                    id: 'probe-1',
                    organizationId: 'org-1',
                    scope: 'TENANT',
                },
                select: { id: true },
            });
            // No challenge in the trigger response: it is only produced when the
            // probe pulls, keyed by whichever secret it presents.
            expect(result).toEqual({
                validationId: 'probe-1',
                expiresAt: expect.any(String),
                status: 'PENDING',
            });
            expect(redis.setJson).toHaveBeenCalledWith(
                'probe:validation:probe-1',
                expect.objectContaining({
                    probeId: 'probe-1',
                    nonce: expect.any(String),
                }),
                120,
            );
        });

        it('throws when the tenant probe is not found', async () => {
            const { service, prisma } = createService();
            prisma.probe.findFirst.mockResolvedValue(null);

            await expect(
                service.triggerForTenant('org-1', 'probe-1'),
            ).rejects.toThrow('Probe not found');
        });
    });

    describe('pullForSecret', () => {
        it('returns a challenge keyed by the presented secret hash', async () => {
            const { service, prisma, redis } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(secretRow);
            redis.getJson.mockResolvedValue(pendingValidation());

            const result = await service.pullForSecret(RAW_SECRET);

            expect(prisma.probeSecret.findUnique).toHaveBeenCalledWith({
                where: { secretHash: hashSecret(RAW_SECRET) },
                include: { probe: { select: { id: true, enabled: true } } },
            });
            expect(result).toMatchObject({
                validation: {
                    validationId: 'probe-1',
                    expiresAt: expect.any(String),
                },
            });

            const challenge = (
                result as {
                    validation: {
                        challenge: { iv: string; tag: string; data: string };
                    };
                }
            ).validation.challenge;
            const plaintext = decryptJson(
                deriveKey(hashSecret(RAW_SECRET)),
                challenge,
            ) as { nonce: string };
            expect(plaintext.nonce).toBe('nonce-123');
        });

        it('returns null when no validation is pending', async () => {
            const { service, prisma, redis } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(secretRow);
            redis.getJson.mockResolvedValue(null);

            await expect(service.pullForSecret(RAW_SECRET)).resolves.toEqual({
                validation: null,
            });
        });

        it('rejects an unknown secret', async () => {
            const { service, prisma } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(null);

            await expect(service.pullForSecret('nope')).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('rejects a secret whose rotation grace window has passed', async () => {
            const { service, prisma } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue({
                ...secretRow,
                expiresAt: new Date(Date.now() - 1000),
            });

            await expect(service.pullForSecret(RAW_SECRET)).rejects.toThrow(
                'Probe secret has expired',
            );
        });

        it('rejects a revoked secret', async () => {
            const { service, prisma } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue({
                ...secretRow,
                revokedAt: new Date(),
            });

            await expect(service.pullForSecret(RAW_SECRET)).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });

    describe('answerForSecret', () => {
        it('verifies the encrypted answer and marks the probe online', async () => {
            const { service, prisma, redis } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(secretRow);
            prisma.probe.update.mockResolvedValue(probeRow);
            redis.getJson.mockResolvedValue(pendingValidation());

            const answer = encryptJson(deriveKey(hashSecret(RAW_SECRET)), {
                nonce: 'nonce-123',
                answeredAt: new Date().toISOString(),
            });

            const result = await service.answerForSecret(
                RAW_SECRET,
                'probe-1',
                answer,
            );

            expect(result).toEqual({
                validationId: 'probe-1',
                ok: true,
                status: 'SUCCESS',
                checkedAt: expect.any(String),
            });
            expect(redis.del).toHaveBeenCalledWith('probe:validation:probe-1');
            expect(prisma.probe.update).toHaveBeenCalledWith({
                where: { id: 'probe-1' },
                data: {
                    lastHeartbeat: expect.any(Date),
                    status: 'ONLINE',
                },
            });
            expect(prisma.probeExecution.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    probeId: 'probe-1',
                    monitorId: null,
                    target: 'validation',
                    trigger: 'MANUAL',
                    status: 'SUCCESS',
                    success: true,
                    error: null,
                }),
            });
        });

        it('rejects a nonce mismatch', async () => {
            const { service, prisma, redis } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(secretRow);
            redis.getJson.mockResolvedValue({
                ...pendingValidation(),
                nonce: 'expected-nonce',
            });

            const answer = encryptJson(deriveKey(hashSecret(RAW_SECRET)), {
                nonce: 'wrong-nonce',
                answeredAt: new Date().toISOString(),
            });

            await expect(
                service.answerForSecret(RAW_SECRET, 'probe-1', answer),
            ).rejects.toThrow(BadRequestException);
        });

        it('rejects when no challenge is pending', async () => {
            const { service, prisma, redis } = createService();
            prisma.probeSecret.findUnique.mockResolvedValue(secretRow);
            redis.getJson.mockResolvedValue(null);

            const answer = encryptJson(deriveKey(hashSecret(RAW_SECRET)), {
                nonce: 'nonce',
                answeredAt: new Date().toISOString(),
            });

            await expect(
                service.answerForSecret(RAW_SECRET, 'probe-1', answer),
            ).rejects.toThrow(
                'Validation challenge not found or already answered',
            );
        });
    });
});

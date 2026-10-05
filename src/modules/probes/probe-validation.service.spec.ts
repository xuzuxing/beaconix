import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
    createCipheriv,
    createDecipheriv,
    hkdfSync,
    randomBytes,
} from 'node:crypto';
import { ProbeValidationService } from './probe-validation.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';

const VALIDATION_INFO = 'beacon-probe-validation-v1';

const probeRow = {
    id: 'probe-1',
    secret: 'tnt_good',
    enabled: true,
};

function deriveKey(token: string): Buffer {
    return Buffer.from(
        hkdfSync(
            'sha256',
            Buffer.from(token, 'utf8'),
            Buffer.alloc(0),
            Buffer.from(VALIDATION_INFO, 'utf8'),
            32,
        ),
    );
}

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

function createService() {
    const prisma = {
        probe: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
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
        it('creates an encrypted challenge and stores it in Redis', async () => {
            const { service, prisma, redis } = createService();
            prisma.probe.findFirst.mockResolvedValue(probeRow);

            const result = await service.triggerForTenant('org-1', 'probe-1');

            expect(prisma.probe.findFirst).toHaveBeenCalledWith({
                where: {
                    id: 'probe-1',
                    organizationId: 'org-1',
                    scope: 'TENANT',
                },
                select: { id: true, secret: true, enabled: true },
            });
            expect(result.validationId).toBe('probe-1');
            expect(result.status).toBe('PENDING');
            expect(result.expiresAt).toEqual(expect.any(String));
            expect(redis.setJson).toHaveBeenCalledWith(
                'probe:validation:probe-1',
                expect.objectContaining({
                    probeId: 'probe-1',
                    nonce: expect.any(String),
                }),
                120,
            );

            const plaintext = decryptJson(
                deriveKey('tnt_good'),
                result.challenge,
            ) as { nonce: string; issuedAt: string };
            expect(plaintext.nonce).toHaveLength(64);
            expect(Number.isNaN(Date.parse(plaintext.issuedAt))).toBe(false);
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
        it('returns a decryptable challenge for a pending validation', async () => {
            const { service, prisma, redis } = createService();
            prisma.probe.findUnique.mockResolvedValue(probeRow);
            redis.getJson.mockResolvedValue({
                probeId: 'probe-1',
                nonce: 'nonce-123',
                issuedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            });

            const result = await service.pullForSecret('tnt_good');

            expect(prisma.probe.findUnique).toHaveBeenCalledWith({
                where: { secret: 'tnt_good' },
                select: { id: true, secret: true, enabled: true },
            });
            expect(result).toMatchObject({
                validation: {
                    validationId: 'probe-1',
                    expiresAt: expect.any(String),
                },
            });

            const plaintext = decryptJson(
                deriveKey('tnt_good'),
                (
                    result as {
                        validation: {
                            challenge: {
                                iv: string;
                                tag: string;
                                data: string;
                            };
                        };
                    }
                ).validation.challenge,
            ) as { nonce: string };
            expect(plaintext.nonce).toBe('nonce-123');
        });

        it('returns null when no validation is pending', async () => {
            const { service, prisma, redis } = createService();
            prisma.probe.findUnique.mockResolvedValue(probeRow);
            redis.getJson.mockResolvedValue(null);

            await expect(service.pullForSecret('tnt_good')).resolves.toEqual({
                validation: null,
            });
        });

        it('rejects an unknown secret', async () => {
            const { service, prisma } = createService();
            prisma.probe.findUnique.mockResolvedValue(null);

            await expect(service.pullForSecret('nope')).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });

    describe('answerForSecret', () => {
        it('verifies the encrypted answer and marks the probe online', async () => {
            const { service, prisma, redis } = createService();
            prisma.probe.findUnique.mockResolvedValue(probeRow);
            prisma.probe.update.mockResolvedValue(probeRow);
            redis.getJson.mockResolvedValue({
                probeId: 'probe-1',
                nonce: 'nonce-123',
                issuedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            });

            const answer = encryptJson(deriveKey('tnt_good'), {
                nonce: 'nonce-123',
                answeredAt: new Date().toISOString(),
            });

            const result = await service.answerForSecret(
                'tnt_good',
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
            prisma.probe.findUnique.mockResolvedValue(probeRow);
            redis.getJson.mockResolvedValue({
                probeId: 'probe-1',
                nonce: 'expected-nonce',
                issuedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            });

            const answer = encryptJson(deriveKey('tnt_good'), {
                nonce: 'wrong-nonce',
                answeredAt: new Date().toISOString(),
            });

            await expect(
                service.answerForSecret('tnt_good', 'probe-1', answer),
            ).rejects.toThrow(BadRequestException);
        });

        it('rejects when no challenge is pending', async () => {
            const { service, prisma, redis } = createService();
            prisma.probe.findUnique.mockResolvedValue(probeRow);
            redis.getJson.mockResolvedValue(null);

            const answer = encryptJson(deriveKey('tnt_good'), {
                nonce: 'nonce',
                answeredAt: new Date().toISOString(),
            });

            await expect(
                service.answerForSecret('tnt_good', 'probe-1', answer),
            ).rejects.toThrow(
                'Validation challenge not found or already answered',
            );
        });
    });
});

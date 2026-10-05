import {
    BadRequestException,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import {
    createCipheriv,
    createDecipheriv,
    hkdfSync,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto';
import { PrismaService } from '../../infra/database/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import {
    ExecutionStatus,
    ExecutionTrigger,
    ProbeScope,
    ProbeStatus,
} from '../../generated/prisma/enums';

const VALIDATION_INFO = Buffer.from('beacon-probe-validation-v1', 'utf8');
const VALIDATION_TTL_SECONDS = 120;
const VALIDATION_KEY_PREFIX = 'probe:validation:';

export interface ProbeValidationCipher {
    iv: string;
    tag: string;
    data: string;
}

interface StoredValidation {
    probeId: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
}

interface ChallengePlaintext {
    nonce: string;
    issuedAt: string;
}

interface AnswerPlaintext {
    nonce: string;
    answeredAt: string;
}

@Injectable()
export class ProbeValidationService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
    ) {}

    /** Manual trigger for a tenant probe (admin/org scope). */
    async triggerForTenant(orgId: string, probeId: string) {
        const probe = await this.requireTenantProbe(orgId, probeId);
        return this.createChallenge(probe);
    }

    /** Manual trigger for a system probe (SUPER_ADMIN scope). */
    async triggerForSystem(probeId: string) {
        const probe = await this.requireSystemProbe(probeId);
        return this.createChallenge(probe);
    }

    /** Agent-facing: fetch the pending challenge for the authenticated probe. */
    async pullForSecret(secret: string | undefined) {
        const probe = await this.requireProbeBySecret(secret);
        const stored = await this.readStoredValidation(probe.id);

        if (!stored) return { validation: null };

        const challenge = this.encrypt(this.deriveKey(probe.secret), {
            nonce: stored.nonce,
            issuedAt: stored.issuedAt,
        } satisfies ChallengePlaintext);

        return {
            validation: {
                validationId: stored.probeId,
                challenge,
                expiresAt: stored.expiresAt,
            },
        };
    }

    /** Agent-facing: submit the encrypted answer for a pending challenge. */
    async answerForSecret(
        secret: string | undefined,
        validationId: string,
        answer: ProbeValidationCipher,
    ) {
        const probe = await this.requireProbeBySecret(secret);

        if (validationId !== probe.id) {
            throw new BadRequestException(
                'Validation id does not match this probe',
            );
        }

        const stored = await this.readStoredValidation(probe.id);
        if (!stored) {
            throw new BadRequestException(
                'Validation challenge not found or already answered',
            );
        }

        if (new Date(stored.expiresAt).getTime() <= Date.now()) {
            await this.redis.del(this.validationKey(probe.id));
            throw new BadRequestException('Validation challenge expired');
        }

        let plaintext: AnswerPlaintext;
        try {
            const decrypted = this.decrypt(
                this.deriveKey(probe.secret),
                answer,
            );
            plaintext = JSON.parse(decrypted) as AnswerPlaintext;
        } catch {
            throw new BadRequestException('Invalid encrypted answer');
        }

        if (
            !plaintext ||
            typeof plaintext.nonce !== 'string' ||
            typeof plaintext.answeredAt !== 'string' ||
            !this.safeEqual(plaintext.nonce, stored.nonce)
        ) {
            throw new BadRequestException('Validation answer nonce mismatch');
        }

        if (Number.isNaN(Date.parse(plaintext.answeredAt))) {
            throw new BadRequestException('Validation answer has invalid time');
        }

        await this.redis.del(this.validationKey(probe.id));

        await this.prisma.probe.update({
            where: { id: probe.id },
            data: {
                lastHeartbeat: new Date(),
                status: ProbeStatus.ONLINE,
            },
        });

        await this.writeValidationExecution(probe.id, true, null);

        return {
            validationId,
            ok: true,
            status: 'SUCCESS',
            checkedAt: new Date().toISOString(),
        };
    }

    // -- Helpers ---------------------------------------------------------

    private async createChallenge(probe: { id: string; secret: string }) {
        const nonce = randomBytes(32).toString('hex');
        const issuedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + VALIDATION_TTL_SECONDS * 1000);

        const stored: StoredValidation = {
            probeId: probe.id,
            nonce,
            issuedAt,
            expiresAt: expiresAt.toISOString(),
        };

        await this.redis.setJson(
            this.validationKey(probe.id),
            stored,
            VALIDATION_TTL_SECONDS,
        );

        const challenge = this.encrypt(this.deriveKey(probe.secret), {
            nonce,
            issuedAt,
        } satisfies ChallengePlaintext);

        return {
            validationId: probe.id,
            challenge,
            expiresAt: stored.expiresAt,
            status: 'PENDING',
        };
    }

    private async readStoredValidation(
        probeId: string,
    ): Promise<StoredValidation | null> {
        const stored = await this.redis.getJson<StoredValidation>(
            this.validationKey(probeId),
        );

        if (!stored || stored.probeId !== probeId) return null;

        if (new Date(stored.expiresAt).getTime() <= Date.now()) {
            await this.redis.del(this.validationKey(probeId));
            return null;
        }

        return stored;
    }

    private async requireProbeBySecret(secret: string | undefined) {
        if (!secret || secret.trim() === '') {
            throw new UnauthorizedException('Missing probe secret');
        }

        const probe = await this.prisma.probe.findUnique({
            where: { secret: secret.trim() },
            select: { id: true, secret: true, enabled: true },
        });

        if (!probe) {
            throw new UnauthorizedException('Unknown probe secret');
        }

        if (!probe.enabled) {
            throw new UnauthorizedException('Probe is disabled');
        }

        return probe;
    }

    private async requireTenantProbe(orgId: string, probeId: string) {
        const probe = await this.prisma.probe.findFirst({
            where: {
                id: probeId,
                organizationId: orgId,
                scope: ProbeScope.TENANT,
            },
            select: { id: true, secret: true, enabled: true },
        });

        if (!probe) {
            throw new NotFoundException('Probe not found');
        }

        return probe;
    }

    private async requireSystemProbe(probeId: string) {
        const probe = await this.prisma.probe.findFirst({
            where: { id: probeId, scope: ProbeScope.SYSTEM },
            select: { id: true, secret: true, enabled: true },
        });

        if (!probe) {
            throw new NotFoundException('System probe not found');
        }

        return probe;
    }

    private async writeValidationExecution(
        probeId: string,
        success: boolean,
        error: string | null,
    ): Promise<void> {
        await this.prisma.probeExecution.create({
            data: {
                probeId,
                monitorId: null,
                target: 'validation',
                trigger: ExecutionTrigger.MANUAL,
                status: success
                    ? ExecutionStatus.SUCCESS
                    : ExecutionStatus.FAILED,
                success,
                latency: null,
                error,
                requestMeta: { validationId: probeId },
                responseMeta: { ok: success },
            },
        });
    }

    private validationKey(probeId: string): string {
        return `${VALIDATION_KEY_PREFIX}${probeId}`;
    }

    private deriveKey(token: string): Buffer {
        return Buffer.from(
            hkdfSync(
                'sha256',
                Buffer.from(token, 'utf8'),
                Buffer.alloc(0),
                VALIDATION_INFO,
                32,
            ),
        );
    }

    private encrypt(key: Buffer, value: unknown): ProbeValidationCipher {
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

    private decrypt(key: Buffer, payload: ProbeValidationCipher): string {
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

        return plaintext.toString('utf8');
    }

    private safeEqual(left: string, right: string): boolean {
        const leftBuffer = Buffer.from(left);
        const rightBuffer = Buffer.from(right);

        if (leftBuffer.length !== rightBuffer.length) return false;

        return timingSafeEqual(leftBuffer, rightBuffer);
    }
}

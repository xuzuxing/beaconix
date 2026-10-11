import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../infra/database/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import {
    GlobalRole,
    MembershipRole,
    ProbeProvider,
} from '../../generated/prisma/enums';
import { ProbesService } from './probes.service';
import { hashSecret } from './probe-secret.util';
import type {
    ApproveEnrollmentDto,
    CreateEnrollTokenDto,
    CreateProbeDto,
    DeviceAuthorizationDto,
    RedeemEnrollmentDto,
} from './dto';

/** Lifetime of a device authorization request. */
const DEVICE_CODE_TTL_SECONDS = 600;

/** Poll interval the CLI is told to honour. */
const DEVICE_POLL_INTERVAL_SECONDS = 5;

/** The credential is only held briefly until the CLI collects it. */
const CREDENTIAL_TTL_SECONDS = 60;

/** Lifetime of a web-issued one-time install token. */
const ENROLL_TOKEN_TTL_SECONDS = 900;

const DC_PREFIX = 'probe:enroll:dc:';
const UC_PREFIX = 'probe:enroll:uc:';
const CRED_PREFIX = 'probe:enroll:cred:';
const TOKEN_PREFIX = 'probe:enroll:tok:';

const ENROLL_TOKEN_PREFIX = 'bet_';

/** User-code alphabet with easily confused characters removed. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

/** Organization roles allowed to approve an enrollment. */
const APPROVER_ROLES: MembershipRole[] = [
    MembershipRole.OWNER,
    MembershipRole.ADMIN,
];

export interface EnrollmentClient {
    client?: string;
    hostname?: string;
    platform?: string;
    runtime?: string;
}

interface DeviceState {
    status: 'pending' | 'approved' | 'denied';
    userCodeHash: string;
    client: EnrollmentClient;
    organizationId?: string;
    probeId?: string;
    createdAt: string;
}

export interface EnrollmentCredential {
    probeId: string;
    secret: string;
    apiUrl: string;
}

interface EnrollGrant {
    organizationId: string;
    createdById: string;
    name?: string;
    provider?: ProbeProvider;
    region?: string;
}

function generateUserCode(): string {
    const bytes = randomBytes(8);
    let code = '';
    for (const byte of bytes) {
        code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Normalises a user code so `wdjb-mjht` and `WDJBMJHT` match. */
function normalizeUserCode(code: string): string {
    return code
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '');
}

@Injectable()
export class ProbeEnrollmentService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        private readonly probesService: ProbesService,
    ) {}

    // -- Path A: device authorization grant (RFC 8628) -------------------

    async startDeviceAuthorization(dto: DeviceAuthorizationDto) {
        const deviceCode = randomBytes(32).toString('hex');
        const userCode = generateUserCode();
        const userCodeHash = hashSecret(normalizeUserCode(userCode));

        const state: DeviceState = {
            status: 'pending',
            userCodeHash,
            client: {
                client: dto.client,
                hostname: dto.hostname,
                platform: dto.platform,
                runtime: dto.runtime,
            },
            createdAt: new Date().toISOString(),
        };

        await this.redis.setJson(
            `${DC_PREFIX}${deviceCode}`,
            state,
            DEVICE_CODE_TTL_SECONDS,
        );
        await this.redis.set(
            `${UC_PREFIX}${userCodeHash}`,
            deviceCode,
            DEVICE_CODE_TTL_SECONDS,
        );

        const verificationUri = this.activationUrl();

        return {
            deviceCode,
            userCode,
            verificationUri,
            verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
            expiresIn: DEVICE_CODE_TTL_SECONDS,
            interval: DEVICE_POLL_INTERVAL_SECONDS,
        };
    }

    /** The CLI polls this; the credential is handed over exactly once. */
    async pollDeviceToken(deviceCode: string) {
        const state = await this.readDeviceState(deviceCode);
        if (!state) return { status: 'expired' as const };

        if (state.status === 'denied') return { status: 'denied' as const };
        if (state.status !== 'approved') return { status: 'pending' as const };

        const credential = await this.redis.consumeJson<EnrollmentCredential>(
            `${CRED_PREFIX}${deviceCode}`,
        );

        // No credential left means the CLI already collected it.
        return credential
            ? { status: 'approved' as const, credential }
            : { status: 'approved' as const };
    }

    /** Data for the SPA confirmation page. */
    async describeActivation(userCode: string) {
        const deviceCode = await this.redis.get(
            `${UC_PREFIX}${hashSecret(normalizeUserCode(userCode))}`,
        );
        if (!deviceCode) {
            throw new NotFoundException('Unknown or expired user code');
        }

        const state = await this.readDeviceState(deviceCode);
        if (!state) {
            throw new NotFoundException('Enrollment request expired');
        }

        return {
            userCode,
            status: state.status,
            requestedAt: state.createdAt,
            client: state.client,
        };
    }

    /** The user confirms in the browser; the probe is created here. */
    async approve(
        userId: string,
        globalRole: GlobalRole,
        dto: ApproveEnrollmentDto,
    ) {
        await this.assertCanApprove(userId, globalRole, dto.organizationId);

        const userCodeHash = hashSecret(normalizeUserCode(dto.userCode));
        const deviceCode = await this.redis.get(`${UC_PREFIX}${userCodeHash}`);
        if (!deviceCode) {
            throw new BadRequestException('Unknown or expired user code');
        }

        const state = await this.readDeviceState(deviceCode);
        if (!state) {
            throw new BadRequestException('Enrollment request expired');
        }
        if (state.status !== 'pending') {
            throw new BadRequestException(
                `Enrollment request is already ${state.status}`,
            );
        }

        const probe = await this.probesService.create(
            dto.organizationId,
            this.buildCreateDto({
                name: dto.name,
                provider: dto.provider,
                region: dto.region,
                client: state.client,
            }),
            userId,
        );

        if (!probe.secret) {
            throw new Error('Probe creation did not return a secret');
        }

        await this.redis.setJson(
            `${CRED_PREFIX}${deviceCode}`,
            {
                probeId: probe.id,
                secret: probe.secret,
                apiUrl: this.publicApiUrl(),
            } satisfies EnrollmentCredential,
            CREDENTIAL_TTL_SECONDS,
        );

        await this.redis.setJson(
            `${DC_PREFIX}${deviceCode}`,
            {
                ...state,
                status: 'approved',
                organizationId: dto.organizationId,
                probeId: probe.id,
            } satisfies DeviceState,
            DEVICE_CODE_TTL_SECONDS,
        );

        return {
            probeId: probe.id,
            organizationId: dto.organizationId,
            status: 'approved' as const,
        };
    }

    // -- Path B: web-issued one-time install token -----------------------

    async createEnrollToken(
        userId: string,
        globalRole: GlobalRole,
        organizationId: string,
        dto: CreateEnrollTokenDto,
    ) {
        await this.assertCanApprove(userId, globalRole, organizationId);

        const token = `${ENROLL_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;

        await this.redis.setJson(
            `${TOKEN_PREFIX}${token}`,
            {
                organizationId,
                createdById: userId,
                name: dto.name,
                provider: dto.provider,
                region: dto.region,
            } satisfies EnrollGrant,
            ENROLL_TOKEN_TTL_SECONDS,
        );

        // The command carries the API address so the installed probe talks to
        // this deployment rather than falling back to a built-in default.
        const command =
            `curl -fsSL ${this.downloadBase()}/install.sh | sudo sh -s -- ` +
            `--token=${token} --api-url=${this.publicApiUrl()}`;

        return {
            token,
            expiresAt: new Date(
                Date.now() + ENROLL_TOKEN_TTL_SECONDS * 1000,
            ).toISOString(),
            command,
            apiUrl: this.publicApiUrl(),
        };
    }

    /** Consumes the token (one-time) and returns a fresh probe credential. */
    async redeem(dto: RedeemEnrollmentDto) {
        const grant = await this.redis.consumeJson<EnrollGrant>(
            `${TOKEN_PREFIX}${dto.token.trim()}`,
        );
        if (!grant) {
            throw new UnauthorizedException(
                'Unknown or already used enrollment token',
            );
        }

        const probe = await this.probesService.create(
            grant.organizationId,
            this.buildCreateDto({
                name: grant.name,
                provider: grant.provider,
                region: grant.region,
                client: {
                    hostname: dto.hostname,
                    platform: dto.platform,
                    runtime: dto.runtime,
                },
            }),
            grant.createdById,
        );

        if (!probe.secret) {
            throw new Error('Probe creation did not return a secret');
        }

        return {
            probeId: probe.id,
            secret: probe.secret,
            apiUrl: this.publicApiUrl(),
        } satisfies EnrollmentCredential;
    }

    // -- Helpers ---------------------------------------------------------

    private async readDeviceState(deviceCode: string) {
        return this.redis.getJson<DeviceState>(`${DC_PREFIX}${deviceCode}`);
    }

    private async assertCanApprove(
        userId: string,
        globalRole: GlobalRole,
        organizationId: string,
    ) {
        if (globalRole === GlobalRole.SUPER_ADMIN) return;

        const membership = await this.prisma.membership.findFirst({
            where: {
                userId,
                organizationId,
                role: { in: APPROVER_ROLES },
            },
            select: { id: true },
        });

        if (!membership) {
            throw new ForbiddenException(
                'Requires ADMIN in the target organization',
            );
        }
    }

    private buildCreateDto(input: {
        name?: string;
        provider?: ProbeProvider;
        region?: string;
        client: EnrollmentClient;
    }): CreateProbeDto {
        const host =
            input.client.hostname ||
            input.client.client ||
            randomBytes(4).toString('hex');

        return {
            name: input.name || `Enrolled probe (${host})`,
            provider: input.provider ?? ProbeProvider.CUSTOM,
            region: input.region || input.client.platform || 'unknown',
            // Probes are outbound-only; the callback URL is a placeholder that
            // satisfies the schema and identifies the enrolled host.
            callbackUrl: `https://probe.beacon.dev/${encodeURIComponent(host)}`,
            enabled: true,
        };
    }

    private activationUrl(): string {
        return (
            process.env.BEACON_ACTIVATE_URL || 'https://app.beacon.dev/activate'
        );
    }

    private publicApiUrl(): string {
        return (
            process.env.BEACON_PUBLIC_API_URL || 'https://api.beacon.dev/api'
        ).replace(/\/+$/, '');
    }

    private downloadBase(): string {
        return (
            process.env.BEACON_DOWNLOAD_BASE || 'https://get.beacon.dev/probe'
        ).replace(/\/+$/, '');
    }
}

import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../infra/database/prisma.service';
import type {
    ApiKeyModel,
    PersonalAccessTokenModel,
} from '../../../generated/prisma/models';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { CreateApiKeyDto, CreatePersonalAccessTokenDto } from './dto';
import { ApiKeyEntity, PersonalAccessTokenEntity } from './entities';
import {
    API_KEY_PREFIX,
    generateToken,
    hashToken,
    PAT_PREFIX,
    toKeyPrefix,
} from '../common/credentials.util';
import { QuotaService } from '../../../shared/quota/quota.service';
import { API_SCOPES } from '../common/scopes';

/** Default PAT lifetime when no expiry is provided. */
const DEFAULT_PAT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap so a PAT can never outlive a reasonable rotation window. */
const MAX_PAT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

@Injectable()
export class ApiCredentialsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly quotaService: QuotaService,
    ) {}

    // -- Organization API keys -------------------------------------------

    async createApiKey(
        orgId: string,
        createdById: string,
        dto: CreateApiKeyDto,
    ): Promise<ApiKeyEntity> {
        await this.quotaService.assertCanCreate(orgId, 'apiKeys');

        if (dto.expiresAt && new Date(dto.expiresAt) <= new Date()) {
            throw new BadRequestException('expiresAt must be in the future');
        }

        const rawKey = generateToken(API_KEY_PREFIX);
        const record = await this.prisma.apiKey.create({
            data: {
                organizationId: orgId,
                name: dto.name,
                keyPrefix: toKeyPrefix(rawKey),
                keyHash: hashToken(rawKey),
                scopes: dto.scopes,
                expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
                createdById,
            },
        });

        return new ApiKeyEntity({
            ...this.toApiKeyEntity(record),
            key: rawKey,
        });
    }

    async listApiKeys(orgId: string): Promise<ApiKeyEntity[]> {
        const keys = await this.prisma.apiKey.findMany({
            where: { organizationId: orgId },
            orderBy: { createdAt: 'desc' },
        });

        return keys.map((key) => this.toApiKeyEntity(key));
    }

    async revokeApiKey(orgId: string, id: string): Promise<ApiKeyEntity> {
        const key = await this.prisma.apiKey.findFirst({
            where: { id, organizationId: orgId },
        });
        if (!key) throw new NotFoundException('API key not found');
        if (key.revokedAt) {
            throw new BadRequestException('API key is already revoked');
        }

        const revoked = await this.prisma.apiKey.update({
            where: { id },
            data: { revokedAt: new Date() },
        });

        return this.toApiKeyEntity(revoked);
    }

    /** Look up a valid API key by its raw secret; null when unknown/invalid. */
    async findValidApiKey(rawKey: string): Promise<ApiKeyModel | null> {
        if (!rawKey.startsWith(API_KEY_PREFIX)) return null;

        const key = await this.prisma.apiKey.findUnique({
            where: { keyHash: hashToken(rawKey) },
        });
        if (!key || key.revokedAt) return null;
        if (key.expiresAt && key.expiresAt <= new Date()) return null;
        return key;
    }

    /** Fire-and-forget lastUsedAt refresh. */
    touchApiKey(id: string): void {
        void this.prisma.apiKey
            .update({ where: { id }, data: { lastUsedAt: new Date() } })
            .catch(() => undefined);
    }

    /** Look up a valid PAT by id; null when unknown/revoked/expired. */
    async findValidPatById(
        id: string,
    ): Promise<PersonalAccessTokenModel | null> {
        const token = await this.prisma.personalAccessToken.findUnique({
            where: { id },
        });
        if (!token || token.revokedAt) return null;
        if (token.expiresAt && token.expiresAt <= new Date()) return null;
        return token;
    }

    /** Fire-and-forget lastUsedAt refresh. */
    touchPat(id: string): void {
        void this.prisma.personalAccessToken
            .update({ where: { id }, data: { lastUsedAt: new Date() } })
            .catch(() => undefined);
    }

    // -- User personal access tokens -------------------------------------

    async createPersonalAccessToken(
        user: JwtPayload,
        dto: CreatePersonalAccessTokenDto,
    ): Promise<PersonalAccessTokenEntity> {
        const expiresAt = dto.expiresAt
            ? new Date(dto.expiresAt)
            : new Date(Date.now() + DEFAULT_PAT_TTL_MS);

        if (expiresAt <= new Date()) {
            throw new BadRequestException('expiresAt must be in the future');
        }
        if (expiresAt.getTime() > Date.now() + MAX_PAT_TTL_MS) {
            throw new BadRequestException(
                'expiresAt must be within one year from now',
            );
        }

        const rawToken = generateToken(PAT_PREFIX);
        const record = await this.prisma.personalAccessToken.create({
            data: {
                userId: user.sub,
                name: dto.name,
                tokenHash: hashToken(rawToken),
                // Omitted scopes mean full access on the developer API.
                scopes: dto.scopes ?? [...API_SCOPES],
                expiresAt,
            },
        });

        // PATs are revocable user JWTs. Existing JWT-protected endpoints keep
        // working unchanged; JwtAuthGuard checks revocation for kind === 'pat'.
        const expiresInSeconds = Math.max(
            1,
            Math.floor((expiresAt.getTime() - Date.now()) / 1000),
        );
        const accessToken = await this.jwtService.signAsync(
            {
                sub: user.sub,
                email: user.email,
                globalRole: user.globalRole,
                kind: 'pat',
                patId: record.id,
            },
            { expiresIn: expiresInSeconds },
        );

        return new PersonalAccessTokenEntity({
            ...this.toPatEntity(record),
            token: accessToken,
        });
    }

    async listPersonalAccessTokens(
        userId: string,
    ): Promise<PersonalAccessTokenEntity[]> {
        const tokens = await this.prisma.personalAccessToken.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });

        return tokens.map((token) => this.toPatEntity(token));
    }

    async revokePersonalAccessToken(
        userId: string,
        id: string,
    ): Promise<PersonalAccessTokenEntity> {
        const token = await this.prisma.personalAccessToken.findFirst({
            where: { id, userId },
        });
        if (!token)
            throw new NotFoundException('Personal access token not found');
        if (token.revokedAt) {
            throw new BadRequestException(
                'Personal access token is already revoked',
            );
        }

        const revoked = await this.prisma.personalAccessToken.update({
            where: { id },
            data: { revokedAt: new Date() },
        });

        return this.toPatEntity(revoked);
    }

    // -- Mapping (never expose keyHash/tokenHash) -------------------------

    private toApiKeyEntity(record: ApiKeyModel): ApiKeyEntity {
        return new ApiKeyEntity({
            id: record.id,
            organizationId: record.organizationId,
            name: record.name,
            keyPrefix: record.keyPrefix,
            scopes: record.scopes,
            expiresAt: record.expiresAt,
            lastUsedAt: record.lastUsedAt,
            revokedAt: record.revokedAt,
            createdById: record.createdById,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        });
    }

    private toPatEntity(
        record: PersonalAccessTokenModel,
    ): PersonalAccessTokenEntity {
        return new PersonalAccessTokenEntity({
            id: record.id,
            userId: record.userId,
            name: record.name,
            scopes: record.scopes,
            expiresAt: record.expiresAt,
            lastUsedAt: record.lastUsedAt,
            revokedAt: record.revokedAt,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        });
    }
}

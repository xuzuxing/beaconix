import {
    ForbiddenException,
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../../../infra/database/prisma.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import { MiniprogramClient } from '../../../infra/wechat/miniprogram';
import { OfficialAccountClient } from '../../../infra/wechat/official-account';
import { WechatRuntimeConfigService } from '../../../infra/wechat/wechat-runtime-config.service';
import type { UserModel } from '../../../generated/prisma/models';
import { Prisma } from '../../../generated/prisma/client';
import { IdentityProvider } from '../../../generated/prisma/enums';
import { WechatMiniProgramConfig, WechatWebsiteConfig } from '../../../config';
import {
    WechatAuthorizeUrlDto,
    WechatWebLoginDto,
    WechatMiniProgramLoginDto,
} from './dto';
import { AuthService } from '../auth.service';
import type { RequestMeta } from '../../../common/interfaces';

@Injectable()
export class WechatAuthService {
    private readonly logger = new Logger(WechatAuthService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly runtimeConfig: WechatRuntimeConfigService,
        private readonly organizationsService: OrganizationsService,
        private readonly miniprogramClient: MiniprogramClient,
        private readonly officialAccountClient: OfficialAccountClient,
        private readonly authService: AuthService,
    ) {}

    /** Builds the Open Platform QR-connect URL for web scan-to-login. */
    async getWebAuthorizeUrl(dto: WechatAuthorizeUrlDto) {
        return {
            url: await this.officialAccountClient.buildQrConnectUrl({
                redirectUri: dto.redirectUri,
                state: dto.state,
            }),
        };
    }

    /**
     * Completes a website-app QR scan login. The frontend receives the `code`
     * on its redirect URL and posts it here; the server exchanges it and
     * fetches the WeChat profile (snsapi_login scope).
     */
    async webLogin(dto: WechatWebLoginDto, meta: RequestMeta) {
        const config = await this.websiteConfig();

        const token = await this.officialAccountClient.exchangeCodeForToken({
            code: dto.code,
            appId: config.appId,
            appSecret: config.appSecret,
        });

        const profile = await this.officialAccountClient.getUserInfo({
            accessToken: token.accessToken,
            openid: token.openid,
        });

        const { user, isNewUser } = await this.findOrCreateUser({
            provider: IdentityProvider.WECHAT_WEB,
            openid: token.openid,
            unionid: token.unionid ?? profile.unionid,
            nickname: profile.nickname,
            avatarUrl: profile.headimgurl,
        });

        return this.finishLogin(user, isNewUser, meta);
    }

    /** Completes a mini-program `wx.login()` code2Session login. */
    async miniProgramLogin(dto: WechatMiniProgramLoginDto, meta: RequestMeta) {
        const { user, isNewUser } = await this.resolveMiniProgramUser(dto);

        return this.finishLogin(user, isNewUser, meta);
    }

    /**
     * Resolves (and provisions) the user behind a mini-program login without
     * issuing tokens — used by the scan-login flow, which decides separately
     * whether the second factor is required.
     */
    async resolveMiniProgramUser(dto: WechatMiniProgramLoginDto) {
        const config = await this.miniprogramConfig();

        const session = await this.miniprogramClient.code2Session({
            appId: config.appId,
            appSecret: config.appSecret,
            code: dto.code,
        });

        return this.findOrCreateUser({
            provider: IdentityProvider.WECHAT_MINI,
            openid: session.openid,
            unionid: session.unionid,
            nickname: dto.nickname,
            avatarUrl: dto.avatarUrl,
        });
    }

    // ─── Config ───────────────────────────────────────────────────────

    private async miniprogramConfig(): Promise<WechatMiniProgramConfig> {
        const wechat = await this.runtimeConfig.config();

        if (!wechat.miniprogram.appId || !wechat.miniprogram.appSecret) {
            throw new ServiceUnavailableException(
                'WeChat mini program login is not configured (WECHAT_MINI_APPID / WECHAT_MINI_APPSECRET)',
            );
        }

        return wechat.miniprogram;
    }

    private async websiteConfig(): Promise<WechatWebsiteConfig> {
        const wechat = await this.runtimeConfig.config();

        if (!wechat.website.appId || !wechat.website.appSecret) {
            throw new ServiceUnavailableException(
                'WeChat website login is not configured (WECHAT_WEB_APPID / WECHAT_WEB_APPSECRET)',
            );
        }

        return wechat.website;
    }

    // ─── User resolution ──────────────────────────────────────────────

    /**
     * Resolves the Beacon user behind a WeChat identity, or provisions a new
     * one (with its starter organization) on first login.
     */
    private async findOrCreateUser(input: {
        provider: IdentityProvider;
        openid: string;
        unionid?: string;
        nickname?: string;
        avatarUrl?: string;
    }): Promise<{ user: UserModel; isNewUser: boolean }> {
        const existing = await this.findUserByIdentity(input);

        if (existing) {
            if (!existing.isActive) {
                throw new ForbiddenException('Account is deactivated');
            }
            if (existing.deletedAt) {
                throw new ForbiddenException('Account is deactivated');
            }

            await this.ensureUserIdentity(existing.id, input);

            return { user: existing, isNewUser: false };
        }

        const email = this.buildWechatEmail(input.provider, input.openid);
        const name = this.buildWechatName(input.nickname, input.openid);
        const password = await bcrypt.hash(
            crypto.randomBytes(32).toString('hex'),
            12,
        );

        try {
            const user = await this.prisma.$transaction(async (tx) => {
                const created = await tx.user.create({
                    data: {
                        email,
                        password,
                        name,
                        avatarUrl: input.avatarUrl ?? null,
                        emailVerified: false,
                    },
                });

                await tx.userIdentity.create({
                    data: {
                        userId: created.id,
                        provider: input.provider,
                        openid: input.openid,
                        unionid: input.unionid ?? null,
                        nickname: input.nickname ?? null,
                        avatarUrl: input.avatarUrl ?? null,
                    },
                });

                await this.organizationsService.provisionForUser(
                    {
                        id: created.id,
                        name: created.name,
                        email: created.email,
                    },
                    tx,
                );

                return created;
            });

            this.logger.log(
                `WeChat user created via ${input.provider}: ${this.maskEmail(user.email)}`,
            );

            return { user, isNewUser: true };
        } catch (error) {
            // A concurrent first login can race on the unique identity or
            // placeholder email; the second request should just log into the
            // winner.
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                const raced = await this.findUserByIdentity(input);
                if (raced) {
                    return { user: raced, isNewUser: false };
                }
            }
            throw error;
        }
    }

    private async findUserByIdentity(input: {
        provider: IdentityProvider;
        openid: string;
        unionid?: string;
    }): Promise<UserModel | null> {
        const byOpenid = await this.prisma.userIdentity.findUnique({
            where: {
                provider_openid: {
                    provider: input.provider,
                    openid: input.openid,
                },
            },
            select: { user: true },
        });
        if (byOpenid?.user) return byOpenid.user;

        if (!input.unionid) return null;

        const byUnionid = await this.prisma.userIdentity.findFirst({
            where: { unionid: input.unionid },
            orderBy: { createdAt: 'asc' },
            select: { user: true },
        });

        return byUnionid?.user ?? null;
    }

    /**
     * Binds (or refreshes) the current provider identity to an existing user.
     * Upserting lets the same user log in from both the website app and the
     * mini program: the first login stores the openid, the second adds its own.
     */
    private async ensureUserIdentity(
        userId: string,
        input: {
            provider: IdentityProvider;
            openid: string;
            unionid?: string;
            nickname?: string;
            avatarUrl?: string;
        },
    ): Promise<void> {
        const updateData: Prisma.UserIdentityUpdateInput = {};
        if (input.unionid) updateData.unionid = input.unionid;
        if (input.nickname) updateData.nickname = input.nickname;
        if (input.avatarUrl) updateData.avatarUrl = input.avatarUrl;

        await this.prisma.userIdentity.upsert({
            where: {
                provider_openid: {
                    provider: input.provider,
                    openid: input.openid,
                },
            },
            update: updateData,
            create: {
                userId,
                provider: input.provider,
                openid: input.openid,
                unionid: input.unionid ?? null,
                nickname: input.nickname ?? null,
                avatarUrl: input.avatarUrl ?? null,
            },
        });
    }

    private async finishLogin(
        user: UserModel,
        isNewUser: boolean,
        meta: RequestMeta,
    ) {
        const auth = await this.authService.issueTokensOrChallenge(user, meta);

        return {
            ...auth,
            isNewUser,
        };
    }

    private buildWechatEmail(
        provider: IdentityProvider,
        openid: string,
    ): string {
        const localPart = `wx_${provider.toLowerCase()}_${openid}`
            .toLowerCase()
            .slice(0, 64);
        return `${localPart}@wechat.local`;
    }

    private buildWechatName(
        nickname: string | undefined,
        openid: string,
    ): string {
        const trimmed = nickname?.trim();
        if (trimmed) {
            return trimmed.slice(0, 64);
        }
        return `微信用户_${openid.slice(-4)}`;
    }

    private maskEmail(email: string): string {
        return email.replace(/^(..)[^@]*/, '$1***');
    }
}

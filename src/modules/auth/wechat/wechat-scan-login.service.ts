import {
    BadRequestException,
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common';
import { toIsoString } from '../../../common/utils/date.util';
import * as crypto from 'crypto';
import { PrismaService } from '../../../infra/database/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { MiniprogramClient } from '../../../infra/wechat/miniprogram';
import { WechatRuntimeConfigService } from '../../../infra/wechat/wechat-runtime-config.service';
import type { WechatMiniProgramEnvVersion } from '../../../infra/wechat/miniprogram';
import {
    WechatMiniProgramConfig,
    WechatScanLoginConfig,
} from '../../../config';
import { AuthService } from '../auth.service';
import { WechatAuthService } from './wechat-auth.service';
import type { RequestMeta } from '../../../common/interfaces';
import {
    CreateWechatScanLoginDto,
    QueryWechatScanLoginStatusDto,
    WechatScanLoginDto,
} from './dto';

const SCAN_LOGIN_KEY_PREFIX = 'wechat:scanlogin:';
const POLL_INTERVAL_MS = 1000;

export type WechatScanLoginTicketStatus = 'PENDING' | 'SCANNED' | 'CONFIRMED';

export interface WechatScanLoginTicket {
    status: WechatScanLoginTicketStatus;
    userId?: string;
    isNewUser?: boolean;
    createdAt: string;
    expiresAt: string;
}

@Injectable()
export class WechatScanLoginService {
    private readonly logger = new Logger(WechatScanLoginService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        private readonly runtimeConfig: WechatRuntimeConfigService,
        private readonly miniprogramClient: MiniprogramClient,
        private readonly wechatAuthService: WechatAuthService,
        private readonly authService: AuthService,
    ) {}

    /** Creates the Redis login ticket and its unlimited mini-program QR code. */
    async createQrCode(dto: CreateWechatScanLoginDto) {
        const config = await this.scanLoginConfig();
        const mini = await this.miniprogramConfig();

        const ticket = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + config.ttlSeconds * 1000);
        const key = this.ticketKey(ticket);

        await this.redis.setJson<WechatScanLoginTicket>(
            key,
            {
                status: 'PENDING',
                createdAt: toIsoString(Date.now()),
                expiresAt: toIsoString(expiresAt),
            },
            config.ttlSeconds,
        );

        try {
            const { buffer, contentType } =
                await this.miniprogramClient.getUnlimitedQrCode({
                    appId: mini.appId,
                    appSecret: mini.appSecret,
                    scene: ticket,
                    page: dto.page ?? config.qrPage,
                    envVersion: this.normalizeEnvVersion(
                        dto.envVersion ?? config.qrEnvVersion,
                    ),
                });

            return {
                ticket,
                qrCodeDataUrl: `data:${contentType};base64,${buffer.toString('base64')}`,
                expiresAt: toIsoString(expiresAt),
                pollUrl: `/api/auth/wechat/miniprogram/qrcode/status?ticket=${ticket}`,
            };
        } catch (error) {
            await this.redis.del(key);
            throw error;
        }
    }

    /**
     * Mini-program side of the scan flow: marks the ticket as scanned, runs
     * the normal code2session login, then marks the ticket confirmed so the
     * waiting web client can pick the session up.
     */
    async scanLogin(dto: WechatScanLoginDto, meta: RequestMeta) {
        const key = this.ticketKey(dto.ticket);
        const current = await this.redis.getJson<WechatScanLoginTicket>(key);

        if (!current) {
            throw new BadRequestException('Login QR code has expired');
        }
        if (current.status === 'CONFIRMED') {
            throw new BadRequestException(
                'Login QR code has already been used',
            );
        }

        if (current.status === 'PENDING') {
            await this.redis.setJson<WechatScanLoginTicket>(
                key,
                { ...current, status: 'SCANNED' },
                this.remainingTtl(current.expiresAt),
            );
        }

        const { user, isNewUser } =
            await this.wechatAuthService.resolveMiniProgramUser({
                code: dto.code,
                nickname: dto.nickname,
                avatarUrl: dto.avatarUrl,
            });

        await this.redis.setJson<WechatScanLoginTicket>(
            key,
            {
                ...current,
                status: 'CONFIRMED',
                userId: user.id,
                isNewUser,
            },
            this.remainingTtl(current.expiresAt),
        );

        this.logger.log(
            `Mini-program scan login confirmed for ticket ${dto.ticket}`,
        );

        // The mini program receives its own login result; when 2FA is on this
        // is a challenge rather than tokens.
        const auth = await this.authService.issueTokensOrChallenge(user, meta);

        return { ...auth, isNewUser };
    }

    /** Web long-poll endpoint: waits until the ticket leaves PENDING/SCANNED. */
    async pollStatus(dto: QueryWechatScanLoginStatusDto, meta: RequestMeta) {
        const config = await this.scanLoginConfig();
        const timeoutMs = Math.min(
            Math.max(dto.timeoutMs ?? config.pollTimeoutMs, 1000),
            30000,
        );
        const key = this.ticketKey(dto.ticket);
        const deadline = Date.now() + timeoutMs;

        for (;;) {
            const current =
                await this.redis.getJson<WechatScanLoginTicket>(key);

            if (!current) {
                return { status: 'EXPIRED' as const };
            }

            if (current.status === 'CONFIRMED') {
                return this.consumeConfirmedTicket(key, meta);
            }

            if (Date.now() >= deadline) {
                return { status: current.status };
            }

            await this.sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
        }
    }

    private async consumeConfirmedTicket(key: string, meta: RequestMeta) {
        const consumed =
            await this.redis.consumeJson<WechatScanLoginTicket>(key);

        if (!consumed || consumed.status !== 'CONFIRMED' || !consumed.userId) {
            return { status: 'EXPIRED' as const };
        }

        const user = await this.prisma.user.findUnique({
            where: { id: consumed.userId },
        });

        if (!user || !user.isActive || user.deletedAt) {
            return { status: 'EXPIRED' as const };
        }

        const auth = await this.authService.issueTokensOrChallenge(user, meta);

        return {
            status: 'CONFIRMED' as const,
            ...auth,
            isNewUser: consumed.isNewUser ?? false,
        };
    }

    private async miniprogramConfig(): Promise<WechatMiniProgramConfig> {
        const wechat = await this.runtimeConfig.config();

        if (!wechat.miniprogram.appId || !wechat.miniprogram.appSecret) {
            throw new ServiceUnavailableException(
                'WeChat mini program is not configured (WECHAT_MINI_APPID / WECHAT_MINI_APPSECRET)',
            );
        }

        return wechat.miniprogram;
    }

    private scanLoginConfig(): Promise<WechatScanLoginConfig> {
        return this.runtimeConfig.scanLogin();
    }

    private ticketKey(ticket: string): string {
        return `${SCAN_LOGIN_KEY_PREFIX}${ticket}`;
    }

    private normalizeEnvVersion(
        envVersion: string,
    ): WechatMiniProgramEnvVersion {
        // WeChat's API expects `develop`; accept the common `developer` alias.
        return envVersion === 'developer'
            ? 'develop'
            : (envVersion as WechatMiniProgramEnvVersion);
    }

    private remainingTtl(expiresAt: string): number {
        const remainingMs = new Date(expiresAt).getTime() - Date.now();
        return Math.max(1, Math.ceil(remainingMs / 1000));
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

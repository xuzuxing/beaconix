import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../infra/database/prisma.service';
import type { RedisService } from '../../../infra/redis/redis.service';
import type { MiniprogramClient } from '../../../infra/wechat/miniprogram';
import type { AuthService } from '../auth.service';
import type { WechatAuthService } from './wechat-auth.service';
import {
    WechatScanLoginService,
    type WechatScanLoginTicket,
} from './wechat-scan-login.service';

function createService() {
    const prisma = {
        user: { findUnique: jest.fn() },
    };
    const redis = {
        setJson: jest.fn().mockResolvedValue(undefined),
        getJson: jest.fn(),
        del: jest.fn().mockResolvedValue(undefined),
        consumeJson: jest.fn(),
    };
    const configService = {
        get: jest.fn().mockReturnValue({
            miniprogram: { appId: 'wx-mp', appSecret: 'mp-secret' },
            scanLogin: {
                qrPage: '',
                qrEnvVersion: 'release',
                ttlSeconds: 300,
                pollTimeoutMs: 25000,
            },
        }),
    };
    const miniprogramClient = {
        getUnlimitedQrCode: jest.fn(),
    };
    const wechatAuthService = {
        miniProgramLogin: jest.fn(),
    };
    const authService = {
        issueTokensForUser: jest.fn(),
    };

    const service = new WechatScanLoginService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        configService as unknown as ConfigService,
        miniprogramClient as unknown as MiniprogramClient,
        wechatAuthService as unknown as WechatAuthService,
        authService as unknown as AuthService,
    );

    return {
        service,
        prisma,
        redis,
        miniprogramClient,
        wechatAuthService,
        authService,
    };
}

describe('WechatScanLoginService', () => {
    describe('createQrCode', () => {
        it('stores a PENDING ticket and returns the QR data URL', async () => {
            const { service, redis, miniprogramClient } = createService();
            miniprogramClient.getUnlimitedQrCode.mockResolvedValue({
                buffer: Buffer.from('png'),
                contentType: 'image/png',
            });

            const result = await service.createQrCode({});

            expect(redis.setJson).toHaveBeenCalledWith(
                expect.stringContaining('wechat:scanlogin:'),
                expect.objectContaining({ status: 'PENDING' }),
                300,
            );
            expect(miniprogramClient.getUnlimitedQrCode).toHaveBeenCalledWith(
                expect.objectContaining({
                    appId: 'wx-mp',
                    appSecret: 'mp-secret',
                    scene: expect.any(String),
                    page: '',
                    envVersion: 'release',
                }),
            );
            expect(result.qrCodeDataUrl).toBe('data:image/png;base64,cG5n');
            expect(result.ticket).toMatch(/^[0-9a-f]{32}$/);
        });

        it('deletes the Redis ticket when QR generation fails', async () => {
            const { service, redis, miniprogramClient } = createService();
            miniprogramClient.getUnlimitedQrCode.mockRejectedValue(
                new Error('wechat down'),
            );

            await expect(service.createQrCode({})).rejects.toThrow(
                'wechat down',
            );
            expect(redis.del).toHaveBeenCalled();
        });

        it('normalizes the `developer` envVersion alias to `develop`', async () => {
            const { service, miniprogramClient } = createService();
            miniprogramClient.getUnlimitedQrCode.mockResolvedValue({
                buffer: Buffer.from('png'),
                contentType: 'image/png',
            });

            await service.createQrCode({ envVersion: 'developer' });

            expect(miniprogramClient.getUnlimitedQrCode).toHaveBeenCalledWith(
                expect.objectContaining({ envVersion: 'develop' }),
            );
        });
    });

    describe('scanLogin', () => {
        it('rejects an expired ticket', async () => {
            const { service, redis } = createService();
            redis.getJson.mockResolvedValue(null);

            await expect(
                service.scanLogin({ ticket: 'a'.repeat(32), code: 'code' }),
            ).rejects.toThrow(BadRequestException);
        });

        it('marks the ticket confirmed after a successful code2session login', async () => {
            const { service, redis, wechatAuthService } = createService();
            const pending: WechatScanLoginTicket = {
                status: 'PENDING',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
            redis.getJson.mockResolvedValue(pending);
            wechatAuthService.miniProgramLogin.mockResolvedValue({
                accessToken: 'at',
                refreshToken: 'rt',
                user: { id: 'user-1' },
                isNewUser: true,
            });

            const result = await service.scanLogin({
                ticket: 'a'.repeat(32),
                code: 'code',
            });

            expect(wechatAuthService.miniProgramLogin).toHaveBeenCalledWith({
                code: 'code',
                nickname: undefined,
                avatarUrl: undefined,
            });
            expect(redis.setJson).toHaveBeenCalledWith(
                expect.stringContaining('wechat:scanlogin:'),
                expect.objectContaining({
                    status: 'CONFIRMED',
                    userId: 'user-1',
                    isNewUser: true,
                }),
                expect.any(Number),
            );
            expect(result.accessToken).toBe('at');
        });
    });

    describe('pollStatus', () => {
        it('returns EXPIRED when the ticket is missing', async () => {
            const { service, redis } = createService();
            redis.getJson.mockResolvedValue(null);

            await expect(
                service.pollStatus({ ticket: 'a'.repeat(32) }),
            ).resolves.toEqual({ status: 'EXPIRED' });
        });

        it('consumes a CONFIRMED ticket and issues web tokens', async () => {
            const { service, redis, prisma, authService } = createService();
            const confirmed: WechatScanLoginTicket = {
                status: 'CONFIRMED',
                userId: 'user-1',
                isNewUser: false,
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
            redis.getJson.mockResolvedValue(confirmed);
            redis.consumeJson.mockResolvedValue(confirmed);
            prisma.user.findUnique.mockResolvedValue({
                id: 'user-1',
                email: 'wx@wechat.local',
                globalRole: 'USER',
                isActive: true,
                deletedAt: null,
            });
            authService.issueTokensForUser.mockResolvedValue({
                accessToken: 'web-at',
                refreshToken: 'web-rt',
                user: { id: 'user-1' },
            });

            const result = await service.pollStatus({
                ticket: 'a'.repeat(32),
            });

            expect(redis.consumeJson).toHaveBeenCalledWith(
                expect.stringContaining('wechat:scanlogin:'),
            );
            expect(authService.issueTokensForUser).toHaveBeenCalled();
            expect(result).toMatchObject({
                status: 'CONFIRMED',
                accessToken: 'web-at',
                refreshToken: 'web-rt',
                isNewUser: false,
            });
        });
    });
});

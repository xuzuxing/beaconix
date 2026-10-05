import type { MultiLevelCacheService } from '../../cache/multi-level-cache.service';
import type { WechatHttpClient } from './wechat-http.client';
import { WechatTokenService } from './wechat-token.service';
import { WechatConfigurationError } from '../wechat.types';

const MP_CREDENTIALS = { appId: 'wx-mp-1', appSecret: 'mp-secret' };
const WORK_CREDENTIALS = { corpId: 'corp-1', corpSecret: 'work-secret' };

function createService() {
    const cache = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(undefined),
    };
    const http = {
        getJson: jest.fn(),
    };

    const service = new WechatTokenService(
        cache as unknown as MultiLevelCacheService,
        http as unknown as WechatHttpClient,
    );

    return { service, cache, http };
}

describe('WechatTokenService', () => {
    describe('getAccessToken', () => {
        it('fetches and caches a token with a 5 minute safety margin', async () => {
            const { service, cache, http } = createService();
            http.getJson.mockResolvedValue({
                access_token: 'tok-1',
                expires_in: 7200,
            });

            const token = await service.getAccessToken(MP_CREDENTIALS);

            expect(token).toBe('tok-1');
            expect(http.getJson).toHaveBeenCalledWith('/cgi-bin/token', {
                query: {
                    grant_type: 'client_credential',
                    appid: MP_CREDENTIALS.appId,
                    secret: MP_CREDENTIALS.appSecret,
                },
            });
            expect(cache.set).toHaveBeenCalledWith(
                'wechat:token:mp:wx-mp-1',
                expect.objectContaining({ token: 'tok-1' }),
                6900,
            );
        });

        it('reuses a cached token without calling WeChat', async () => {
            const { service, cache, http } = createService();
            cache.get.mockResolvedValue({
                token: 'cached',
                expiresAt: Date.now() + 3600_000,
            });

            await expect(service.getAccessToken(MP_CREDENTIALS)).resolves.toBe(
                'cached',
            );
            expect(http.getJson).not.toHaveBeenCalled();
        });

        it('refreshes a token that is inside the safety margin', async () => {
            const { service, cache, http } = createService();
            cache.get.mockResolvedValue({
                token: 'stale',
                expiresAt: Date.now() + 120_000,
            });
            http.getJson.mockResolvedValue({
                access_token: 'fresh',
                expires_in: 7200,
            });

            await expect(service.getAccessToken(MP_CREDENTIALS)).resolves.toBe(
                'fresh',
            );
            expect(http.getJson).toHaveBeenCalledTimes(1);
        });

        it('collapses concurrent requests into a single fetch', async () => {
            const { service, cache, http } = createService();
            cache.get.mockResolvedValue(null);

            let resolveFetch: ((value: unknown) => void) | undefined;
            http.getJson.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveFetch = resolve;
                    }),
            );

            const first = service.getAccessToken(MP_CREDENTIALS);
            await new Promise((resolve) => setImmediate(resolve));
            const second = service.getAccessToken(MP_CREDENTIALS);
            await new Promise((resolve) => setImmediate(resolve));

            expect(http.getJson).toHaveBeenCalledTimes(1);

            resolveFetch?.({ access_token: 'shared', expires_in: 7200 });

            await expect(Promise.all([first, second])).resolves.toEqual([
                'shared',
                'shared',
            ]);
        });

        it('rejects missing credentials before calling WeChat', async () => {
            const { service, http } = createService();

            await expect(
                service.getAccessToken({ appId: '', appSecret: 'x' }),
            ).rejects.toThrow(WechatConfigurationError);
            expect(http.getJson).not.toHaveBeenCalled();
        });

        it('surfaces a token endpoint failure', async () => {
            const { service, http } = createService();
            http.getJson.mockResolvedValue({
                errcode: 40013,
                errmsg: 'invalid appid',
            });

            await expect(
                service.getAccessToken(MP_CREDENTIALS),
            ).rejects.toThrow('invalid appid');
        });
    });

    describe('getWorkAccessToken', () => {
        it('requests the enterprise WeChat token endpoint', async () => {
            const { service, cache, http } = createService();
            http.getJson.mockResolvedValue({
                access_token: 'work-tok',
                expires_in: 7200,
            });

            await expect(
                service.getWorkAccessToken(WORK_CREDENTIALS),
            ).resolves.toBe('work-tok');

            expect(http.getJson).toHaveBeenCalledWith(
                'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
                {
                    query: {
                        corpid: WORK_CREDENTIALS.corpId,
                        corpsecret: WORK_CREDENTIALS.corpSecret,
                    },
                    platform: 'work',
                },
            );
            expect(cache.set).toHaveBeenCalledWith(
                'wechat:token:work:corp-1',
                expect.objectContaining({ token: 'work-tok' }),
                6900,
            );
        });
    });

    describe('invalidate', () => {
        it('drops the cached token for the given namespace', async () => {
            const { service, cache } = createService();

            await service.invalidate('mp', 'wx-mp-1');

            expect(cache.del).toHaveBeenCalledWith('wechat:token:mp:wx-mp-1');
        });
    });
});

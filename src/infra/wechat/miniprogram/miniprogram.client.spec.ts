import type { WechatHttpClient } from '../clients/wechat-http.client';
import type { WechatTokenService } from '../clients/wechat-token.service';
import { WechatApiError } from '../wechat.types';
import { MiniprogramClient } from './miniprogram.client';

function createClient() {
    const http = {
        getJson: jest.fn(),
        postJson: jest.fn(),
        postBuffer: jest.fn(),
    };
    const tokens = {
        getAccessToken: jest.fn().mockResolvedValue('token-1'),
        invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const client = new MiniprogramClient(
        http as unknown as WechatHttpClient,
        tokens as unknown as WechatTokenService,
    );

    return { client, http, tokens };
}

describe('MiniprogramClient', () => {
    describe('code2Session', () => {
        it('exchanges a login code for openid and session key', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({
                openid: 'o-1',
                unionid: 'u-1',
                session_key: 'sk-1',
            });

            const result = await client.code2Session({
                appId: 'wx-1',
                appSecret: 'sec-1',
                code: 'code-1',
            });

            expect(result).toEqual({
                openid: 'o-1',
                unionid: 'u-1',
                sessionKey: 'sk-1',
            });
            expect(http.getJson).toHaveBeenCalledWith('/sns/jscode2session', {
                query: {
                    appid: 'wx-1',
                    secret: 'sec-1',
                    js_code: 'code-1',
                    grant_type: 'authorization_code',
                },
            });
        });

        it('rejects a response without openid/session_key', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({});

            await expect(
                client.code2Session({
                    appId: 'wx-1',
                    appSecret: 'sec-1',
                    code: 'code-1',
                }),
            ).rejects.toThrow(WechatApiError);
        });
    });

    describe('getUnlimitedQrCode', () => {
        it('generates a QR code carrying the login scene', async () => {
            const { client, http } = createClient();
            const buffer = Buffer.from('png-bytes');
            http.postBuffer.mockResolvedValue({
                buffer,
                contentType: 'image/png',
            });

            const result = await client.getUnlimitedQrCode({
                appId: 'wx-1',
                appSecret: 'sec-1',
                scene: 'ticket-1',
                page: 'pages/login/index',
                envVersion: 'trial',
                width: 280,
            });

            const [path, body, options] = http.postBuffer.mock.calls[0];
            expect(path).toBe('/wxa/getwxacodeunlimit?access_token=token-1');
            expect(body).toEqual({
                scene: 'ticket-1',
                page: 'pages/login/index',
                check_path: false,
                env_version: 'trial',
                width: 280,
            });
            expect(options).toEqual({ retries: 0, platform: 'mp' });
            expect(result).toEqual({ buffer, contentType: 'image/png' });
        });

        it('omits page when not provided', async () => {
            const { client, http } = createClient();
            http.postBuffer.mockResolvedValue({
                buffer: Buffer.from('bytes'),
                contentType: 'image/jpeg',
            });

            await client.getUnlimitedQrCode({
                appId: 'wx-1',
                appSecret: 'sec-1',
                scene: 'ticket-1',
            });

            const [, body] = http.postBuffer.mock.calls[0];
            expect(body).toEqual({
                scene: 'ticket-1',
                check_path: false,
                env_version: 'release',
                width: 430,
            });
        });
    });

    describe('sendSubscribeMessage', () => {
        it('posts the template payload with an access token', async () => {
            const { client, http, tokens } = createClient();
            http.postJson.mockResolvedValue({});

            await client.sendSubscribeMessage({
                appId: 'wx-1',
                appSecret: 'sec-1',
                openId: 'o-1',
                templateId: 'tpl-1',
                page: 'pages/monitor/index',
                data: { thing1: { value: '订单API' } },
            });

            const [path, body, options] = http.postJson.mock.calls[0];
            expect(path).toBe(
                '/cgi-bin/message/subscribe/send?access_token=token-1',
            );
            expect(body).toMatchObject({
                touser: 'o-1',
                template_id: 'tpl-1',
                page: 'pages/monitor/index',
                miniprogram_state: 'formal',
                lang: 'zh_CN',
                data: { thing1: { value: '订单API' } },
            });
            expect(options).toEqual({ retries: 0 });
            expect(tokens.getAccessToken).toHaveBeenCalledWith({
                appId: 'wx-1',
                appSecret: 'sec-1',
            });
        });

        it('honours an explicit miniprogram state and lang', async () => {
            const { client, http } = createClient();
            http.postJson.mockResolvedValue({});

            await client.sendSubscribeMessage({
                appId: 'wx-1',
                appSecret: 'sec-1',
                openId: 'o-1',
                templateId: 'tpl-1',
                miniprogramState: 'trial',
                lang: 'en_US',
                data: {},
            });

            expect(http.postJson.mock.calls[0][1]).toMatchObject({
                miniprogram_state: 'trial',
                lang: 'en_US',
            });
        });

        it('refreshes an expired token and retries once', async () => {
            const { client, http, tokens } = createClient();
            http.postJson
                .mockRejectedValueOnce(
                    new WechatApiError({
                        platform: 'mp',
                        endpoint: 'POST subscribe/send',
                        errcode: 40001,
                    }),
                )
                .mockResolvedValueOnce({});
            tokens.getAccessToken
                .mockResolvedValueOnce('stale-token')
                .mockResolvedValueOnce('fresh-token');

            await client.sendSubscribeMessage({
                appId: 'wx-1',
                appSecret: 'sec-1',
                openId: 'o-1',
                templateId: 'tpl-1',
                data: {},
            });

            expect(tokens.invalidate).toHaveBeenCalledWith('mp', 'wx-1');
            expect(http.postJson).toHaveBeenCalledTimes(2);
            expect(http.postJson.mock.calls[0][0]).toContain(
                'access_token=stale-token',
            );
            expect(http.postJson.mock.calls[1][0]).toContain(
                'access_token=fresh-token',
            );
        });

        it('does not retry other WeChat errors', async () => {
            const { client, http, tokens } = createClient();
            http.postJson.mockRejectedValue(
                new WechatApiError({
                    platform: 'mp',
                    endpoint: 'POST subscribe/send',
                    errcode: 40013,
                }),
            );

            await expect(
                client.sendSubscribeMessage({
                    appId: 'wx-1',
                    appSecret: 'sec-1',
                    openId: 'o-1',
                    templateId: 'tpl-1',
                    data: {},
                }),
            ).rejects.toThrow(WechatApiError);

            expect(http.postJson).toHaveBeenCalledTimes(1);
            expect(tokens.invalidate).not.toHaveBeenCalled();
        });
    });

    describe('sendSubscribeMessageToMany', () => {
        it('collects per-recipient failures', async () => {
            const { client, http } = createClient();
            http.postJson
                .mockResolvedValueOnce({})
                .mockRejectedValueOnce(new Error('user refuse to accept'))
                .mockResolvedValueOnce({});

            const result = await client.sendSubscribeMessageToMany({
                appId: 'wx-1',
                appSecret: 'sec-1',
                openIds: ['o-1', 'o-2', 'o-3'],
                templateId: 'tpl-1',
                data: {},
            });

            expect(result.delivered).toBe(2);
            expect(result.failures).toEqual(['o-2: user refuse to accept']);
        });
    });

    describe('getPhoneNumber', () => {
        it('returns the phone info', async () => {
            const { client, http } = createClient();
            http.postJson.mockResolvedValue({
                phone_info: {
                    phoneNumber: '13800000000',
                    purePhoneNumber: '13800000000',
                    countryCode: '86',
                },
            });

            await expect(
                client.getPhoneNumber({
                    appId: 'wx-1',
                    appSecret: 'sec-1',
                    code: 'code-1',
                }),
            ).resolves.toEqual({
                phoneNumber: '13800000000',
                purePhoneNumber: '13800000000',
                countryCode: '86',
            });

            expect(http.postJson.mock.calls[0][1]).toEqual({ code: 'code-1' });
        });

        it('rejects a response without phone_info', async () => {
            const { client, http } = createClient();
            http.postJson.mockResolvedValue({});

            await expect(
                client.getPhoneNumber({
                    appId: 'wx-1',
                    appSecret: 'sec-1',
                    code: 'code-1',
                }),
            ).rejects.toThrow('missing phone_info');
        });
    });
});

import type { ConfigService } from '@nestjs/config';
import type { WechatHttpClient } from '../clients/wechat-http.client';
import {
    buildMsgSignature,
    checkMsgSignature,
    decryptMessage,
    encryptMessage,
    sha1Hex,
} from '../clients/wechat-signature.util';
import type { WechatTokenService } from '../clients/wechat-token.service';
import { WechatApiError, WechatConfigurationError } from '../wechat.types';
import { OfficialAccountClient } from './official-account.client';

const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

const OA_CONFIG = {
    appId: 'wx-oa',
    appSecret: 'oa-secret',
    token: 'OA_TOKEN',
    aesKey: AES_KEY,
};

const WEBSITE_CONFIG = {
    appId: 'wx-web',
    appSecret: 'web-secret',
};

function createClient(
    overrides: Partial<typeof OA_CONFIG> = {},
    websiteOverrides: Partial<typeof WEBSITE_CONFIG> = {},
) {
    const config = { ...OA_CONFIG, ...overrides };
    const website = { ...WEBSITE_CONFIG, ...websiteOverrides };
    const http = {
        getJson: jest.fn(),
        postJson: jest.fn(),
    };
    const tokens = {
        getAccessToken: jest.fn().mockResolvedValue('access-token-1'),
        invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const configService = {
        get: jest.fn().mockReturnValue({
            officialAccount: config,
            website,
        }),
    };

    const client = new OfficialAccountClient(
        http as unknown as WechatHttpClient,
        tokens as unknown as WechatTokenService,
        configService as unknown as ConfigService,
    );

    return { client, http, tokens, config };
}

describe('OfficialAccountClient', () => {
    describe('buildOAuthUrl', () => {
        it('builds an encoded authorisation URL ending with #wechat_redirect', () => {
            const { client } = createClient();

            const url = client.buildOAuthUrl({
                redirectUri: 'https://beaconix.example.com/oauth/cb',
                state: 's1',
            });

            expect(
                url.startsWith(
                    'https://open.weixin.qq.com/connect/oauth2/authorize?',
                ),
            ).toBe(true);
            expect(url).toContain('appid=wx-oa');
            expect(url).toContain(
                'redirect_uri=https%3A%2F%2Fbeacon.example.com%2Foauth%2Fcb',
            );
            expect(url).toContain('response_type=code');
            expect(url).toContain('scope=snsapi_base');
            expect(url).toContain('state=s1');
            expect(url.endsWith('#wechat_redirect')).toBe(true);
        });

        it('honours an explicit scope', () => {
            const { client } = createClient();

            const url = client.buildOAuthUrl({
                redirectUri: 'https://beaconix.example.com/oauth/cb',
                scope: 'snsapi_userinfo',
            });

            expect(url).toContain('scope=snsapi_userinfo');
        });

        it('rejects a missing appId', () => {
            const { client } = createClient({ appId: '' });

            expect(() =>
                client.buildOAuthUrl({ redirectUri: 'https://x/cb' }),
            ).toThrow(WechatConfigurationError);
        });
    });

    describe('buildQrConnectUrl', () => {
        it('builds a snsapi_login QR-connect URL ending with #wechat_redirect', () => {
            const { client } = createClient();

            const url = client.buildQrConnectUrl({
                redirectUri: 'https://beaconix.example.com/wechat/cb',
                state: 's2',
            });

            expect(
                url.startsWith('https://open.weixin.qq.com/connect/qrconnect?'),
            ).toBe(true);
            expect(url).toContain('appid=wx-web');
            expect(url).toContain(
                'redirect_uri=https%3A%2F%2Fbeacon.example.com%2Fwechat%2Fcb',
            );
            expect(url).toContain('response_type=code');
            expect(url).toContain('scope=snsapi_login');
            expect(url).toContain('state=s2');
            expect(url.endsWith('#wechat_redirect')).toBe(true);
        });

        it('rejects a missing website appId', () => {
            const { client } = createClient({}, { appId: '' });

            expect(() =>
                client.buildQrConnectUrl({
                    redirectUri: 'https://x/cb',
                }),
            ).toThrow(WechatConfigurationError);
        });
    });

    describe('exchangeCodeForToken', () => {
        it('maps the OAuth token response', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({
                access_token: 'oa-token',
                expires_in: 7200,
                refresh_token: 'refresh-1',
                openid: 'o-1',
                scope: 'snsapi_userinfo',
                unionid: 'u-1',
            });

            await expect(
                client.exchangeCodeForToken({ code: 'code-1' }),
            ).resolves.toEqual({
                accessToken: 'oa-token',
                expiresIn: 7200,
                refreshToken: 'refresh-1',
                openid: 'o-1',
                scope: 'snsapi_userinfo',
                unionid: 'u-1',
            });

            expect(http.getJson).toHaveBeenCalledWith(
                '/sns/oauth2/access_token',
                {
                    query: {
                        appid: 'wx-oa',
                        secret: 'oa-secret',
                        code: 'code-1',
                        grant_type: 'authorization_code',
                    },
                    platform: 'official-account',
                },
            );
        });

        it('rejects a response without access_token', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({ openid: 'o-1' });

            await expect(
                client.exchangeCodeForToken({ code: 'code-1' }),
            ).rejects.toThrow(WechatApiError);
        });

        it('rejects missing credentials', async () => {
            const { client } = createClient({ appId: '', appSecret: '' });

            await expect(
                client.exchangeCodeForToken({ code: 'code-1' }),
            ).rejects.toThrow(WechatConfigurationError);
        });
    });

    describe('refreshOAuthToken', () => {
        it('calls the refresh endpoint', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({
                access_token: 'oa-token-2',
                openid: 'o-1',
            });

            await client.refreshOAuthToken({ refreshToken: 'refresh-1' });

            expect(http.getJson).toHaveBeenCalledWith(
                '/sns/oauth2/refresh_token',
                {
                    query: {
                        appid: 'wx-oa',
                        grant_type: 'refresh_token',
                        refresh_token: 'refresh-1',
                    },
                    platform: 'official-account',
                },
            );
        });
    });

    describe('getUserInfo', () => {
        it('reads the profile behind the OAuth token', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({
                openid: 'o-1',
                nickname: '张三',
                sex: 1,
                province: 'Zhejiang',
                city: 'Hangzhou',
                country: 'China',
                headimgurl: 'https://wx/avatar.png',
                privilege: ['a', 'b'],
            });

            const info = await client.getUserInfo({
                accessToken: 'oa-token',
                openid: 'o-1',
            });

            expect(info.nickname).toBe('张三');
            expect(info.privilege).toEqual(['a', 'b']);
            expect(http.getJson).toHaveBeenCalledWith('/sns/userinfo', {
                query: {
                    access_token: 'oa-token',
                    openid: 'o-1',
                    lang: 'zh_CN',
                },
                platform: 'official-account',
            });
        });

        it('rejects a response without openid', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({});

            await expect(
                client.getUserInfo({ accessToken: 't', openid: 'o-1' }),
            ).rejects.toThrow(WechatApiError);
        });
    });

    describe('sendTemplateMessage', () => {
        it('posts the template payload with an access token', async () => {
            const { client, http } = createClient();
            http.postJson.mockResolvedValue({ msgid: 12345 });

            const result = await client.sendTemplateMessage({
                openId: 'o-1',
                templateId: 'tpl-1',
                url: 'https://beaconix.example.com/monitors/1',
                data: { first: { value: '订单API 异常' } },
            });

            expect(result).toEqual({ msgId: '12345' });

            const [path, body, options] = http.postJson.mock.calls[0];
            expect(path).toBe(
                '/cgi-bin/message/template/send?access_token=access-token-1',
            );
            expect(body).toMatchObject({
                touser: 'o-1',
                template_id: 'tpl-1',
                url: 'https://beaconix.example.com/monitors/1',
                data: { first: { value: '订单API 异常' } },
            });
            expect(options).toEqual({
                retries: 0,
                platform: 'official-account',
            });
        });

        it('refreshes an expired token and retries once', async () => {
            const { client, http, tokens } = createClient();
            http.postJson
                .mockRejectedValueOnce(
                    new WechatApiError({
                        platform: 'official-account',
                        endpoint: 'POST template/send',
                        errcode: 40001,
                    }),
                )
                .mockResolvedValueOnce({ msgid: 1 });
            tokens.getAccessToken
                .mockResolvedValueOnce('stale')
                .mockResolvedValueOnce('fresh');

            await client.sendTemplateMessage({
                openId: 'o-1',
                templateId: 'tpl-1',
                data: {},
            });

            expect(tokens.invalidate).toHaveBeenCalledWith('mp', 'wx-oa');
            expect(http.postJson).toHaveBeenCalledTimes(2);
            expect(http.postJson.mock.calls[1][0]).toContain(
                'access_token=fresh',
            );
        });
    });

    describe('sendCustomTextMessage', () => {
        it('posts a text customer service message', async () => {
            const { client, http } = createClient();
            http.postJson.mockResolvedValue({});

            await client.sendCustomTextMessage({
                openId: 'o-1',
                content: '服务已恢复',
            });

            const [path, body] = http.postJson.mock.calls[0];
            expect(path).toBe(
                '/cgi-bin/message/custom/send?access_token=access-token-1',
            );
            expect(body).toEqual({
                touser: 'o-1',
                msgtype: 'text',
                text: { content: '服务已恢复' },
            });
        });
    });

    describe('verifyServerSignature', () => {
        const timestamp = '1700000000';
        const nonce = 'nonce-1';

        it('accepts a matching signature', () => {
            const { client } = createClient();
            const signature = sha1Hex(
                ['OA_TOKEN', timestamp, nonce].sort().join(''),
            );

            expect(
                client.verifyServerSignature({ signature, timestamp, nonce }),
            ).toBe(true);
        });

        it('rejects a mismatching signature', () => {
            const { client } = createClient();

            expect(
                client.verifyServerSignature({
                    signature: 'nope',
                    timestamp,
                    nonce,
                }),
            ).toBe(false);
        });

        it('rejects when no token is configured', () => {
            const { client } = createClient({ token: '' });

            expect(() =>
                client.verifyServerSignature({
                    signature: 'x',
                    timestamp,
                    nonce,
                }),
            ).toThrow(WechatConfigurationError);
        });
    });

    describe('parseServerMessage', () => {
        const timestamp = '1700000000';
        const nonce = 'nonce-1';
        const plaintext = '<xml><Content><![CDATA[hello]]></Content></xml>';

        it('verifies and decrypts a safe-mode message', () => {
            const { client } = createClient();
            const encrypted = encryptMessage(plaintext, AES_KEY, 'wx-oa');

            const result = client.parseServerMessage({
                encrypted,
                msgSignature: buildMsgSignature(
                    'OA_TOKEN',
                    timestamp,
                    nonce,
                    encrypted,
                ),
                timestamp,
                nonce,
            });

            expect(result).toBe(plaintext);
        });

        it('rejects a tampered signature', () => {
            const { client } = createClient();
            const encrypted = encryptMessage(plaintext, AES_KEY, 'wx-oa');

            expect(() =>
                client.parseServerMessage({
                    encrypted,
                    msgSignature: 'deadbeef',
                    timestamp,
                    nonce,
                }),
            ).toThrow('signature verification failed');
        });

        it('rejects when the AES key is missing', () => {
            const { client } = createClient({ aesKey: '' });

            expect(() =>
                client.parseServerMessage({
                    encrypted: 'x',
                    msgSignature: 'y',
                    timestamp,
                    nonce,
                }),
            ).toThrow(WechatConfigurationError);
        });
    });

    describe('buildEncryptedReply', () => {
        it('encrypts and signs the reply', () => {
            const { client } = createClient();

            const reply = client.buildEncryptedReply('<xml>ok</xml>');

            expect(
                checkMsgSignature(
                    'OA_TOKEN',
                    reply.timestamp,
                    reply.nonce,
                    reply.encrypt,
                    reply.msgSignature,
                ),
            ).toBe(true);
            expect(decryptMessage(reply.encrypt, AES_KEY, 'wx-oa')).toBe(
                '<xml>ok</xml>',
            );
        });
    });
});

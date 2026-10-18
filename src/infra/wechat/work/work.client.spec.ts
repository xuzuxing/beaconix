import type { WechatRuntimeConfigService } from '../wechat-runtime-config.service';
import type { WechatHttpClient } from '../clients/wechat-http.client';
import type { WechatTokenService } from '../clients/wechat-token.service';
import { WechatApiError, WechatConfigurationError } from '../wechat.types';
import { WorkClient } from './work.client';

const WORK_CONFIG = {
    corpId: 'corp-1',
    corpSecret: 'work-secret',
    agentId: '100001',
};

function createClient(overrides: Partial<typeof WORK_CONFIG> = {}) {
    const config = { ...WORK_CONFIG, ...overrides };
    const http = {
        getJson: jest.fn(),
        postJson: jest.fn(),
    };
    const tokens = {
        getWorkAccessToken: jest.fn().mockResolvedValue('work-token'),
        invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const runtimeConfig = {
        work: jest.fn().mockResolvedValue(config),
    };

    const client = new WorkClient(
        http as unknown as WechatHttpClient,
        tokens as unknown as WechatTokenService,
        runtimeConfig as unknown as WechatRuntimeConfigService,
    );

    return { client, http, tokens, config };
}

describe('WorkClient', () => {
    describe('sendAppMessage', () => {
        it('sends a text message with the configured agent id', async () => {
            const { client, http, tokens } = createClient();
            http.postJson.mockResolvedValue({
                msgid: 'msg-1',
                invaliduser: 'u-2',
            });

            const result = await client.sendAppMessage({
                toUser: ['u-1', 'u-2'],
                content: { msgType: 'text', text: { content: '服务异常' } },
            });

            expect(tokens.getWorkAccessToken).toHaveBeenCalledWith({
                corpId: 'corp-1',
                corpSecret: 'work-secret',
            });

            const [path, body, options] = http.postJson.mock.calls[0];
            expect(path).toBe('/cgi-bin/message/send?access_token=work-token');
            expect(body).toEqual({
                touser: 'u-1|u-2',
                toparty: '',
                totag: '',
                msgtype: 'text',
                agentid: 100001,
                safe: 0,
                text: { content: '服务异常' },
            });
            expect(options).toEqual({ retries: 0, platform: 'work' });

            expect(result).toEqual({
                msgId: 'msg-1',
                invalidUser: ['u-2'],
                invalidParty: [],
                invalidTag: [],
            });
        });

        it('supports markdown messages', async () => {
            const { client, http } = createClient();
            http.postJson.mockResolvedValue({});

            await client.sendAppMessage({
                toUser: '@all',
                content: {
                    msgType: 'markdown',
                    markdown: { content: '**订单API** 已恢复' },
                },
            });

            expect(http.postJson.mock.calls[0][1]).toMatchObject({
                touser: '@all',
                msgtype: 'markdown',
                markdown: { content: '**订单API** 已恢复' },
            });
        });

        it('supports textcard messages', async () => {
            const { client, http } = createClient();
            http.postJson.mockResolvedValue({});

            await client.sendAppMessage({
                toParty: ['2'],
                content: {
                    msgType: 'textcard',
                    textcard: {
                        title: '服务异常',
                        description: '订单API 连续失败',
                        url: 'https://beaconix.example.com/monitors/1',
                        btntxt: '查看',
                    },
                },
            });

            expect(http.postJson.mock.calls[0][1]).toMatchObject({
                toparty: '2',
                msgtype: 'textcard',
                textcard: {
                    title: '服务异常',
                    description: '订单API 连续失败',
                    url: 'https://beaconix.example.com/monitors/1',
                    btntxt: '查看',
                },
            });
        });

        it('honours an explicit agent id', async () => {
            const { client, http } = createClient();
            http.postJson.mockResolvedValue({});

            await client.sendAppMessage({
                toUser: 'u-1',
                agentId: '200002',
                safe: 1,
                content: { msgType: 'text', text: { content: 'hi' } },
            });

            expect(http.postJson.mock.calls[0][1]).toMatchObject({
                agentid: 200002,
                safe: 1,
            });
        });

        it('rejects a missing agent id', async () => {
            const { client } = createClient({ agentId: '' });

            await expect(
                client.sendAppMessage({
                    toUser: 'u-1',
                    content: { msgType: 'text', text: { content: 'hi' } },
                }),
            ).rejects.toThrow(WechatConfigurationError);
        });

        it('rejects missing credentials', async () => {
            const { client } = createClient({ corpId: '', corpSecret: '' });

            await expect(
                client.sendAppMessage({
                    toUser: 'u-1',
                    content: { msgType: 'text', text: { content: 'hi' } },
                }),
            ).rejects.toThrow(WechatConfigurationError);
        });

        it('refreshes an expired work token and retries once', async () => {
            const { client, http, tokens } = createClient();
            http.postJson
                .mockRejectedValueOnce(
                    new WechatApiError({
                        platform: 'work',
                        endpoint: 'POST /cgi-bin/message/send',
                        errcode: 42001,
                    }),
                )
                .mockResolvedValueOnce({});
            tokens.getWorkAccessToken
                .mockResolvedValueOnce('stale')
                .mockResolvedValueOnce('fresh');

            await client.sendAppMessage({
                toUser: 'u-1',
                content: { msgType: 'text', text: { content: 'hi' } },
            });

            expect(tokens.invalidate).toHaveBeenCalledWith('work', 'corp-1');
            expect(http.postJson).toHaveBeenCalledTimes(2);
            expect(http.postJson.mock.calls[1][0]).toContain(
                'access_token=fresh',
            );
        });
    });

    describe('getDepartmentList', () => {
        it('lists every department', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({
                department: [{ id: 1, name: '总部', parentid: 0, order: 1 }],
            });

            const departments = await client.getDepartmentList();

            expect(departments).toEqual([
                { id: 1, name: '总部', parentid: 0, order: 1 },
            ]);

            const [path, options] = http.getJson.mock.calls[0];
            expect(path).toBe(
                '/cgi-bin/department/list?access_token=work-token',
            );
            expect(options).toEqual({
                query: undefined,
                retries: 0,
                platform: 'work',
            });
        });

        it('scopes the list to a department id', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({ department: [] });

            await client.getDepartmentList({ departmentId: 2 });

            expect(http.getJson.mock.calls[0][1].query).toEqual({ id: 2 });
        });
    });

    describe('getUser', () => {
        it('maps the member profile', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({
                userid: 'u-1',
                name: '张三',
                department: [1, 2],
                mobile: '13800000000',
            });

            await expect(client.getUser({ userId: 'u-1' })).resolves.toEqual({
                userid: 'u-1',
                name: '张三',
                department: [1, 2],
                mobile: '13800000000',
                email: undefined,
                position: undefined,
                status: undefined,
            });

            expect(http.getJson.mock.calls[0][1].query).toEqual({
                userid: 'u-1',
            });
        });

        it('rejects a response without userid', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({ name: '张三' });

            await expect(client.getUser({ userId: 'u-1' })).rejects.toThrow(
                WechatApiError,
            );
        });
    });

    describe('listUsersByDepartment', () => {
        it('lists members without sub-departments by default', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({
                userlist: [{ userid: 'u-1', name: '张三', department: [1] }],
            });

            const users = await client.listUsersByDepartment({
                departmentId: 1,
            });

            expect(users).toHaveLength(1);
            expect(http.getJson.mock.calls[0][1].query).toEqual({
                department_id: 1,
                fetch_child: 0,
            });
        });

        it('includes sub-departments on request', async () => {
            const { client, http } = createClient();
            http.getJson.mockResolvedValue({ userlist: [] });

            await client.listUsersByDepartment({
                departmentId: 1,
                fetchChild: true,
            });

            expect(http.getJson.mock.calls[0][1].query).toEqual({
                department_id: 1,
                fetch_child: 1,
            });
        });
    });
});

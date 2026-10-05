import type { NotificationChannelModel } from '../../../generated/prisma/models';
import type { MiniprogramClient } from '../../../infra/wechat/miniprogram';
import type { NotificationPayload } from '../notifier.types';
import { WechatSubscribeSender } from './wechat-subscribe.sender';

const payload: NotificationPayload = {
    monitorId: 'monitor-1',
    monitorName: '订单API',
    monitorType: 'HTTP',
    target: 'https://internal/health',
    organizationId: 'org-1',
    previousStatus: 'UP',
    status: 'DOWN',
    event: 'DOWN',
    failCount: 2,
    latency: 320,
    error: 'status 500',
    checkedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function createChannel(
    overrides: Record<string, unknown> = {},
): NotificationChannelModel {
    return {
        id: 'channel-1',
        type: 'WECHAT_SUBSCRIBE',
        config: {
            appId: 'wx-1',
            appSecret: 'sec-1',
            templateId: 'tpl-1',
            openIds: ['o-1', 'o-2'],
            ...overrides,
        },
    } as unknown as NotificationChannelModel;
}

function createSender(
    result: { delivered: number; failures: string[] } = {
        delivered: 2,
        failures: [],
    },
) {
    const client = {
        sendSubscribeMessageToMany: jest.fn().mockResolvedValue(result),
    };

    const sender = new WechatSubscribeSender(
        client as unknown as MiniprogramClient,
    );

    return { sender, client };
}

describe('WechatSubscribeSender', () => {
    it('maps the default template fields onto the payload', async () => {
        const { sender, client } = createSender();

        await sender.send(createChannel(), payload);

        expect(client.sendSubscribeMessageToMany).toHaveBeenCalledWith(
            expect.objectContaining({
                appId: 'wx-1',
                appSecret: 'sec-1',
                templateId: 'tpl-1',
                openIds: ['o-1', 'o-2'],
            }),
        );

        const input = client.sendSubscribeMessageToMany.mock.calls[0][0];
        // Every field is capped at 20 characters, so the ISO timestamp is cut.
        expect(input.data).toEqual({
            thing1: { value: '订单API' },
            phrase2: { value: 'DOWN' },
            time3: { value: '2026-01-01T00:00:...' },
        });
    });

    it('lets channel config override individual template fields', async () => {
        const { sender, client } = createSender();

        await sender.send(
            createChannel({
                fields: { thing1: 'target', character_string4: 'latency' },
            }),
            payload,
        );

        const input = client.sendSubscribeMessageToMany.mock.calls[0][0];
        expect(input.data.thing1).toEqual({
            value: 'https://internal/...',
        });
        expect(input.data.character_string4).toEqual({ value: '320ms' });
        // Untouched default fields survive an override.
        expect(input.data.phrase2).toEqual({ value: 'DOWN' });
    });

    it('forwards the page and miniprogram state', async () => {
        const { sender, client } = createSender();

        await sender.send(
            createChannel({
                page: 'pages/monitor/index',
                miniprogramState: 'trial',
            }),
            payload,
        );

        const input = client.sendSubscribeMessageToMany.mock.calls[0][0];
        expect(input.page).toBe('pages/monitor/index');
        expect(input.miniprogramState).toBe('trial');
    });

    it('truncates values to the 20 character WeChat limit', async () => {
        const { sender, client } = createSender();

        await sender.send(createChannel(), {
            ...payload,
            monitorName: 'A'.repeat(50),
        });

        const value =
            client.sendSubscribeMessageToMany.mock.calls[0][0].data.thing1
                .value;
        expect(value).toHaveLength(20);
        expect(value.endsWith('...')).toBe(true);
    });

    it('throws when any recipient is rejected', async () => {
        const { sender } = createSender({
            delivered: 1,
            failures: ['o-2: user refuse to accept'],
        });

        await expect(sender.send(createChannel(), payload)).rejects.toThrow(
            'WeChat subscribe send failed for 1/2 recipient(s): o-2: user refuse to accept',
        );
    });
});

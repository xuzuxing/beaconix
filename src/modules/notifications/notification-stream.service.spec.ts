import { NotificationStreamService } from './notification-stream.service';
import { NotificationEntity } from './entities';
import type { RedisService } from '../../infra/redis/redis.service';

function fixture() {
    const handlers = new Map<string, (...args: string[]) => void>();
    const subscriber = {
        on: jest
            .fn()
            .mockImplementation((name, callback) =>
                handlers.set(name, callback),
            ),
        connect: jest.fn().mockResolvedValue(undefined),
        subscribe: jest.fn().mockResolvedValue(undefined),
        quit: jest.fn().mockResolvedValue(undefined),
    };
    const client = {
        options: { keyPrefix: 'test:' },
        duplicate: jest.fn().mockReturnValue(subscriber),
        publish: jest.fn().mockResolvedValue(1),
    };
    const service = new NotificationStreamService({
        getClient: () => client,
    } as unknown as RedisService);
    return { service, client, subscriber, handlers };
}

describe('Notification SSE fan-out', () => {
    it('uses a dedicated Redis subscriber and fans out only to the target user', async () => {
        const { service, client, subscriber, handlers } = fixture();
        await service.onModuleInit();
        expect(client.duplicate).toHaveBeenCalledWith({ lazyConnect: true });
        expect(subscriber.subscribe).toHaveBeenCalledWith(
            'test:workspace-notifications',
        );
        const target = jest.fn();
        const other = jest.fn();
        const a = service.getStream('user').subscribe(target);
        const b = service.getStream('other').subscribe(other);
        handlers.get('message')!(
            'test:workspace-notifications',
            JSON.stringify({ id: 'notice', userId: 'user' }),
        );
        expect(target).toHaveBeenCalledWith({
            id: 'notice',
            data: { id: 'notice', userId: 'user' },
        });
        expect(other).not.toHaveBeenCalled();
        a.unsubscribe();
        b.unsubscribe();
        await service.onModuleDestroy();
    });

    it('keeps a second tab subscribed when the first tab disconnects', async () => {
        const { service, handlers } = fixture();
        await service.onModuleInit();
        const first = service.getStream('user').subscribe();
        const secondNext = jest.fn();
        const second = service.getStream('user').subscribe(secondNext);
        first.unsubscribe();
        handlers.get('message')!(
            'channel',
            JSON.stringify({ id: 'notice', userId: 'user' }),
        );
        expect(secondNext).toHaveBeenCalledTimes(1);
        second.unsubscribe();
        const thirdNext = jest.fn();
        const third = service.getStream('user').subscribe(thirdNext);
        handlers.get('message')!(
            'channel',
            JSON.stringify({ id: 'next', userId: 'user' }),
        );
        expect(thirdNext).toHaveBeenCalledTimes(1);
        third.unsubscribe();
        await service.onModuleDestroy();
    });

    it('publishes to the cross-instance Redis bus with stable notification IDs', async () => {
        const { service, client } = fixture();
        const notice = new NotificationEntity({ id: 'notice', userId: 'user' });
        await service.emit(notice);
        expect(client.publish).toHaveBeenCalledWith(
            'test:workspace-notifications',
            JSON.stringify(notice),
        );
    });

    it('ignores invalid messages and completes subscribers on shutdown', async () => {
        const { service, subscriber, handlers } = fixture();
        await service.onModuleInit();
        const next = jest.fn();
        const complete = jest.fn();
        service.getStream('user').subscribe({ next, complete });
        handlers.get('message')!('channel', 'not json');
        handlers.get('message')!('channel', '{"userId":"user"}');
        expect(next).not.toHaveBeenCalled();
        await service.onModuleDestroy();
        expect(complete).toHaveBeenCalledTimes(1);
        expect(subscriber.quit).toHaveBeenCalledTimes(1);
    });
});

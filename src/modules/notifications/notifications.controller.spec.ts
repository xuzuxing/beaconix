import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import request from 'supertest';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import type { NotificationMessageEvent } from './notification-stream.service';

describe('Notification HTTP contract', () => {
    let app: INestApplication;
    let stream: Subject<NotificationMessageEvent>;
    let subscribed: () => void;
    const service = {
        getStream: jest.fn(),
        findOne: jest.fn(),
        getUnreadCount: jest.fn(),
    };

    beforeEach(async () => {
        stream = new Subject();
        jest.clearAllMocks();
        service.getStream.mockImplementation(() => {
            return new Observable<NotificationMessageEvent>((subscriber) => {
                const subscription = stream.subscribe(subscriber);
                subscribed?.();
                return () => subscription.unsubscribe();
            });
        });
        service.findOne.mockResolvedValue({ id: 'old-notice', userId: 'user' });
        service.getUnreadCount.mockResolvedValue({ count: 3 });
        const module = await Test.createTestingModule({
            controllers: [NotificationsController],
            providers: [{ provide: NotificationsService, useValue: service }],
        }).compile();
        app = module.createNestApplication();
        app.setGlobalPrefix('api');
        app.use((req, _res, next) => {
            req.user = { sub: 'user' };
            next();
        });
        app.useGlobalInterceptors(new TransformInterceptor());
        await app.listen(0, '127.0.0.1');
    });

    afterEach(async () => {
        stream.complete();
        await app.close();
    });

    it('keeps static unread-count ahead of the single-notification route', async () => {
        const response = await request(app.getHttpServer())
            .get('/api/notifications/unread-count')
            .expect(200);
        expect(response.body.data).toEqual({ count: 3 });
        expect(service.findOne).not.toHaveBeenCalled();
    });

    it('passes the authenticated user to direct detail lookup', async () => {
        const response = await request(app.getHttpServer())
            .get('/api/notifications/old-notice')
            .expect(200);
        expect(response.body.data).toEqual({
            id: 'old-notice',
            userId: 'user',
        });
        expect(service.findOne).toHaveBeenCalledWith('user', 'old-notice');
    });

    it('sends raw SSE data with a stable event ID despite the global transform interceptor', async () => {
        const ready = new Promise<void>((resolve) => {
            subscribed = resolve;
        });
        const abort = new AbortController();
        const responsePromise = fetch(
            `${await app.getUrl()}/api/notifications/stream`,
            { signal: abort.signal },
        );
        await ready;
        stream.next({
            id: 'notice',
            data: {
                id: 'notice',
                userId: 'user',
                type: 'TASK_UPDATED',
                title: 'Changed',
                isRead: false,
                createdAt: new Date(),
            } as never,
        });
        const response = await responsePromise;
        expect(response.headers.get('content-type')).toContain(
            'text/event-stream',
        );
        const reader = response.body!.getReader();
        let text = '';
        try {
            while (!text.includes('data:')) {
                const { value, done } = await reader.read();
                if (done) break;
                text += new TextDecoder().decode(value);
            }
            expect(text).toContain('id: notice');
            const payload = JSON.parse(
                text
                    .split('\n')
                    .find((line) => line.startsWith('data:'))!
                    .slice(5),
            );
            expect(payload.id).toBe('notice');
            expect(payload.userId).toBe('user');
            expect(payload).not.toHaveProperty('meta');
        } finally {
            abort.abort();
            await reader.cancel().catch(() => undefined);
        }
    });
});

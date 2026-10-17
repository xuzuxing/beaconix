import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/infra/database/prisma.service';
import { JwtAuthGuard } from '../src/common/guards';
import { TransformInterceptor } from '../src/common/interceptors';
import { ProjectAccessService } from '../src/common/authorization/project-access.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { NotificationAccessService } from '../src/modules/notifications/notification-access.service';
import { TicketsController } from '../src/modules/tickets/tickets.controller';
import { TicketCategoriesController } from '../src/modules/tickets/ticket-categories.controller';
import { TicketsService } from '../src/modules/tickets/tickets.service';
import { TicketCategoriesService } from '../src/modules/tickets/ticket-categories.service';
import { AdminTicketsController } from '../src/modules/admin/tickets/admin-tickets.controller';
import { AdminTicketCategoriesController } from '../src/modules/admin/tickets/admin-ticket-categories.controller';
import { AdminTicketsService } from '../src/modules/admin/tickets/admin-tickets.service';
import { AdminTicketCategoriesService } from '../src/modules/admin/tickets/admin-ticket-categories.service';

const url = process.env.TICKETS_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

/** Only a disposable local database is ever touched. */
function assertSafeDatabase(value: string): void {
    const parsed = new URL(value);
    if (
        !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
        !/^\/beacon_tickets_test(?:_[a-z0-9_]+)?$/.test(parsed.pathname)
    ) {
        throw new Error(
            'TICKETS_TEST_DATABASE_URL must point at a disposable local database named beacon_tickets_test',
        );
    }
}

suite('Support tickets (real PostgreSQL/HTTP)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let base: string;
    let authorToken: string;
    let otherToken: string;
    let staffToken: string;
    let author: string;
    let other: string;
    let staff: string;
    const prefix = `tickets-${randomUUID()}`;

    const request = async (
        method: string,
        path: string,
        jwt?: string,
        body?: unknown,
    ) => {
        const response = await fetch(`${base}/api${path}`, {
            method,
            headers: {
                ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
                ...(body === undefined
                    ? {}
                    : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        return {
            status: response.status,
            body: text ? JSON.parse(text) : null,
        };
    };

    beforeAll(async () => {
        assertSafeDatabase(url!);
        prisma = new PrismaService(
            new ConfigService({
                database: { url },
                app: { isDevelopment: false, webUrl: 'http://localhost:3000' },
            }),
        );

        const access = new ProjectAccessService(prisma);
        const authorization = new NotificationAccessService(prisma, access);
        const notifications = new NotificationsService(
            prisma,
            { kick: () => undefined } as never,
            {} as never,
            authorization,
            access,
        );

        const module = await Test.createTestingModule({
            imports: [JwtModule.register({ secret: 'tickets-e2e-only' })],
            controllers: [
                TicketCategoriesController,
                TicketsController,
                AdminTicketsController,
                AdminTicketCategoriesController,
            ],
            providers: [
                { provide: PrismaService, useValue: prisma },
                { provide: NotificationsService, useValue: notifications },
                {
                    provide: ConfigService,
                    useValue: {
                        get: () => ({
                            webUrl: 'http://localhost:3000',
                        }),
                    },
                },
                ProjectAccessService,
                TicketsService,
                TicketCategoriesService,
                AdminTicketsService,
                AdminTicketCategoriesService,
                { provide: APP_GUARD, useClass: JwtAuthGuard },
            ],
        }).compile();

        app = module.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
            }),
        );
        app.useGlobalInterceptors(new TransformInterceptor());
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();

        author = (
            await prisma.user.create({
                data: {
                    email: `${prefix}-author@test.invalid`,
                    name: 'Author',
                    password: 'unused',
                    emailVerified: true,
                },
            })
        ).id;
        other = (
            await prisma.user.create({
                data: {
                    email: `${prefix}-other@test.invalid`,
                    name: 'Other',
                    password: 'unused',
                    emailVerified: true,
                },
            })
        ).id;
        staff = (
            await prisma.user.create({
                data: {
                    email: `${prefix}-staff@test.invalid`,
                    name: 'Ops',
                    password: 'unused',
                    emailVerified: true,
                    globalRole: 'SUPER_ADMIN',
                },
            })
        ).id;

        const jwt = app.get(JwtService);
        authorToken = jwt.sign({ sub: author, globalRole: 'USER' });
        otherToken = jwt.sign({ sub: other, globalRole: 'USER' });
        staffToken = jwt.sign({ sub: staff, globalRole: 'SUPER_ADMIN' });
    }, 60000);

    afterAll(async () => {
        if (prisma) {
            const users = [author, other, staff].filter(Boolean);
            await prisma.ticket.deleteMany({
                where: { authorId: { in: users } },
            });
            await prisma.notification.deleteMany({
                where: { userId: { in: users } },
            });
            await prisma.user.deleteMany({ where: { id: { in: users } } });
        }
        await app?.close();
        await prisma?.$disconnect();
    });

    it('requires a JWT on both surfaces', async () => {
        expect((await request('GET', '/tickets')).status).toBe(401);
        expect((await request('GET', '/admin/tickets')).status).toBe(401);
    });

    it('forbids non-platform users from the admin surface', async () => {
        expect(
            (await request('GET', '/admin/tickets', authorToken)).status,
        ).toBe(403);
        expect(
            (await request('GET', '/admin/tickets', staffToken)).status,
        ).toBe(200);
    });

    it('serves the category list before the :ticketId route', async () => {
        const { status, body } = await request(
            'GET',
            '/tickets/categories',
            authorToken,
        );
        expect(status).toBe(200);
        expect(Array.isArray(body.data)).toBe(true);
    });

    it('runs the full submit → reply → timeline → close loop', async () => {
        const created = await request('POST', '/tickets', authorToken, {
            subject: 'Export fails on large workspaces',
            content: 'Posting the export endpoint returns 500.',
            priority: 'HIGH',
        });
        expect(created.status).toBe(201);
        const ticketId = created.body.data.id as string;
        expect(created.body.data).toMatchObject({
            number: expect.any(Number),
            status: 'OPEN',
            priority: 'HIGH',
        });

        // The author cannot see the admin surface, and another user cannot read
        // the ticket: it is indistinguishable from a missing one.
        expect(
            (await request('GET', `/tickets/${ticketId}`, otherToken)).status,
        ).toBe(404);

        const replied = await request(
            'POST',
            `/admin/tickets/${ticketId}/replies`,
            staffToken,
            { body: 'We shipped a fix in the latest release.' },
        );
        expect(replied.status).toBe(201);
        expect(replied.body.data.ticket.status).toBe('PROCESSING');

        const detail = await request(
            'GET',
            `/tickets/${ticketId}`,
            authorToken,
        );
        expect(detail.status).toBe(200);
        expect(detail.body.data.status).toBe('PROCESSING');
        expect(detail.body.data.timelineTruncated).toBe(false);
        expect(
            detail.body.data.timeline.map(
                (item: { kind: string }) => item.kind,
            ),
        ).toEqual(['activity', 'reply']);
        expect(detail.body.data.timeline[0]).toMatchObject({
            kind: 'activity',
            type: 'CREATED',
        });
        expect(detail.body.data.timeline[1]).toMatchObject({
            kind: 'reply',
            authorType: 'STAFF',
            body: 'We shipped a fix in the latest release.',
        });

        const unread = await prisma.notification.count({
            where: {
                userId: author,
                resourceId: ticketId,
                isRead: false,
            },
        });
        expect(unread).toBe(1);

        const closed = await request(
            'POST',
            `/tickets/${ticketId}/close`,
            authorToken,
        );
        expect(closed.status).toBe(200);
        expect(closed.body.data).toMatchObject({ status: 'CLOSED' });
        expect(closed.body.data.closedAt).toBeTruthy();

        const after = await request('GET', `/tickets/${ticketId}`, authorToken);
        expect(after.body.data.timeline).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'activity',
                    type: 'STATUS_CHANGED',
                    oldValue: 'PROCESSING',
                    newValue: 'CLOSED',
                }),
            ]),
        );

        // Closing twice is a conflict, and replying reopens the ticket.
        expect(
            (await request('POST', `/tickets/${ticketId}/close`, authorToken))
                .status,
        ).toBe(409);
        const reopened = await request(
            'POST',
            `/tickets/${ticketId}/replies`,
            authorToken,
            { body: 'Actually it still fails.' },
        );
        expect(reopened.status).toBe(201);
        expect(reopened.body.data.ticket.status).toBe('OPEN');
    });

    it('never exposes internal notes to the submitter', async () => {
        const created = await request('POST', '/tickets', authorToken, {
            subject: 'Internal note visibility',
            content: 'Please check the note handling.',
        });
        const ticketId = created.body.data.id as string;

        await request(
            'POST',
            `/admin/tickets/${ticketId}/replies`,
            staffToken,
            {
                body: 'Internal only: duplicate of #12.',
                isInternalNote: true,
            },
        );

        const detail = await request(
            'GET',
            `/tickets/${ticketId}`,
            authorToken,
        );
        expect(detail.body.data.timeline).toEqual([
            expect.objectContaining({ kind: 'activity', type: 'CREATED' }),
        ]);
        const adminDetail = await request(
            'GET',
            `/admin/tickets/${ticketId}`,
            staffToken,
        );
        expect(adminDetail.body.data.timeline).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'activity', type: 'CREATED' }),
                expect.objectContaining({
                    kind: 'reply',
                    isInternalNote: true,
                }),
            ]),
        );
        expect(
            await prisma.notification.count({
                where: { userId: author, resourceId: ticketId },
            }),
        ).toBe(0);
    });

    it('validates the payloads', async () => {
        expect(
            (
                await request('POST', '/tickets', authorToken, {
                    subject: 'no',
                    content: 'body',
                })
            ).status,
        ).toBe(400);
        expect(
            (
                await request('POST', '/tickets', authorToken, {
                    subject: 'Shell injection',
                    content: 'body',
                    status: 'CLOSED',
                })
            ).status,
        ).toBe(400);
        expect(
            (
                await request('PATCH', '/admin/tickets/missing', staffToken, {
                    status: 'CLOSED',
                })
            ).status,
        ).toBe(404);
    });
});

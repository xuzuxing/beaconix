import { mockProjectAccess } from '../../common/authorization/access-test.fixture';
import { CommentsService } from './comments.service';

function setup(parentAuthor: string | null = 'reply-author') {
    let inTransaction = false;
    const tx = {
        comment: {
            findFirst: jest
                .fn()
                .mockResolvedValue({ id: 'parent', authorId: parentAuthor }),
            create: jest
                .fn()
                .mockResolvedValue({ id: 'comment', body: 'A reply' }),
        },
        membership: {
            findMany: jest.fn().mockResolvedValue([
                { userId: 'mentioned', user: { name: 'Ann' } },
                { userId: 'reply-author', user: { name: 'Bob' } },
                { userId: 'actor', user: { name: 'Me' } },
                { userId: 'other-name', user: { name: 'Anna' } },
            ]),
        },
    };
    const prisma = {
        task: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'task',
                projectId: 'project',
                organizationId: 'org',
                number: 7,
            }),
        },
        $transaction: jest.fn().mockImplementation(async (callback) => {
            inTransaction = true;
            try {
                return await callback(tx);
            } finally {
                inTransaction = false;
            }
        }),
    };
    const notifications = {
        taskRecipients: jest
            .fn()
            .mockResolvedValue([
                'actor',
                'reply-author',
                'mentioned',
                'watcher',
                'creator',
                'assignee',
                'watcher',
            ]),
        publish: jest.fn().mockImplementation((_event, client) => {
            expect(inTransaction).toBe(true);
            expect(client).toBe(tx);
            return Promise.resolve();
        }),
    };
    Object.assign(tx, { task: prisma.task });
    return {
        service: new CommentsService(
            prisma as never,
            notifications as never,
            mockProjectAccess(prisma, 'org'),
        ),
        prisma,
        tx,
        notifications,
        event: () => notifications.publish.mock.calls[0][0],
    };
}

describe('CommentsService collaboration notifications', () => {
    it('prioritizes mentions, then reply authors, then task participants with one notice each', async () => {
        const { service, notifications, tx, event } = setup();
        await service.create('task', 'actor', {
            body: 'Hello @Ann and @Me',
            parentId: 'parent',
        });
        expect(event()).toMatchObject({
            eventKey: 'comment:comment:created',
            type: 'TASK_COMMENTED',
            actorId: 'actor',
            organizationId: 'org',
            resourceType: 'Task',
            resourceId: 'task',
            meta: { commentId: 'comment', parentId: 'parent' },
            recipients: [
                {
                    userId: 'mentioned',
                    type: 'MENTION',
                    title: expect.any(String),
                },
                {
                    userId: 'reply-author',
                    type: 'COMMENT_REPLIED',
                    title: expect.any(String),
                },
                'watcher',
                'creator',
                'assignee',
            ],
        });
        expect(notifications.taskRecipients).toHaveBeenCalledWith('task', tx);
        expect(tx.membership.findMany).toHaveBeenCalledWith({
            where: {
                organizationId: 'org',
                user: { isActive: true, deletedAt: null },
                OR: [
                    { role: { in: ['OWNER', 'ADMIN'] } },
                    {
                        role: { in: ['MEMBER', 'VIEWER'] },
                        projectMemberships: { some: { projectId: 'project' } },
                    },
                ],
            },
            select: { userId: true, user: { select: { name: true } } },
        });
    });

    it('gives a mentioned reply author only the MENTION override', async () => {
        const { service, event } = setup('mentioned');
        await service.create('task', 'actor', {
            body: '@Ann a reply',
            parentId: 'parent',
        });
        expect(
            event().recipients.filter((r) => r.userId === 'mentioned'),
        ).toEqual([
            { userId: 'mentioned', type: 'MENTION', title: expect.any(String) },
        ]);
        expect(
            event().recipients.some((r) => r.type === 'COMMENT_REPLIED'),
        ).toBe(false);
    });

    it('notifies a reply author even when they are not watching', async () => {
        const { service, notifications, event } = setup();
        notifications.taskRecipients.mockResolvedValue(['watcher']);
        await service.create('task', 'actor', {
            body: 'A reply',
            parentId: 'parent',
        });
        expect(event().recipients).toEqual([
            {
                userId: 'reply-author',
                type: 'COMMENT_REPLIED',
                title: expect.any(String),
            },
            'watcher',
        ]);
    });

    it.each(['actor', null])(
        'does not target a self/deleted reply author %s',
        async (author) => {
            const { service, notifications, event } = setup(author);
            notifications.taskRecipients.mockResolvedValue([
                'actor',
                'watcher',
            ]);
            await service.create('task', 'actor', {
                body: 'A reply',
                parentId: 'parent',
            });
            expect(event().recipients).toEqual(['watcher']);
        },
    );

    it('does not treat an email address or a name prefix as a mention', async () => {
        const { service, event } = setup();
        await service.create('task', 'actor', {
            body: 'foo@Ann.com and @Anna',
        });
        expect(event().recipients[0]).toMatchObject({
            userId: 'other-name',
            type: 'MENTION',
        });
        expect(event().recipients).toContain('mentioned');
        expect(event().recipients.some((r) => r.userId === 'mentioned')).toBe(
            false,
        );
    });

    it('rejects a missing or cross-task parent before creating or publishing', async () => {
        const { service, tx, notifications } = setup();
        tx.comment.findFirst.mockResolvedValue(null);
        await expect(
            service.create('task', 'actor', {
                body: 'A reply',
                parentId: 'missing',
            }),
        ).rejects.toThrow('Parent comment not found');
        expect(tx.comment.findFirst).toHaveBeenCalledWith({
            where: { id: 'missing', taskId: 'task', deletedAt: null },
        });
        expect(tx.comment.create).not.toHaveBeenCalled();
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('propagates publish failure through the comment transaction', async () => {
        const { service, notifications } = setup();
        notifications.publish.mockRejectedValue(
            new Error('Outbox unavailable'),
        );
        await expect(
            service.create('task', 'actor', { body: 'Comment' }),
        ).rejects.toThrow('Outbox unavailable');
    });
});

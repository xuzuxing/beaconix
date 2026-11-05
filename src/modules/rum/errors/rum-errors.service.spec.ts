import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RumErrorStatus } from '../../../generated/prisma/enums';
import { RumErrorsService } from './rum-errors.service';

describe('RumErrorsService', () => {
    function setup(
        options: { groupExists?: boolean; allowManage?: boolean } = {},
    ) {
        const { groupExists = true, allowManage = false } = options;
        const prisma = {
            rumApp: {
                findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }),
            },
            membership: {
                findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }),
            },
            rumErrorGroup: {
                findFirst: jest
                    .fn()
                    .mockResolvedValue(groupExists ? { id: 'error-1' } : null),
                update: jest
                    .fn()
                    .mockImplementation(({ data }) =>
                        Promise.resolve({ id: 'error-1', ...data }),
                    ),
            },
            rumErrorOccurrence: {
                findMany: jest
                    .fn()
                    .mockResolvedValue([
                        { id: 'occurrence-2' },
                        { id: 'occurrence-1' },
                    ]),
                count: jest.fn().mockResolvedValue(2),
            },
            rumErrorNote: {
                findMany: jest.fn().mockResolvedValue([{ id: 'note-1' }]),
                count: jest.fn().mockResolvedValue(1),
                create: jest
                    .fn()
                    .mockImplementation(({ data }) =>
                        Promise.resolve({ id: 'note-1', ...data }),
                    ),
                findFirst: jest.fn().mockResolvedValue({
                    id: 'note-1',
                    authorId: 'author-1',
                }),
                delete: jest.fn().mockResolvedValue({ id: 'note-1' }),
            },
            $transaction: jest.fn((operations) => Promise.all(operations)),
        };
        const access = {
            project: jest.fn((_principal, _projectId, action: string) => {
                if (action === 'app.manage' && !allowManage) {
                    return Promise.reject(
                        new ForbiddenException('Administrator required'),
                    );
                }
                return Promise.resolve({ organizationId: 'org-1' });
            }),
        };
        return {
            service: new RumErrorsService(prisma as never, access as never),
            prisma,
            access,
        };
    }

    it('returns paginated occurrences only for the requested app and group', async () => {
        const { service, prisma, access } = setup();
        const principal = { type: 'USER', userId: 'user-1' } as const;

        await expect(
            service.findOccurrences(
                'project-1',
                'app-1',
                'error-1',
                { page: 2, limit: 10 },
                principal,
            ),
        ).resolves.toEqual({
            items: [{ id: 'occurrence-2' }, { id: 'occurrence-1' }],
            total: 2,
            page: 2,
            limit: 10,
        });

        expect(access.project).toHaveBeenCalledWith(
            principal,
            'project-1',
            'rum.read',
        );
        expect(prisma.rumErrorOccurrence.findMany).toHaveBeenCalledWith({
            where: { groupId: 'error-1', appId: 'app-1' },
            orderBy: { receivedAt: 'desc' },
            skip: 10,
            take: 10,
        });
    });

    it('does not expose occurrences when the error group is missing', async () => {
        const { service, prisma } = setup({ groupExists: false });

        await expect(
            service.findOccurrences(
                'project-1',
                'app-1',
                'error-1',
                { page: 1, limit: 20 },
                { type: 'USER', userId: 'user-1' },
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.rumErrorOccurrence.findMany).not.toHaveBeenCalled();
    });

    it('stamps the resolver when a reader resolves an error', async () => {
        const { service, prisma } = setup();

        await service.update(
            'project-1',
            'app-1',
            'error-1',
            { status: RumErrorStatus.RESOLVED },
            { type: 'USER', userId: 'user-1' },
        );

        const update = prisma.rumErrorGroup.update.mock.calls[0][0];
        expect(update.where).toEqual({ id: 'error-1' });
        expect(update.data).toMatchObject({
            status: RumErrorStatus.RESOLVED,
            resolvedBy: 'user-1',
            ignoredUntil: null,
        });
        expect(update.data.resolvedAt).toBeInstanceOf(Date);
    });

    it('requires app.manage before assigning another member', async () => {
        const { service, prisma } = setup();

        await expect(
            service.update(
                'project-1',
                'app-1',
                'error-1',
                { assigneeId: 'other-user' },
                { type: 'USER', userId: 'user-1' },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.rumErrorGroup.update).not.toHaveBeenCalled();
    });

    it('rejects an assignee outside the organization', async () => {
        const { service, prisma } = setup({ allowManage: true });
        prisma.membership.findFirst.mockResolvedValue(null);

        await expect(
            service.update(
                'project-1',
                'app-1',
                'error-1',
                { assigneeId: 'stranger' },
                { type: 'USER', userId: 'user-1' },
            ),
        ).rejects.toThrow('active organization member');
        expect(prisma.rumErrorGroup.update).not.toHaveBeenCalled();
    });

    it('keeps the ignore window when ignoring and clears it on reopen', async () => {
        const { service, prisma } = setup();

        await service.update(
            'project-1',
            'app-1',
            'error-1',
            {
                status: RumErrorStatus.IGNORED,
                ignoredUntil: '2026-12-01T00:00:00.000Z',
            },
            { type: 'USER', userId: 'user-1' },
        );
        expect(prisma.rumErrorGroup.update.mock.calls[0][0].data).toMatchObject(
            {
                status: RumErrorStatus.IGNORED,
                ignoredUntil: new Date('2026-12-01T00:00:00.000Z'),
                resolvedAt: null,
                resolvedBy: null,
            },
        );

        await service.update(
            'project-1',
            'app-1',
            'error-1',
            { status: RumErrorStatus.UNRESOLVED },
            { type: 'USER', userId: 'user-1' },
        );
        expect(prisma.rumErrorGroup.update.mock.calls[1][0].data).toMatchObject(
            {
                status: RumErrorStatus.UNRESOLVED,
                ignoredUntil: null,
            },
        );
    });

    it('lists handling notes with author information', async () => {
        const { service, prisma } = setup();

        const result = await service.notes(
            'project-1',
            'app-1',
            'error-1',
            { page: 1, limit: 20 },
            { type: 'USER', userId: 'user-1' },
        );

        expect(result).toEqual({
            items: [{ id: 'note-1' }],
            total: 1,
            page: 1,
            limit: 20,
        });
        expect(prisma.rumErrorNote.findMany).toHaveBeenCalledWith({
            where: { appId: 'app-1', groupId: 'error-1' },
            include: {
                author: { select: { id: true, name: true, email: true } },
            },
            orderBy: { createdAt: 'desc' },
            skip: 0,
            take: 20,
        });
    });

    it('records the author when a member adds a note', async () => {
        const { service, prisma } = setup();

        await service.createNote(
            'project-1',
            'app-1',
            'error-1',
            { body: '  checking on staging  ' },
            { type: 'USER', userId: 'user-1' },
        );

        expect(prisma.rumErrorNote.create).toHaveBeenCalledWith({
            data: {
                appId: 'app-1',
                groupId: 'error-1',
                authorId: 'user-1',
                body: 'checking on staging',
            },
            include: {
                author: { select: { id: true, name: true, email: true } },
            },
        });
    });

    it('lets the author delete a note without app.manage', async () => {
        const { service, prisma } = setup();
        prisma.rumErrorNote.findFirst.mockResolvedValue({
            id: 'note-1',
            authorId: 'user-1',
        });

        await service.removeNote('project-1', 'app-1', 'error-1', 'note-1', {
            type: 'USER',
            userId: 'user-1',
        });

        expect(prisma.rumErrorNote.delete).toHaveBeenCalledWith({
            where: { id: 'note-1' },
        });
    });

    it('requires app.manage before deleting another member note', async () => {
        const { service, prisma } = setup();

        await expect(
            service.removeNote('project-1', 'app-1', 'error-1', 'note-1', {
                type: 'USER',
                userId: 'user-2',
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.rumErrorNote.delete).not.toHaveBeenCalled();
    });
});

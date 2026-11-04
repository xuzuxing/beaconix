import { NotFoundException } from '@nestjs/common';
import { RumErrorsService } from './rum-errors.service';

describe('RumErrorsService', () => {
    function setup(groupExists = true) {
        const prisma = {
            rumApp: {
                findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }),
            },
            rumErrorGroup: {
                findFirst: jest
                    .fn()
                    .mockResolvedValue(groupExists ? { id: 'error-1' } : null),
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
            $transaction: jest.fn((operations) => Promise.all(operations)),
        };
        const access = {
            project: jest.fn().mockResolvedValue({ organizationId: 'org-1' }),
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
        const { service, prisma } = setup(false);

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
});

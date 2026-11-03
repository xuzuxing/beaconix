import { ConflictException } from '@nestjs/common';
import { RumAppsService } from './rum-apps.service';

describe('RumAppsService', () => {
    function setup(count = 0) {
        const tx = {
            rumApp: {
                count: jest.fn().mockResolvedValue(count),
                create: jest.fn((args) => Promise.resolve(args.data)),
            },
        };
        const access = {
            withProject: jest.fn((_principal, _projectId, _action, work) =>
                work(tx, { organizationId: 'org-1' }),
            ),
        };
        const service = new RumAppsService(
            {} as never,
            access as never,
            {
                get: () => ({
                    maxAppsPerProject: 2,
                    appRequestsPerMinute: 600,
                    sourceRequestsPerMinute: 120,
                    errorRetentionDays: 90,
                }),
            } as never,
        );
        return { service, access, tx };
    }

    it('creates an app under the authorized project lock', async () => {
        const { service, access, tx } = setup();
        const result = await service.create(
            'project-1',
            { name: ' Portal ' },
            { type: 'USER', userId: 'user-1' },
        );

        expect(access.withProject).toHaveBeenCalledWith(
            { type: 'USER', userId: 'user-1' },
            'project-1',
            'app.manage',
            expect.any(Function),
            'UPDATE',
        );
        expect(tx.rumApp.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                name: 'Portal',
                publicKey: expect.stringMatching(/^rum_[A-Za-z0-9_-]+$/),
                organizationId: 'org-1',
                projectId: 'project-1',
                createdById: 'user-1',
            }),
        });
        expect(result).toMatchObject({ name: 'Portal' });
    });

    it('enforces the configured project app limit inside the lock', async () => {
        const { service, tx } = setup(2);
        await expect(
            service.create(
                'project-1',
                { name: 'Portal' },
                { type: 'USER', userId: 'user-1' },
            ),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(tx.rumApp.create).not.toHaveBeenCalled();
    });
});

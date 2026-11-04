import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PROJECT_PERMISSION_KEY } from '../../../common/authorization/project-permission.decorator';
import { RumAlertRulesController } from './rum-alert-rules.controller';
import { RumAlertRulesService } from './rum-alert-rules.service';

describe('RUM alert channel selection', () => {
    const principal = { type: 'USER' as const, userId: 'user-1' };
    function setup() {
        const tx = {
            rumApp: { findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }) },
            notificationChannel: {
                findMany: jest
                    .fn()
                    .mockResolvedValue([
                        { id: 'channel-1', name: 'Operations', enabled: true },
                    ]),
            },
        };
        const access = {
            withProject: jest.fn((_principal, _projectId, _action, work) =>
                work(tx, { organizationId: 'org-1' }),
            ),
        };
        return {
            tx,
            access,
            service: new RumAlertRulesService({} as never, access as never),
        };
    }

    it('requires app management on the RUM app at the controller', () => {
        expect(
            Reflect.getMetadata(
                PROJECT_PERMISSION_KEY,
                RumAlertRulesController,
            ),
        ).toEqual({
            action: 'app.manage',
            resource: { resourceType: 'RUM_APP', idParam: 'appId' },
        });
        expect(
            Reflect.getMetadata(
                PROJECT_PERMISSION_KEY,
                Object.getOwnPropertyDescriptor(
                    RumAlertRulesController.prototype,
                    'channels',
                )?.value as object,
            ),
        ).toBeUndefined();
    });

    it('checks project and app and selects only non-secret fields from the authorized organization', async () => {
        const { service, access, tx } = setup();
        await expect(
            service.channels('project-1', 'app-1', principal),
        ).resolves.toEqual([
            { id: 'channel-1', name: 'Operations', enabled: true },
        ]);
        expect(access.withProject).toHaveBeenCalledWith(
            principal,
            'project-1',
            'app.manage',
            expect.any(Function),
        );
        expect(tx.rumApp.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'app-1',
                organizationId: 'org-1',
                projectId: 'project-1',
                deletedAt: null,
            },
            select: { id: true },
        });
        expect(tx.notificationChannel.findMany).toHaveBeenCalledWith({
            where: { organizationId: 'org-1' },
            select: { id: true, name: true, enabled: true },
            orderBy: { name: 'asc' },
        });
    });

    it('does not list channels if project authorization fails or the app is unavailable', async () => {
        const { service, access, tx } = setup();
        access.withProject.mockRejectedValueOnce(new ForbiddenException());
        await expect(
            service.channels('project-1', 'app-1', principal),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(tx.notificationChannel.findMany).not.toHaveBeenCalled();
        tx.rumApp.findFirst.mockResolvedValueOnce(null);
        await expect(
            service.channels('project-1', 'wrong-app', principal),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(tx.notificationChannel.findMany).not.toHaveBeenCalled();
    });
});

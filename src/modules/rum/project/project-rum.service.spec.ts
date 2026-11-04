import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PROJECT_PERMISSION_KEY } from '../../../common/authorization/project-permission.decorator';
import { ProjectRumController } from './project-rum.controller';
import { ProjectRumService } from './project-rum.service';
import {
    QueryProjectRumErrorsDto,
    QueryProjectRumEventsDto,
} from './query-project-rum.dto';

describe('project RUM queries', () => {
    const principal = { type: 'USER' as const, userId: 'u' };
    const scope = { organizationId: 'org', projectId: 'p', deletedAt: null };
    function setup() {
        const error = {
            findMany: jest.fn().mockResolvedValue([{ id: 'e' }]),
            count: jest.fn().mockResolvedValue(21),
            groupBy: jest
                .fn()
                .mockResolvedValue([{ appId: 'a', _count: { _all: 3 } }]),
        };
        const events = {
            findMany: jest.fn().mockResolvedValue([{ id: 'v' }]),
            count: jest.fn().mockResolvedValue(6),
            groupBy: jest
                .fn()
                .mockResolvedValue([{ appId: 'a', _count: { _all: 6 } }]),
        };
        const db = {
            rumErrorGroup: error,
            rumEvent: events,
            rumApp: {
                findMany: jest
                    .fn()
                    .mockResolvedValue([{ id: 'a', name: 'A', enabled: true }]),
            },
            rumReplaySession: { count: jest.fn().mockResolvedValue(2) },
            rumAlertIncident: { count: jest.fn().mockResolvedValue(1) },
            $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
        };
        const access = {
            project: jest.fn().mockResolvedValue({ organizationId: 'org' }),
        };
        return {
            db,
            access,
            service: new ProjectRumService(db as never, access as never),
        };
    }
    it('requires project rum.read at the controller and service', async () => {
        expect(
            Reflect.getMetadata(PROJECT_PERMISSION_KEY, ProjectRumController),
        ).toEqual({
            action: 'rum.read',
            resource: { resourceType: 'PROJECT', idParam: 'projectId' },
        });
        const { service, access, db } = setup();
        access.project.mockRejectedValueOnce(new ForbiddenException());
        await expect(service.overview('p', principal)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        expect(db.rumApp.findMany).not.toHaveBeenCalled();
        expect(access.project).toHaveBeenCalledWith(principal, 'p', 'rum.read');
    });
    it('scopes overview counts to the authorized project and excludes deleted apps', async () => {
        const { service, db } = setup();
        const result = await service.overview('p', principal);
        expect(result).toMatchObject({
            appCount: 1,
            errorGroups: 21,
            events7d: 6,
            replays: 2,
            openAlerts: 1,
            apps: [{ id: 'a', errorGroups: 3, events7d: 6 }],
        });
        expect(db.rumApp.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: scope }),
        );
        expect(db.rumErrorGroup.count).toHaveBeenCalledWith({
            where: { app: scope },
        });
        expect(db.rumEvent.count).toHaveBeenCalledWith({
            where: { app: scope, receivedAt: { gte: expect.any(Date) } },
        });
    });
    it('queries errors with project, application, type, date and real database pagination', async () => {
        const { service, db } = setup();
        const query = Object.assign(new QueryProjectRumErrorsDto(), {
            page: 2,
            limit: 10,
            appId: 'a',
            type: 'error',
            from: '2026-01-01T00:00:00Z',
        });
        expect(await service.errors('p', query, principal)).toMatchObject({
            total: 21,
            page: 2,
            limit: 10,
        });
        expect(db.rumErrorGroup.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    app: { ...scope, id: 'a' },
                    type: 'error',
                    lastSeenAt: { gte: new Date(query.from) },
                },
                skip: 10,
                take: 10,
            }),
        );
    });
    it('queries events by project and application and rejects invalid date ranges', async () => {
        const { service, db } = setup();
        const query = Object.assign(new QueryProjectRumEventsDto(), {
            page: 3,
            limit: 10,
            appId: 'a',
            eventName: 'checkout',
            to: '2026-01-03T00:00:00Z',
        });
        await service.events('p', query, principal);
        expect(db.rumEvent.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    app: { ...scope, id: 'a' },
                    eventName: 'checkout',
                    receivedAt: { lte: new Date(query.to) },
                },
                skip: 20,
                take: 10,
            }),
        );
        await expect(
            service.events(
                'p',
                { ...query, from: '2026-02-01T00:00:00Z' },
                principal,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});

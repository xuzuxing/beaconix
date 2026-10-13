import { NotFoundException } from '@nestjs/common';
import { ResourceContextResolver } from './resource-context.resolver';
import type { ProjectResourceType } from './access.types';

function setup() {
    const resource = {
        id: 'resource',
        projectId: 'project',
        organizationId: 'org',
    };
    const task = { ...resource, id: 'task' };
    const db = {
        project: {
            findFirst: jest.fn().mockResolvedValue({ organizationId: 'org' }),
        },
        task: { findFirst: jest.fn().mockResolvedValue(task) },
        sprint: { findUnique: jest.fn().mockResolvedValue(resource) },
        monitor: { findFirst: jest.fn().mockResolvedValue(resource) },
        label: { findUnique: jest.fn().mockResolvedValue(resource) },
        ruleGroup: { findFirst: jest.fn().mockResolvedValue(resource) },
        alertEvent: { findUnique: jest.fn().mockResolvedValue(resource) },
        comment: {
            findFirst: jest.fn().mockResolvedValue({ taskId: 'task', task }),
        },
        attachment: {
            findFirst: jest.fn().mockResolvedValue({ taskId: 'task', task }),
        },
    };
    return { resolver: new ResourceContextResolver(db as never), db, resource };
}
describe('Explicit project resource resolution', () => {
    it.each([
        ['TASK', 'task', 'findFirst'],
        ['MONITOR', 'monitor', 'findFirst'],
        ['LABEL', 'label', 'findUnique'],
        ['RULE_GROUP', 'ruleGroup', 'findFirst'],
        ['ALERT_EVENT', 'alertEvent', 'findUnique'],
    ] as const)(
        'rejects inconsistent own organization fields for %s',
        async (resourceType, delegate, method) => {
            const { resolver, db, resource } = setup();
            db[delegate][method].mockResolvedValue({
                ...resource,
                organizationId: 'other-org',
            });
            await expect(
                resolver.resolve(
                    { id: 'resource' },
                    { resourceType, idParam: 'id' },
                ),
            ).rejects.toThrow(NotFoundException);
        },
    );
    it.each(['COMMENT', 'ATTACHMENT'] as const)(
        'rejects inconsistent task organization fields for %s',
        async (resourceType) => {
            const { resolver, db } = setup();
            const delegate =
                resourceType === 'COMMENT' ? db.comment : db.attachment;
            delegate.findFirst.mockResolvedValue({
                taskId: 'task',
                task: {
                    id: 'task',
                    projectId: 'project',
                    organizationId: 'other-org',
                },
            });
            await expect(
                resolver.resolve(
                    { id: 'resource' },
                    { resourceType, idParam: 'id' },
                ),
            ).rejects.toThrow(NotFoundException);
        },
    );
    it.each([
        'PROJECT',
        'TASK',
        'SPRINT',
        'MONITOR',
        'LABEL',
        'RULE_GROUP',
        'ALERT_EVENT',
        'COMMENT',
        'ATTACHMENT',
    ] as ProjectResourceType[])(
        'rejects declared parent mismatch for %s',
        async (resourceType) => {
            const { resolver } = setup();
            await expect(
                resolver.resolve(
                    { id: 'resource', projectId: 'other-project' },
                    { resourceType, idParam: 'id', projectParam: 'projectId' },
                ),
            ).rejects.toThrow(NotFoundException);
        },
    );
    it('requires declared organization and task parents to match exactly', async () => {
        const { resolver } = setup();
        await expect(
            resolver.resolve(
                { id: 'comment', taskId: 'other-task' },
                { resourceType: 'COMMENT', idParam: 'id', taskParam: 'taskId' },
            ),
        ).rejects.toThrow(NotFoundException);
        await expect(
            resolver.resolve(
                { id: 'project', orgId: 'other-org' },
                {
                    resourceType: 'PROJECT',
                    idParam: 'id',
                    organizationParam: 'orgId',
                },
            ),
        ).rejects.toThrow(NotFoundException);
    });
    it('fails closed for missing IDs, unknown types and shared labels', async () => {
        const { resolver, db } = setup();
        await expect(
            resolver.resolve({}, { resourceType: 'PROJECT', idParam: 'id' }),
        ).rejects.toThrow();
        await expect(
            resolver.resolve({ id: 'resource' }, {
                resourceType: 'UNKNOWN',
                idParam: 'id',
            } as never),
        ).rejects.toThrow();
        db.label.findUnique.mockResolvedValue({ projectId: null });
        await expect(
            resolver.resolve(
                { id: 'resource' },
                { resourceType: 'LABEL', idParam: 'id' },
            ),
        ).rejects.toThrow();
    });
    it('filters deleted resources and deleted parent organizations', async () => {
        const { resolver, db } = setup();
        await resolver.resolve(
            { id: 'task' },
            { resourceType: 'TASK', idParam: 'id' },
        );
        expect(db.task.findFirst).toHaveBeenCalledWith({
            where: { id: 'task', deletedAt: null },
            select: { id: true, projectId: true, organizationId: true },
        });
        expect(db.project.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'project',
                deletedAt: null,
                organization: { deletedAt: null },
            },
            select: { organizationId: true },
        });
    });
});

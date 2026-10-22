import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { resolveTenant } from './resolve-tenant';

function makeRequest(params: Record<string, string>): Request {
    return { params } as unknown as Request;
}

/**
 * 每个分支默认返回 null，测试按需覆盖——这样「命中哪个分支」一目了然，
 * 不会因为 mock 默认值掩盖顺序问题。
 */
function createPrisma(
    options: {
        project?: { organizationId: string } | null;
        task?: { organizationId: string; projectId: string } | null;
        org?: { id: string } | null;
        label?: { organizationId: string } | null;
        order?: { organizationId: string } | null;
    } = {},
) {
    return {
        project: {
            findFirst: jest
                .fn()
                .mockResolvedValue(
                    options.project === undefined ? null : options.project,
                ),
        },
        task: {
            findFirst: jest
                .fn()
                .mockResolvedValue(
                    options.task === undefined ? null : options.task,
                ),
        },
        organization: {
            findFirst: jest
                .fn()
                .mockResolvedValue(
                    options.org === undefined ? null : options.org,
                ),
        },
        label: {
            findUnique: jest
                .fn()
                .mockResolvedValue(
                    options.label === undefined ? null : options.label,
                ),
        },
        order: {
            findUnique: jest
                .fn()
                .mockResolvedValue(
                    options.order === undefined ? null : options.order,
                ),
        },
    };
}

describe('resolveTenant', () => {
    it('takes :orgId as is without touching the database', async () => {
        const prisma = createPrisma();

        await expect(
            resolveTenant(prisma as never, makeRequest({ orgId: 'org-1' })),
        ).resolves.toBe('org-1');

        expect(prisma.organization.findFirst).not.toHaveBeenCalled();
        expect(prisma.project.findFirst).not.toHaveBeenCalled();
        expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });

    it('resolves the tenant through :projectId and stashes it', async () => {
        const prisma = createPrisma({
            project: { organizationId: 'org-1' },
            org: { id: 'org-1' },
        });
        const request = makeRequest({ projectId: 'project-1' });

        await expect(resolveTenant(prisma as never, request)).resolves.toBe(
            'org-1',
        );
        expect(
            (request as unknown as Record<string, unknown>)['projectOrgId'],
        ).toBe('org-1');
    });

    it('rejects an unknown project', async () => {
        const prisma = createPrisma();

        await expect(
            resolveTenant(
                prisma as never,
                makeRequest({ projectId: 'missing' }),
            ),
        ).rejects.toThrow(new NotFoundException('Project not found'));
    });

    it('rejects a project whose organization is soft-deleted', async () => {
        const prisma = createPrisma({
            project: { organizationId: 'org-1' },
        });

        await expect(
            resolveTenant(
                prisma as never,
                makeRequest({ projectId: 'project-1' }),
            ),
        ).rejects.toThrow(new NotFoundException('Organization not found'));
    });

    it('resolves the tenant through :taskId and stashes project too', async () => {
        const prisma = createPrisma({
            task: { organizationId: 'org-1', projectId: 'project-1' },
            org: { id: 'org-1' },
        });
        const request = makeRequest({ taskId: 'task-1' });

        await expect(resolveTenant(prisma as never, request)).resolves.toBe(
            'org-1',
        );

        const stash = request as unknown as Record<string, unknown>;

        expect(stash['taskOrgId']).toBe('org-1');
        expect(stash['taskProjectId']).toBe('project-1');
    });

    it('rejects an unknown task', async () => {
        const prisma = createPrisma();

        await expect(
            resolveTenant(prisma as never, makeRequest({ taskId: 'missing' })),
        ).rejects.toThrow(new NotFoundException('Task not found'));
    });

    it('treats a generic :id as an organization when it matches one', async () => {
        const prisma = createPrisma({ org: { id: 'org-1' } });

        await expect(
            resolveTenant(prisma as never, makeRequest({ id: 'org-1' })),
        ).resolves.toBe('org-1');
    });

    it('treats a generic :id as a label and stashes the tenant', async () => {
        const prisma = createPrisma({ label: { organizationId: 'org-1' } });
        const request = makeRequest({ id: 'label-1' });

        await expect(resolveTenant(prisma as never, request)).resolves.toBe(
            'org-1',
        );
        expect(
            (request as unknown as Record<string, unknown>)['labelOrgId'],
        ).toBe('org-1');
    });

    it('treats a generic :id as an order and stashes the tenant', async () => {
        const prisma = createPrisma({ order: { organizationId: 'org-1' } });
        const request = makeRequest({ id: 'order-1' });

        await expect(resolveTenant(prisma as never, request)).resolves.toBe(
            'org-1',
        );
        expect(
            (request as unknown as Record<string, unknown>)['orderOrgId'],
        ).toBe('org-1');
    });

    it('returns undefined when the generic :id matches nothing', async () => {
        const prisma = createPrisma();

        await expect(
            resolveTenant(prisma as never, makeRequest({ id: 'unknown' })),
        ).resolves.toBeUndefined();
    });

    it('prefers :orgId over a generic :id when both are present', async () => {
        const prisma = createPrisma({ order: { organizationId: 'org-order' } });

        await expect(
            resolveTenant(
                prisma as never,
                makeRequest({ orgId: 'org-path', id: 'order-1' }),
            ),
        ).resolves.toBe('org-path');
        expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });

    it('returns undefined when the route carries no tenant-ish param', async () => {
        const prisma = createPrisma();

        await expect(
            resolveTenant(prisma as never, makeRequest({})),
        ).resolves.toBeUndefined();
    });
});

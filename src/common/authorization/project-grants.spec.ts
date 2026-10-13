import { BadRequestException, ConflictException } from '@nestjs/common';
import { assertGrantProjects, validateProjectGrants } from './project-grants';
const grant = { projectId: 'a', role: 'VIEWER' as const };
describe('Project grants validation', () => {
    it.each([undefined, [], null])(
        'requires projects for a regular invitation (%s)',
        (projects) => {
            expect(() =>
                validateProjectGrants('MEMBER', projects as never, true),
            ).toThrow(BadRequestException);
        },
    );
    it('allows empty replacement without inheriting all projects', () => {
        expect(validateProjectGrants('MEMBER', [])).toEqual([]);
    });
    it.each(['OWNER', 'ADMIN'] as const)(
        'disallows explicit grants for %s',
        (role) => {
            expect(() => validateProjectGrants(role, [])).toThrow(
                BadRequestException,
            );
            expect(validateProjectGrants(role, undefined)).toEqual([]);
        },
    );
    it('rejects duplicates', () => {
        expect(() => validateProjectGrants('MEMBER', [grant, grant])).toThrow(
            BadRequestException,
        );
    });
    it('rejects invalid roles, missing IDs and more than 100 grants', () => {
        expect(() =>
            validateProjectGrants('MEMBER', [
                { projectId: '', role: 'VIEWER' },
            ]),
        ).toThrow();
        expect(() =>
            validateProjectGrants('MEMBER', [
                { projectId: 'a', role: 'OWNER' } as never,
            ]),
        ).toThrow();
        expect(() =>
            validateProjectGrants(
                'MEMBER',
                Array.from({ length: 101 }, (_, index) => ({
                    ...grant,
                    projectId: String(index),
                })),
            ),
        ).toThrow();
    });
    it('caps viewer inputs', () => {
        expect(() =>
            validateProjectGrants('VIEWER', [{ ...grant, role: 'ADMIN' }]),
        ).toThrow();
        expect(validateProjectGrants('VIEWER', [grant], true)).toEqual([grant]);
    });
    it('does not replace the same transaction client or query all projects', async () => {
        const tx = {
            project: { findMany: jest.fn().mockResolvedValue([{ id: 'a' }]) },
        };
        await assertGrantProjects(tx as never, 'org', [grant]);
        expect(tx.project.findMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['a'] },
                organizationId: 'org',
                deletedAt: null,
                status: 'ACTIVE',
            },
            select: { id: true },
        });
    });
    it('uses a conflict when fixed invitation projects became invalid', async () => {
        const tx = { project: { findMany: jest.fn().mockResolvedValue([]) } };
        await expect(
            assertGrantProjects(tx as never, 'org', [grant], true),
        ).rejects.toThrow(ConflictException);
    });
});

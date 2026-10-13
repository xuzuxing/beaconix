import { BadRequestException, ConflictException } from '@nestjs/common';
import type { MembershipRole, ProjectRole } from '../../generated/prisma/enums';
import type { AccessDb } from './access-locks';

export interface ProjectGrantInput {
    projectId: string;
    role: ProjectRole;
}

export function validateProjectGrants(
    role: MembershipRole,
    projects: ProjectGrantInput[] | undefined,
    invitation = false,
) {
    if (role === 'OWNER' || role === 'ADMIN') {
        if (projects !== undefined) {
            throw new BadRequestException(
                'Organization administrators inherit all projects',
            );
        }
        return [];
    }
    if (
        !Array.isArray(projects) ||
        projects.length > 100 ||
        (invitation && projects.length === 0) ||
        projects.some(
            (project) =>
                !project ||
                typeof project.projectId !== 'string' ||
                !project.projectId.trim() ||
                !['VIEWER', 'MEMBER', 'ADMIN'].includes(project.role),
        )
    )
        throw new BadRequestException('Provide up to 100 valid project grants');
    if (
        new Set(projects.map((project) => project.projectId)).size !==
        projects.length
    ) {
        throw new BadRequestException('Duplicate project grants');
    }
    if (
        role === 'VIEWER' &&
        projects.some((project) => project.role !== 'VIEWER')
    ) {
        throw new BadRequestException(
            'Organization viewers can only receive VIEWER grants',
        );
    }
    return projects;
}

export async function assertGrantProjects(
    tx: AccessDb,
    organizationId: string,
    grants: ProjectGrantInput[],
    accepting = false,
) {
    const projects = await tx.project.findMany({
        where: {
            id: { in: grants.map((grant) => grant.projectId) },
            organizationId,
            deletedAt: null,
            status: 'ACTIVE',
        },
        select: { id: true },
    });
    if (projects.length !== grants.length) {
        const Exception = accepting ? ConflictException : BadRequestException;
        throw new Exception(
            'Every granted project must be active and belong to this organization',
        );
    }
}

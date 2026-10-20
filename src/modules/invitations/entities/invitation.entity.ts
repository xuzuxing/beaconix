import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
    InvitationStatus,
    MembershipRole,
    ProjectRole,
} from '../../../generated/prisma/enums';

export type InvitationAccessMode = 'ALL_PROJECTS' | 'SELECTED_PROJECTS';

/**
 * Public (token-only) view of an invitation. It intentionally exposes no
 * invitee email, invitee-facing project names or issuer identity beyond the
 * inviter's display name.
 */
export class InvitationPreviewEntity {
    @ApiProperty({ example: 'Beaconix' })
    organizationName: string;

    @ApiProperty({ example: 'beaconix' })
    organizationSlug: string;

    @ApiPropertyOptional({
        example: 'https://cdn.example.com/logos/beaconix.png',
        nullable: true,
    })
    organizationLogoUrl: string | null;

    @ApiProperty({ example: 'Jane Doe' })
    inviterName: string;

    @ApiProperty({ enum: ['ADMIN', 'MEMBER', 'VIEWER'], example: 'MEMBER' })
    role: MembershipRole;

    @ApiProperty({
        enum: ['ALL_PROJECTS', 'SELECTED_PROJECTS'],
        example: 'SELECTED_PROJECTS',
    })
    accessMode: InvitationAccessMode;

    @ApiProperty({
        example: 3,
        description:
            'Projects the invitee would join: the organization project count for ALL_PROJECTS, otherwise the number of granted projects',
    })
    projectCount: number;

    @ApiProperty({ example: '2026-03-12T12:00:00.000Z' })
    expiresAt: Date;

    @ApiProperty({
        enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED'],
        example: 'PENDING',
    })
    status: InvitationStatus;

    @ApiProperty({ example: true })
    requiresLogin: boolean;

    constructor(partial: InvitationPreviewEntity) {
        this.organizationName = partial.organizationName;
        this.organizationSlug = partial.organizationSlug;
        this.organizationLogoUrl = partial.organizationLogoUrl ?? null;
        this.inviterName = partial.inviterName;
        this.role = partial.role;
        this.accessMode = partial.accessMode;
        this.projectCount = partial.projectCount;
        this.expiresAt = partial.expiresAt;
        this.status = partial.status;
        this.requiresLogin = partial.requiresLogin;
    }
}

export class InvitationEntity {
    @ApiProperty({ example: 'uuid-here' })
    id: string;

    @ApiProperty({ example: 'jane@example.com' })
    email: string;

    @ApiProperty({ example: 'uuid-org' })
    organizationId: string;

    @ApiProperty({
        enum: ['ADMIN', 'MEMBER', 'VIEWER'],
        example: 'MEMBER',
    })
    role: string;

    @ApiProperty({
        enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED'],
        example: 'PENDING',
    })
    status: string;

    @ApiProperty({ example: '2026-03-12T12:00:00.000Z' })
    expiresAt: Date;

    @ApiProperty({ example: 'uuid-sender' })
    sentById: string;

    @ApiPropertyOptional({ example: '2026-03-06T12:00:00.000Z' })
    acceptedAt: Date | null;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    // Included when relations are loaded
    organization?: {
        id: string;
        name: string;
        slug: string;
    };

    sentBy?: {
        id: string;
        name: string;
        email: string;
    };

    @ApiProperty({ enum: ['ALL_PROJECTS', 'SELECTED_PROJECTS'] })
    accessMode: string;

    @ApiProperty({
        type: 'array',
        items: {
            type: 'object',
            properties: {
                projectId: { type: 'string' },
                projectName: { type: 'string' },
                role: { type: 'string', enum: ['VIEWER', 'MEMBER', 'ADMIN'] },
            },
        },
    })
    projects: { projectId: string; projectName: string; role: ProjectRole }[];

    constructor(
        partial: Partial<InvitationEntity> & {
            projectGrants?: {
                projectId: string;
                role: ProjectRole;
                project: { name: string };
            }[];
        },
    ) {
        this.id = partial.id!;
        this.email = partial.email!;
        this.organizationId = partial.organizationId!;
        this.role = partial.role!;
        this.status = partial.status!;
        this.expiresAt = partial.expiresAt!;
        this.sentById = partial.sentById!;
        this.acceptedAt = partial.acceptedAt ?? null;
        this.createdAt = partial.createdAt!;
        this.updatedAt = partial.updatedAt!;
        if (partial.organization) {
            this.organization = {
                id: partial.organization.id,
                name: partial.organization.name,
                slug: partial.organization.slug,
            };
        }
        if (partial.sentBy) {
            this.sentBy = {
                id: partial.sentBy.id,
                name: partial.sentBy.name,
                email: partial.sentBy.email,
            };
        }
        this.accessMode =
            partial.role === 'ADMIN' || partial.role === 'OWNER'
                ? 'ALL_PROJECTS'
                : 'SELECTED_PROJECTS';
        this.projects = (partial.projectGrants ?? []).map((grant) => ({
            projectId: grant.projectId,
            projectName: grant.project.name,
            role: grant.role,
        }));
    }
}

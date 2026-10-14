import {
    Injectable,
    ConflictException,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { toIsoString } from '../../common/utils/date.util';
import type { Prisma } from '../../generated/prisma/client';
import {
    CreateOrganizationDto,
    UpdateOrganizationDto,
    TransferOwnershipDto,
} from './dto';
import { OrganizationEntity } from './entities';
import { NotificationsService } from '../notifications/notifications.service';
import { ADMIN_ROLES } from '../notifications/notification-event';
import {
    lockIdentities,
    lockOrganizationMembers,
} from '../../common/authorization/access-locks';

import {
    provisionOrganizationForUser,
    type ProvisioningUser,
    type ProvisionedOrganization,
} from './organization-provisioning';

export {
    DEFAULT_PROJECT_NAME,
    DEFAULT_PROJECT_KEY,
    type ProvisioningUser,
    type ProvisionedOrganization,
} from './organization-provisioning';

@Injectable()
export class OrganizationsService {
    private readonly logger = new Logger(OrganizationsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly notifications: NotificationsService,
    ) {}

    async create(userId: string, dto: CreateOrganizationDto) {
        const existing = await this.prisma.organization.findUnique({
            where: { slug: dto.slug },
        });
        if (existing) {
            throw new ConflictException('Organization slug already taken');
        }

        const org = await this.prisma.$transaction(async (tx) => {
            await lockIdentities(tx, [{ type: 'USER', userId }]);
            await this.assertActiveUser(tx, userId);
            const organization = await tx.organization.create({
                data: {
                    name: dto.name,
                    slug: dto.slug,
                    description: dto.description,
                    logoUrl: dto.logoUrl,
                    website: dto.website,
                    ownerId: userId,
                },
            });

            // Auto-create OWNER membership
            await tx.membership.create({
                data: {
                    userId,
                    organizationId: organization.id,
                    role: 'OWNER',
                },
            });

            return organization;
        });

        return new OrganizationEntity(org);
    }

    async findAllForUser(userId: string) {
        const memberships = await this.prisma.membership.findMany({
            where: {
                userId,
                organization: { deletedAt: null },
            },
            include: {
                organization: true,
            },
        });

        return memberships.map((m) => new OrganizationEntity(m.organization));
    }

    async findOne(orgId: string) {
        const org = await this.prisma.organization.findUnique({
            where: { id: orgId, deletedAt: null },
        });
        if (!org) {
            throw new NotFoundException('Organization not found');
        }
        return new OrganizationEntity(org);
    }

    async update(orgId: string, dto: UpdateOrganizationDto) {
        await this.ensureOrgExists(orgId);

        const org = await this.prisma.organization.update({
            where: { id: orgId },
            data: dto,
        });

        return new OrganizationEntity(org);
    }

    async softDelete(orgId: string, userId: string) {
        const org = await this.ensureOrgExists(orgId);

        if (org.ownerId !== userId) {
            throw new ForbiddenException(
                'Only the owner can delete the organization',
            );
        }

        const updated = await this.prisma.$transaction(async (tx) => {
            await lockOrganizationMembers(tx, orgId, [userId], [], 'UPDATE');
            await this.assertActiveUser(tx, userId);
            const current = await this.ensureOrgExists(orgId, tx);
            if (current.ownerId !== userId)
                throw new ForbiddenException(
                    'Only the owner can delete the organization',
                );
            const members = await tx.membership.findMany({
                where: { organizationId: orgId },
                select: { userId: true, role: true },
            });
            const updated = await tx.organization.update({
                where: { id: orgId },
                data: { deletedAt: new Date() },
            });
            await this.notifications.publish(
                {
                    eventKey: `organization-deleted:${orgId}:${toIsoString(updated.updatedAt)}`,
                    type: 'ORGANIZATION_DELETED',
                    title: `Organization "${org.name}" was deleted`,
                    body: 'This organization is no longer accessible.',
                    resourceType: 'Organization',
                    resourceId: orgId,
                    organizationId: orgId,
                    actorId: userId,
                    allowOutsideOrg: true,
                    recipients: members.map((member) => ({
                        userId: member.userId,
                        email: ADMIN_ROLES.includes(member.role),
                    })),
                },
                tx,
            );
            return updated;
        });

        return new OrganizationEntity(updated);
    }

    async transferOwnership(
        orgId: string,
        currentUserId: string,
        dto: TransferOwnershipDto,
    ) {
        const org = await this.ensureOrgExists(orgId);

        if (org.ownerId !== currentUserId) {
            throw new ForbiddenException(
                'Only the owner can transfer ownership',
            );
        }

        if (dto.newOwnerId === currentUserId) {
            throw new BadRequestException('You are already the owner');
        }

        // Verify the new owner is a member
        const newOwnerMembership = await this.prisma.membership.findUnique({
            where: {
                userId_organizationId: {
                    userId: dto.newOwnerId,
                    organizationId: orgId,
                },
            },
        });

        if (!newOwnerMembership) {
            throw new BadRequestException(
                'New owner must be a member of this organization',
            );
        }

        const updated = await this.prisma.$transaction(async (tx) => {
            await lockOrganizationMembers(
                tx,
                orgId,
                [currentUserId, dto.newOwnerId],
                [currentUserId, dto.newOwnerId],
                'UPDATE',
            );
            await this.assertActiveUser(tx, currentUserId);
            await this.assertActiveUser(tx, dto.newOwnerId);
            const current = await this.ensureOrgExists(orgId, tx);
            if (current.ownerId !== currentUserId)
                throw new ForbiddenException(
                    'Only the owner can transfer ownership',
                );
            const currentNewOwner = await tx.membership.findUnique({
                where: {
                    userId_organizationId: {
                        userId: dto.newOwnerId,
                        organizationId: orgId,
                    },
                },
            });
            if (
                !currentNewOwner ||
                currentNewOwner.id !== newOwnerMembership.id
            ) {
                throw new ConflictException(
                    'New owner membership changed; reload and retry',
                );
            }
            const previousOwner = await tx.membership.findUnique({
                where: {
                    userId_organizationId: {
                        userId: currentUserId,
                        organizationId: orgId,
                    },
                },
            });
            if (!previousOwner || previousOwner.role !== 'OWNER') {
                throw new ConflictException(
                    'Owner membership changed; reload and retry',
                );
            }
            // Update org owner
            const updatedOrg = await tx.organization.update({
                where: { id: orgId },
                data: { ownerId: dto.newOwnerId },
            });

            // Promote new owner to OWNER role
            await tx.membership.update({
                where: { id: currentNewOwner.id },
                data: {
                    role: 'OWNER',
                    projectPermissionsVersion: { increment: 1 },
                },
            });

            // Demote previous owner to ADMIN
            await tx.membership.update({
                where: {
                    userId_organizationId: {
                        userId: currentUserId,
                        organizationId: orgId,
                    },
                },
                data: {
                    role: 'ADMIN',
                    projectPermissionsVersion: { increment: 1 },
                },
            });
            await tx.auditLog.create({
                data: {
                    actorId: currentUserId,
                    organizationId: orgId,
                    action: 'UPDATE',
                    entity: 'OrganizationOwnership',
                    entityId: orgId,
                    before: {
                        ownerId: currentUserId,
                        memberships: [previousOwner, currentNewOwner].map(
                            (member) => ({
                                membershipId: member.id,
                                userId: member.userId,
                                role: member.role,
                                projectPermissionsVersion:
                                    member.projectPermissionsVersion,
                            }),
                        ),
                    },
                    after: {
                        ownerId: dto.newOwnerId,
                        memberships: [
                            {
                                membershipId: previousOwner.id,
                                userId: currentUserId,
                                role: 'ADMIN',
                                projectPermissionsVersion:
                                    previousOwner.projectPermissionsVersion + 1,
                            },
                            {
                                membershipId: currentNewOwner.id,
                                userId: dto.newOwnerId,
                                role: 'OWNER',
                                projectPermissionsVersion:
                                    currentNewOwner.projectPermissionsVersion +
                                    1,
                            },
                        ],
                    },
                },
            });

            await this.notifications.publish(
                {
                    eventKey: `ownership-transferred:${orgId}:${toIsoString(updatedOrg.updatedAt)}`,
                    type: 'OWNERSHIP_TRANSFERRED',
                    title: `Ownership of "${org.name}" was transferred`,
                    body: 'Organization ownership and administrator permissions have changed.',
                    organizationId: orgId,
                    resourceType: 'Organization',
                    resourceId: orgId,
                    actorId: currentUserId,
                    includeActor: true,
                    email: true,
                    recipients: [
                        currentUserId,
                        dto.newOwnerId,
                        ...(await this.notifications.organizationRecipients(
                            orgId,
                            tx,
                            ADMIN_ROLES,
                        )),
                    ],
                    meta: {
                        previousOwnerId: currentUserId,
                        newOwnerId: dto.newOwnerId,
                    },
                },
                tx,
            );
            return updatedOrg;
        });

        return new OrganizationEntity(updated);
    }

    // ─── Onboarding ────────────────────────────────────────────────────

    /**
     * Bootstrap the starter organization every newly verified user gets: one
     * organization they own (with an OWNER membership) and one project.
     *
     * Idempotent: when the user already belongs to any organization nothing is
     * created and `null` is returned, so callers can safely retry (and users
     * whose verification was retried never end up with duplicates).
     *
     * @param tx Optional transaction client — pass it to keep provisioning
     *   atomic with the caller's own writes, e.g. flipping `emailVerified`.
     */
    async provisionForUser(
        user: ProvisioningUser,
        tx?: Prisma.TransactionClient,
    ): Promise<ProvisionedOrganization | null> {
        return provisionOrganizationForUser(
            tx ?? this.prisma,
            user,
            this.logger,
        );
    }

    private async assertActiveUser(
        tx: Prisma.TransactionClient,
        userId: string,
    ) {
        const user = await tx.user.findFirst({
            where: { id: userId, isActive: true, deletedAt: null },
            select: { id: true },
        });
        if (!user) throw new ForbiddenException('User is no longer active');
    }

    private async ensureOrgExists(
        orgId: string,
        db: Prisma.TransactionClient = this.prisma,
    ) {
        const org = await db.organization.findUnique({
            where: { id: orgId, deletedAt: null },
        });
        if (!org) {
            throw new NotFoundException('Organization not found');
        }
        return org;
    }
}

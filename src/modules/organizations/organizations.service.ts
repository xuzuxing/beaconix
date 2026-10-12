import {
    Injectable,
    ConflictException,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
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

/** Only the delegates onboarding touches — works for the client and a transaction. */
type OnboardingDb = Pick<
    Prisma.TransactionClient,
    'organization' | 'membership' | 'plan' | 'subscription'
>;

/** The project seeded alongside a user's first organization. */
export const DEFAULT_PROJECT_NAME = 'My First Project';
export const DEFAULT_PROJECT_KEY = 'MFP';

const ORG_NAME_SUFFIX = "'s Workspace";
const MAX_ORG_NAME_LENGTH = 100;
const MAX_SLUG_BASE_LENGTH = 40;
const SLUG_FALLBACK = 'workspace';
const SLUG_ATTEMPTS = 4;

export interface ProvisioningUser {
    id: string;
    name: string;
    email: string;
}

export interface ProvisionedOrganization {
    organizationId: string;
    projectId: string;
}

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
            // Update org owner
            const updatedOrg = await tx.organization.update({
                where: { id: orgId },
                data: { ownerId: dto.newOwnerId },
            });

            // Promote new owner to OWNER role
            await tx.membership.update({
                where: { id: newOwnerMembership.id },
                data: { role: 'OWNER' },
            });

            // Demote previous owner to ADMIN
            await tx.membership.update({
                where: {
                    userId_organizationId: {
                        userId: currentUserId,
                        organizationId: orgId,
                    },
                },
                data: { role: 'ADMIN' },
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
        const db: OnboardingDb = tx ?? this.prisma;

        const existingMembership = await db.membership.findFirst({
            where: { userId: user.id },
            select: { id: true },
        });
        if (existingMembership) {
            return null;
        }

        const slug = await this.buildUniqueSlug(db, user);

        const organization = await db.organization.create({
            data: {
                name: this.buildOrgName(user.name),
                slug,
                ownerId: user.id,
                memberships: {
                    create: { userId: user.id, role: 'OWNER' },
                },
                projects: {
                    create: {
                        name: DEFAULT_PROJECT_NAME,
                        key: DEFAULT_PROJECT_KEY,
                        createdById: user.id,
                    },
                },
            },
            include: { projects: { select: { id: true } } },
        });

        // Bind the FREE fallback subscription so the organization always has a
        // plan. Seed data normally creates FREE; skip gracefully when missing.
        const freePlan = await db.plan.findUnique({ where: { code: 'FREE' } });
        if (freePlan) {
            await db.subscription.create({
                data: {
                    organizationId: organization.id,
                    planId: freePlan.id,
                    status: 'ACTIVE',
                    startsAt: new Date(),
                    expiresAt: new Date('2099-12-31T23:59:59.000Z'),
                },
            });
        } else {
            this.logger.warn(
                'FREE plan not found; starter subscription was not created',
            );
        }

        this.logger.log(
            `Provisioned starter organization "${slug}" for user ${user.id}`,
        );

        return {
            organizationId: organization.id,
            projectId: organization.projects[0].id,
        };
    }

    private buildOrgName(name: string): string {
        const maxBaseLength = MAX_ORG_NAME_LENGTH - ORG_NAME_SUFFIX.length;
        const base = name.trim().slice(0, maxBaseLength);
        return base ? `${base}${ORG_NAME_SUFFIX}` : 'My Workspace';
    }

    /**
     * Organization slugs are globally unique, so derive one from the user name
     * (falling back to the email local part) and resolve collisions with a
     * numeric suffix.
     */
    private async buildUniqueSlug(
        db: OnboardingDb,
        user: ProvisioningUser,
    ): Promise<string> {
        const base =
            this.slugify(user.name) ||
            this.slugify(user.email.split('@')[0] ?? '') ||
            SLUG_FALLBACK;

        for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt++) {
            const candidate = attempt === 1 ? base : `${base}-${attempt}`;
            if (!(await this.slugExists(db, candidate))) {
                return candidate;
            }
        }

        // Random suffix — collisions here are cryptographically unlikely.
        const candidate = `${base}-${crypto.randomBytes(3).toString('hex')}`;
        if (!(await this.slugExists(db, candidate))) {
            return candidate;
        }

        return `${base}-${crypto.randomUUID().slice(0, 8)}`;
    }

    private async slugExists(db: OnboardingDb, slug: string): Promise<boolean> {
        const existing = await db.organization.findUnique({
            where: { slug },
            select: { id: true },
        });
        return existing !== null;
    }

    private slugify(value: string): string {
        return value
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .slice(0, MAX_SLUG_BASE_LENGTH)
            .replace(/^-+|-+$/g, '');
    }

    private async ensureOrgExists(orgId: string) {
        const org = await this.prisma.organization.findUnique({
            where: { id: orgId, deletedAt: null },
        });
        if (!org) {
            throw new NotFoundException('Organization not found');
        }
        return org;
    }
}

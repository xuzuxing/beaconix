import * as crypto from 'crypto';
import type { Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

/** Only the delegates onboarding touches, for either a client or a transaction. */
type OnboardingDb = Pick<
    Prisma.TransactionClient,
    'organization' | 'membership' | 'plan' | 'subscription'
>;

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

/** Call inside the user's transaction to keep onboarding atomic. */
export async function provisionOrganizationForUser(
    db: OnboardingDb,
    user: ProvisioningUser,
    logger: Pick<Logger, 'log' | 'warn'>,
): Promise<ProvisionedOrganization | null> {
    const existingMembership = await db.membership.findFirst({
        where: { userId: user.id },
        select: { id: true },
    });
    if (existingMembership) {
        return null;
    }

    const slug = await buildUniqueSlug(db, user);
    const organization = await db.organization.create({
        data: {
            name: buildOrgName(user.name),
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

    // Seed data normally supplies FREE; keep onboarding usable without it.
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
        logger.warn(
            'FREE plan not found; starter subscription was not created',
        );
    }

    logger.log(
        `Provisioned starter organization "${slug}" for user ${user.id}`,
    );

    return {
        organizationId: organization.id,
        projectId: organization.projects[0].id,
    };
}

function buildOrgName(name: string): string {
    const maxBaseLength = MAX_ORG_NAME_LENGTH - ORG_NAME_SUFFIX.length;
    const base = name.trim().slice(0, maxBaseLength);
    return base ? `${base}${ORG_NAME_SUFFIX}` : 'My Workspace';
}

async function buildUniqueSlug(
    db: OnboardingDb,
    user: ProvisioningUser,
): Promise<string> {
    const base =
        slugify(user.name) ||
        slugify(user.email.split('@')[0] ?? '') ||
        SLUG_FALLBACK;

    for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt++) {
        const candidate = attempt === 1 ? base : `${base}-${attempt}`;
        if (!(await slugExists(db, candidate))) {
            return candidate;
        }
    }

    const candidate = `${base}-${crypto.randomBytes(3).toString('hex')}`;
    if (!(await slugExists(db, candidate))) {
        return candidate;
    }

    return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

async function slugExists(db: OnboardingDb, slug: string): Promise<boolean> {
    const existing = await db.organization.findUnique({
        where: { slug },
        select: { id: true },
    });
    return existing !== null;
}

function slugify(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, MAX_SLUG_BASE_LENGTH)
        .replace(/^-+|-+$/g, '');
}

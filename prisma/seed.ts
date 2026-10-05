import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client';

const FREE_SUBSCRIPTION_EXPIRY = new Date('2099-12-31T23:59:59.000Z');

async function main() {
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });

    const plans = [
        {
            code: 'FREE',
            name: '免费版',
            description: 'For trying out Beacon monitoring',
            price: 0,
            sortOrder: 1,
            durationDays: 36500,
            maxMonitors: 5,
            maxProbes: 0,
            maxMembers: 3,
            maxChannels: 1,
            minInterval: 300,
            allowTenantProbe: false,
            allowStatusPage: false,
        },
        {
            code: 'PRO',
            name: '专业版',
            description: 'For small teams',
            price: 2900,
            sortOrder: 2,
            durationDays: 30,
            maxMonitors: 50,
            maxProbes: 3,
            maxMembers: 10,
            maxChannels: 5,
            minInterval: 60,
            allowTenantProbe: true,
            allowStatusPage: true,
        },
        {
            code: 'TEAM',
            name: '团队版',
            description: 'For growing businesses',
            price: 9900,
            sortOrder: 3,
            durationDays: 30,
            maxMonitors: 200,
            maxProbes: 10,
            maxMembers: 999,
            maxChannels: 99,
            minInterval: 30,
            allowTenantProbe: true,
            allowStatusPage: true,
        },
    ];

    for (const plan of plans) {
        await prisma.plan.upsert({
            where: { code: plan.code },
            update: plan,
            create: plan,
        });
    }

    // Ensure every organization has the FREE fallback subscription.
    const freePlan = await prisma.plan.findUniqueOrThrow({
        where: { code: 'FREE' },
    });
    const organizations = await prisma.organization.findMany({
        select: { id: true },
    });

    for (const organization of organizations) {
        const existingFree = await prisma.subscription.findFirst({
            where: {
                organizationId: organization.id,
                planId: freePlan.id,
            },
        });

        if (!existingFree) {
            await prisma.subscription.create({
                data: {
                    organizationId: organization.id,
                    planId: freePlan.id,
                    status: 'ACTIVE',
                    startsAt: new Date(),
                    expiresAt: FREE_SUBSCRIPTION_EXPIRY,
                },
            });
        }
    }

    await prisma.$disconnect();
    await pool.end();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

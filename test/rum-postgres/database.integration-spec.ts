import 'reflect-metadata';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { PrismaService } from '../../src/infra/database/prisma.service';
import { RumIngestService } from '../../src/modules/rum/ingest/rum-ingest.service';
import { RumRetentionService } from '../../src/modules/rum/retention/rum-retention.service';
import {
    assertEmptyDatabase,
    deployMigrations,
    root,
    validateTestUrl,
} from '../monitor-postgres/harness';

void test(
    'RUM migrations, concurrent aggregation and lifecycle on PostgreSQL',
    { timeout: 120_000 },
    async () => {
        const url = validateTestUrl(process.env.MONITOR_TEST_DATABASE_URL);
        const sql = new Client({ connectionString: url });
        let prisma: PrismaService | undefined;
        try {
            await sql.connect();
            await assertEmptyDatabase(sql);
            await deployMigrations(url, join(root, 'prisma/migrations'));

            prisma = new PrismaService(
                new ConfigService({
                    database: { url },
                    app: { isDevelopment: false },
                }),
            );
            await prisma.$connect();

            const user = await prisma.user.create({
                data: {
                    email: 'rum-integration@example.invalid',
                    password: 'not-used',
                    name: 'RUM integration',
                    emailVerified: true,
                },
            });
            const organization = await prisma.organization.create({
                data: {
                    name: 'RUM integration',
                    slug: 'rum-integration',
                    ownerId: user.id,
                },
            });
            const project = await prisma.project.create({
                data: {
                    name: 'RUM project',
                    key: 'RUM',
                    organizationId: organization.id,
                    createdById: user.id,
                },
            });
            const app = await prisma.rumApp.create({
                data: {
                    organizationId: organization.id,
                    projectId: project.id,
                    name: 'Portal',
                    publicKey: 'rum_integration_app',
                    createdById: user.id,
                },
            });
            const secondApp = await prisma.rumApp.create({
                data: {
                    organizationId: organization.id,
                    projectId: project.id,
                    name: 'Admin',
                    publicKey: 'rum_integration_admin',
                    createdById: user.id,
                },
            });
            const ingest = new RumIngestService(prisma, {
                consume: () => Promise.resolve(),
            } as never);
            const payload = {
                publicKey: app.publicKey,
                type: 'Error',
                message: 'token=secret profile failed',
                page: 'https://example.invalid/profile?token=secret',
            };

            await Promise.all(
                Array.from({ length: 24 }, () =>
                    ingest.reportError(payload, '127.0.0.1'),
                ),
            );
            await ingest.reportError(
                { ...payload, publicKey: secondApp.publicKey },
                '127.0.0.1',
            );

            const firstGroups = await prisma.rumErrorGroup.findMany({
                where: { appId: app.id },
            });
            assert.equal(firstGroups.length, 1);
            assert.equal(firstGroups[0].count, 24);
            assert.equal(
                firstGroups[0].message,
                'token=[REDACTED] profile failed',
            );
            assert.equal(
                firstGroups[0].page,
                'https://example.invalid/profile',
            );
            assert.equal(
                await prisma.rumErrorGroup.count({
                    where: { appId: secondApp.id },
                }),
                1,
            );

            await prisma.rumApp.update({
                where: { id: app.id },
                data: { enabled: false },
            });
            await assert.rejects(
                ingest.reportError(payload, '127.0.0.1'),
                NotFoundException,
            );

            await prisma.rumErrorGroup.updateMany({
                where: { appId: secondApp.id },
                data: { lastSeenAt: new Date('2025-01-01T00:00:00.000Z') },
            });
            const retention = new RumRetentionService(
                prisma,
                { register: () => undefined } as never,
                new ConfigService({
                    rum: {
                        maxAppsPerProject: 20,
                        appRequestsPerMinute: 600,
                        sourceRequestsPerMinute: 120,
                        errorRetentionDays: 90,
                    },
                }),
            );
            await retention.handleCleanup();
            assert.equal(
                await prisma.rumErrorGroup.count({
                    where: { appId: secondApp.id },
                }),
                0,
            );

            await prisma.project.update({
                where: { id: project.id },
                data: { status: 'ARCHIVED' },
            });
            await prisma.rumApp.update({
                where: { id: secondApp.id },
                data: { enabled: true },
            });
            await assert.rejects(
                ingest.reportError(
                    { ...payload, publicKey: secondApp.publicKey },
                    '127.0.0.1',
                ),
                NotFoundException,
            );
        } finally {
            await prisma?.$disconnect();
            await sql.end().catch(() => undefined);
        }
    },
);

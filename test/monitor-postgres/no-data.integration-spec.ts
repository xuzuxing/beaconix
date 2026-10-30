import 'reflect-metadata';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { PrismaService } from '../../src/infra/database/prisma.service';
import { MonitorNoDataService } from '../../src/modules/alert-events/monitor-no-data.service';
import {
    assertEmptyDatabase,
    deployMigrations,
    root,
    validateTestUrl,
} from './harness';

void test('no-data candidate scan uses timestamp arithmetic at timeout boundaries', async () => {
    const url = validateTestUrl(process.env.MONITOR_TEST_DATABASE_URL);
    const sql = new Client({
        connectionString: url,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
    });
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
                email: 'no-data@example.invalid',
                name: 'No-data fixture',
                password: 'not-a-credential',
            },
        });
        const organization = await prisma.organization.create({
            data: { name: 'No-data', slug: 'no-data', ownerId: user.id },
        });
        const project = await prisma.project.create({
            data: {
                name: 'No-data',
                key: 'NODATA',
                organizationId: organization.id,
            },
        });
        const at = new Date();
        const cases = [
            { interval: 60, age: 600_000, due: true },
            { interval: 60, age: 599_999, due: false },
            { interval: 300, age: 900_000, due: true },
            { interval: 300, age: 899_999, due: false },
        ];
        const expected = new Map<string, boolean>();
        for (const sample of cases) {
            const anchor = new Date(at.getTime() - sample.age);
            const monitor = await prisma.monitor.create({
                data: {
                    organizationId: organization.id,
                    projectId: project.id,
                    name: 'No-data boundary fixture',
                    type: 'HTTP',
                    target: 'example.invalid',
                    interval: sample.interval,
                    createdAt: anchor,
                    updatedAt: anchor,
                },
            });
            expected.set(monitor.id, sample.due);
        }
        const candidates = new Set<string>();
        const sweep = new MonitorNoDataService(
            prisma,
            {} as never,
            {} as never,
        );
        // Run the actual Prisma/PostgreSQL candidate query; isolate alert
        // mutations, which are covered by the no-data lifecycle unit tests.
        sweep.mark = (id) => {
            candidates.add(id);
            return Promise.resolve(true);
        };
        await sweep.sweep(at);
        for (const [id, due] of expected) {
            assert.equal(candidates.has(id), due);
        }
    } finally {
        await prisma?.$disconnect();
        await sql.end();
    }
});

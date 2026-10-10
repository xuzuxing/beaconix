import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Client } from 'pg';

const url = process.env.MONITORING_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('Monitoring migration upgrade with existing records', () => {
    it('preserves attributable history and never guesses historic protocol or state', async () => {
        if (!url || !/beacon_dashboard_test/.test(url))
            throw new Error('Unsafe test database');
        const client = new Client({ connectionString: url });
        const schema = `monitoring_upgrade_${randomUUID().replaceAll('-', '')}`;
        await client.connect();
        try {
            // The identifier is generated locally and contains only letters/digits/underscores.
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET search_path TO "${schema}"`);
            const migrations = (await readdir('prisma/migrations'))
                .filter((name) => /^\d/.test(name))
                .sort();
            const old = migrations.filter((name) => name < '20261010120000');
            const current = migrations.filter(
                (name) => name >= '20261010120000',
            );
            for (const name of old)
                await client.query(
                    await readFile(
                        `prisma/migrations/${name}/migration.sql`,
                        'utf8',
                    ),
                );
            await client.query(
                `INSERT INTO users (id,email,password,name,"updatedAt") VALUES ('u','upgrade@test.invalid','unused','Upgrade',NOW())`,
            );
            await client.query(
                `INSERT INTO organizations (id,name,slug,"ownerId","updatedAt") VALUES ('o','Upgrade','upgrade','u',NOW())`,
            );
            await client.query(
                `INSERT INTO projects (id,name,key,"organizationId","updatedAt") VALUES ('p','Upgrade','UPG','o',NOW())`,
            );
            await client.query(`INSERT INTO monitors (id,name,type,target,"organizationId","projectId","updatedAt","checkSsl","sslExpiryThreshold")
                VALUES ('m','Existing','HTTP','https://upgrade.test','o','p',NOW(),true,30)`);
            await client.query(`INSERT INTO monitor_states ("monitorId",status,"failCount","lastError","sslExpiresAt","updatedAt")
                VALUES ('m','DOWN',3,'SSL certificate expires in 5 day(s)',NOW() + INTERVAL '5 days',NOW())`);
            await client.query(`INSERT INTO check_logs (id,"monitorId",success,latency,"statusCode")
                VALUES ('c','m',false,5000,NULL)`);
            await client.query(`INSERT INTO probes (id,name,scope,provider,region,"callbackUrl","organizationId","updatedAt")
                VALUES ('probe','Existing probe','TENANT','CUSTOM','test','https://private.test','o',NOW())`);
            await client.query(`INSERT INTO probe_results (id,"probeId",target,success,latency)
                VALUES ('raw','probe','https://upgrade.test',true,10)`);
            for (const name of current)
                await client.query(
                    await readFile(
                        `prisma/migrations/${name}/migration.sql`,
                        'utf8',
                    ),
                );
            const log = (
                await client.query(`SELECT * FROM check_logs WHERE id='c'`)
            ).rows[0];
            expect(log.projectId).toBe('p');
            expect(log.organizationId).toBe('o');
            expect(log.monitorType).toBeNull();
            expect(log.statusCode).toBeNull();
            expect(log.localServiceVerdict).toBeNull();
            const raw = (
                await client.query(`SELECT * FROM probe_results WHERE id='raw'`)
            ).rows[0];
            expect(raw.probeRefId).toBe('probe');
            expect(raw.monitorId).toBeNull();
            expect(raw.projectId).toBeNull();
            const events = (
                await client.query(
                    `SELECT * FROM alert_events WHERE "monitorId"='m'`,
                )
            ).rows;
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                kind: 'SSL',
                origin: 'BASELINE',
                firstNotifiedAt: null,
            });
            expect(
                (
                    await client.query(
                        `SELECT count(*)::integer AS count FROM alert_deliveries`,
                    )
                ).rows[0].count,
            ).toBe(0);
            const history = (
                await client.query(
                    `SELECT * FROM monitor_history WHERE "monitorId"='m'`,
                )
            ).rows;
            expect(history).toHaveLength(1);
            expect(history[0]).toMatchObject({
                cause: 'BASELINE',
                status: 'DOWN',
                deleted: false,
                enabled: true,
            });
            const water = (
                await client.query(`SELECT "countsStartedAt" >= CURRENT_TIMESTAMP - INTERVAL '1 minute' AS fresh
                FROM monitoring_coverage WHERE "projectId"='p'`)
            ).rows[0];
            expect(water.fresh).toBe(true);
            await client.query(
                `UPDATE monitors SET enabled=false WHERE id='m'`,
            );
            expect(
                (
                    await client.query(
                        `SELECT "suppressedReason","resolvedAt" FROM alert_events`,
                    )
                ).rows[0],
            ).toMatchObject({ suppressedReason: 'PAUSED', resolvedAt: null });
            expect(
                (
                    await client.query(
                        `SELECT "configRevision" FROM monitors WHERE id='m'`,
                    )
                ).rows[0].configRevision,
            ).toBe(2);
        } finally {
            // Roll back an interrupted migration before dropping only this test's schema.
            await client.query('ROLLBACK');
            await client.query('SET search_path TO public');
            await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await client.end();
        }
    }, 30000);
});

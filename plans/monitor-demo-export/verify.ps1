$ErrorActionPreference = 'Stop'
$container = 'beacon-dashboard-test-20261010'
$sourceDb = 'beacon_dashboard_test'
$testDb = 'beacon_uat_export_verify_20261010'
$sqlPath = Join-Path $PSScriptRoot '../../exports/uat-monitor-demo-20261010/import.sql'
$containerSql = '/tmp/beacon-uat-demo-import-20261010.sql'
$schemaSql = '/tmp/beacon-uat-demo-schema-20261010.sql'
$ownerEmail = 'uat-export-verification@example.test'

function Invoke-Docker {
    param([string[]]$Arguments, [int]$ExpectedExit = 0)
    $result = & docker @Arguments 2>&1
    $actualExit = $LASTEXITCODE
    $text = $result -join "`n"
    if ($actualExit -ne $ExpectedExit) {
        throw "Expected exit $ExpectedExit, got $actualExit for docker $($Arguments -join ' ')`n$text"
    }
    return $text
}

function Invoke-Sql {
    param([string]$Sql)
    $result = $Sql | & docker exec -i $container psql -U postgres -d $testDb -X -v ON_ERROR_STOP=1 -f - 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($result -join "`n") }
    return $result -join "`n"
}

function Invoke-Import {
    param([string[]]$Variables, [int]$ExpectedExit = 0, [string]$ExpectedMessage = '')
    $args = @('exec', $container, 'psql', '-U', 'postgres', '-d', $testDb, '-X', '-f', $containerSql)
    foreach ($variable in $Variables) { $args += @('-v', $variable) }
    $text = Invoke-Docker -Arguments $args -ExpectedExit $ExpectedExit
    if ($ExpectedMessage -and -not $text.Contains($ExpectedMessage)) {
        throw "Expected message '$ExpectedMessage', got:`n$text"
    }
    return $text
}

$exists = Invoke-Docker -Arguments @('exec', $container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atc',
    "SELECT count(*) FROM pg_database WHERE datname = '$testDb'")
if ($exists.Trim() -ne '0') { throw "Refusing to overwrite an existing verification database: $testDb" }

$created = $false
try {
    Invoke-Docker -Arguments @('exec', $container, 'createdb', '-U', 'postgres', $testDb)
    $created = $true
    Invoke-Docker -Arguments @('exec', $container, 'pg_dump', '-U', 'postgres', '-d', $sourceDb,
        '--schema-only', '--no-owner', '--no-privileges', '-f', $schemaSql)
    Invoke-Docker -Arguments @('exec', $container, 'psql', '-U', 'postgres', '-d', $testDb,
        '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-f', $schemaSql) | Out-Null
    Invoke-Docker -Arguments @('cp', (Resolve-Path $sqlPath).Path, "${container}:$containerSql")
    Invoke-Sql @'
INSERT INTO users (id, email, password, name, "emailVerified", "updatedAt")
VALUES ('c000000000000000000000001', 'uat-export-verification@example.test',
    'NOT_A_LOGIN_PASSWORD', 'Isolated verification only', true, now() AT TIME ZONE 'UTC');
'@

    Invoke-Import -Variables @() -ExpectedExit 3 -ExpectedMessage 'workers_paused must be exactly true' | Out-Null
    Invoke-Import -Variables @('workers_paused=true') -ExpectedExit 3 -ExpectedMessage 'Expected exactly one active existing UAT user' | Out-Null
    Invoke-Import -Variables @("owner_email=$ownerEmail") -ExpectedExit 3 -ExpectedMessage 'workers_paused must be exactly true' | Out-Null
    Invoke-Import -Variables @("owner_email=$ownerEmail", 'workers_paused=false') -ExpectedExit 3 -ExpectedMessage 'workers_paused must be exactly true' | Out-Null
    Invoke-Import -Variables @('owner_email=missing@example.test', 'workers_paused=true') -ExpectedExit 3 -ExpectedMessage 'Expected exactly one active existing UAT user' | Out-Null
    Invoke-Import -Variables @("owner_email=x'; SELECT 1; --", 'workers_paused=true') -ExpectedExit 3 -ExpectedMessage 'Expected exactly one active existing UAT user' | Out-Null
    Write-Output 'PASS: missing parameters, missing owner, and SQL-literal escaping.'

    Invoke-Sql @'
ALTER TABLE check_logs RENAME COLUMN "configRevision" TO "verifyHiddenConfigRevision";
'@ | Out-Null
    Invoke-Import -Variables @("owner_email=$ownerEmail", 'workers_paused=true') -ExpectedExit 3 -ExpectedMessage 'Apply the current Beacon migrations' | Out-Null
    Invoke-Sql 'ALTER TABLE check_logs RENAME COLUMN "verifyHiddenConfigRevision" TO "configRevision";' | Out-Null
    Write-Output 'PASS: incompatible schema refused.'

    Invoke-Sql @'
INSERT INTO organizations (id, name, slug, "ownerId", "updatedAt")
VALUES ('preserved-org', 'Existing UAT tenant', 'preserved-tenant', 'c000000000000000000000001', now());
INSERT INTO memberships (id, "userId", "organizationId", role, "updatedAt")
VALUES ('preserved-membership', 'c000000000000000000000001', 'preserved-org', 'OWNER', now());
INSERT INTO projects (id, name, key, "organizationId", "updatedAt")
VALUES ('preserved-project', 'Existing project', 'KEEP', 'preserved-org', now());
INSERT INTO monitors (id, "organizationId", "projectId", name, type, target, "updatedAt")
VALUES ('preserved-monitor', 'preserved-org', 'preserved-project', 'Existing monitor',
    'HTTP', 'https://preserved.example.test', now());
INSERT INTO monitor_states ("monitorId", status, "updatedAt")
VALUES ('preserved-monitor', 'UP', now());
INSERT INTO check_logs (id, "monitorId", "monitorRefId", "organizationId", "projectId",
    "monitorType", success, latency, "checkedAt")
VALUES ('preserved-check', 'preserved-monitor', 'preserved-monitor', 'preserved-org',
    'preserved-project', 'HTTP', true, 123, now());
INSERT INTO alert_events (id, "monitorId", "organizationId", "projectId", "monitorName",
    target, kind, level, status, reason, "startedAt", "resolvedAt", "durationSeconds", "updatedAt")
VALUES ('preserved-event', 'preserved-monitor', 'preserved-org', 'preserved-project', 'Existing monitor',
    'https://preserved.example.test', 'CONNECTIVITY', 'critical', 'resolved', 'TIMEOUT',
    now() - interval '1 hour', now(), 3600, now());
CREATE FUNCTION demo_verify_original() RETURNS jsonb LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'user', (SELECT to_jsonb(t) FROM users t WHERE id = 'c000000000000000000000001'),
        'organization', (SELECT to_jsonb(t) FROM organizations t WHERE id = 'preserved-org'),
        'membership', (SELECT to_jsonb(t) FROM memberships t WHERE id = 'preserved-membership'),
        'project', (SELECT to_jsonb(t) FROM projects t WHERE id = 'preserved-project'),
        'monitor', (SELECT to_jsonb(t) FROM monitors t WHERE id = 'preserved-monitor'),
        'state', (SELECT to_jsonb(t) FROM monitor_states t WHERE "monitorId" = 'preserved-monitor'),
        'check', (SELECT to_jsonb(t) FROM check_logs t WHERE id = 'preserved-check'),
        'coverage', (SELECT to_jsonb(t) FROM monitoring_coverage t WHERE "projectId" = 'preserved-project'),
        'history', (SELECT jsonb_agg(to_jsonb(t) ORDER BY revision) FROM monitor_history t WHERE "monitorId" = 'preserved-monitor'),
        'event', (SELECT to_jsonb(t) FROM alert_events t WHERE id = 'preserved-event')
    );
$$;
CREATE TABLE demo_verify_snapshot AS SELECT demo_verify_original() AS original;
CREATE FUNCTION demo_verify_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Intentional mid-import verification failure'; END $$;
CREATE TRIGGER demo_verify_failure BEFORE INSERT ON monitors
    FOR EACH ROW EXECUTE FUNCTION demo_verify_failure();
'@ | Out-Null
    Invoke-Import -Variables @("owner_email=$ownerEmail", 'workers_paused=true') -ExpectedExit 3 -ExpectedMessage 'Intentional mid-import verification failure' | Out-Null
    Invoke-Sql @'
DO $$
BEGIN
    IF (SELECT count(*) FROM organizations) <> 1 OR (SELECT count(*) FROM memberships) <> 1
        OR (SELECT count(*) FROM projects) <> 1 OR (SELECT count(*) FROM monitoring_coverage) <> 1
        OR (SELECT count(*) FROM monitor_history) <> 2
    THEN RAISE EXCEPTION 'Partial records survived rollback'; END IF;
    IF demo_verify_original() IS DISTINCT FROM (SELECT original FROM demo_verify_snapshot)
    THEN RAISE EXCEPTION 'Existing tenant changed after rollback'; END IF;
END $$;
DROP TRIGGER demo_verify_failure ON monitors;
DROP FUNCTION demo_verify_failure();
'@ | Out-Null
    Write-Output 'PASS: injected mid-import failure rolled back organization, membership, projects and coverage.'

    $watch = [Diagnostics.Stopwatch]::StartNew()
    Invoke-Import -Variables @("owner_email=$ownerEmail", 'workers_paused=true') -ExpectedMessage 'Import complete.'
    $watch.Stop()
    Write-Output "Successful import took $([math]::Round($watch.Elapsed.TotalSeconds, 1)) seconds."

    Invoke-Sql @'
DO $$
DECLARE total integer; expected integer;
BEGIN
    -- Whole-database totals include the unrelated populated preservation tenant.
    IF (SELECT count(*) FROM organizations) <> 2
        OR (SELECT count(*) FROM projects) <> 3
        OR (SELECT count(*) FROM users) <> 1
        OR (SELECT count(*) FROM memberships WHERE role = 'OWNER') <> 2
        OR (SELECT count(*) FROM monitors) <> 17
        OR (SELECT count(*) FROM check_logs) <> 604561
        OR (SELECT count(*) FROM monitor_history) <> 166
        OR (SELECT count(*) FROM alert_events) <> 55
        OR (SELECT count(*) FROM alert_events WHERE status = 'ongoing') <> 6
        OR (SELECT count(*) FROM alert_events WHERE status = 'resolved') <> 49
    THEN RAISE EXCEPTION 'Unexpected dataset counts'; END IF;
    IF (SELECT count(*) FROM monitor_states WHERE status = 'UP') <> 9
        OR (SELECT count(*) FROM monitor_states WHERE status = 'DOWN') <> 2
        OR (SELECT count(*) FROM monitor_states WHERE status = 'DEGRADED') <> 2
        OR (SELECT count(*) FROM monitor_states WHERE status = 'PAUSED') <> 2
        OR (SELECT count(*) FROM monitor_states WHERE status = 'UNKNOWN') <> 2
    THEN RAISE EXCEPTION 'Unexpected status distribution'; END IF;
    IF EXISTS (SELECT 1 FROM monitors m JOIN monitor_states s ON s."monitorId" = m.id
        LEFT JOIN monitor_history h ON h."monitorId" = m.id AND h.revision = m."historyRevision"
        WHERE h.id IS NULL OR h.status <> s.status OR h.enabled <> m.enabled)
    THEN RAISE EXCEPTION 'Live state/history mismatch'; END IF;
    IF EXISTS (SELECT 1 FROM monitors m WHERE m."organizationId" <> 'preserved-org' AND m.id !~ '^c[a-z0-9]{24}$')
        OR EXISTS (SELECT 1 FROM check_logs c JOIN monitors m ON m.id = c."monitorRefId"
            WHERE m."organizationId" <> 'preserved-org' AND (c."monitorId" <> m.id OR c."organizationId" <> m."organizationId"
                OR c."projectId" <> m."projectId" OR c."monitorType" <> m.type
                OR c."configRevision" <> m."configRevision"
                OR (c."rescuedByProbe" AND (NOT c.success OR c."localSuccess"))
                OR (c."statusCode" IS NOT NULL AND m.type <> 'HTTP')))
    THEN RAISE EXCEPTION 'Invalid ID, snapshot or verdict semantics'; END IF;
    IF EXISTS (SELECT 1 FROM monitor_states s
        LEFT JOIN LATERAL (SELECT * FROM check_logs WHERE "monitorId" = s."monitorId"
            ORDER BY "checkedAt" DESC LIMIT 1) c ON true
        WHERE s."monitorId" <> 'preserved-monitor' AND (s."lastCheckAt" IS DISTINCT FROM c."checkedAt"
            OR s."lastLatency" IS DISTINCT FROM c.latency
            OR s."lastAppliedObservationId" IS DISTINCT FROM c."observationId"))
    THEN RAISE EXCEPTION 'Latest check disagrees with state'; END IF;
    IF EXISTS (SELECT 1 FROM alert_events WHERE "firstNotifiedAt" IS NOT NULL
        OR ("resolvedAt" IS NOT NULL AND "durationSeconds" <>
            extract(epoch FROM ("resolvedAt" - "startedAt"))::integer))
        OR EXISTS (SELECT 1 FROM notification_channels)
        OR EXISTS (SELECT 1 FROM alert_deliveries)
        OR EXISTS (SELECT 1 FROM probes)
    THEN RAISE EXCEPTION 'Unexpected notification/probe evidence'; END IF;
    SELECT count(*) INTO total FROM check_logs c JOIN monitors m ON m.id = c."monitorId"
        WHERE m.name = 'Production API' AND NOT c.success
            AND c."checkedAt" >= (SELECT max("updatedAt") FROM monitors) - interval '24 hours';
    IF total <> 180 THEN RAISE EXCEPTION 'Expected 180 failed API checks in last 24h, got %', total; END IF;
    SELECT count(*) INTO total FROM check_logs c JOIN monitors m ON m.id = c."monitorId"
        WHERE m.name = 'Production API'
            AND c."checkedAt" >= (SELECT max("updatedAt") FROM monitors) - interval '24 hours';
    IF total <> 1440 THEN RAISE EXCEPTION 'Expected 1440 API checks in last 24h, got %', total; END IF;
    IF EXISTS (SELECT 1 FROM projects p JOIN monitoring_coverage c ON c."projectId" = p.id
        WHERE p."organizationId" <> 'preserved-org' AND (c."checksStartedAt" <> p."createdAt" OR c."countsStartedAt" <> p."createdAt"
            OR c."alertsStartedAt" <> p."createdAt"))
    THEN RAISE EXCEPTION 'Coverage mismatch'; END IF;
    IF EXISTS (SELECT 1 FROM check_logs c JOIN monitors m ON m.id = c."monitorId"
        WHERE m."organizationId" <> 'preserved-org' AND (c."checkedAt" < m."createdAt" OR c."checkedAt" > m."updatedAt"))
    THEN RAISE EXCEPTION 'Sample timestamps outside monitor lifetime'; END IF;
    IF EXISTS (SELECT 1 FROM check_logs WHERE "rescuedByProbe" AND (latency <> 5000 OR error IS NOT NULL))
        OR EXISTS (SELECT 1 FROM check_logs WHERE "sslVerdict" = 'EXPIRING'
            AND (success OR "serviceVerdict" <> 'SUCCESS'))
    THEN RAISE EXCEPTION 'Rescue or certificate verdict semantics mismatch'; END IF;
    IF EXISTS (SELECT 1 FROM alert_events WHERE "organizationId" <> 'preserved-org' AND kind = 'AVAILABILITY'
        AND (actual <> 70 OR unit <> 'percent'))
    THEN RAISE EXCEPTION 'Availability opening evidence mismatch'; END IF;
    IF EXISTS (SELECT 1 FROM alert_events e JOIN monitors m ON m.id = e."monitorId"
        WHERE e.kind = 'AVAILABILITY' AND e.status = 'ongoing' AND e."startedAt" <>
            m."updatedAt" - CASE WHEN m.name = 'Production API' THEN interval '2 hours 57 minutes 30 seconds'
                ELSE interval '9 minutes 30 seconds' END)
    THEN RAISE EXCEPTION 'Availability opening timestamp mismatch'; END IF;
    IF demo_verify_original() IS DISTINCT FROM (SELECT original FROM demo_verify_snapshot)
    THEN RAISE EXCEPTION 'Existing tenant changed after successful import'; END IF;
END $$;
SELECT s.status, count(*) FROM monitor_states s GROUP BY s.status ORDER BY s.status;
SELECT kind, status, count(*) FROM alert_events GROUP BY kind, status ORDER BY kind, status;
SELECT m.name, count(*) AS checks_24h, count(*) FILTER (WHERE NOT c.success) AS failures_24h,
    round(100.0 * count(*) FILTER (WHERE c.success) / nullif(count(*), 0), 2) AS uptime_24h
FROM monitors m JOIN check_logs c ON c."monitorId" = m.id
WHERE c."checkedAt" >= m."updatedAt" - interval '24 hours'
GROUP BY m.id ORDER BY m.name;
'@
    Write-Output 'PASS: counts, 30-day sample semantics, IDs, snapshots, live state, history, events, coverage and 24h metrics.'
    Invoke-Import -Variables @("owner_email=$ownerEmail", 'workers_paused=true') -ExpectedExit 3 -ExpectedMessage 'Demo organization already exists' | Out-Null
    Invoke-Sql @'
DO $$ BEGIN
    IF (SELECT count(*) FROM organizations) <> 2 OR (SELECT count(*) FROM check_logs) <> 604561
    THEN RAISE EXCEPTION 'Duplicate import changed data'; END IF;
    IF demo_verify_original() IS DISTINCT FROM (SELECT original FROM demo_verify_snapshot)
    THEN RAISE EXCEPTION 'Existing tenant changed after repeat import'; END IF;
END $$;
'@ | Out-Null
    Write-Output 'PASS: repeat import refused without data changes.'
}
finally {
    if ($created) {
        Invoke-Docker -Arguments @('exec', $container, 'dropdb', '-U', 'postgres', $testDb)
        Write-Output "Removed isolated verification database $testDb."
    }
}

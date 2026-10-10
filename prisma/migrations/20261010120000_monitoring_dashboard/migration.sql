BEGIN;
ALTER TABLE "monitors" ADD COLUMN "configRevision" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "historyRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "monitor_states" ADD COLUMN "connectivityFailCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastAppliedObservationAt" TIMESTAMP(3),
    ADD COLUMN "lastAppliedObservationId" TEXT;
ALTER TABLE "check_logs" ADD COLUMN "monitorRefId" TEXT,
    ADD COLUMN "organizationId" TEXT, ADD COLUMN "projectId" TEXT,
    ADD COLUMN "monitorType" "MonitorType", ADD COLUMN "observationId" TEXT;
UPDATE "check_logs" c SET "monitorRefId" = m.id, "organizationId" = m."organizationId",
    "projectId" = m."projectId" FROM monitors m WHERE m.id = c."monitorId";
-- Historic protocol is intentionally unknown: current type is not historical evidence.
ALTER TABLE "check_logs" DROP CONSTRAINT "check_logs_monitorId_fkey";
ALTER TABLE "check_logs" ADD CONSTRAINT "check_logs_monitorRefId_fkey"
    FOREIGN KEY ("monitorRefId") REFERENCES monitors(id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "check_logs_observationId_key" ON check_logs("observationId");
CREATE INDEX "check_logs_projectId_source_checkedAt_idx" ON check_logs("projectId",source,"checkedAt");
CREATE INDEX "check_logs_projectId_source_monitorType_checkedAt_idx" ON check_logs("projectId",source,"monitorType","checkedAt");

ALTER TABLE probe_results ADD COLUMN "probeRefId" TEXT, ADD COLUMN "monitorId" TEXT,
    ADD COLUMN "organizationId" TEXT, ADD COLUMN "projectId" TEXT,
    ADD COLUMN "monitorType" "MonitorType", ADD COLUMN "configRevision" INTEGER,
    ADD COLUMN "reportId" TEXT, ADD COLUMN "payloadHash" TEXT,
    ADD COLUMN "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "appliedAt" TIMESTAMP(3);
UPDATE probe_results SET "probeRefId" = "probeId";
ALTER TABLE probe_results DROP CONSTRAINT "probe_results_probeId_fkey";
ALTER TABLE probe_results ADD CONSTRAINT "probe_results_probeRefId_fkey"
    FOREIGN KEY ("probeRefId") REFERENCES probes(id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "probe_results_probeId_reportId_key" ON probe_results("probeId","reportId");
CREATE INDEX "probe_results_projectId_monitorId_checkedAt_idx" ON probe_results("projectId","monitorId","checkedAt");
CREATE INDEX "probe_results_projectId_probeId_checkedAt_idx" ON probe_results("projectId","probeId","checkedAt");
ALTER TABLE notification_logs ADD COLUMN "eventId" TEXT, ADD COLUMN "deliveryId" TEXT,
    ADD COLUMN phase TEXT, ADD COLUMN attempt INTEGER;
CREATE INDEX "notification_logs_eventId_sentAt_idx" ON notification_logs("eventId","sentAt");

CREATE TABLE monitoring_coverage (
    "projectId" TEXT PRIMARY KEY, "checksStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "countsStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "probeStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alertsStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE monitor_history (
    id TEXT PRIMARY KEY, "monitorId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL, enabled BOOLEAN NOT NULL, deleted BOOLEAN NOT NULL,
    status "MonitorStatus" NOT NULL, "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revision INTEGER NOT NULL, cause TEXT NOT NULL
);
CREATE UNIQUE INDEX "monitor_history_monitorId_revision_key" ON monitor_history("monitorId",revision);
CREATE INDEX "monitor_history_projectId_effectiveAt_idx" ON monitor_history("projectId","effectiveAt");
CREATE INDEX "monitor_history_monitorId_effectiveAt_revision_idx" ON monitor_history("monitorId","effectiveAt",revision);
CREATE TABLE alert_events (
    id TEXT PRIMARY KEY, "monitorId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL, "monitorName" TEXT NOT NULL, target TEXT NOT NULL,
    kind TEXT NOT NULL, level TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ongoing',
    "suppressedReason" TEXT, reason TEXT NOT NULL, threshold DOUBLE PRECISION,
    actual DOUBLE PRECISION, unit TEXT, message TEXT, origin TEXT NOT NULL DEFAULT 'OBSERVED',
    "latestEvidence" JSONB NOT NULL DEFAULT '{}', "lifecycleRevision" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER, "firstNotifiedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX alert_events_one_ongoing ON alert_events("monitorId",kind) WHERE status = 'ongoing';
CREATE INDEX "alert_events_projectId_updatedAt_id_idx" ON alert_events("projectId","updatedAt",id);
CREATE INDEX "alert_events_projectId_status_idx" ON alert_events("projectId",status);
CREATE TABLE alert_deliveries (
    id TEXT PRIMARY KEY, "eventId" TEXT NOT NULL REFERENCES alert_events(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    "eventRevision" INTEGER NOT NULL, phase TEXT NOT NULL, "channelId" TEXT NOT NULL,
    payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "leaseUntil" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3), "lastError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "alert_deliveries_eventId_eventRevision_phase_channelId_key"
    ON alert_deliveries("eventId","eventRevision",phase,"channelId");
CREATE INDEX "alert_deliveries_status_nextAttemptAt_idx" ON alert_deliveries(status,"nextAttemptAt");

-- Coverage is initialized atomically with project creation, including onboarding.
CREATE FUNCTION beacon_project_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO monitoring_coverage("projectId") VALUES (NEW.id) ON CONFLICT DO NOTHING;
    RETURN NEW;
END $$;
CREATE TRIGGER project_monitoring_coverage AFTER INSERT ON projects
    FOR EACH ROW EXECUTE FUNCTION beacon_project_coverage();
INSERT INTO monitoring_coverage("projectId") SELECT id FROM projects ON CONFLICT DO NOTHING;

CREATE FUNCTION beacon_monitor_history(mid TEXT, why TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m monitors%ROWTYPE; s "MonitorStatus"; rev INTEGER;
BEGIN
    SELECT * INTO m FROM monitors WHERE id = mid FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    SELECT status INTO s FROM monitor_states WHERE "monitorId" = mid;
    s := CASE WHEN NOT m.enabled THEN 'PAUSED'::"MonitorStatus"
        WHEN s IS NULL OR s = 'PAUSED' THEN 'UNKNOWN'::"MonitorStatus" ELSE s END;
    IF why <> 'BASELINE' AND EXISTS (
        SELECT 1 FROM monitor_history h WHERE h."monitorId" = mid
        AND h.revision = m."historyRevision" AND h.enabled = m.enabled
        AND h.deleted = (m."deletedAt" IS NOT NULL) AND h.status = s
    ) THEN RETURN; END IF;
    UPDATE monitors SET "historyRevision" = "historyRevision" + 1 WHERE id = mid RETURNING "historyRevision" INTO rev;
    INSERT INTO monitor_history(id,"monitorId","organizationId","projectId",enabled,deleted,status,"effectiveAt",revision,cause)
        VALUES (md5(mid || ':' || rev::TEXT),mid,m."organizationId",m."projectId",m.enabled,
        m."deletedAt" IS NOT NULL,s,CASE WHEN why = 'BASELINE' THEN CURRENT_TIMESTAMP ELSE clock_timestamp() END,rev,why);
    UPDATE alert_events SET "suppressedReason" = CASE WHEN m."deletedAt" IS NOT NULL THEN 'DELETED'
        WHEN NOT m.enabled THEN 'PAUSED'
        WHEN (kind = 'SSL' AND NOT m."checkSsl") OR (kind = 'AVAILABILITY' AND NOT m."availabilityEnabled") THEN 'CONFIG_DISABLED'
        ELSE NULL END, "updatedAt" = clock_timestamp()
        WHERE "monitorId" = mid AND status = 'ongoing';
END $$;
CREATE FUNCTION beacon_monitor_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN PERFORM beacon_monitor_history(NEW.id,'CREATE');
    ELSIF (OLD.enabled,OLD."deletedAt",OLD."projectId",OLD."configRevision")
        IS DISTINCT FROM (NEW.enabled,NEW."deletedAt",NEW."projectId",NEW."configRevision")
        THEN PERFORM beacon_monitor_history(NEW.id,'UPDATE');
    END IF;
    RETURN NEW;
END $$;
CREATE FUNCTION beacon_monitor_config() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (OLD.type,OLD.target,OLD.interval,OLD.timeout,OLD."expectedStatus",OLD.enabled,
        OLD."checkSsl",OLD."sslExpiryThreshold",OLD."failureThreshold",OLD."availabilityEnabled",
        OLD."availabilityThreshold",OLD."availabilityWindow",OLD."deletedAt")
        IS DISTINCT FROM
       (NEW.type,NEW.target,NEW.interval,NEW.timeout,NEW."expectedStatus",NEW.enabled,
        NEW."checkSsl",NEW."sslExpiryThreshold",NEW."failureThreshold",NEW."availabilityEnabled",
        NEW."availabilityThreshold",NEW."availabilityWindow",NEW."deletedAt")
    THEN NEW."configRevision" := OLD."configRevision" + 1; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER monitor_config_revision BEFORE UPDATE ON monitors FOR EACH ROW EXECUTE FUNCTION beacon_monitor_config();
CREATE TRIGGER monitor_history_changes AFTER INSERT OR UPDATE ON monitors FOR EACH ROW EXECUTE FUNCTION beacon_monitor_changed();
CREATE FUNCTION beacon_state_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM beacon_monitor_history(NEW."monitorId",'STATE');
    RETURN NEW;
END $$;
CREATE TRIGGER monitor_state_history AFTER INSERT OR UPDATE OF status ON monitor_states
    FOR EACH ROW EXECUTE FUNCTION beacon_state_history();
SELECT beacon_monitor_history(id,'BASELINE') FROM monitors ORDER BY id;
-- Existing check records prove retained checks, but not earlier deleted data.
UPDATE monitoring_coverage c SET "checksStartedAt" =
    GREATEST(CURRENT_TIMESTAMP - INTERVAL '30 days', p."createdAt")
    FROM projects p WHERE p.id = c."projectId";
INSERT INTO alert_events(id,"monitorId","organizationId","projectId","monitorName",target,kind,level,reason,origin,"updatedAt")
    SELECT md5(m.id || ':baseline-connectivity'),m.id,m."organizationId",m."projectId",m.name,m.target,
        'CONNECTIVITY','critical','CHECK_FAILED','BASELINE',CURRENT_TIMESTAMP
    FROM monitors m JOIN monitor_states s ON s."monitorId" = m.id
    WHERE s.status = 'DOWN';
INSERT INTO alert_events(id,"monitorId","organizationId","projectId","monitorName",target,kind,level,reason,origin,"updatedAt")
    SELECT md5(m.id || ':baseline-availability'),m.id,m."organizationId",m."projectId",m.name,m.target,
        'AVAILABILITY','warning','AVAILABILITY_LOW','BASELINE',CURRENT_TIMESTAMP
    FROM monitors m JOIN monitor_states s ON s."monitorId" = m.id WHERE s."availabilityAlertActive";
COMMIT;

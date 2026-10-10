BEGIN;
ALTER TABLE check_logs ADD COLUMN "configRevision" INTEGER;
CREATE FUNCTION beacon_reset_connectivity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (OLD.target, OLD.type) IS DISTINCT FROM (NEW.target, NEW.type) THEN
        UPDATE monitor_states SET "connectivityFailCount" = 0,
            "lastAppliedObservationAt" = NULL, "lastAppliedObservationId" = NULL WHERE "monitorId" = NEW.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER monitoring_reset_connectivity AFTER UPDATE OF target,type ON monitors
    FOR EACH ROW EXECUTE FUNCTION beacon_reset_connectivity();
ALTER TABLE notification_logs ADD COLUMN "channelRefId" TEXT;
UPDATE notification_logs SET "channelRefId" = "channelId";
ALTER TABLE notification_logs DROP CONSTRAINT "notification_logs_channelId_fkey";
ALTER TABLE notification_logs ADD CONSTRAINT "notification_logs_channelRefId_fkey"
    FOREIGN KEY ("channelRefId") REFERENCES notification_channels(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE alert_deliveries ADD COLUMN "leaseToken" TEXT;
CREATE INDEX probe_results_pending_ingest ON probe_results("receivedAt") WHERE "appliedAt" IS NULL AND "monitorId" IS NOT NULL;

CREATE OR REPLACE FUNCTION beacon_monitor_history(mid TEXT, why TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m monitors%ROWTYPE; s "MonitorStatus"; rev INTEGER; suppression TEXT;
BEGIN
    SELECT * INTO m FROM monitors WHERE id = mid FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE alert_events e SET "suppressedReason" = CASE WHEN m."deletedAt" IS NOT NULL THEN 'DELETED'
        WHEN NOT m.enabled THEN 'PAUSED'
        WHEN (e.kind = 'SSL' AND NOT m."checkSsl") OR (e.kind = 'AVAILABILITY' AND NOT m."availabilityEnabled")
        THEN 'CONFIG_DISABLED' ELSE NULL END, "updatedAt" = clock_timestamp()
    WHERE e."monitorId" = mid AND e.status = 'ongoing' AND e."suppressedReason" IS DISTINCT FROM
        CASE WHEN m."deletedAt" IS NOT NULL THEN 'DELETED' WHEN NOT m.enabled THEN 'PAUSED'
        WHEN (e.kind = 'SSL' AND NOT m."checkSsl") OR (e.kind = 'AVAILABILITY' AND NOT m."availabilityEnabled")
        THEN 'CONFIG_DISABLED' ELSE NULL END;
    SELECT status INTO s FROM monitor_states WHERE "monitorId" = mid;
    s := CASE WHEN NOT m.enabled THEN 'PAUSED'::"MonitorStatus"
        WHEN s IS NULL OR s = 'PAUSED' THEN 'UNKNOWN'::"MonitorStatus" ELSE s END;
    IF why <> 'BASELINE' AND EXISTS (
        SELECT 1 FROM monitor_history h WHERE h."monitorId" = mid AND h.revision = m."historyRevision"
        AND h.enabled = m.enabled AND h.deleted = (m."deletedAt" IS NOT NULL) AND h.status = s
    ) THEN RETURN; END IF;
    UPDATE monitors SET "historyRevision" = "historyRevision" + 1 WHERE id = mid RETURNING "historyRevision" INTO rev;
    INSERT INTO monitor_history(id,"monitorId","organizationId","projectId",enabled,deleted,status,"effectiveAt",revision,cause)
    VALUES (md5(mid || ':' || rev::TEXT),mid,m."organizationId",m."projectId",m.enabled,
        m."deletedAt" IS NOT NULL,s,CASE WHEN why = 'BASELINE' THEN CURRENT_TIMESTAMP ELSE clock_timestamp() END,rev,why);
END $$;

-- Rule changes invalidate in-flight observations just like target/threshold changes.
CREATE FUNCTION beacon_rule_binding_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        UPDATE monitors SET "configRevision" = "configRevision" + 1 WHERE id = OLD."monitorId";
        RETURN OLD;
    END IF;
    UPDATE monitors SET "configRevision" = "configRevision" + 1 WHERE id = NEW."monitorId";
    RETURN NEW;
END $$;
CREATE TRIGGER monitoring_rule_binding_revision AFTER INSERT OR UPDATE OR DELETE ON monitor_rule_bindings
    FOR EACH ROW EXECUTE FUNCTION beacon_rule_binding_changed();
CREATE FUNCTION beacon_rule_tree_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid TEXT;
BEGIN
    IF (OLD.tree,OLD.enabled,OLD."deletedAt") IS DISTINCT FROM (NEW.tree,NEW.enabled,NEW."deletedAt") THEN
        FOR mid IN SELECT "monitorId" FROM monitor_rule_bindings WHERE "ruleGroupId" = NEW.id ORDER BY "monitorId"
        LOOP
            UPDATE monitors SET "configRevision" = "configRevision" + 1 WHERE id = mid;
        END LOOP;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER monitoring_rule_tree_revision AFTER UPDATE ON rule_groups FOR EACH ROW EXECUTE FUNCTION beacon_rule_tree_changed();

-- Only persisted certificate evidence can establish a baseline incident.
INSERT INTO alert_events(id,"monitorId","organizationId","projectId","monitorName",target,kind,level,reason,
    threshold,actual,unit,origin,"updatedAt")
SELECT md5(m.id || ':baseline-ssl'),m.id,m."organizationId",m."projectId",m.name,m.target,'SSL',
    CASE WHEN s."sslExpiresAt" <= CURRENT_TIMESTAMP THEN 'critical' ELSE 'warning' END,
    CASE WHEN s."sslExpiresAt" <= CURRENT_TIMESTAMP THEN 'SSL_INVALID' ELSE 'SSL_EXPIRING' END,
    m."sslExpiryThreshold",extract(epoch FROM (s."sslExpiresAt" - CURRENT_TIMESTAMP))/86400,'days','BASELINE',CURRENT_TIMESTAMP
FROM monitors m JOIN monitor_states s ON s."monitorId" = m.id
WHERE m."checkSsl" AND s."sslExpiresAt" IS NOT NULL AND s."lastError" LIKE 'SSL certificate%'
    AND s."sslExpiresAt" <= CURRENT_TIMESTAMP + m."sslExpiryThreshold" * INTERVAL '1 day'
ON CONFLICT DO NOTHING;
DELETE FROM alert_events e USING monitor_states s WHERE e."monitorId" = s."monitorId"
    AND e.origin = 'BASELINE' AND e.kind = 'CONNECTIVITY' AND s."lastError" LIKE 'SSL certificate%';
SELECT beacon_monitor_history(id,'SUPPRESSION') FROM monitors ORDER BY id;
COMMIT;

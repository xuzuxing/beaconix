-- Probe success ratio: tenant probes become the primary verdict, the local check
-- only decides when no effective tenant probe reported for the batch.
ALTER TABLE "monitors"
  ADD COLUMN "probeSuccessRatio" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "monitors"
  ADD CONSTRAINT "monitors_probeSuccessRatio_check"
  CHECK ("probeSuccessRatio" BETWEEN 1 AND 100);

-- Batch (round) attribution of probe observations.
ALTER TABLE "probe_results" ADD COLUMN "roundId" TEXT;
CREATE INDEX "probe_results_monitorId_roundId_checkedAt_idx"
  ON "probe_results" ("monitorId", "roundId", "checkedAt");
CREATE INDEX "probe_results_projectId_monitorId_roundId_idx"
  ON "probe_results" ("projectId", "monitorId", "roundId");

-- One CheckLog row per batch: the unique index is the database-level guard that
-- a batch is settled exactly once (NULL roundId rows stay unconstrained).
ALTER TABLE "check_logs" ADD COLUMN "roundId" TEXT;
ALTER TABLE "check_logs" ADD COLUMN "appliedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "check_logs_monitorId_roundId_key"
  ON "check_logs" ("monitorId", "roundId");
CREATE INDEX "check_logs_monitorId_appliedAt_idx"
  ON "check_logs" ("monitorId", "appliedAt");

-- The ratio is part of the monitor definition: changing it must advance
-- configRevision so in-flight local results and probe evidence become stale.
CREATE OR REPLACE FUNCTION beacon_monitor_config() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (OLD.type,OLD.target,OLD.interval,OLD.timeout,OLD."expectedStatus",OLD.enabled,
        OLD."checkSsl",OLD."sslExpiryThreshold",OLD."failureThreshold",OLD."probeSuccessRatio",
        OLD."availabilityEnabled",OLD."availabilityThreshold",OLD."availabilityWindow",OLD."deletedAt",
        OLD.config,OLD."configVersion",OLD."credentialsEnc")
        IS DISTINCT FROM
       (NEW.type,NEW.target,NEW.interval,NEW.timeout,NEW."expectedStatus",NEW.enabled,
        NEW."checkSsl",NEW."sslExpiryThreshold",NEW."failureThreshold",NEW."probeSuccessRatio",
        NEW."availabilityEnabled",NEW."availabilityThreshold",NEW."availabilityWindow",NEW."deletedAt",
        NEW.config,NEW."configVersion",NEW."credentialsEnc")
    THEN NEW."configRevision" := OLD."configRevision" + 1; END IF;
    RETURN NEW;
END $$;

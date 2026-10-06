-- AlterTable
ALTER TABLE "monitor_states" ADD COLUMN "lastLocalCheckAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "check_logs" ADD COLUMN "localSuccess" BOOLEAN,
ADD COLUMN "rescuedByProbe" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: until now every check ran locally (the PROBE source was unused), so
-- the previous check timestamps and outcomes are the local ones. Without this,
-- the first tick after the upgrade would see every monitor as due at once.
UPDATE "monitor_states"
SET "lastLocalCheckAt" = "lastCheckAt"
WHERE "lastCheckAt" IS NOT NULL;

UPDATE "check_logs"
SET "localSuccess" = "success"
WHERE "localSuccess" IS NULL;

-- CreateIndex
-- The retention job trims by timestamp only; the existing composite indexes all
-- lead with an id column, so these keep the cleanup deletes off sequential scans.
CREATE INDEX "check_logs_checkedAt_idx" ON "check_logs"("checkedAt");

-- CreateIndex
CREATE INDEX "probe_executions_executedAt_idx" ON "probe_executions"("executedAt");

-- CreateIndex
CREATE INDEX "probe_results_checkedAt_idx" ON "probe_results"("checkedAt");

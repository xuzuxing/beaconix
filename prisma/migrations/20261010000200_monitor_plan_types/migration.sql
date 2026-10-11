-- Separate migration: newly added PostgreSQL enum values must be committed
-- before they can be referenced by defaults or backfills.
ALTER TABLE "plans" ADD COLUMN "allowedMonitorTypes" "MonitorType"[]
    NOT NULL DEFAULT ARRAY['HTTP', 'TCP', 'PING']::"MonitorType"[];
UPDATE "plans"
SET "allowedMonitorTypes" = ARRAY['HTTP', 'TCP', 'PING', 'DNS']::"MonitorType"[]
WHERE "code" IN ('PRO', 'TEAM');

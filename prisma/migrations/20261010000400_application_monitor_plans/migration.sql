-- Separate migration: PostgreSQL must commit enum additions before their use.
ALTER TABLE "monitors" ADD COLUMN "credentialsEnc" TEXT;

UPDATE "plans"
SET "allowedMonitorTypes" = ARRAY(
    SELECT DISTINCT unnest(
        "allowedMonitorTypes" ||
        ARRAY['MYSQL', 'POSTGRESQL', 'REDIS', 'MONGODB', 'DOCKER', 'GRPC', 'WEBSOCKET']::"MonitorType"[]
    )
)
WHERE "code" IN ('PRO', 'TEAM');

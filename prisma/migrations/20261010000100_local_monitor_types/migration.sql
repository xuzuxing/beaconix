ALTER TYPE "MonitorType" ADD VALUE IF NOT EXISTS 'PING';
ALTER TYPE "MonitorType" ADD VALUE IF NOT EXISTS 'DNS';

ALTER TABLE "monitors"
    ADD COLUMN "config" JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "configVersion" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "monitor_states" ADD COLUMN "executionBlockedReason" TEXT;
ALTER TABLE "monitor_states" ADD COLUMN "availabilityAlertPendingId" TEXT;
ALTER TABLE "check_logs"
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "evaluated" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "failureKind" TEXT,
    ADD COLUMN "meta" JSONB NOT NULL DEFAULT '{}';

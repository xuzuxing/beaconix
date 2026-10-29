ALTER TYPE "NotificationType" ADD VALUE 'MONITOR_CAPACITY_GRACE_STARTED';
ALTER TYPE "NotificationType" ADD VALUE 'MONITOR_CAPACITY_GRACE_ENDING';
ALTER TYPE "NotificationType" ADD VALUE 'MONITOR_CAPACITY_LIMITED';
ALTER TYPE "NotificationType" ADD VALUE 'MONITOR_CAPACITY_RESTORED';

ALTER TABLE "organizations"
    ADD COLUMN "monitorCapacityPlanId" TEXT,
    ADD COLUMN "monitorCapacityLimit" INTEGER,
    ADD COLUMN "monitorCapacityObservedAt" TIMESTAMP(3);
ALTER TABLE "monitors" ADD COLUMN "quotaGraceEndsAt" TIMESTAMP(3);
CREATE INDEX "monitors_organizationId_quotaGraceEndsAt_idx"
    ON "monitors" ("organizationId", "quotaGraceEndsAt");

CREATE TABLE "monitor_capacity_cycles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceSubscriptionId" TEXT,
    "purchaserId" TEXT,
    "fromPlanId" TEXT NOT NULL,
    "fromLimit" INTEGER NOT NULL,
    "toPlanId" TEXT NOT NULL,
    "limit" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "graceEndsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GRACE',
    "selectedMonitorIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "retainedMonitorIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "restrictedMonitorIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "announcedAt" TIMESTAMP(3),
    "warnedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "monitor_capacity_cycles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "monitor_capacity_cycles_organizationId_fkey" FOREIGN KEY ("organizationId")
        REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "monitor_capacity_cycles_valid_period" CHECK ("graceEndsAt" >= "startsAt"),
    CONSTRAINT "monitor_capacity_cycles_valid_limit" CHECK ("limit" >= 0 AND "fromLimit" >= 0),
    CONSTRAINT "monitor_capacity_cycles_valid_status" CHECK ("status" IN ('GRACE', 'LIMITED', 'RESOLVED'))
);
CREATE UNIQUE INDEX "monitor_capacity_cycles_sourceKey_key" ON "monitor_capacity_cycles"("sourceKey");
CREATE INDEX "monitor_capacity_cycles_organizationId_status_idx" ON "monitor_capacity_cycles"("organizationId", "status");
CREATE INDEX "monitor_capacity_cycles_status_graceEndsAt_idx" ON "monitor_capacity_cycles"("status", "graceEndsAt");
CREATE UNIQUE INDEX "monitor_capacity_cycles_one_open_per_org"
    ON "monitor_capacity_cycles"("organizationId") WHERE "status" IN ('GRACE', 'LIMITED');

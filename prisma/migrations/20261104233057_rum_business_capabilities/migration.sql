-- CreateEnum
CREATE TYPE "RumErrorStatus" AS ENUM ('UNRESOLVED', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "RumAlertScope" AS ENUM ('APP', 'ERROR_GROUP');

-- CreateEnum
CREATE TYPE "RumPerfMetric" AS ENUM ('LCP', 'CLS', 'INP', 'FCP', 'TTFB', 'PAGE_LOAD', 'RESOURCE', 'HTTP');

-- CreateEnum
CREATE TYPE "RumPerfRating" AS ENUM ('GOOD', 'NEEDS_IMPROVEMENT', 'POOR');

-- CreateEnum
CREATE TYPE "RumMaintenanceJobType" AS ENUM ('PURGE', 'SUBJECT_DELETION');

-- CreateEnum
CREATE TYPE "RumMaintenanceJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RumAlertMetric" ADD VALUE 'NEW_ERROR';
ALTER TYPE "RumAlertMetric" ADD VALUE 'ERROR_RATE';
ALTER TYPE "RumAlertMetric" ADD VALUE 'SPIKE';

-- DropIndex
DROP INDEX "rum_alert_rules_enabled_deletedAt_idx";

-- AlterTable
ALTER TABLE "rum_alert_rules" ADD COLUMN     "confirmWindows" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "consecutiveHits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "scope" "RumAlertScope" NOT NULL DEFAULT 'APP',
ADD COLUMN     "silenceUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "rum_apps" ADD COLUMN     "keyRotatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "rum_error_groups" ADD COLUMN     "assigneeId" TEXT,
ADD COLUMN     "ignoredUntil" TIMESTAMP(3),
ADD COLUMN     "reopenedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedBy" TEXT,
ADD COLUMN     "status" "RumErrorStatus" NOT NULL DEFAULT 'UNRESOLVED';

-- CreateTable
CREATE TABLE "rum_error_notes" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rum_error_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rum_perf_samples" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "metric" "RumPerfMetric" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "rating" "RumPerfRating",
    "page" TEXT,
    "release" TEXT,
    "dimension" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "sessionId" TEXT,
    "endUserId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rum_perf_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rum_perf_buckets" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "metric" "RumPerfMetric" NOT NULL,
    "page" TEXT NOT NULL DEFAULT '*',
    "dimension" TEXT NOT NULL DEFAULT '*',
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "sum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "goodCount" INTEGER NOT NULL DEFAULT 0,
    "needsImprovementCount" INTEGER NOT NULL DEFAULT 0,
    "poorCount" INTEGER NOT NULL DEFAULT 0,
    "histogram" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rum_perf_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rum_maintenance_jobs" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "RumMaintenanceJobType" NOT NULL,
    "status" "RumMaintenanceJobStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB,
    "result" JSONB,
    "error" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rum_maintenance_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rum_error_notes_groupId_createdAt_idx" ON "rum_error_notes"("groupId", "createdAt");

-- CreateIndex
CREATE INDEX "rum_error_notes_authorId_idx" ON "rum_error_notes"("authorId");

-- CreateIndex
CREATE INDEX "rum_perf_samples_appId_metric_receivedAt_idx" ON "rum_perf_samples"("appId", "metric", "receivedAt");

-- CreateIndex
CREATE INDEX "rum_perf_samples_appId_page_receivedAt_idx" ON "rum_perf_samples"("appId", "page", "receivedAt");

-- CreateIndex
CREATE INDEX "rum_perf_samples_appId_dimension_receivedAt_idx" ON "rum_perf_samples"("appId", "dimension", "receivedAt");

-- CreateIndex
CREATE INDEX "rum_perf_buckets_appId_metric_bucketStart_idx" ON "rum_perf_buckets"("appId", "metric", "bucketStart");

-- CreateIndex
CREATE INDEX "rum_perf_buckets_appId_page_bucketStart_idx" ON "rum_perf_buckets"("appId", "page", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "rum_perf_buckets_appId_metric_page_dimension_bucketStart_key" ON "rum_perf_buckets"("appId", "metric", "page", "dimension", "bucketStart");

-- CreateIndex
CREATE INDEX "rum_maintenance_jobs_appId_createdAt_idx" ON "rum_maintenance_jobs"("appId", "createdAt");

-- CreateIndex
CREATE INDEX "rum_maintenance_jobs_status_createdAt_idx" ON "rum_maintenance_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "rum_maintenance_jobs_requestedById_idx" ON "rum_maintenance_jobs"("requestedById");

-- CreateIndex
CREATE INDEX "rum_alert_rules_enabled_deletedAt_metric_idx" ON "rum_alert_rules"("enabled", "deletedAt", "metric");

-- CreateIndex
CREATE INDEX "rum_alert_rules_groupId_idx" ON "rum_alert_rules"("groupId");

-- CreateIndex
CREATE INDEX "rum_error_groups_appId_status_lastSeenAt_idx" ON "rum_error_groups"("appId", "status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "rum_error_groups_assigneeId_idx" ON "rum_error_groups"("assigneeId");

-- CreateIndex
CREATE INDEX "rum_error_groups_resolvedBy_idx" ON "rum_error_groups"("resolvedBy");

-- AddForeignKey
ALTER TABLE "rum_error_groups" ADD CONSTRAINT "rum_error_groups_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rum_error_groups" ADD CONSTRAINT "rum_error_groups_resolvedBy_fkey" FOREIGN KEY ("resolvedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rum_error_notes" ADD CONSTRAINT "rum_error_notes_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "rum_error_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rum_error_notes" ADD CONSTRAINT "rum_error_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rum_alert_rules" ADD CONSTRAINT "rum_alert_rules_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "rum_error_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rum_perf_samples" ADD CONSTRAINT "rum_perf_samples_appId_fkey" FOREIGN KEY ("appId") REFERENCES "rum_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rum_perf_buckets" ADD CONSTRAINT "rum_perf_buckets_appId_fkey" FOREIGN KEY ("appId") REFERENCES "rum_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rum_maintenance_jobs" ADD CONSTRAINT "rum_maintenance_jobs_appId_fkey" FOREIGN KEY ("appId") REFERENCES "rum_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rum_maintenance_jobs" ADD CONSTRAINT "rum_maintenance_jobs_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

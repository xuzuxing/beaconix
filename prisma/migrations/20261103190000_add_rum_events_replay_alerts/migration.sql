ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RUM_ALERT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RUM_RECOVERED';

CREATE TYPE "RumMetricKind" AS ENUM ('ERROR', 'EVENT');
CREATE TYPE "RumAlertMetric" AS ENUM ('ERROR_COUNT', 'EVENT_COUNT');
CREATE TYPE "RumAlertIncidentStatus" AS ENUM ('OPEN', 'RESOLVED');

ALTER TABLE "rum_error_groups"
ADD COLUMN "resolvedStack" TEXT,
ADD COLUMN "release" TEXT,
ADD COLUMN "replaySessionId" TEXT,
ADD COLUMN "sourceMapApplied" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "rum_events" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "endUserId" TEXT,
    "anonymousId" TEXT,
    "sessionId" TEXT,
    "release" TEXT,
    "page" TEXT,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rum_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rum_metric_buckets" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "kind" "RumMetricKind" NOT NULL,
    "name" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "rum_metric_buckets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rum_replay_sessions" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "release" TEXT,
    "page" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "rum_replay_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rum_replay_chunks" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "events" JSONB NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rum_replay_chunks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rum_source_maps" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "release" TEXT NOT NULL,
    "artifactPath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "rum_source_maps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rum_alert_rules" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metric" "RumAlertMetric" NOT NULL,
    "eventName" TEXT,
    "threshold" INTEGER NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "channelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "lastEvaluatedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "rum_alert_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rum_alert_incidents" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "status" "RumAlertIncidentStatus" NOT NULL DEFAULT 'OPEN',
    "value" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "openedNotifiedAt" TIMESTAMP(3),
    "resolvedNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "rum_alert_incidents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rum_error_groups_appId_release_idx" ON "rum_error_groups"("appId", "release");
CREATE INDEX "rum_events_appId_receivedAt_idx" ON "rum_events"("appId", "receivedAt");
CREATE INDEX "rum_events_appId_eventName_receivedAt_idx" ON "rum_events"("appId", "eventName", "receivedAt");
CREATE INDEX "rum_events_appId_sessionId_idx" ON "rum_events"("appId", "sessionId");
CREATE UNIQUE INDEX "rum_metric_buckets_appId_kind_name_bucketStart_key" ON "rum_metric_buckets"("appId", "kind", "name", "bucketStart");
CREATE INDEX "rum_metric_buckets_appId_kind_bucketStart_idx" ON "rum_metric_buckets"("appId", "kind", "bucketStart");
CREATE UNIQUE INDEX "rum_replay_sessions_appId_sessionKey_key" ON "rum_replay_sessions"("appId", "sessionKey");
CREATE INDEX "rum_replay_sessions_appId_lastSeenAt_idx" ON "rum_replay_sessions"("appId", "lastSeenAt");
CREATE UNIQUE INDEX "rum_replay_chunks_sessionId_sequence_key" ON "rum_replay_chunks"("sessionId", "sequence");
CREATE INDEX "rum_replay_chunks_sessionId_sequence_idx" ON "rum_replay_chunks"("sessionId", "sequence");
CREATE UNIQUE INDEX "rum_source_maps_appId_release_artifactPath_key" ON "rum_source_maps"("appId", "release", "artifactPath");
CREATE INDEX "rum_source_maps_appId_release_idx" ON "rum_source_maps"("appId", "release");
CREATE INDEX "rum_source_maps_uploadedById_idx" ON "rum_source_maps"("uploadedById");
CREATE INDEX "rum_alert_rules_appId_deletedAt_idx" ON "rum_alert_rules"("appId", "deletedAt");
CREATE INDEX "rum_alert_rules_enabled_deletedAt_idx" ON "rum_alert_rules"("enabled", "deletedAt");
CREATE INDEX "rum_alert_rules_createdById_idx" ON "rum_alert_rules"("createdById");
CREATE INDEX "rum_alert_incidents_ruleId_status_idx" ON "rum_alert_incidents"("ruleId", "status");
CREATE INDEX "rum_alert_incidents_appId_startedAt_idx" ON "rum_alert_incidents"("appId", "startedAt");

ALTER TABLE "rum_events" ADD CONSTRAINT "rum_events_appId_fkey"
FOREIGN KEY ("appId") REFERENCES "rum_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rum_metric_buckets" ADD CONSTRAINT "rum_metric_buckets_appId_fkey"
FOREIGN KEY ("appId") REFERENCES "rum_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rum_replay_sessions" ADD CONSTRAINT "rum_replay_sessions_appId_fkey"
FOREIGN KEY ("appId") REFERENCES "rum_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rum_replay_chunks" ADD CONSTRAINT "rum_replay_chunks_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "rum_replay_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rum_source_maps" ADD CONSTRAINT "rum_source_maps_appId_fkey"
FOREIGN KEY ("appId") REFERENCES "rum_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rum_source_maps" ADD CONSTRAINT "rum_source_maps_uploadedById_fkey"
FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "rum_alert_rules" ADD CONSTRAINT "rum_alert_rules_appId_fkey"
FOREIGN KEY ("appId") REFERENCES "rum_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rum_alert_rules" ADD CONSTRAINT "rum_alert_rules_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "rum_alert_incidents" ADD CONSTRAINT "rum_alert_incidents_ruleId_fkey"
FOREIGN KEY ("ruleId") REFERENCES "rum_alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rum_alert_incidents" ADD CONSTRAINT "rum_alert_incidents_appId_fkey"
FOREIGN KEY ("appId") REFERENCES "rum_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

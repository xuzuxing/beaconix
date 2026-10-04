-- CreateEnum
CREATE TYPE "MonitorType" AS ENUM ('HTTP', 'TCP');

-- CreateEnum
CREATE TYPE "MonitorStatus" AS ENUM ('UNKNOWN', 'UP', 'DEGRADED', 'DOWN', 'PAUSED');

-- CreateEnum
CREATE TYPE "ProbeProvider" AS ENUM ('TENCENT', 'ALIYUN', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ProbeStatus" AS ENUM ('ONLINE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "CheckSource" AS ENUM ('LOCAL', 'PROBE');

-- CreateEnum
CREATE TYPE "NotificationChannelType" AS ENUM ('FEISHU', 'WECOM', 'DINGTALK', 'WECHAT_SUBSCRIBE', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "monitors" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "MonitorType" NOT NULL,
    "target" TEXT NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 60,
    "timeout" INTEGER NOT NULL DEFAULT 5000,
    "expectedStatus" INTEGER NOT NULL DEFAULT 200,
    "failureThreshold" INTEGER NOT NULL DEFAULT 3,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "monitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_states" (
    "monitorId" TEXT NOT NULL,
    "status" "MonitorStatus" NOT NULL DEFAULT 'UNKNOWN',
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lastCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastLatency" INTEGER,
    "lastNotifiedStatus" "MonitorStatus",
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitor_states_pkey" PRIMARY KEY ("monitorId")
);

-- CreateTable
CREATE TABLE "probes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "ProbeProvider" NOT NULL,
    "region" TEXT NOT NULL,
    "callbackUrl" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastHeartbeat" TIMESTAMP(3),
    "status" "ProbeStatus" NOT NULL DEFAULT 'OFFLINE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "probes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_probes" (
    "monitorId" TEXT NOT NULL,
    "probeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitor_probes_pkey" PRIMARY KEY ("monitorId","probeId")
);

-- CreateTable
CREATE TABLE "probe_results" (
    "id" TEXT NOT NULL,
    "probeId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,
    "latency" INTEGER NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "probe_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_logs" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "latency" INTEGER NOT NULL,
    "error" TEXT,
    "source" TEXT NOT NULL DEFAULT 'local',
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "NotificationChannelType" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL,
    "error" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_pages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "visibleMonitorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "showLatency" BOOLEAN NOT NULL DEFAULT true,
    "showUptime" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "status_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monitors_organizationId_idx" ON "monitors"("organizationId");

-- CreateIndex
CREATE INDEX "monitors_projectId_idx" ON "monitors"("projectId");

-- CreateIndex
CREATE INDEX "monitors_enabled_idx" ON "monitors"("enabled");

-- CreateIndex
CREATE INDEX "monitors_projectId_enabled_idx" ON "monitors"("projectId", "enabled");

-- CreateIndex
CREATE INDEX "monitors_deletedAt_idx" ON "monitors"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "probes_secret_key" ON "probes"("secret");

-- CreateIndex
CREATE INDEX "probes_organizationId_idx" ON "probes"("organizationId");

-- CreateIndex
CREATE INDEX "probes_enabled_idx" ON "probes"("enabled");

-- CreateIndex
CREATE INDEX "monitor_probes_monitorId_idx" ON "monitor_probes"("monitorId");

-- CreateIndex
CREATE INDEX "monitor_probes_probeId_idx" ON "monitor_probes"("probeId");

-- CreateIndex
CREATE INDEX "probe_results_target_checkedAt_idx" ON "probe_results"("target", "checkedAt");

-- CreateIndex
CREATE INDEX "probe_results_probeId_checkedAt_idx" ON "probe_results"("probeId", "checkedAt");

-- CreateIndex
CREATE INDEX "check_logs_monitorId_checkedAt_idx" ON "check_logs"("monitorId", "checkedAt");

-- CreateIndex
CREATE INDEX "notification_channels_organizationId_idx" ON "notification_channels"("organizationId");

-- CreateIndex
CREATE INDEX "notification_channels_enabled_idx" ON "notification_channels"("enabled");

-- CreateIndex
CREATE INDEX "notification_logs_monitorId_sentAt_idx" ON "notification_logs"("monitorId", "sentAt");

-- CreateIndex
CREATE INDEX "notification_logs_channelId_sentAt_idx" ON "notification_logs"("channelId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "status_pages_slug_key" ON "status_pages"("slug");

-- CreateIndex
CREATE INDEX "status_pages_organizationId_idx" ON "status_pages"("organizationId");

-- CreateIndex
CREATE INDEX "status_pages_slug_idx" ON "status_pages"("slug");

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_states" ADD CONSTRAINT "monitor_states_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "probes" ADD CONSTRAINT "probes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_probes" ADD CONSTRAINT "monitor_probes_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_probes" ADD CONSTRAINT "monitor_probes_probeId_fkey" FOREIGN KEY ("probeId") REFERENCES "probes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_probeId_fkey" FOREIGN KEY ("probeId") REFERENCES "probes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_logs" ADD CONSTRAINT "check_logs_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "notification_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

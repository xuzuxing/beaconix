-- CreateEnum
CREATE TYPE "ProbeScope" AS ENUM ('SYSTEM', 'TENANT');

-- CreateEnum
CREATE TYPE "ExecutionTrigger" AS ENUM ('SCHEDULED', 'MANUAL', 'CALLBACK');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('SUCCESS', 'FAILED', 'TIMEOUT', 'SKIPPED');

-- AlterTable: probes
ALTER TABLE "probes" ADD COLUMN "scope" "ProbeScope" NOT NULL DEFAULT 'TENANT',
ADD COLUMN "maxTenants" INTEGER DEFAULT 0,
ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "probes" ALTER COLUMN "organizationId" DROP NOT NULL;

-- AlterTable: check_logs source string -> enum
ALTER TABLE "check_logs" ALTER COLUMN "source" DROP DEFAULT;

ALTER TABLE "check_logs"
ALTER COLUMN "source" TYPE "CheckSource"
USING (
    CASE lower("source")
        WHEN 'probe' THEN 'PROBE'::"CheckSource"
        ELSE 'LOCAL'::"CheckSource"
    END
);

ALTER TABLE "check_logs" ALTER COLUMN "source" SET DEFAULT 'LOCAL';

-- CreateTable
CREATE TABLE "probe_executions" (
    "id" TEXT NOT NULL,
    "probeId" TEXT,
    "monitorId" TEXT,
    "target" TEXT NOT NULL,
    "trigger" "ExecutionTrigger" NOT NULL,
    "status" "ExecutionStatus" NOT NULL,
    "success" BOOLEAN NOT NULL,
    "latency" INTEGER,
    "error" TEXT,
    "requestMeta" JSONB DEFAULT '{}',
    "responseMeta" JSONB DEFAULT '{}',
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "probe_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "probes_scope_idx" ON "probes"("scope");

-- CreateIndex
CREATE INDEX "probe_executions_probeId_executedAt_idx" ON "probe_executions"("probeId", "executedAt");

-- CreateIndex
CREATE INDEX "probe_executions_monitorId_executedAt_idx" ON "probe_executions"("monitorId", "executedAt");

-- CreateIndex
CREATE INDEX "probe_executions_status_idx" ON "probe_executions"("status");

-- AddForeignKey
ALTER TABLE "probe_executions" ADD CONSTRAINT "probe_executions_probeId_fkey" FOREIGN KEY ("probeId") REFERENCES "probes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "probe_executions" ADD CONSTRAINT "probe_executions_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "monitors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

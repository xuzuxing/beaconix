-- CreateEnum
CREATE TYPE "RuleAction" AS ENUM ('ALERT', 'MARK_DOWN', 'SILENCE');

-- CreateTable
CREATE TABLE "rule_groups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tree" JSONB NOT NULL,
    "fieldsUsed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "rule_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_rule_bindings" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "ruleGroupId" TEXT NOT NULL,
    "action" "RuleAction" NOT NULL DEFAULT 'ALERT',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitor_rule_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_groups_organizationId_idx" ON "rule_groups"("organizationId");

-- CreateIndex
CREATE INDEX "rule_groups_projectId_idx" ON "rule_groups"("projectId");

-- CreateIndex
CREATE INDEX "rule_groups_enabled_idx" ON "rule_groups"("enabled");

-- CreateIndex
CREATE INDEX "rule_groups_deletedAt_idx" ON "rule_groups"("deletedAt");

-- CreateIndex
CREATE INDEX "monitor_rule_bindings_monitorId_idx" ON "monitor_rule_bindings"("monitorId");

-- CreateIndex
CREATE INDEX "monitor_rule_bindings_ruleGroupId_idx" ON "monitor_rule_bindings"("ruleGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "monitor_rule_bindings_monitorId_ruleGroupId_key" ON "monitor_rule_bindings"("monitorId", "ruleGroupId");

-- AddForeignKey
ALTER TABLE "rule_groups" ADD CONSTRAINT "rule_groups_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_groups" ADD CONSTRAINT "rule_groups_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_rule_bindings" ADD CONSTRAINT "monitor_rule_bindings_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_rule_bindings" ADD CONSTRAINT "monitor_rule_bindings_ruleGroupId_fkey" FOREIGN KEY ("ruleGroupId") REFERENCES "rule_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

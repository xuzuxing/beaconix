-- CreateEnum
CREATE TYPE "PlanCycle" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cycle" "PlanCycle",
ADD COLUMN     "termId" TEXT;

-- CreateTable
CREATE TABLE "plan_terms" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "cycle" "PlanCycle" NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_terms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_terms_planId_enabled_sortOrder_idx" ON "plan_terms"("planId", "enabled", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "plan_terms_planId_cycle_key" ON "plan_terms"("planId", "cycle");

-- CreateIndex
CREATE INDEX "orders_termId_idx" ON "orders"("termId");

-- AddForeignKey
ALTER TABLE "plan_terms" ADD CONSTRAINT "plan_terms_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_termId_fkey" FOREIGN KEY ("termId") REFERENCES "plan_terms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 回填：每个已有套餐按现有 price / durationDays 生成一条档位。
-- 周期按天数近似推断（沿用 30/90/365 的约定），FREE 的 36500 天归入 YEARLY。
INSERT INTO "plan_terms" ("id", "planId", "cycle", "durationDays", "price", "enabled", "sortOrder", "createdAt", "updatedAt")
SELECT
    md5(random()::text || clock_timestamp()::text),
    p."id",
    CASE
        WHEN p."durationDays" <= 31 THEN 'MONTHLY'::"PlanCycle"
        WHEN p."durationDays" <= 92 THEN 'QUARTERLY'::"PlanCycle"
        ELSE 'YEARLY'::"PlanCycle"
    END,
    p."durationDays",
    p."price",
    true,
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "plans" p;

-- 回填：历史订单挂到所属套餐的档位上，保住金额与时长快照的可追溯性。
UPDATE "orders" o
SET "termId" = t."id", "cycle" = t."cycle"
FROM "plan_terms" t
WHERE t."planId" = o."planId";

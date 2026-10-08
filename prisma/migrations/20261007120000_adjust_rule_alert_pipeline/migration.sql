-- AlterTable
ALTER TABLE "check_logs" ADD COLUMN "ruleMatched" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "ruleGroupIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "monitor_rule_bindings" DROP COLUMN "action";

-- DropEnum
DROP TYPE "RuleAction";

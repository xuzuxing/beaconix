-- AlterTable
ALTER TABLE "settings" ADD COLUMN "overridden" BOOLEAN NOT NULL DEFAULT false;

-- 既有行都是管理端改过的：旧语义下"存在行"就等于"已覆盖"
UPDATE "settings" SET "overridden" = true;

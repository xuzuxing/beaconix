-- Nullable for existing sessions and compatibility during rollout. A legacy
-- token's ID becomes its family ID on the first atomic rotation.
ALTER TABLE "refresh_tokens" ADD COLUMN "familyId" TEXT;
CREATE INDEX "refresh_tokens_userId_familyId_idx" ON "refresh_tokens"("userId", "familyId");
-- At most one current token per tracked session; also accelerates live-family
-- checks when purging revoked ancestors. Legacy null families remain separate.
CREATE UNIQUE INDEX "refresh_tokens_one_current_per_family"
ON "refresh_tokens"("userId", "familyId")
WHERE "revokedAt" IS NULL AND "familyId" IS NOT NULL;

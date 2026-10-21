-- AlterTable
-- General uploads that a business flow keeps by URL (avatars, organization
-- logos, brand images) have no task/ticket host to point at them, so the
-- orphan cleanup used to delete those files 24 hours after upload. `claimedAt`
-- records "something durable references this object" and the cleanup now skips
-- claimed rows.
ALTER TABLE "attachments" ADD COLUMN "claimedAt" TIMESTAMP(3);

-- Backfill: every unhosted upload whose URL is already referenced by a user
-- avatar, an organization logo or a setting value is in use and must survive
-- the next cleanup run.
UPDATE "attachments" a
SET "claimedAt" = NOW()
WHERE a."claimedAt" IS NULL
  AND a."fileKey" IS NOT NULL
  AND a."taskId" IS NULL
  AND a."ticketId" IS NULL
  AND a."ticketReplyId" IS NULL
  AND (
    EXISTS (
      SELECT 1 FROM "users" u
      WHERE u."avatarUrl" LIKE '%' || a."fileKey" || '%'
    )
    OR EXISTS (
      SELECT 1 FROM "organizations" o
      WHERE o."logoUrl" LIKE '%' || a."fileKey" || '%'
    )
    OR EXISTS (
      SELECT 1 FROM "settings" s
      WHERE s."value"::text LIKE '%' || a."fileKey" || '%'
    )
  );

-- The cleanup filters on `claimedAt IS NULL` on top of the host columns;
-- this index keeps that scan off the full table as history grows.
CREATE INDEX "attachments_unclaimed_idx"
    ON "attachments" ("createdAt")
    WHERE "claimedAt" IS NULL
      AND "taskId" IS NULL
      AND "ticketId" IS NULL
      AND "ticketReplyId" IS NULL;

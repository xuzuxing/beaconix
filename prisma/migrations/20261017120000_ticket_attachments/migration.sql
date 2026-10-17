-- AlterEnum
-- General uploads are readable through a signed link, which is a visibility of
-- its own: PRIVATE covers task uploads and EXTERNAL covers linked files.
ALTER TYPE "AttachmentVisibility" ADD VALUE 'PUBLIC';

-- AlterTable
-- A general upload now lands in the table before any business flow claims it,
-- so the task host becomes optional and two ticket hosts are added.
ALTER TABLE "attachments"
    ALTER COLUMN "taskId" DROP NOT NULL,
    ADD COLUMN "ticketId" TEXT,
    ADD COLUMN "ticketReplyId" TEXT;

-- CreateIndex
CREATE INDEX "attachments_ticketId_idx" ON "attachments"("ticketId");
CREATE INDEX "attachments_ticketReplyId_idx" ON "attachments"("ticketReplyId");
CREATE INDEX "attachments_fileKey_idx" ON "attachments"("fileKey");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_ticketReplyId_fkey" FOREIGN KEY ("ticketReplyId") REFERENCES "ticket_replies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An attachment can only ever belong to one host: a task, a ticket or a ticket
-- reply. Prisma cannot express this, so the constraint is enforced here.
ALTER TABLE "attachments" ADD CONSTRAINT "attachment_single_owner" CHECK (
    (CASE WHEN "taskId" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "ticketId" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "ticketReplyId" IS NOT NULL THEN 1 ELSE 0 END) <= 1
);

-- AlterTable
-- Reminder de-duplication for the task due-soon / overdue jobs: a task is
-- reminded once per due-soon window and once per day while overdue.
ALTER TABLE "tasks" ADD COLUMN "dueSoonNotifiedAt" TIMESTAMP(3),
ADD COLUMN "overdueNotifiedAt" TIMESTAMP(3);

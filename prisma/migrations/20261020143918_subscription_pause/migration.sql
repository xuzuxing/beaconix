-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PAUSED';

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedRemainingDays" INTEGER;

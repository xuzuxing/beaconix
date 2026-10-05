-- AlterTable
ALTER TABLE "monitor_states" ADD COLUMN     "sslDaysRemaining" INTEGER,
ADD COLUMN     "sslExpiresAt" TIMESTAMP(3),
ADD COLUMN     "sslIssuer" TEXT,
ADD COLUMN     "sslLastNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "sslSubject" TEXT;

-- AlterTable
ALTER TABLE "monitors" ADD COLUMN     "checkSsl" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sslExpiryThreshold" INTEGER NOT NULL DEFAULT 30;

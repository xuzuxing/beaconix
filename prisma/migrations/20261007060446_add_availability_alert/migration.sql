-- AlterTable
ALTER TABLE "monitor_states" ADD COLUMN     "lastAvailabilityAlertAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "monitors" ADD COLUMN     "availabilityEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "availabilityThreshold" DOUBLE PRECISION DEFAULT 90,
ADD COLUMN     "availabilityWindow" INTEGER DEFAULT 10;

-- CreateTable
CREATE TABLE "monitor_notification_channels" (
    "monitorId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitor_notification_channels_pkey" PRIMARY KEY ("monitorId","channelId")
);

-- CreateIndex
CREATE INDEX "monitor_notification_channels_monitorId_idx" ON "monitor_notification_channels"("monitorId");

-- CreateIndex
CREATE INDEX "monitor_notification_channels_channelId_idx" ON "monitor_notification_channels"("channelId");

-- AddForeignKey
ALTER TABLE "monitor_notification_channels" ADD CONSTRAINT "monitor_notification_channels_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_notification_channels" ADD CONSTRAINT "monitor_notification_channels_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "notification_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

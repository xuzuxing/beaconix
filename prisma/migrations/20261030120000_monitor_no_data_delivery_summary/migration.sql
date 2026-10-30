ALTER TYPE "NotificationType" ADD VALUE 'ALERT_DELIVERY_FAILED_SUMMARY';
ALTER TABLE "monitor_states" ADD COLUMN "noDataSince" TIMESTAMP(3);
ALTER TABLE "monitor_states" ADD COLUMN "lastEffectiveObservationAt" TIMESTAMP(3);
-- Pending rounds also write lastCheckAt. Seed existing applied observations
-- once; only StateService application advances this new clock afterwards.
UPDATE "monitor_states" SET "lastEffectiveObservationAt" = "lastCheckAt"
WHERE "lastAppliedObservationAt" IS NOT NULL;
CREATE INDEX "alert_deliveries_status_createdAt_id_idx" ON "alert_deliveries"("status", "createdAt", "id");

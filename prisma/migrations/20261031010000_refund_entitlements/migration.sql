ALTER TABLE "subscriptions" ADD COLUMN "entitlementsTracked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "refunds" ADD COLUMN "submittedAt" TIMESTAMP(3);

-- Existing PROCESSING/SUCCESS rows were already submitted. Ambiguous old PENDING
-- and FAILED rows require channel verification; never infer authorization from age.
UPDATE "refunds" SET "submittedAt" = "createdAt"
WHERE "status" IN ('PROCESSING', 'SUCCESS');

CREATE TABLE "subscription_entitlements" (
    "orderId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "consumedMs" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "subscription_entitlements_pkey" PRIMARY KEY ("orderId"),
    CONSTRAINT "subscription_entitlements_interval_check" CHECK ("endsAt" >= "startsAt" AND "consumedMs" >= 0),
    CONSTRAINT "subscription_entitlements_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "subscription_entitlements_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "subscription_entitlements_subscriptionId_startsAt_idx"
ON "subscription_entitlements"("subscriptionId", "startsAt");

-- Do not delete or relabel historical duplicate financial records. Resolve them
-- against the channel before deploying if this invariant is already violated.
CREATE UNIQUE INDEX "refunds_one_effective_per_order"
ON "refunds"("orderId") WHERE "status" IN ('PENDING', 'PROCESSING', 'SUCCESS');

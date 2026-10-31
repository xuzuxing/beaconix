ALTER TABLE "payments" ADD COLUMN "outTradeNo" TEXT;
ALTER TABLE "payment_attempts"
    ADD COLUMN "prepayId" TEXT,
    ADD COLUMN "lastCheckedAt" TIMESTAMP(3),
    ADD COLUMN "lastError" TEXT,
    ADD COLUMN "closePending" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "reconcileLeaseToken" TEXT,
    ADD COLUMN "reconcileLeaseUntil" TIMESTAMP(3);

CREATE INDEX "payment_attempts_channel_status_lastCheckedAt_idx"
    ON "payment_attempts"("channel", "status", "lastCheckedAt");

-- Keep the merchant numbers of checkouts issued before per-attempt payments.
INSERT INTO "payment_attempts" (
    "id", "orderId", "channel", "outTradeNo", "openid", "amount", "status",
    "wxOrderId", "paidAt", "rawNotify", "prepayId", "closePending", "createdAt", "updatedAt"
)
SELECT 'legacy_' || p."id", p."orderId", p."channel", o."orderNo", '', p."amount",
    CASE WHEN p."status" IN ('SUCCESS', 'REFUNDED') THEN 'PAID'
         WHEN p."status" = 'FAILED' THEN 'FAILED' ELSE 'PENDING' END::"PaymentAttemptStatus",
    p."transactionId", p."paidAt", p."rawCallback", p."prepayId",
    o."status" = 'CANCELLED' AND p."status" NOT IN ('SUCCESS', 'REFUNDED'), p."createdAt", p."updatedAt"
FROM "payments" p JOIN "orders" o ON o."id" = p."orderId"
WHERE p."channel" IN ('WECHAT', 'ALIPAY')
ON CONFLICT ("outTradeNo") DO NOTHING;

UPDATE "payments" p SET "outTradeNo" = o."orderNo"
FROM "orders" o WHERE o."id" = p."orderId" AND p."channel" IN ('WECHAT', 'ALIPAY');

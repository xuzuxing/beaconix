-- AlterEnum
ALTER TYPE "PaymentChannel" ADD VALUE 'WECHAT_VIRTUAL';

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'PAID', 'CLOSED', 'FAILED');

-- AlterTable
ALTER TABLE "plan_terms" ADD COLUMN     "wechatProductId" TEXT;

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "channel" "PaymentChannel" NOT NULL,
    "outTradeNo" TEXT NOT NULL,
    "openid" TEXT NOT NULL,
    "productId" TEXT,
    "amount" INTEGER NOT NULL,
    "env" INTEGER NOT NULL DEFAULT 0,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "wxOrderId" TEXT,
    "paidAt" TIMESTAMP(3),
    "rawNotify" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_outTradeNo_key" ON "payment_attempts"("outTradeNo");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_wxOrderId_key" ON "payment_attempts"("wxOrderId");

-- CreateIndex
CREATE INDEX "payment_attempts_orderId_idx" ON "payment_attempts"("orderId");

-- CreateIndex
CREATE INDEX "payment_attempts_status_createdAt_idx" ON "payment_attempts"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

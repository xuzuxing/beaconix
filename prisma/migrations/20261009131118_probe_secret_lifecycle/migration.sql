-- Probe secret lifecycle.
--
-- Credentials move from a single plaintext column on `probes` to a hashed
-- credential table that supports revocation and smooth (overlapping) rotation:
-- during a rotation the old and new secret both validate until the old one's
-- expiresAt grace deadline passes.
--
-- Existing plaintext secrets are hashed in place so running probes keep working
-- without re-enrolling.

-- CreateTable
CREATE TABLE "probe_secrets" (
    "id" TEXT NOT NULL,
    "probeId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "secretPrefix" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "probe_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "probe_secrets_secretHash_key" ON "probe_secrets"("secretHash");

-- CreateIndex
CREATE INDEX "probe_secrets_probeId_idx" ON "probe_secrets"("probeId");

-- CreateIndex
CREATE INDEX "probe_secrets_revokedAt_idx" ON "probe_secrets"("revokedAt");

-- CreateIndex
CREATE INDEX "probe_secrets_expiresAt_idx" ON "probe_secrets"("expiresAt");

-- Backfill: hash every existing plaintext secret. sha256() and
-- gen_random_uuid() are built into PostgreSQL 13+, no extension needed.
INSERT INTO "probe_secrets" ("id", "probeId", "secretHash", "secretPrefix", "createdAt")
SELECT
    gen_random_uuid()::text,
    "id",
    encode(sha256("secret"::bytea), 'hex'),
    left("secret", 12),
    now()
FROM "probes";

-- DropIndex
DROP INDEX "probes_secret_key";

-- AlterTable
ALTER TABLE "probes" DROP COLUMN "secret";

-- AddForeignKey
ALTER TABLE "probe_secrets" ADD CONSTRAINT "probe_secrets_probeId_fkey" FOREIGN KEY ("probeId") REFERENCES "probes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

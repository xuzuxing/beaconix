CREATE TYPE "RumAppPlatform" AS ENUM ('WEB');

CREATE TABLE "rum_apps" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" "RumAppPlatform" NOT NULL DEFAULT 'WEB',
    "publicKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "rum_apps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rum_error_groups" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "fingerprintVersion" INTEGER NOT NULL DEFAULT 1,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "page" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstOccurredAt" TIMESTAMP(3),
    "lastOccurredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rum_error_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rum_apps_publicKey_key" ON "rum_apps"("publicKey");
CREATE INDEX "rum_apps_organizationId_idx" ON "rum_apps"("organizationId");
CREATE INDEX "rum_apps_projectId_deletedAt_idx" ON "rum_apps"("projectId", "deletedAt");
CREATE INDEX "rum_apps_projectId_enabled_idx" ON "rum_apps"("projectId", "enabled");
CREATE INDEX "rum_apps_createdById_idx" ON "rum_apps"("createdById");

CREATE UNIQUE INDEX "rum_error_groups_appId_fingerprintVersion_fingerprint_key"
ON "rum_error_groups"("appId", "fingerprintVersion", "fingerprint");
CREATE INDEX "rum_error_groups_appId_lastSeenAt_idx" ON "rum_error_groups"("appId", "lastSeenAt");
CREATE INDEX "rum_error_groups_appId_count_idx" ON "rum_error_groups"("appId", "count");

ALTER TABLE "rum_apps"
ADD CONSTRAINT "rum_apps_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rum_apps"
ADD CONSTRAINT "rum_apps_projectId_organizationId_fkey"
FOREIGN KEY ("projectId", "organizationId") REFERENCES "projects"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rum_apps"
ADD CONSTRAINT "rum_apps_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "rum_error_groups"
ADD CONSTRAINT "rum_error_groups_appId_fkey"
FOREIGN KEY ("appId") REFERENCES "rum_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

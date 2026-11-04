CREATE TYPE "RumErrorCategory" AS ENUM (
    'JAVASCRIPT',
    'PROMISE',
    'RESOURCE',
    'HTTP',
    'VUE',
    'MANUAL'
);

CREATE TYPE "RumErrorLevel" AS ENUM ('INFO', 'WARNING', 'ERROR', 'FATAL');

ALTER TABLE "rum_error_groups"
ADD COLUMN "category" "RumErrorCategory",
ADD COLUMN "level" "RumErrorLevel";

CREATE TABLE "rum_error_occurrences" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "clientEventId" TEXT,
    "category" "RumErrorCategory" NOT NULL,
    "level" "RumErrorLevel" NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "resolvedStack" TEXT,
    "sourceMapApplied" BOOLEAN NOT NULL DEFAULT false,
    "page" TEXT,
    "release" TEXT,
    "sessionId" TEXT,
    "endUserId" TEXT,
    "anonymousId" TEXT,
    "requestId" TEXT,
    "http" JSONB,
    "resource" JSONB,
    "vue" JSONB,
    "breadcrumbs" JSONB NOT NULL DEFAULT '[]',
    "sdk" JSONB,
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rum_error_occurrences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rum_error_occurrences_appId_clientEventId_key"
ON "rum_error_occurrences"("appId", "clientEventId");

CREATE INDEX "rum_error_occurrences_groupId_receivedAt_idx"
ON "rum_error_occurrences"("groupId", "receivedAt");

CREATE INDEX "rum_error_occurrences_appId_receivedAt_idx"
ON "rum_error_occurrences"("appId", "receivedAt");

CREATE INDEX "rum_error_occurrences_appId_category_receivedAt_idx"
ON "rum_error_occurrences"("appId", "category", "receivedAt");

CREATE INDEX "rum_error_occurrences_appId_requestId_idx"
ON "rum_error_occurrences"("appId", "requestId");

ALTER TABLE "rum_error_occurrences"
ADD CONSTRAINT "rum_error_occurrences_appId_fkey"
FOREIGN KEY ("appId") REFERENCES "rum_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rum_error_occurrences"
ADD CONSTRAINT "rum_error_occurrences_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "rum_error_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

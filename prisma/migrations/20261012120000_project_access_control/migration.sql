CREATE TYPE "ProjectRole" AS ENUM ('VIEWER', 'MEMBER', 'ADMIN');
CREATE TYPE "InvitationIssuerType" AS ENUM ('LEGACY', 'ORGANIZATION', 'PLATFORM');
CREATE TYPE "NotificationAccessScope" AS ENUM ('UNKNOWN', 'ACCOUNT', 'INVITATION', 'ORGANIZATION', 'PROJECT');
CREATE TYPE "AttachmentVisibility" AS ENUM ('UNKNOWN', 'PRIVATE', 'EXTERNAL');

ALTER TABLE "users" ADD COLUMN "platformAuthorityVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "memberships" ADD COLUMN "projectPermissionsVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "invitations"
    ADD COLUMN "issuerType" "InvitationIssuerType" NOT NULL DEFAULT 'LEGACY',
    ADD COLUMN "issuerMembershipId" TEXT,
    ADD COLUMN "issuerAuthorityVersion" INTEGER;
ALTER TABLE "notifications"
    ADD COLUMN "organizationId" TEXT,
    ADD COLUMN "projectId" TEXT,
    ADD COLUMN "accessScope" "NotificationAccessScope" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "notification_deliveries" ADD COLUMN "dispatchAuthorizedAt" TIMESTAMP(3);
ALTER TABLE "attachments" ADD COLUMN "visibility" "AttachmentVisibility" NOT NULL DEFAULT 'UNKNOWN';

CREATE UNIQUE INDEX "memberships_id_organizationId_key" ON "memberships"("id", "organizationId");
CREATE UNIQUE INDEX "projects_id_organizationId_key" ON "projects"("id", "organizationId");
CREATE UNIQUE INDEX "invitations_id_organizationId_key" ON "invitations"("id", "organizationId");

CREATE TABLE "project_memberships" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "role" "ProjectRole" NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_memberships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_memberships_membershipId_organizationId_fkey"
        FOREIGN KEY ("membershipId", "organizationId") REFERENCES "memberships"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "project_memberships_projectId_organizationId_fkey"
        FOREIGN KEY ("projectId", "organizationId") REFERENCES "projects"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "project_memberships_grantedById_fkey"
        FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "project_memberships_membershipId_projectId_key" ON "project_memberships"("membershipId", "projectId");
CREATE INDEX "project_memberships_projectId_role_idx" ON "project_memberships"("projectId", "role");
CREATE INDEX "project_memberships_membershipId_organizationId_idx" ON "project_memberships"("membershipId", "organizationId");

CREATE TABLE "invitation_project_grants" (
    "id" TEXT NOT NULL,
    "invitationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "role" "ProjectRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invitation_project_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invitation_project_grants_invitationId_organizationId_fkey"
        FOREIGN KEY ("invitationId", "organizationId") REFERENCES "invitations"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invitation_project_grants_projectId_organizationId_fkey"
        FOREIGN KEY ("projectId", "organizationId") REFERENCES "projects"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "invitation_project_grants_invitationId_projectId_key" ON "invitation_project_grants"("invitationId", "projectId");
CREATE INDEX "invitation_project_grants_projectId_idx" ON "invitation_project_grants"("projectId");
CREATE INDEX "notifications_userId_accessScope_projectId_isRead_idx" ON "notifications"("userId", "accessScope", "projectId", "isRead");

ALTER TABLE "memberships" ADD CONSTRAINT "memberships_projectPermissionsVersion_check" CHECK ("projectPermissionsVersion" >= 0);
ALTER TABLE "users" ADD CONSTRAINT "users_platformAuthorityVersion_check" CHECK ("platformAuthorityVersion" >= 0);
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_issuer_check" CHECK (
    ("issuerType" = 'LEGACY' AND "issuerMembershipId" IS NULL AND "issuerAuthorityVersion" IS NULL)
    OR ("issuerType" = 'ORGANIZATION' AND "issuerMembershipId" IS NOT NULL AND "issuerAuthorityVersion" IS NULL)
    OR ("issuerType" = 'PLATFORM' AND "issuerMembershipId" IS NULL AND "issuerAuthorityVersion" IS NOT NULL AND "issuerAuthorityVersion" >= 0)
);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_accessScope_check" CHECK (
    "accessScope" = 'UNKNOWN'
    OR ("accessScope" = 'ACCOUNT' AND "organizationId" IS NULL AND "projectId" IS NULL)
    OR ("accessScope" IN ('INVITATION', 'ORGANIZATION') AND "organizationId" IS NOT NULL AND "projectId" IS NULL)
    OR ("accessScope" = 'PROJECT' AND "organizationId" IS NOT NULL AND "projectId" IS NOT NULL)
);

-- Preserve historical identity; role/status restoration cannot revive old invitations.
CREATE FUNCTION "advance_platform_authority_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."globalRole" IS DISTINCT FROM OLD."globalRole"
       OR NEW."isActive" IS DISTINCT FROM OLD."isActive"
       OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" THEN
        NEW."platformAuthorityVersion" := OLD."platformAuthorityVersion" + 1;
    ELSE
        NEW."platformAuthorityVersion" := OLD."platformAuthorityVersion";
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "users_platform_authority_version"
    BEFORE UPDATE ON "users" FOR EACH ROW
    EXECUTE FUNCTION "advance_platform_authority_version"();

-- No automatic project grants or historical notification/file classifications.
UPDATE "invitations" SET "status" = 'REVOKED', "updatedAt" = CURRENT_TIMESTAMP
WHERE "issuerType" = 'LEGACY' AND "status" = 'PENDING';

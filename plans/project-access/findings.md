# Project Access Findings

## Verified Current State

- Organization membership is the only resource-access relationship in
  prisma/schema.prisma; no project membership or invitation-project grant exists.
- OrgMemberGuard and RolesGuard resolve project/task organization but verify
  only organization Membership.
- ProjectsController.findAll passes only orgId; ProjectsService.findAll filters
  by organizationId and deletedAt, not the requesting user.
- CreateInvitationDto supports email and organization role only.
- InvitationsService.acceptById creates organization Membership in a transaction,
  with invitation state claims and notification/email outbox writes.
- Existing docs deliberately keep monitors under projects and probes/channels
  as organization infrastructure.
- Existing notifications use current organization membership as a privacy
  boundary; adding project isolation must include notifications and delivery.
- The repository contains substantial unrelated uncommitted changes. Plans must
  explicitly account for working-tree drift, not just commit drift.

## Recommended Design Direction

- Keep organization OWNER/ADMIN as all-project administrators.
- Use explicit project grants for organization MEMBER/VIEWER.
- Project roles: VIEWER, MEMBER, ADMIN; no redundant project OWNER.
- Empty project grants mean no access, never all-project access.
- Do not carry organization ADMIN into an invite intended for one-project admin.
- Preserve organization VIEWER as a read-only ceiling.
- Default-deny historical non-admin members until reviewed grants are assigned.

## Remaining Investigation

- Direct and nested child-resource routes.
- Organization aggregates and include payloads.
- Personal tokens and organization API keys.
- Historical notifications, SSE, scheduled notifications, and external channels.
- Permission management, ownership-transfer, and project lifecycle interactions.

## Additional Verified Findings

- DeveloperAuthGuard checks PAT scopes plus organization membership, but not
  project roles. JwtAuthGuard also accepts PAT on ordinary user endpoints.
- Organization monitoring overview includes every organization monitor.
- Some task/comment/attachment writes use only OrgMemberGuard. Read-only
  project access requires explicit operation gates.
- RuleGroupsService.update/softDelete scope writes by id only. New guards must
  not replace service-level parent ownership constraints.
- Comments/attachment deletion reads organization role; project management
  capability must be propagated separately.
- Task recipients and project recipients use organization membership sets.
  Notification inbox and unread count filter only by userId.
- Local and OSS storage providers optionally return publicBaseUrl links.
  Private project authorization must account for existing public attachment URLs.
- Public status pages are an intentional publication boundary, not private ACL.
- Project creator, task assignee, and watcher relationships are not sufficient
  authority to auto-backfill historical project grants.

## Design Document

- plans/002-project-access-control.md contains the Chinese design, migration,
  implementation boundaries, verification commands, and regression matrix.
- Proposed defaults that require product confirmation: OWNER-only organization
  ADMIN grants; explicit historical non-admin grants; PAT developer-only use.

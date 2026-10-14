# Workspace Notifications

Date: 2026-10-11

## Objective

Implement the complete notification inventory in one delivery, preserving existing
workspace changes. Cover invitations, memberships, ownership, tasks, comments,
projects, sprints, security, billing, monitoring and credentials.

## Work

- [x] Durable transactional notification and email delivery, deduplication,
      retries, multi-instance SSE and invitation state projection.
- [x] Invitation lifecycle, verified email ownership, pending invitation discovery.
- [x] Collaboration recipients, assignment, replies, deletion/restoration and dependencies.
- [x] Password/2FA, credential lifecycle, billing and monitoring notifications.
- [x] Frontend types, rendering, resource navigation and actionable invitations.
- [x] Regression tests, migration verification, type-check, lint, build and review.

## Shared Contract

`NotificationsService.publish(event, tx?)` accepts:

```ts
{
    eventKey: string; // Stable business event id; unique per real transition.
    type: NotificationType;
    title: string;
    body?: string;
    resourceType?: string;
    resourceId?: string;
    organizationId?: string;
    actorId?: string;
    includeActor?: boolean; // Security reminders include the actor.
    allowOutsideOrg?: boolean; // Invitations and removal notices only.
    email?: boolean; // Generic email in addition to in-app.
    meta?: Prisma.InputJsonValue;
    recipients: Array<string | {
        userId: string;
        type?: NotificationType;
        title?: string;
        body?: string;
        email?: boolean;
    }>;
}
```

The second argument is a Prisma transaction client. Use it inside the same
transaction as the business mutation. No network calls happen inside `publish`.
Recipient overrides are first-wins, so place mentions/replies/assignees before
ordinary watcher recipients. Recipients must be active users, and org-scoped
notifications require current membership unless `allowOutsideOrg` is true.

Additional helpers:

- `organizationRecipients(orgId, tx?, roles?)`: current org member IDs.
- `taskRecipients(taskId, tx?)`: current org members who created, own or watch the task.
- `projectRecipients(projectId, tx?)`: current org members participating in project tasks,
  project creator and org admins/owners (there is no project membership table).
- `enqueueEmail(template, payload, eventKey, tx?)`: durable typed email delivery.
- `syncPendingInvitations(userId, tx?)`: discover valid invitations after verified email.

## Boundaries

Do not expose tokens, recovery codes, credentials or passwords in notification
metadata or text. Do not broadcast personal security events to teams. Ignore no-op
mutations, exclude ordinary actors, deduplicate recipients, and preserve existing
external monitor incident/recovery semantics.

## Verification

Run Prisma generation, focused and full unit tests, backend type-check/lint/build,
frontend checks and targeted UI validation. Do not reset the user's database.

## Final Gate Status

- Prisma generation and existing local migration verification passed.
- Disposable PostgreSQL notifications integration: 9 tests passed.
- Redis two-instance notifications integration: 1 test passed.
- Frontend final regression: 101 tests passed; type-check, lint and build passed.
- Browser desktop, mobile and mobile-dark invitation workflows passed.
- Backend final regression: 104 suites / 1344 tests passed; type-check, lint and
  build passed.
- Core and frontend rereviews have no Critical/Important findings.
- Final formatted browser smoke rerun passed all three viewport/theme cases.

## Errors And Resolutions

- CodeRabbit CLI unavailable: used two independent local reviewers.
- A resumed exploratory store read used a missing path; located the actual
  `src/stores/modules/notification.ts` with `rg --files`.
- Vite reports an existing large-chunk warning; build completes successfully.
- Browser smoke script formatting check initially failed; Prettier formatting,
  scoped ESLint and all three browser cases subsequently passed.
- Disabling Git CRLF normalization produced false whitespace errors; the check
  with the repository's normalization and `cr-at-eol` passes. No line-ending
  conversion was made for this task.

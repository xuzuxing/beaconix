# Workspace Notification Inventory

All events below are implemented. Each eligible recipient gets one personal
inbox record and a durable SSE intent. Email is additional, not a substitute for
the inbox. Ordinary actors are excluded; personal security and credential
changes deliberately include the actor.

## Events And Recipients

| Domain               | Events                                                                           | Personal inbox audience                                                                                                                                                                                      | Additional email                                                                      |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Invitations          | Received, accepted, declined, revoked, expired                                   | Received/revoked: verified matching invitee, including non-members. Accepted: inviter, current admins/owners and joining user. Declined/expired: inviter. Existing received notice reflects terminal status. | Invitation link on send; welcome on acceptance.                                       |
| Memberships          | Joined, removed, left, role changed                                              | Joining/removed user and relevant admins/owners. Role changes notify target; admin promotion/demotion also notifies admins/owners.                                                                           | Removed user and role-change target.                                                  |
| Organizations        | Ownership transferred, deleted, restored                                         | Ownership: old/new owner and admins. Lifecycle: current members; deletion may notify recipients outside the now-inaccessible org.                                                                            | Ownership audience; lifecycle admins/owners.                                          |
| Tasks                | Assigned, unassigned, updated, status changed, sprint changed, deleted, restored | Task creator, old/new assignee, watchers, filtered to current membership. Assignee-specific notice takes precedence over a generic update.                                                                   | None for ordinary collaboration changes.                                              |
| Dependencies         | Dependency changed, task unblocked                                               | Relevant participants of the affected task/dependency.                                                                                                                                                       | None.                                                                                 |
| Comments             | New comment, reply, mention                                                      | Mentioned members first, parent-comment author second, then task participants. One notice per recipient.                                                                                                     | None.                                                                                 |
| Task reminders       | Due soon, overdue                                                                | Task creator, current assignee and watchers who remain members.                                                                                                                                              | Verified current assignee. Due-soon once per due date; overdue once per calendar day. |
| Projects             | Archived, deleted, restored                                                      | Project creator, participants in active project tasks and org admins/owners.                                                                                                                                 | None.                                                                                 |
| Sprints              | Started, completed, deleted                                                      | Participants of affected sprint tasks. Task moves are notified only to affected task participants.                                                                                                           | None.                                                                                 |
| Passwords            | Changed, reset completed                                                         | Account owner only.                                                                                                                                                                                          | Account owner.                                                                        |
| Two-factor security  | Enabled, disabled, recovery code used, recovery codes regenerated                | Account owner only; no recovery code/secret content.                                                                                                                                                         | Account owner.                                                                        |
| Billing              | Payment succeeded, subscription activated/renewed                                | Order purchaser and current admins/owners.                                                                                                                                                                   | Same audience, verified email only.                                                   |
| Subscription expiry  | Expiring at 7/3/1 days, expired                                                  | Current admins/owners. Stacked subscriptions are evaluated before claiming effective entitlement changed.                                                                                                    | Same audience, verified email only.                                                   |
| Monitoring           | Incident opened, recovered                                                       | Current admins/owners on opening. Recovery uses durable opening audience and rechecks current membership, independent of inbox dismissal. Baseline incidents do not create opening alerts.                   | Existing external monitor channels remain separate and unchanged.                     |
| API credentials      | Organization API key created/revoked                                             | Creator/operator and current admins/owners.                                                                                                                                                                  | Same audience, verified email only.                                                   |
| Personal credentials | Personal access token created/revoked                                            | Token owner only.                                                                                                                                                                                            | Token owner.                                                                          |
| Probes               | Enrolled, secret rotated, credential revoked/deleted                             | Operator and current admins/owners.                                                                                                                                                                          | Same audience, verified email only.                                                   |

## Invitation Access

- `GET /api/invitations/pending`: invitations addressed to the authenticated,
  active user's verified email. No team membership is needed.
- `GET /api/invitations/by-id/:id`: invitee-only current state.
- `POST /api/invitations/by-id/:id/accept` and `/decline`: authenticated matching
  verified email required. `OWNER` invitations are not permitted.
- Existing token routes remain supported; station notifications never contain
  the invitation token. Pending/expired/revoked status disables unsafe actions.
- Invitations created before registration or email verification are discovered
  after verification and when the notification inbox/count is requested.
- Ignoring an invitation notification does not dismiss the actual invitation:
  it remains available under pending invitations.

## Reliability And Privacy

- Business mutation, inbox record and email/SSE intents commit together.
- A unique event reservation prevents duplicate delivery and resurrection after
  inbox deletion. The outbox must be retained while event replay or incident
  recovery is possible; it is not a disposable inbox cache.
- The outbox uses conditional DB leases and lease tokens across replicas.
  Failed delivery retries with capped exponential backoff; email carries a
  stable provider idempotency key.
- Delivery statuses are `PENDING`, `SENDING`, `SENT`, `SKIPPED`. Removed/inactive
  recipients and processed invitation emails are skipped, not marked sent.
- Redis pub/sub fans out SSE to all application instances. The stream endpoint
  bypasses the JSON response wrapper. Event IDs enable frontend replay dedup.
- Inbox endpoints are scoped to the authenticated user, including
  `GET /api/notifications/:id` for arbitrarily old notifications.
- Metadata recursively removes password/token/secret/recovery-code/credential
  fields. Frontend displays an explicit metadata allowlist and internal links.
- Notification types do not grant access to resources; navigation revalidates
  accessible organization/project context.
- In development, `EmailService` renders emails to console instead of sending
  them. Production delivery requires the normal Resend configuration.

## Deployment And Verification

Apply `20261011120000_workspace_notifications` before starting the updated
backend, then regenerate the Prisma client. Do not use database reset for deploy.

```powershell
pnpm exec prisma migrate deploy
pnpm exec prisma generate
pnpm type-check
pnpm test -- --runInBand
pnpm lint
pnpm build
```

The PostgreSQL regression suite requires an **empty disposable local database**
named `beacon_monitor_test` or `beacon_monitor_test_<suffix>`:

```powershell
$env:MONITOR_TEST_DATABASE_URL = '<disposable local PostgreSQL URL>'
pnpm exec tsx --test test/notifications-postgres.integration-spec.ts
```

The harness refuses a nonempty database and never resets existing data.
Frontend regression tests live in the sibling `beacon-vue3/test` directory,
including optional Playwright smoke checks in `notification-ui.smoke.mjs`.

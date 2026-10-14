# Findings

- The user's working tree already contains unrelated monitoring/demo changes.
- Existing station notifications are database records plus process-local SSE.
- Invitation send has only email; invitation accept lacks email ownership checks.
- Task create assignment, comment replies, role changes, ownership changes,
  deleted/restored resources and task movement/dependencies lack complete coverage.
- Due/overdue station recipients omit assignees who stopped watching.
- Monitor alert events/delivery records are distinct from personal notifications.
- Security and billing services have no unified station notification integration.
- The Vue frontend exists at D:/zuxcloud/Beacon/beacon-vue3.
- Some referenced NestJS skill rule files are not installed; use the available
  top-level skill and repository patterns.

## Implemented Outcome

- The original invitation path only sent email. Invitations now create a
  personal notification for active verified matching accounts, with deferred
  discovery for users who register or verify later.
- Notification delivery is now durable and transactional, not a process-local
  fire-and-forget event. The retained SSE outbox reserves event identity and
  preserves monitor opening audiences after inbox dismissal.
- Recipients are revalidated at dispatch; inactive or removed users are skipped,
  with explicit non-member exceptions for invitations and removal notices.
- Global response transformation wrapped actual SSE output; bypassing it is
  covered by an HTTP test for raw event data and stable IDs.
- Frontend mutations win over stale REST/SSE results. Historical detail uses a
  user-scoped single-record endpoint rather than scanning limited pages.
- Final desktop and mobile screenshots show actionable pending invitations and
  terminal-state badges without unsafe buttons or horizontal page overflow.
- Complete event/recipient/email inventory and deployment instructions are in
  `docs/design/workspace-notifications.md`.

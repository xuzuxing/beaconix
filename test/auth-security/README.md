# Notification and session security acceptance

Run the normal `pnpm exec jest --runInBand`, `pnpm test:business:offline`,
`pnpm type-check`, `pnpm lint:check`, and `pnpm build` gates. Unit coverage includes
notification URL admission, all-answer DNS checks, socket address pinning with
the original Host, rejected redirects, response size/deadline limits, diagnostic
and audit redaction, and atomic refresh/logout behavior.

## PostgreSQL acceptance

Create an **empty, disposable, local** database named `beacon_monitor_test` or
`beacon_monitor_test_<suffix>`, then run:

```powershell
$env:MONITOR_TEST_DATABASE_URL = 'postgresql://test_user:test_password@127.0.0.1:5432/beacon_monitor_test_auth'
pnpm test:auth:postgres
```

The shared harness validates this explicit URL, refuses a nonempty database,
deploys the full migration history, and never resets or drops databases. There
is no `DATABASE_URL` fallback. Use a fresh database for each run.

The suite uses real AuthService, TokenCleanupService and PostgreSQL transactions
with a stubbed JWT signer and notification publisher. It covers simultaneous
refresh attempts, one-current-token-per-family uniqueness, signing rollback,
refresh/logout races across multiple devices, password-change revocation,
the 2FA user-lock/revocation contract, family-aware cleanup, and fresh account
status checks. A signing barrier crosses the parent's actual expiry time and
verifies cleanup waits for the user lock before deciding whether to purge it.
The 2FA scenario exercises its locking contract, not an external OTP provider.

## Deployment of `20261031020000_refresh_token_families`

Deploy the migration and matching application together, generating the Prisma
client during the build. Quiesce session writes and the token-cleanup job during
the version switch: old application instances cannot maintain family lineage,
and old cleanup code deletes the ancestors needed for family-aware logout.

`familyId` is nullable for legacy sessions. Their first new-version rotation
uses the old token ID as the family ID. The migration does not reconstruct
already-purged or previously rotated historical sessions. Existing legacy
tokens cannot link to descendants created before this version.

Refresh and logout serialize on the user row. Parent revocation and replacement
insertion commit together; a failed signing or insert leaves the parent usable.
Logout using a retained ancestor revokes its current family without revoking
other devices. Cleanup locks users in bounded batches in the same order and
retains even expired ancestors while a valid descendant exists. This deliberately
retains family history for the lifetime of a continuously refreshed session.
This change does not alter the existing access-JWT lifetime or initial-login
issuance policy.

## Notification compatibility and data boundary

Notification destinations must use public HTTP(S) addresses. Every DNS answer
is checked; the selected socket address is pinned while Host/SNI stay tied to
the original hostname. `MONITOR_ALLOW_PRIVATE_TARGETS` only affects monitoring;
it does not allow tenant notifications to reach private addresses. Redirects
fail, so configure the final public provider endpoint. URL userinfo/fragments
are rejected. The default five-second deadline includes DNS and response reads;
response bodies are limited to 64 KiB.

New notification failures and audit records redact channel/API credentials.
Immutable historical audit rows and existing delivery errors are not rewritten.
No real notification provider, production database, or external network policy
is verified by these tests. Retain normal network egress restrictions in the
deployment environment.

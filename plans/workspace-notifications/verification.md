# Verification

Date: 2026-10-11

## Backend

- Prisma client generated successfully after schema additions.
- Existing local migration/table/column verified without resetting the database.
- `pnpm test -- --runInBand`: 104 suites, 1344 tests passed.
- `pnpm type-check`, `pnpm lint`, `pnpm build`: passed.
- Real PostgreSQL notification integration: 9 tests passed in a fresh disposable
  database, including repeated migration deploy, rollback, concurrent
  publication/acceptance, deleted-inbox replay, recovery audience and delivery.
- Real Redis notification integration: 1 test passed, two application instances
  and multiple subscriptions.
- Probe actor HTTP subset: 3 tests passed; 28 unrelated database cases skipped.
- HTTP SSE regression confirms raw event payload and stable event ID.

## Frontend

- `pnpm exec tsx --test test/*.test.*`: 101 tests passed.
- `pnpm build`: type-check and production build passed.
- `pnpm lint`: passed.
- Browser smoke after final formatting: desktop 1440x1000, mobile 375x812 and
  mobile-dark passed invitation discovery, accept/decline, terminal states,
  membership refresh, overflow checks and browser error checks.
- Desktop/mobile screenshots inspected; saved under `screenshots/`.

## Review And Limits

- Independent core and frontend rereviews: no Critical/Important findings.
- CodeRabbit CLI unavailable; local independent reviewers used.
- Development email rendering exercised, not production Resend sending.
- Full existing monitoring PostgreSQL/e2e suites were not run.
- Nonfatal existing Vite large-chunk and local pnpm configuration warnings remain.
- Local preview: http://127.0.0.1:5174/notifications

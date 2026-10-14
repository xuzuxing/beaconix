# Progress

## 2026-10-10
- Read PostgreSQL and planning skill guidance and current schema/triggers.
- Verified source fixture and explained that this is equivalent synthetic data, not a raw dump.
- Started a scoped plan without changing other ongoing plans or application source.
- Created import SQL, Chinese README, and isolated PostgreSQL verification script.
- Missing parameters, invalid/missing owner, SQL-literal escaping, incompatible schema,
  and injected mid-import rollback safeguards passed.
- Initial real import exposed a streak-count bug; consistency assertion rejected the transaction.
  Fixed the filtered window count and rerunning the same complete verification.
- `pnpm type-check` passed.
- Complete PostgreSQL 16 import passed in 46.6 seconds: 16 monitors, 604560 checks,
  164 history snapshots, 48 events (6 ongoing, 42 resolved).
- Verified status distribution, CUID shape, snapshot ownership, current config revision,
  rescue semantics, latest state vs checks, history revision pointers, event durations,
  no notifications/probes, coverage and 24h metrics.
- Duplicate import refused with counts unchanged.
- Verification database removed; dedicated source test database still has zero organizations,
  monitors, check logs and events. No UAT connection was used.
- Independent read-only review requested through an existing agent (new spawn limit reached).
- Reviewer identified SSL lifecycle, availability opening evidence, rescued latency/error semantics,
  and missing populated-tenant preservation test. Confirmed each against StateService,
  CheckerService and AlertEventsService, then corrected SQL and expanded verification.
- Revised fixture preserves five-state distribution; Authentication is DEGRADED due to SSL policy,
  Payment API is UP. Connectivity failures are independent of certificate failures.
- Availability incidents now include historical recoveries, yielding 54 expected events.
- Rerunning full import with a populated unrelated tenant and exact row snapshots.
- Revised import passed in 39.5 seconds: demo-only totals 16 monitors, 604560 checks,
  164 history rows, 54 events (6 ongoing and 48 resolved).
- Existing user's complete row and populated tenant's organization, membership, project,
  monitor, state, check, coverage, history and event stayed byte-equivalent as JSON
  after rollback, successful import, and refused repeat import.
- Asserted SSL policy outcomes, rescued local5000ms/finalNULLerror semantics, 70% opening
  availability evidence and observation-derived opening timestamps.
- Removed revised verification database; awaiting narrow follow-up review, then repackage.
- User requested just one directly runnable SQL file. Created exports/TestTeam-UAT.sql
  with no psql metacommands or parameters; only an existing UAT email needs replacement.
- Preserved transactional guards and synthetic-data warning; worker pause is a header prerequisite.
- Running the standalone pure SQL in a fresh isolated database; no application code changed.
- Standalone SQL passed actual PostgreSQL import: 16 monitors, 604560 checks,
  164 history rows, 54 events. Unedited owner placeholder safely rejected.
- Removed standalone verification database and opened SQL at the editable owner email.
- Deliver only the plain SQL link and concise prerequisites per the latest request.

# Project Access Acceptance

These suites do not read `.env` or fall back to `DATABASE_URL`. They never create,
reset, or drop a database. Production and development databases are not accepted.

## Offline Checks

Run `pnpm test:project-access:safety`.

This runs the URL/catalog safety tests, migration staging and cleanup tests, pool
teardown checks, and a Nest controller/guard/DTO bootstrap smoke test. SQL clients
are simulated; the genuine disconnected Prisma pool must have zero connections.
These tests are not PostgreSQL acceptance.

## Database Prerequisites

Provision three distinct, empty disposable databases on a local PostgreSQL server
and set all three variables in the process running the tests:

| Variable | Accepted database name |
| --- | --- |
| `PROJECT_ACCESS_TEST_DATABASE_URL` | `beacon_project_access_test` or `beacon_project_access_test_<suffix>` |
| `PROJECT_ACCESS_UPGRADE_TEST_DATABASE_URL` | `beacon_project_access_upgrade_test` or `beacon_project_access_upgrade_test_<suffix>` |
| `PROJECT_ACCESS_HTTP_TEST_DATABASE_URL` | `beacon_project_access_http_test` or `beacon_project_access_http_test_<suffix>` |

Only `postgres:`/`postgresql:` URLs with `localhost`, `127.0.0.1`, or `[::1]`
hosts are accepted. Query strings and fragments are rejected. Suffixes use
lowercase ASCII letters, digits, and underscores. An omitted port is fixed to
5432 rather than inherited from `PGPORT`.

Both entry points validate all three configurations and their distinct database
identities before connecting. The PostgreSQL suite checks all three catalogs
before any DDL. The HTTP suite checks only its own catalog, allowing the preceding
PostgreSQL suite to leave the other databases populated. Runtime SQL/Prisma
identity checks must match the validated database.

## Execution Order

1. Run `pnpm test:project-access:postgres`.
2. Run `pnpm test:project-access:http`.

The first command migrates the fresh and upgrade databases; it leaves the HTTP
database empty. The second command independently migrates the HTTP database.
Each re-run requires new empty databases for its scenarios. The harness refuses
nonempty databases instead of deleting data.

Historical migrations are staged into an owned temporary directory. Protocol and
trigger compatibility migrations are added in the existing historical upgrade
order, followed by the ACL migration. The suite checks that all migrations are
present exactly once; it does not use `db push` or omit compatibility migrations.

Missing or unsafe configuration exits nonzero, with no skipped/todo acceptance
cases and no fallback connection. Driver and child-process diagnostics are
withheld or scrubbed so connection credentials are not printed.

## Implemented Coverage

The PostgreSQL suite covers composite grant foreign keys, uniqueness and CHECKs,
platform-authority generation triggers, migration idempotency, old pending
invitation revocation, no automatic project grants, UNKNOWN historical data,
assignee eligibility, business write versus ACL revocation using observed
PostgreSQL lock waits, and attachment audit-failure rollback before storage
cleanup.

The HTTP suite uses actual controllers, guards, business services and one genuine
PrismaService for fixtures and requests. It covers role snapshots, explicit A/B/C
and future-project access, VIEWER write denial and subscriptions, DTO validation,
parent binding, foreign references, local project administration, legacy nested
cross-links, attachment access/moderation, PAT scopes and revocation, organization
API keys, inactive identities, ACL replacement and stale preconditions.

External storage and notification dispatch are stubbed. No real file is uploaded
and no external email is sent. The HTTP module is a focused acceptance fixture,
not a complete AppModule bootstrap.

## Remaining Acceptance Matrix

The design's full acceptance matrix is broader than these suites. Dedicated
database-backed cases for invitation issuer lifecycles, final-member quota
competition, membership removal/rejoin and ownership-transfer races, concurrent
ACL replacements, project deletion/acceptance, notification worker/SSE lease and
revocation boundaries, and DB-backed dashboard/ETag caches are not yet included.
Related unit/HTTP-mock tests do not replace those real database cases.

Bucket/CDN policies, proxy exposure, historical attachment migration, administrator
approved grant backfills, notification classification, and coordinated deployment
must also be verified separately. Passing these suites alone does not approve a
production rollout.

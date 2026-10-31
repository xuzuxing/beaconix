# Refund correctness acceptance

Run unit and offline HTTP coverage with the normal `pnpm exec jest --runInBand`
and `pnpm test:business:offline` gates.

The PostgreSQL suite requires an **empty, disposable, local** database named
`beacon_monitor_test` or `beacon_monitor_test_<suffix>`:

```powershell
$env:MONITOR_TEST_DATABASE_URL = 'postgresql://test_user:test_password@127.0.0.1:5432/beacon_monitor_test_refunds'
pnpm test:billing:postgres
```

The shared harness validates this URL, refuses a nonempty database, applies the
full migration history, and never resets or drops databases. There is no
`DATABASE_URL` fallback. Use a fresh database for each run. The suite verifies
concurrent create/approve/retry admission, the partial unique index, concurrent
successful settlement, and lazy legacy service backfill using real transactions.
Notification and channel I/O are stubbed; this does not validate real payments.

## Deployment of `20261031010000_refund_entitlements`

Before deployment, reconcile historical refunds against channel records. This
query must return no rows before the unique index can be installed:

```sql
SELECT "orderId", array_agg("id") AS "refundIds", count(*)
FROM "refunds"
WHERE "status" IN ('PENDING', 'PROCESSING', 'SUCCESS')
GROUP BY "orderId"
HAVING count(*) > 1;
```

Do not delete duplicate financial history to make the migration pass. Resolve
the channel facts and account for those exceptions before enabling new refunds.
The migration deliberately fails if the invariant is already violated.

Older `PENDING` rows can represent either approval or an interrupted submission;
older `FAILED` rows can represent a lost response. Review both statuses and their
original merchant refund numbers against channel records. The migration infers
`submittedAt` only for `PROCESSING` and `SUCCESS`. After deployment, unsubmitted
`PENDING` rows wait for approval and are excluded from reconciliation; unknown
channel results stay `PROCESSING`, and submitted refunds cannot be locally closed.

Deploy migrations and the matching application version with refund writes
quiesced. Generate the Prisma client as part of the normal build. Do not run the
old refund implementation after new entitlement schedules have been written:
it can invalidate the order-level allocation. Prefer a forward fix if needed.

Legacy subscriptions are backfilled only when complete, contiguous original
order windows prove ownership. Missing/overlapping/restored/merged histories,
require manual reconciliation
(`REFUND_ENTITLEMENT_REVIEW_REQUIRED`) before channel submission. Financial
`Order.serviceStartsAt/serviceEndsAt` snapshots are never rewritten.
Tracked and untracked same-plan carriers remain separate: the paused carrier
waits until the other ends, then resumes independently. Known allocations and
already-submitted refunds retain their tracking status throughout.

Unsolicited virtual/Apple refunds retain the existing operational policy: book
the external refund and ask operations to review service rights. A waiting local
approval is closed as superseded; it is not implicitly approved. Already
submitted local refunds use the common settlement and service-reclaim path.

Real channel acceptance still needs: response loss, original-key replay,
asynchronous callbacks, definitive rejection/retry, and virtual/Apple refund
notifications. The local tests do not claim these external checks have run.

# Monitor Insights

`GET /api/projects/:projectId/monitors/:monitorId/insights`

Requires JWT and membership of the project's organization (VIEWER or higher).
The monitor must belong to this project. Soft-deleted monitors, projects and
organizations return 404, including for SUPER_ADMIN.

## Query

| Parameter | Values                   | Default         |
| --------- | ------------------------ | --------------- |
| range     | `1h`, `24h`, `7d`, `30d` | `24h`           |
| tz        | Valid IANA time zone     | `Asia/Shanghai` |

The normal `{ data, meta: { timestamp } }` response envelope applies. Swagger
publishes the complete response schema as `MonitorInsightsEntity`.

## Response

- `monitorId`, `range`, `tz`, `asOf`, `from`, `to`: snapshot identity and window.
- `latest`: normalized status, consecutive failures, latest check time/latency/error,
  count of all ongoing events.
- `metrics`: full-window total/failed/rescued checks, effective-success uptime,
  mean and exact P50/P95/P99 local duration in milliseconds.
- `timeline`: UTC-aligned bounded buckets, timestamps formatted in `tz`.
  Steps are 2 minutes / 1 hour / 6 hours / 1 day respectively; at most 32 points.
- `checks`: newest 50 LOCAL checks within the selected reliable window, ordered
  by checkedAt then id descending; `checksLimit: 50`.
- `events`: newest 20 events, ongoing first, then updatedAt and id descending;
  ongoing events may predate the window, resolved events must have been updated
  within the reliable selected window. Includes origin, suppression, duration,
  observed message, and actual first-notification evidence; `eventsLimit: 20`.
- `history`: independent check/event watermarks and AVAILABLE/EMPTY/TRUNCATED
  coverage statuses, with 90-day retention.
- `metricBasis`: LOCAL samples, EFFECTIVE_SUCCESS availability, LOCAL_DURATION
  latency. Probe-only observations never count as separate check samples.

SQL calculates metrics from every qualifying sample, not from the recent-check
list. Counts and percentages for an incomplete check window are null. Empty,
fully covered windows have zero counts but null uptime and duration statistics.
Time before monitor creation is known empty. Incomplete timeline buckets are
null and must not be connected or interpreted as healthy.

The read-only repeatable-read transaction uses the database clock for a
consistent snapshot. No schema changes, migrations or notification sends are
required by this endpoint.

## Verification

The isolated SQL/HTTP suite refuses any database name other than
`beacon_dashboard_test`:

```powershell
$env:MONITORING_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55439/beacon_dashboard_test'
pnpm test:e2e --runInBand --detectOpenHandles monitor-insights
```

# Monitor List And Detail

Date: 2026-10-10

Goal: Complete the existing monitor list and add a real, deep-linkable monitor detail page. Preserve all existing and concurrent changes; do not migrate developer databases or send real notifications.

## Work

1. Inspect frontend/backend conventions and current API: complete.
2. Add scoped single-monitor insights API, exact LOCAL metrics, timeline, events and tests: complete.
3. Improve list, reusable editor, route and detail page, including responsive and async states: complete.
4. Unit/SQL/HTTP/browser verification and read-only review: complete.
5. Documentation and final handoff: complete.

## Decisions

- Reuse existing monitor CRUD endpoints. Add GET projects/:projectId/monitors/:monitorId/insights.
- Range: 1h/24h/7d/30d, bounded UTC buckets, explicit timezone and independent check/event coverage.
- SQL performs full-window exact quantiles; recent records are not the KPI denominator.
- List uses the complete existing list endpoint with client-side search/filter/sort/pagination, without per-row API calls.
- Preserve advanced protocol configuration when editing. Do not silently convert existing monitors to HTTP/TCP.
- Detail identity includes projectId and monitorId; project changes leave the old detail, and late responses are discarded.
- No new database models or migrations required.

## Environment

- Backend: D:/zuxcloud/nest-beacon.
- Frontend: D:/zuxcloud/Beacon/beacon-vue3.
- Existing frontend dev server: 127.0.0.1:5179.
- Dedicated test database: beacon_dashboard_test at 127.0.0.1:55439.
- UI skill helper script and Nest skill rule files are absent; use the fully read main guides and actual repository patterns.

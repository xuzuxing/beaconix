# Findings

- Current list has CRUD, pause/resume and a small checks modal, but no search, filters, pagination or detail link. Failed requests leave stale content.
- Existing single-monitor state API offers only a 24h summary; project dashboard cannot serve monitor-specific metrics/events.
- MonitorType now includes HTTP/TCP/PING/DNS/MYSQL/POSTGRESQL/REDIS/MONGODB/DOCKER/GRPC/WEBSOCKET. Protocol work is concurrent; retain it.
- Existing frontend layout has a large minimum width; scope responsive overrides to monitor routes as with dashboard.
- Hidden routes still appear in secondary navigation when includeHidden=true; dynamic detail routes must explicitly opt out of menu generation.
- Previous overview fixtures provide a dedicated real SQL/HTTP app, but a separate suite keeps this request isolated from concurrent changes.
- Existing PostgreSQL triggers and monitoring_coverage provide reliable per-project history watermarks. Reuse without schema changes.
- Editor must omit unchanged SSL settings: the existing backend resets health/certificate state whenever those keys are present, even with unchanged values.
- Deep-link workspace resolution uses authorized monitor lookup and organization/project reads; failed/empty initialization is an explicit recoverable error, not an infinite spinner.
- Protocol selection is validated against supported types, not currently loaded rows, so deletion/empty projects cannot broaden the user's filter.
- Browser verification at 1440x1000 and 375x812 confirms nonblank charts, no page/content horizontal overflow, and all implemented flows. Compact axis labels retain full timezone offsets in tooltips.

# Application monitor driver acceptance

`pnpm test:monitor:applications` runs real mysql2, pg, ioredis and mongodb driver
checks against **disposable local services only**. It does not load `.env`, use
`DATABASE_URL`, migrate, seed or write user data. Destinations are fixed loopback
ports and test credentials defined in the test. It refuses to run without
`APPLICATION_MONITOR_INTEGRATION=disposable-local-services`.

The `application-protocols` job in `.github/workflows/monitor-validation.yml`
creates PostgreSQL 16, MySQL 8.4, MongoDB 8 and Redis 7 test containers.
Redis requires a fixture password and deliberately has only two databases to
exercise authentication and failed database selection.
Coverage includes healthy commands, wrong credentials, stalled sockets, deadlines
and cleanup. No production connection or privileged Docker socket is required.

Normal Jest coverage includes real loopback WebSocket/gRPC servers and a fake
read-only Docker API on a temporary Unix socket/Windows named pipe. Real MongoDB
worker tests use a test-only driver double to force stalled connect and close.
Those fixtures validate lifecycle behavior, not server compatibility; the
container job validates the actual MongoDB driver against MongoDB.

These jobs have been added, not executed on the developer's Windows host.
Live TLS deployment acceptance remains required.

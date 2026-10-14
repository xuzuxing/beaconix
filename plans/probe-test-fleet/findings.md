# Findings

- POST /auth/login accepts { email, password }, returns user/accessToken/refreshToken.
- MFA login can return a different response; fail explicitly instead of bypassing MFA.
- POST /auth/refresh rotates the refresh token.
- GET /admin/system-probes lists metadata only, never the original secret.
- POST /admin/system-probes returns { id, secret, ... } exactly once.
- Dedicated deterministic test names plus a persisted credential manifest allow reuse.
- Existing named probes without saved credentials must fail safely with guidance.
- The backend globally throttles by IP per route; test backend THROTTLE_LIMIT must be
  raised explicitly. Bootstrap honors Retry-After; it cannot reconfigure the backend.
- New probes become online at first heartbeat; final rebalance must follow real
  successful child heartbeats, not merely process spawn.
- Existing agent is dependency-free CommonJS, uses Node >=18, supports HTTP/TCP,
  logs a recognizable first successful heartbeat and handles SIGTERM.
- No additional backend endpoints or runtime packages are needed.
- On relocation, the running deployment's Compose project is nest-beacon and its
  credential volume is nest-beacon_probe_fleet_data. Explicitly preserve that
  project name; retain repository-root build context with the relocated Dockerfile.

## Review Findings and Resolution

- Confirmed actual heartbeat DTO accepts 5..3600 seconds; fleet config now matches.
- Confirmed pending rebalance could falsely announce readiness after a child exit
  or deadline. Supervisor now checks child generation and readiness again, retries
  for recovered generations, cancels pending requests and awaits their cleanup.
- Regression tests cover both stale-generation and late-completion races.
- A second review verified the backend can return stale assignments while locked.
  Readiness now requires an array entry for every selected probe ID, retrying incomplete
  tables under the readiness deadline. Natural exits invalidate readiness on exit
  rather than waiting for stdio close, and exitCode/signalCode are checked.
- Added regression coverage for stale tables and natural exit before close.
- Final targeted recheck confirmed all concrete findings resolved.
- Reviewer noted existing agent children do not implement parent Retry-After
  handling. Deliberately preserved the existing agent implementation: sufficient
  LOCAL throttle capacity is mandatory and documented. Changing child retries
  cannot make sustained 100-agent traffic fit 10 requests/minute. The tool never
  alters production backend limits, and startup fails if agents cannot become ready.

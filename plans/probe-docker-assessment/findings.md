# Findings

- Dockerfile.probe uses node:22-alpine and starts one agent in foreground run mode.
- The agent accepts one key/token pair through environment variables or a JSON config.
- System probe creation is available through admin/system-probes, guarded by SUPER_ADMIN.
- Creation returns a unique sys_-prefixed secret once; the database stores its hash.
- System assignment currently selects online, enabled probes and supports HTTP/TCP only.
- Each eligible monitor is assigned to one least-loaded system probe, not all probes.
- Working tree contains substantial existing changes, including scheduler changes.
- Existing root planning and plans/README.md must remain untouched.

## Verified Constraints

- src/config/throttler.config.ts:13-14 defaults to 10 requests per 60 seconds.
- src/app.module.ts registers the stock global ThrottlerGuard. The installed
  node_modules/@nestjs/throttler/dist/throttler.guard.js tracks normalized req.ip
  and keys each bucket by controller/handler/throttler/IP.
- Probe ingest routes do not skip throttling. Independent secrets do not bypass
  the shared same-IP bucket. Local testing needs an explicit rate-limit adjustment.
- probes.service.ts:436-469 marks first-heartbeat probes ONLINE and rebalances.
  Concurrent rebalances can reuse the already-published table; a final explicit
  rebalance after all agents become online makes test assignment deterministic.
- system-probe-scheduler.ts:127,155-160 assigns each eligible HTTP/TCP monitor
  to exactly one least-loaded system probe. Fewer than 100 eligible monitors
  can leave some of 100 probes with no tasks.
- probes.service.ts:1003 authenticates using the secret hash, not the key in
  the local config. Reusing one secret creates multiple clients for one identity.
- callbackUrl is required metadata in the create DTO; the foreground agent uses
  outbound heartbeat/results and does not create a callback listener.
- Agent tests passed: 12/12. Docker daemon unavailable, so container runtime,
  host networking and memory capacity were not empirically verified.

## Suggested Implementation Scope

- A SUPER_ADMIN-authenticated local provisioning utility, with stable test names,
  persistent credentials, restart reuse and cleanup of only its own test records.
- A container supervisor spawning actual foreground agent children with isolated
  per-child configuration, prefixed logs, bounded restart backoff, startup jitter,
  and SIGTERM forwarding.
- A separate test Compose configuration and read-only credential mount. Do not
  copy secrets into image layers or commit them.
- Local-only throttling configuration, at least 100 eligible test monitors if
  every agent must execute checks, and a final explicit rebalance.
- Assertions should cover 100 distinct ONLINE identities, per-agent results,
  unauthorized/disabled credentials, process restart and shared-container failure.

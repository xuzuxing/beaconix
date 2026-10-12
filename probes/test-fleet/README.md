# Local system probe test fleet

One container runs 100 real Beacon agent processes by default. On startup the
bootstrap logs in, lists system probes, reuses this fleet's saved credentials,
creates only missing fleet probes, and starts the agents. No database access or
new backend endpoint is required.

## Prerequisites

- A running Beacon test backend with PostgreSQL and Redis.
- An email/password account with the `SUPER_ADMIN` global role. Password-only
  login does not support MFA accounts; do not disable MFA on a production account.
- Docker Engine / Docker Desktop running, with enough memory for 100 Node processes.
- **Raise `THROTTLE_LIMIT` on the local test backend**, for example to `1000`
  with the default 60-second agent interval, and restart the backend. This is
  a starting point, not a capacity guarantee. A shared IP otherwise gets only
  10 requests per endpoint per minute; staggering cannot solve sustained overload.
  Do not loosen production limits for this test.

Run the backend separately. The test Compose file does not launch or reconfigure it.
Its default API address is `http://host.docker.internal:3000/api`, for a backend
running on the host. HTTP requires explicit `PROBE_ALLOW_INSECURE=true`;
the local-only Compose file sets this default. Use HTTPS for remote APIs.
Monitoring targets must also be reachable from inside the container:
`localhost` in a monitor target means the probe container, not the host.

## Start from PowerShell

Run from the repository root:

```powershell
$credential = Get-Credential -Message 'Beacon test SUPER_ADMIN (email as username)'
$env:BEACON_ADMIN_EMAIL = $credential.UserName
$env:BEACON_ADMIN_PASSWORD = $credential.GetNetworkCredential().Password
$env:BEACON_API_URL = 'http://host.docker.internal:3000/api'
$env:PROBE_FLEET_COUNT = '100'

docker compose -f probes/docker-compose.probe-test.yml up --build -d
docker compose -f probes/docker-compose.probe-test.yml logs -f probe-fleet
```

Wait for `Fleet ready: 100 distinct agents completed heartbeats; assignments
rebalanced`. A running container alone does **not** mean all agents are online.
Bootstrap honors `Retry-After` and may take minutes when creating 100 probes on a
backend with low limits. Startup failure exits nonzero; this Compose configuration
does not automatically restart and repeatedly attempt login.

Subsequent `up`/`restart` uses the same volume and credentials. If one of this
fleet's records was deleted from the backend, the script replaces only that
missing record. If it was disabled or its secret was revoked, startup fails
without enabling, rotating or deleting it.

```powershell
# Stop all children gracefully; keep the state volume and backend probe records.
docker compose -f probes/docker-compose.probe-test.yml down

# Prepare credentials only. Do this while the fleet container is stopped.
docker compose -f probes/docker-compose.probe-test.yml run --rm probe-fleet provision
```

Keep the environment variables set for Compose management commands, or use a private
ignored `.env.local` file via `--env-file .env.local`. Never commit that file.
Passwords supplied as environment variables are visible to users with Docker
administration access. The password and JWTs are not written to the credential
manifest and are not passed to agent children; this tool is for trusted local
test environments, not production credential management.

## Credential reuse and ownership

Probe secrets are returned **only once at creation**. The list API cannot recover
them because the backend stores hashes. `probe_fleet_data` therefore persists
`/data/credentials.json`, written atomically with mode `0600`. Preserve this
volume; do not use `down -v` while expecting to reuse its probes.

The test Dockerfile and Compose file live directly under `probes/`. Build context
remains the repository root, and the Compose project name remains `nest-beacon`,
so moving these files does not change the existing `nest-beacon_probe_fleet_data`
volume. From inside `probes/`, use `-f docker-compose.probe-test.yml` instead.

The script manages only deterministic names under `PROBE_FLEET_PREFIX`:
`docker-system-test-0001` through `docker-system-test-0100` by default.
Unrelated probes do not count toward the requested fleet size and are untouched.
An existing matching name without a saved credential causes a clear error,
even if the backend already has 100 system probes.

If the volume is lost, restore a backup or use both a **new prefix and a new
volume** (for example, a different Compose project via `-p another-fleet`).
Do not simply change the prefix while reusing the old volume. State is bound to
the API URL, login email and prefix. Duplicate matching names are also rejected.
Reducing the count starts fewer processes without deleting the additional records.

One state directory may only have one running fleet. Clean shutdown releases its
lock. After a forced kill or host crash, verify that no fleet using this volume
is running before manually removing `/data/fleet.lock`; a stale lock is never
automatically stolen.

Network failure after a create can leave a server-side probe whose secret was
never received. Creates are not blindly retried. Resolve the matching test record
manually or use a new prefix/volume; never delete unrelated probes to work around it.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `BEACON_API_URL` | `http://host.docker.internal:3000/api` | API root including `/api` |
| `BEACON_ADMIN_EMAIL` | required | Test SUPER_ADMIN login email |
| `BEACON_ADMIN_PASSWORD` | required | Login password; prefer environment over CLI |
| `PROBE_FLEET_COUNT` | `100` | Number of distinct agents, `1..1000` |
| `PROBE_FLEET_PREFIX` | `docker-system-test` | Dedicated test namespace |
| `PROBE_FLEET_STATE_DIR` | `.beacon/test-fleet` (`/data` in Docker) | Persistent secret directory |
| `PROBE_ALLOW_INSECURE` | `false` (`true` in test Compose) | Permit local plain HTTP |
| `PROBE_INTERVAL_SECONDS` | `60` | Per-agent heartbeat interval, `5..3600` |
| `PROBE_TIMEOUT_MS` | `5000` | Agent API/check timeout |
| `PROBE_CONCURRENCY` | `3` | Checks in parallel per agent, `1..20` |
| `PROBE_FLEET_STARTUP_DELAY_MS` | `250` | Delay between child launches |
| `PROBE_FLEET_READY_TIMEOUT_SECONDS` | `180` | Heartbeat readiness timeout after launching |
| `PROBE_FLEET_API_TIMEOUT_MS` | `30000` | Bootstrap request/body timeout |
| `PROBE_FLEET_RATE_RETRIES` | `12` | Maximum 429 retries per API call |
| `PROBE_FLEET_SHUTDOWN_TIMEOUT_SECONDS` | `15` | Grace before killing child processes |

The last three advanced options can be passed with `docker run -e`, or added to
the Compose environment. Compose waits 30 seconds on stop by default; keep it
longer than the supervisor shutdown timeout if changing that option.

To run without Docker (Node.js 22 or later):

```powershell
$env:BEACON_API_URL = 'http://localhost:3000/api'
$env:PROBE_ALLOW_INSECURE = 'true'
node probes/test-fleet/index.js run --count 5
```

The CLI also accepts `--email`, `--password`, `--api-url`, `--prefix`,
`--state-dir`, `--allow-insecure`, and `provision`; use `--help` for details.
Local state under `.beacon/` is excluded from Git and Docker build context.

## What this tests

All agents run the existing `probes/agent` implementation with isolated
credentials, schedules and result buffers. Logs are prefixed by fleet probe name.
Unexpected exits are restarted with bounded backoff. SIGTERM/SIGINT stops the
whole fleet and forwards termination to children.

Current system assignment distributes each eligible HTTP/TCP monitor to **one**
least-loaded system probe. At least 100 eligible monitors are needed for all 100
agents to receive a task; existing online tenant bindings also affect eligibility.
This script does not create or alter monitors. All agents share a network exit
and failure domain, so this is not a multi-region availability test.

## Tests

```powershell
node --test probes/test-fleet/test/*.test.js probes/agent/test/*.test.js
pnpm type-check
```

The optional full process test starts 100 real agents against an isolated local
mock API and checks distinct heartbeats, HTTP observations and result reports:

```powershell
$env:BEACON_TEST_FLEET_FULL = '1'
node --test probes/test-fleet/test/*.test.js probes/agent/test/*.test.js
```

Tests use synthetic accounts/secrets and an isolated mock API. They cover 100
unique credential creation, reuse, missing-record replacement, partial failure,
unknown/disabled/revoked credentials, role/MFA rejection, retry/refresh, locks,
child credential isolation, and real agent-process readiness/shutdown.

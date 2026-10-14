# Local System Probe Test Fleet

Date: 2026-10-12

## Requirements

- On container startup, log in with the supplied account email and password.
- Require SUPER_ADMIN and use only the existing public/admin HTTP APIs.
- Provision up to the requested count (default 100) of dedicated test probes.
- Persist the once-only returned secrets and reuse them on subsequent starts.
- Never adopt, reset, delete or enable unrelated system probes.
- Start independent existing agent processes with separate credentials.
- Handle rate limiting, startup staggering, restart backoff and shutdown.
- Keep passwords/JWTs out of the state file, child processes and logs.
- Provide Docker/Compose configuration, documentation and focused mock-API tests.

## Phases

1. Inspect API contracts and existing agent conventions. complete
2. Implement bootstrap, state, supervision and container files. complete
3. Test provisioning/reuse/errors and actual child lifecycle. complete
4. Independent review and verification. complete
5. Move test Docker/Compose files under probes and verify context/volume compatibility. complete

## Boundaries

- No changes to Prisma schema, backend API/auth or production throttling.
- Preserve all pre-existing modifications.
- No real administrator credentials have been supplied: do not mutate a live API.
- Docker daemon was unavailable in the preceding assessment.

## Verification

- Full final test run with BEACON_TEST_FLEET_FULL=1: 30 tests passed, 0 skipped.
- 100 actual agent children each completed heartbeat, HTTP check and result report
  with distinct synthetic credentials against an isolated mock API.
- pnpm type-check and pnpm build passed.
- Scoped ESLint no-unused-vars/no-undef/no-unreachable and Prettier check passed.
- docker compose config --quiet passed with synthetic validation-only credentials.
- Docker Desktop Linux engine pipe remains absent; image build/run not verified.
- Final targeted independent review found no remaining reported issues.
- Relocation verified with Docker now available: Compose configuration resolves
  the same root build context, nest-beacon project and credential volume.
- Relocated image build, container --help smoke test and type-check passed.
- No fleet startup, backend requests or credential-volume mutations during relocation.

## Errors and Corrections

- Initial test cleanup released a lock after its temporary directory was removed;
  removed the unnecessary lock from that provisioning test (lock has dedicated tests).
- Initial Compose validation required credentials; repeated using synthetic
  values confined to that validation process.
- Scoped CLI lint initially omitted the built-in URL global; corrected invocation.
- CodeRabbit CLI is not installed; used an independent read-only reviewer subagent.

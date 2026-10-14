# UAT Monitor Demo Export

## Goal
Deliver a verified, credential-free SQL package equivalent to the Test Team browser fixture.

## Phases
- Discovery: complete. Browser fixture is synthetic; dedicated test PG is empty.
- SQL and instructions: complete.
- Isolated PostgreSQL verification and failure safeguards: complete (including post-review evidence alignment).
- Single plain SQL delivery: complete (user requested no archive or psql parameters).

## Decisions
- Create a separate marked organization owned by an explicitly selected existing UAT account.
- Require confirmation that monitoring workers and probes are stopped.
- Generate relative UTC timestamps at import time; do not alter existing records.
- Preserve current schema and triggers; create no accounts, credentials, or channels.
- Derive connectivity, certificate-policy and rolling-availability incidents from independent evidence;
  compare an unrelated populated tenant before and after all import outcomes.

## Errors
- Initial import consistency check caught failure-streak counting including the preceding success;
  changed the window aggregate to count only failed observations. Transaction rolled back.
- New reviewer spawn reached the agent limit; reused an existing reviewer.

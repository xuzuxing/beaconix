# Findings

- Test Team originates from the frontend Playwright interception fixture, not retained PG rows.
- Dedicated test database has zero organizations, monitors, check logs, and alert events.
- Current monitoring schema includes snapshot IDs, history revisions, coverage, and incident lifecycle.
- Triggers generate initial history. Replace only history belonging to newly inserted demo monitors
  within the same transaction, then synchronize live revisions with chronological demo snapshots.
- DEGRADED means a failure streak below failureThreshold, not probe rescue.
- Use complete one-minute samples over 30 days for observed monitors; UNKNOWN has no samples,
  PAUSED samples end at the pause timestamp.
- Native PostgreSQL tools are available inside the dedicated Docker container.

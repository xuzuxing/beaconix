# Findings

## Confirmed Repository Facts

- Current evaluateResult filters ProbeResult by monitorId and configRevision.
- Eligibility is restricted to legacy HTTP/TCP configuration; blocked executions and assertion failures cannot be rescued.
- Aggregated success preserves CheckResult fields and sets serviceVerdict to SUCCESS.
- SSL verdicts and service connectivity verdicts are independent.
- StateService records under a monitor row lock and checks configuration/revision.
- AlertEventsService owns current alert decisions, not evaluateAvailabilityAlert.
- Probe results use a rolling 2-15 minute freshness window, not a shared round ID.
- Probe callback application has a separate 5-30 second deduplication window.

## Leads To Vet

- Proposed per-probe queries omit monitorId/configRevision and current system-probe eligibility filters.
- Proposed successful CheckResult drops serviceVerdict, statusCode, SSL verdict, and other metadata.
- Proposed latest-only behavior differs from current any-success-in-window behavior.
- Threshold field needs DTO validation, response projection, and update revision semantics.
- Callback deduplication can freeze a partial-set ratio until the next reevaluation.
- A threshold of 1 percent only means any success when the denominator is at most 100.

## Vetted Findings

- All aggregation leads were confirmed against the live code; report.md records evidence and examples.
- Production whitelist strips unknown DTO fields; forbidNonWhitelisted is false, despite older repository guidance.
- Monitor response spread can already include a persisted new field; the missing work is typed/Swagger contract, not necessarily a manual response projection.
- Ratio edits must join application definitionChanged and the database beacon_monitor_config trigger function.
- The pending-result handler marks skipped callback rows applied, so no guaranteed delayed retry after callback deduplication.
- Existing focused tests pass; they establish the baseline, not new-feature correctness.

## Revision Decisions

- Plan 003 uses a pure 1-100 percentage; latest-per-probe sampling changes are explicitly intentional.
- Keep legacy callback deduplication, appliedAt, state folding, and alert algorithms unchanged.
- No shared rounds, minimum coverage field, agent protocol change, or per-probe query fan-out.
- Add a database CHECK and include the ratio in both application revision and database configRevision tracking.
- The PostgreSQL harness needs a separate third migration stage so the ratio migration is absent from the prior-system snapshot.
- Stable ordering uses checkedAt, receivedAt, and id; payload selection uses a typed partial Prisma model.
- Revised-plan baseline is e2895cc; relevant committed code did not change since the initial assessment.
- Cold review confirmed the plan is executable; query budgets apply only to Checker's direct result reads, not scheduler cache-miss rebalance work.

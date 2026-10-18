-- Per-monitor probe assignment quota.
--
-- `maxProbes` limits how many tenant probes an organization may register;
-- `maxProbesPerMonitor` limits how many of them a single monitor may bind.
-- The effective limit is min(maxProbes, maxProbesPerMonitor), so the new column
-- never widens an organization beyond its probe allowance.
ALTER TABLE "plans"
  ADD COLUMN "maxProbesPerMonitor" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_maxProbesPerMonitor_check"
  CHECK ("maxProbesPerMonitor" >= 0);

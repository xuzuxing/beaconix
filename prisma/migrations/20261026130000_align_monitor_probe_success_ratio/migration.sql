-- Align the probe success ratio with its documented scale: 1-100 percent, where
-- 100 means every voting probe must succeed. Rows still on the old default
-- (1 = 1%) move to the new default so upgrading does not silently keep the
-- loosest possible verdict.
ALTER TABLE "monitors" ALTER COLUMN "probeSuccessRatio" SET DEFAULT 100;

UPDATE "monitors" SET "probeSuccessRatio" = 100 WHERE "probeSuccessRatio" = 1;

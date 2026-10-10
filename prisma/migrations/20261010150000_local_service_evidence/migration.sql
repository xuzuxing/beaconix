ALTER TABLE check_logs ADD COLUMN "localServiceVerdict" TEXT;
-- Only an unrescued verdict proves the original local service evidence.
UPDATE check_logs SET "localServiceVerdict" = "serviceVerdict"
WHERE NOT "rescuedByProbe" AND "serviceVerdict" IS NOT NULL;

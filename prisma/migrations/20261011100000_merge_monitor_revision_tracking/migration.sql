-- Protocol config and credential edits invalidate probe observations too.
CREATE OR REPLACE FUNCTION beacon_monitor_config() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (OLD.type,OLD.target,OLD.interval,OLD.timeout,OLD."expectedStatus",OLD.enabled,
        OLD."checkSsl",OLD."sslExpiryThreshold",OLD."failureThreshold",OLD."availabilityEnabled",
        OLD."availabilityThreshold",OLD."availabilityWindow",OLD."deletedAt",
        OLD.config,OLD."configVersion",OLD."credentialsEnc")
        IS DISTINCT FROM
       (NEW.type,NEW.target,NEW.interval,NEW.timeout,NEW."expectedStatus",NEW.enabled,
        NEW."checkSsl",NEW."sslExpiryThreshold",NEW."failureThreshold",NEW."availabilityEnabled",
        NEW."availabilityThreshold",NEW."availabilityWindow",NEW."deletedAt",
        NEW.config,NEW."configVersion",NEW."credentialsEnc")
    THEN NEW."configRevision" := OLD."configRevision" + 1; END IF;
    RETURN NEW;
END $$;

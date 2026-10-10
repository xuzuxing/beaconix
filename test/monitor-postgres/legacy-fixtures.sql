INSERT INTO "users" ("id", "email", "password", "name", "updatedAt")
VALUES ('fixture-user', 'monitor-validation@example.invalid', 'not-a-credential', 'Fixture', CURRENT_TIMESTAMP);
INSERT INTO "organizations" ("id", "name", "slug", "ownerId", "updatedAt")
VALUES ('fixture-org', 'Fixture', 'monitor-validation', 'fixture-user', CURRENT_TIMESTAMP);
INSERT INTO "projects" ("id", "name", "key", "organizationId", "updatedAt")
VALUES ('fixture-project', 'Fixture', 'TEST', 'fixture-org', CURRENT_TIMESTAMP);

INSERT INTO "plans" ("id", "code", "name", "price", "maxMonitors", "minInterval", "enabled", "updatedAt")
VALUES
    ('fixture-free', 'FREE', 'Existing free', 0, 7, 300, true, CURRENT_TIMESTAMP),
    ('fixture-pro', 'PRO', 'Existing pro', 1234, 42, 60, true, CURRENT_TIMESTAMP),
    ('fixture-team', 'TEAM', 'Existing team', 5678, 99, 30, false, CURRENT_TIMESTAMP),
    ('fixture-custom', 'CUSTOM', 'Existing custom', 9876, 23, 120, true, CURRENT_TIMESTAMP);
INSERT INTO "subscriptions" ("id", "organizationId", "planId", "startsAt", "expiresAt", "updatedAt")
VALUES ('fixture-subscription', 'fixture-org', 'fixture-pro', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP);

INSERT INTO "monitors" ("id", "organizationId", "projectId", "name", "type", "target", "updatedAt")
VALUES ('fixture-http', 'fixture-org', 'fixture-project', 'HTTP history', 'HTTP', 'https://example.invalid', CURRENT_TIMESTAMP);
INSERT INTO "monitors" ("id", "organizationId", "projectId", "name", "type", "target", "enabled", "deletedAt", "updatedAt")
VALUES ('fixture-tcp', 'fixture-org', 'fixture-project', 'TCP archived', 'TCP', 'example.invalid:443', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "monitor_states" ("monitorId", "status", "failCount", "lastCheckAt", "lastLocalCheckAt", "lastError", "lastLatency", "availabilityAlertActive", "updatedAt")
VALUES
    ('fixture-http', 'DOWN', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'Existing outage', 5000, true, CURRENT_TIMESTAMP),
    ('fixture-tcp', 'PAUSED', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, 15, false, CURRENT_TIMESTAMP);
INSERT INTO "check_logs" ("id", "monitorId", "success", "localSuccess", "latency", "error", "source", "statusCode")
VALUES
    ('fixture-log-http', 'fixture-http', false, false, 5000, 'Existing outage', 'LOCAL', 503),
    ('fixture-log-tcp', 'fixture-tcp', true, true, 15, NULL, 'LOCAL', NULL);

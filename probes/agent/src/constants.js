'use strict';

/** Protocol constants. Values are unchanged from the original agent. */

const PROBE_SECRET_HEADER = 'x-probe-secret';
const USER_AGENT = 'Beacon-Probe/2.0';

const DEFAULT_API_URL = 'http://localhost:3000/api';
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESULTS = 100;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const VALIDATION_INFO = 'beacon-probe-validation-v1';

/** How many monitors one round checks in parallel (default). */
const DEFAULT_CONCURRENCY = 3;

/** Upper bound for PROBE_CONCURRENCY. */
const MAX_CONCURRENCY = 20;

/**
 * Buffered results while the backend is unreachable. Reaching this bound pauses
 * checks (backpressure) instead of growing the buffer without limit.
 */
const MAX_PENDING_RESULTS = 500;

/**
 * Lower bound applied to `monitor.interval`. The backend already enforces the
 * plan's minimum interval; this only guards against a bad payload.
 */
const MIN_CHECK_INTERVAL_SECONDS = 10;

module.exports = {
    PROBE_SECRET_HEADER,
    USER_AGENT,
    DEFAULT_API_URL,
    DEFAULT_INTERVAL_SECONDS,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_RESULTS,
    MAX_ERROR_MESSAGE_LENGTH,
    VALIDATION_INFO,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
    MAX_PENDING_RESULTS,
    MIN_CHECK_INTERVAL_SECONDS,
};

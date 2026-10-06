#!/usr/bin/env node
'use strict';

/**
 * Beacon probe agent.
 *
 * A dependency-free Node.js agent that interacts with the existing Beacon
 * probes API:
 *
 *   POST /api/probes/heartbeat   (x-probe-secret) -> fetch assigned monitors
 *   POST /api/probes/results     (x-probe-secret) -> report check results
 *
 * The backend response is wrapped by TransformInterceptor as
 * `{ data: ..., meta: { timestamp } }`; this script unwraps `data`.
 *
 * Usage:
 *   node scripts/probe-agent.js validate [options]
 *   node scripts/probe-agent.js run [--once] [options]
 *   node scripts/probe-agent.js heartbeat [options]
 *
 * Configuration priority: CLI > environment > JSON config file.
 */

const {
    createCipheriv,
    createDecipheriv,
    hkdfSync,
    randomBytes,
} = require('node:crypto');
const { Socket } = require('node:net');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');

const PROBE_SECRET_HEADER = 'x-probe-secret';
const USER_AGENT = 'Beacon-Probe/1.0';

const DEFAULT_API_URL = 'http://localhost:3000/api';
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESULTS = 100;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const VALIDATION_INFO = 'beacon-probe-validation-v1';

/** How many monitors one round checks in parallel. */
const DEFAULT_CONCURRENCY = 3;

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

const HELP = `Beacon probe agent

Usage:
  node scripts/probe-agent.js <command> [options]

Commands:
  run          Run the probe continuously (default command); also answers
               pending validation challenges before each heartbeat
  run --once   Run one heartbeat/check/report cycle and exit
  validate     Run a one-shot deployment validation (connectivity + encryption);
               also answers a pending validation challenge if one exists
  heartbeat    Send a single heartbeat and print the response

Options:
  --config <path>            JSON config file
  --api-url <url>            Beacon API base URL (default: ${DEFAULT_API_URL})
  --key <probeId>            Probe id returned by the backend (the "key")
  --token <secret>           Probe secret returned by the backend (the "token")
  --secret <secret>          Alias for --token
  --interval-seconds <n>     Heartbeat interval for run mode (default: ${DEFAULT_INTERVAL_SECONDS});
                             monitors are checked on their own interval instead, ${DEFAULT_CONCURRENCY} at a time
  --timeout-ms <n>           Per-request/check timeout (default: ${DEFAULT_TIMEOUT_MS})
  --allow-insecure           Allow http:// API URL (not recommended in production)
  -h, --help                 Show this help

Environment variables:
  BEACON_API_URL, PROBE_KEY, PROBE_TOKEN (or PROBE_SECRET),
  PROBE_CONFIG, PROBE_INTERVAL_SECONDS, PROBE_TIMEOUT_MS,
  PROBE_MAX_RESULTS, PROBE_ALLOW_INSECURE

Config file (JSON):
  {
    "apiUrl": "https://api.example.com/api",
    "key": "probe_xxx",
    "token": "tnt_xxx",
    "intervalSeconds": 60,
    "timeoutMs": 5000,
    "maxResultsPerReport": 100,
    "allowInsecure": false
  }
`;

// -- Logging -------------------------------------------------------------

function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}

function warn(...args) {
    console.warn(`[${new Date().toISOString()}]`, ...args);
}

function error(...args) {
    console.error(`[${new Date().toISOString()}]`, ...args);
}

// -- CLI/config ----------------------------------------------------------

function parseArgs(argv) {
    const args = {
        command: 'run',
        once: false,
        help: false,
        config: undefined,
        apiUrl: undefined,
        key: undefined,
        token: undefined,
        intervalSeconds: undefined,
        timeoutMs: undefined,
        allowInsecure: undefined,
    };
    const positionals = [];

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else if (arg === '--once') {
            args.once = true;
        } else if (arg === '--config') {
            args.config = requireValue(argv, ++i, arg);
        } else if (arg === '--api-url') {
            args.apiUrl = requireValue(argv, ++i, arg);
        } else if (arg === '--key') {
            args.key = requireValue(argv, ++i, arg);
        } else if (arg === '--token' || arg === '--secret') {
            args.token = requireValue(argv, ++i, arg);
        } else if (arg === '--interval-seconds') {
            args.intervalSeconds = Number(requireValue(argv, ++i, arg));
        } else if (arg === '--timeout-ms') {
            args.timeoutMs = Number(requireValue(argv, ++i, arg));
        } else if (arg === '--allow-insecure') {
            args.allowInsecure = true;
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            positionals.push(arg);
        }
    }

    if (positionals.length > 1) {
        throw new Error(`Unexpected arguments: ${positionals.slice(1).join(' ')}`);
    }

    if (positionals[0]) {
        if (!['run', 'validate', 'heartbeat'].includes(positionals[0])) {
            throw new Error(`Unknown command: ${positionals[0]}`);
        }
        args.command = positionals[0];
    }

    return args;
}

function requireValue(argv, index, option) {
    if (index >= argv.length) {
        throw new Error(`${option} requires a value`);
    }
    return argv[index];
}

function readConfigFile(configPath) {
    if (!configPath) return {};

    const resolved = path.resolve(configPath);
    let raw;
    try {
        raw = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
        throw new Error(`Cannot read config file ${resolved}: ${err.message}`);
    }

    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`Invalid JSON in config file ${resolved}: ${err.message}`);
    }
}

function toNumber(value, name) {
    if (value === undefined || value === null || value === '') return undefined;
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new Error(`${name} must be a finite number (got: ${value})`);
    }
    return number;
}

function toBoolean(value, name) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new Error(`${name} must be a boolean (got: ${value})`);
}

function loadConfig(args) {
    const env = process.env;
    const file = readConfigFile(args.config ?? env.PROBE_CONFIG);

    const config = {
        apiUrl:
            args.apiUrl ??
            env.BEACON_API_URL ??
            file.apiUrl ??
            DEFAULT_API_URL,
        key: args.key ?? env.PROBE_KEY ?? file.key ?? '',
        token:
            args.token ??
            env.PROBE_TOKEN ??
            env.PROBE_SECRET ??
            file.token ??
            '',
        intervalSeconds: toNumber(
            args.intervalSeconds ??
                env.PROBE_INTERVAL_SECONDS ??
                file.intervalSeconds ??
                DEFAULT_INTERVAL_SECONDS,
            'intervalSeconds',
        ),
        timeoutMs: toNumber(
            args.timeoutMs ??
                env.PROBE_TIMEOUT_MS ??
                file.timeoutMs ??
                DEFAULT_TIMEOUT_MS,
            'timeoutMs',
        ),
        maxResultsPerReport: toNumber(
            env.PROBE_MAX_RESULTS ??
                file.maxResultsPerReport ??
                DEFAULT_MAX_RESULTS,
            'maxResultsPerReport',
        ),
        allowInsecure: toBoolean(
            args.allowInsecure ??
                env.PROBE_ALLOW_INSECURE ??
                file.allowInsecure ??
                false,
            'allowInsecure',
        ),
    };

    config.apiUrl = config.apiUrl.replace(/\/+$/, '');

    if (!Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 1) {
        throw new Error('intervalSeconds must be a positive integer');
    }
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100) {
        throw new Error('timeoutMs must be an integer >= 100');
    }
    if (
        !Number.isInteger(config.maxResultsPerReport) ||
        config.maxResultsPerReport < 1 ||
        config.maxResultsPerReport > 100
    ) {
        throw new Error('maxResultsPerReport must be an integer between 1 and 100');
    }

    return config;
}

function trimTrailingSlash(value) {
    return value.replace(/\/+$/, '');
}

// -- HTTP helpers --------------------------------------------------------

function describeError(err) {
    if (err && err.cause && err.cause.code) {
        return `${err.cause.code}: ${err.cause.message || err.message}`;
    }
    return (err && err.message) || String(err);
}

function truncate(value, maxLength) {
    const text = String(value ?? '');
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

async function requestJson({ apiUrl, token, path: requestPath, method = 'POST', body, timeoutMs }) {
    const headers = {
        accept: 'application/json',
        [PROBE_SECRET_HEADER]: token,
    };

    if (body !== undefined) {
        headers['content-type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetch(`${apiUrl}${requestPath}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        throw new Error(
            `Request ${method} ${requestPath} failed: ${describeError(err)}`,
        );
    } finally {
        clearTimeout(timer);
    }

    const text = await response.text();
    let parsed = null;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = text;
        }
    }

    if (!response.ok) {
        throw new Error(
            `${method} ${requestPath} failed with HTTP ${response.status}: ${truncate(text, MAX_ERROR_MESSAGE_LENGTH)}`,
        );
    }

    if (parsed && typeof parsed === 'object' && 'data' in parsed) {
        return parsed.data;
    }

    return parsed;
}

async function heartbeat(config) {
    return requestJson({
        apiUrl: config.apiUrl,
        token: config.token,
        path: '/probes/heartbeat',
        method: 'POST',
        timeoutMs: config.timeoutMs,
    });
}

async function reportResults(config, results) {
    const chunkSize = config.maxResultsPerReport;
    for (let i = 0; i < results.length; i += chunkSize) {
        const chunk = results.slice(i, i + chunkSize);
        await requestJson({
            apiUrl: config.apiUrl,
            token: config.token,
            path: '/probes/results',
            method: 'POST',
            body: { results: chunk },
            timeoutMs: config.timeoutMs,
        });
    }
}

// -- Validation challenge (AES-256-GCM keyed by the probe token) ---------

function deriveValidationKey(token) {
    return Buffer.from(
        hkdfSync(
            'sha256',
            Buffer.from(token, 'utf8'),
            Buffer.alloc(0),
            Buffer.from(VALIDATION_INFO, 'utf8'),
            32,
        ),
    );
}

function encryptValidationJson(key, value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: data.toString('base64'),
    };
}

function decryptValidationJson(key, payload) {
    const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(payload.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.data, 'base64')),
        decipher.final(),
    ]);

    return JSON.parse(plaintext.toString('utf8'));
}

async function pullValidation(config) {
    return requestJson({
        apiUrl: config.apiUrl,
        token: config.token,
        path: '/probes/validation/pull',
        method: 'POST',
        timeoutMs: config.timeoutMs,
    });
}

async function answerValidation(config, validationId, answer) {
    return requestJson({
        apiUrl: config.apiUrl,
        token: config.token,
        path: `/probes/validation/${encodeURIComponent(validationId)}/answer`,
        method: 'POST',
        body: { answer },
        timeoutMs: config.timeoutMs,
    });
}

async function pollAndAnswerValidation(config) {
    let data;
    try {
        data = await pullValidation(config);
    } catch (err) {
        warn(`Validation pull failed: ${err.message}`);
        return null;
    }

    const validation = data && data.validation;
    if (!validation) return null;

    const key = deriveValidationKey(config.token);

    let challenge;
    try {
        challenge = decryptValidationJson(key, validation.challenge);
    } catch (err) {
        warn(`Validation challenge decrypt failed: ${err.message}`);
        return null;
    }

    const answer = encryptValidationJson(key, {
        nonce: challenge.nonce,
        answeredAt: new Date().toISOString(),
    });

    try {
        const result = await answerValidation(
            config,
            validation.validationId,
            answer,
        );
        log(
            `Validation challenge answered: ${
                result && result.ok ? 'OK' : 'FAILED'
            }`,
        );
        return result;
    } catch (err) {
        warn(`Validation answer failed: ${err.message}`);
        return null;
    }
}

// -- Monitor checks ------------------------------------------------------

function failure(target, latency, message) {
    return {
        target,
        success: false,
        latency: Math.max(0, Math.round(latency)),
        error: truncate(message, MAX_ERROR_MESSAGE_LENGTH),
        checkedAt: new Date().toISOString(),
    };
}

async function checkHttp(monitor, config) {
    const target = monitor.target;
    const expectedStatus = monitor.expectedStatus;
    const timeout = monitor.timeout ?? config.timeoutMs;
    const startedAt = Date.now();

    let url;
    try {
        url = new URL(target);
    } catch {
        return failure(target, 0, `Invalid URL "${target}"`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return failure(
            target,
            0,
            `Unsupported protocol "${url.protocol}" (expected http or https)`,
        );
    }

    try {
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(timeout),
            headers: {
                'user-agent': USER_AGENT,
                accept: '*/*',
            },
        });

        const latency = Date.now() - startedAt;

        // Drain the body so the connection can be reused or closed cleanly.
        await response.arrayBuffer().catch(() => undefined);

        if (response.status !== expectedStatus) {
            return failure(
                target,
                latency,
                `Unexpected status ${response.status} (expected ${expectedStatus})`,
            );
        }

        return {
            target,
            success: true,
            latency: Math.max(0, Math.round(latency)),
            error: null,
            checkedAt: new Date().toISOString(),
        };
    } catch (err) {
        return failure(target, Date.now() - startedAt, describeError(err));
    }
}

function parseTcpTarget(target) {
    const match =
        /^(?:\[(?<v6>[0-9a-fA-F:]+)\]|(?<host>[^:\s]+)):(?<port>\d{1,5})$/.exec(
            String(target ?? '').trim(),
        );

    const groups = match && match.groups;
    if (!groups) return null;

    const port = Number(groups.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

    const host = groups.v6 ?? groups.host;
    if (!host) return null;

    return { host, port };
}

function checkTcp(monitor, config) {
    const target = monitor.target;
    const timeout = monitor.timeout ?? config.timeoutMs;
    const parsed = parseTcpTarget(target);

    if (!parsed) {
        return Promise.resolve(
            failure(target, 0, `Invalid host:port target "${target}"`),
        );
    }

    const startedAt = Date.now();

    return new Promise((resolve) => {
        const socket = new Socket();
        let settled = false;

        const finish = (success, message) => {
            if (settled) return;
            settled = true;
            socket.destroy();

            if (success) {
                resolve({
                    target,
                    success: true,
                    latency: Math.max(0, Math.round(Date.now() - startedAt)),
                    error: null,
                    checkedAt: new Date().toISOString(),
                });
                return;
            }

            resolve(failure(target, Date.now() - startedAt, message));
        };

        socket.setTimeout(timeout);
        socket.once('connect', () => finish(true, null));
        socket.once('timeout', () =>
            finish(false, `Connection timed out after ${timeout}ms`),
        );
        socket.once('error', (err) => finish(false, err.message));

        socket.connect(parsed.port, parsed.host);
    });
}

function checkMonitor(monitor, config) {
    const type = String(monitor.type ?? '').toUpperCase();
    const target = monitor.target ?? 'unknown-target';

    if (type === 'HTTP') return checkHttp(monitor, config);
    if (type === 'TCP') return checkTcp(monitor, config);

    return Promise.resolve(
        failure(target, 0, `Unsupported monitor type "${type}"`),
    );
}

// -- Local check schedule ------------------------------------------------

/**
 * Monotonic clock: the schedule must not jump when the system clock is
 * adjusted (NTP steps, DST, manual changes).
 */
function nowMs() {
    return performance.now();
}

function monitorSignature(monitor) {
    return [
        monitor.type,
        monitor.target,
        monitor.interval,
        monitor.timeout,
        monitor.expectedStatus,
    ].join('|');
}

function monitorIntervalMs(monitor) {
    const seconds = Number(monitor && monitor.interval);
    const safe =
        Number.isFinite(seconds) && seconds > 0
            ? seconds
            : DEFAULT_INTERVAL_SECONDS;

    return Math.max(MIN_CHECK_INTERVAL_SECONDS, safe) * 1000;
}

/**
 * Local check schedule driven by the monitors the backend hands back.
 *
 * The heartbeat response is the authoritative task list, but it is *not* a
 * "check everything now" command: each monitor is checked on its own
 * `interval`, at most `DEFAULT_CONCURRENCY` checks at a time. Without this the
 * agent re-checked every monitor on every heartbeat, i.e. a 300s monitor was
 * checked (and reported) five times more often than configured.
 *
 * Results are buffered and reported once per round; while the backend is
 * unreachable the buffer is kept (up to MAX_PENDING_RESULTS) so a short outage
 * does not lose data, and checks pause once it is full.
 */
function createSchedule() {
    /** @type {Map<string, {monitor: object, signature: string, nextDueAt: number, inFlight: boolean}>} */
    const tasks = new Map();
    /** @type {Array<object>} */
    let pending = [];

    function sync(monitors, at = nowMs()) {
        const seen = new Set();
        let added = 0;
        let rescheduled = 0;

        for (const monitor of monitors) {
            if (!monitor || typeof monitor.id !== 'string') continue;

            const signature = monitorSignature(monitor);
            const existing = tasks.get(monitor.id);
            seen.add(monitor.id);

            if (!existing) {
                // New assignment: check it right away to get a first result.
                tasks.set(monitor.id, {
                    monitor,
                    signature,
                    nextDueAt: at,
                    inFlight: false,
                });
                added += 1;
                continue;
            }

            existing.monitor = monitor;

            if (existing.signature !== signature) {
                // Target/interval/timeout changed - re-check immediately so the
                // new definition takes effect instead of waiting out the old one.
                existing.signature = signature;
                existing.nextDueAt = at;
                rescheduled += 1;
            }
        }

        let removed = 0;
        for (const id of [...tasks.keys()]) {
            if (!seen.has(id)) {
                tasks.delete(id);
                removed += 1;
            }
        }

        return { tracked: tasks.size, added, rescheduled, removed };
    }

    function dueTasks(at) {
        const due = [];
        for (const task of tasks.values()) {
            if (!task.inFlight && task.nextDueAt <= at) due.push(task);
        }
        return due;
    }

    async function runDue(config) {
        const due = dueTasks(nowMs());
        if (due.length === 0) return { due: 0, executed: 0, deferred: 0 };

        if (pending.length >= MAX_PENDING_RESULTS) {
            warn(
                `Result buffer is full (${pending.length}/${MAX_PENDING_RESULTS}); ` +
                    `pausing checks until it can be reported`,
            );
            return { due: due.length, executed: 0, deferred: due.length };
        }

        let executed = 0;
        let active = 0;
        let cursor = 0;
        const workerCount = Math.min(DEFAULT_CONCURRENCY, due.length);

        const workers = Array.from({ length: workerCount }, async () => {
            while (
                cursor < due.length &&
                pending.length + active < MAX_PENDING_RESULTS
            ) {
                const task = due[cursor];
                cursor += 1;

                if (task.inFlight) continue;
                task.inFlight = true;
                active += 1;

                try {
                    const result = await checkMonitor(task.monitor, config);
                    pending.push(result);
                    executed += 1;

                    const state = result.success ? 'UP' : 'DOWN';
                    const latency =
                        result.latency !== null ? ` (${result.latency}ms)` : '';
                    const detail = result.error ? ` - ${result.error}` : '';
                    log(
                        `  ${task.monitor.type} ${result.target}: ${state}${latency}${detail}`,
                    );
                } catch (err) {
                    // checkMonitor reports target failures as results; throwing
                    // here means a bug, so keep it out of the report.
                    warn(
                        `Check failed for monitor ${task.monitor.id}: ${err.message}`,
                    );
                } finally {
                    active -= 1;
                    task.inFlight = false;
                    task.nextDueAt = nowMs() + monitorIntervalMs(task.monitor);
                }
            }
        });

        await Promise.all(workers);

        return {
            due: due.length,
            executed,
            deferred: due.length - executed,
        };
    }

    async function flush(config) {
        if (pending.length === 0) return 0;

        const batch = pending;
        pending = [];

        try {
            await reportResults(config, batch);
            return batch.length;
        } catch (err) {
            // Keep the results for the next round rather than dropping them.
            pending = batch.concat(pending);
            throw err;
        }
    }

    return {
        sync,
        runDue,
        flush,
        buffered: () => pending.length,
        size: () => tasks.size,
    };
}

// -- Commands ------------------------------------------------------------

function assertCredentials(config) {
    const missing = [];
    if (!config.key) missing.push('PROBE_KEY');
    if (!config.token) missing.push('PROBE_TOKEN');

    if (missing.length > 0) {
        throw new Error(
            `Missing probe credential(s): ${missing.join(', ')}. ` +
                'Set them via --key/--token, environment variables, or --config.',
        );
    }
}

function assertEncryptedTransport(config) {
    let url;
    try {
        url = new URL(config.apiUrl);
    } catch {
        throw new Error(`Invalid API URL: ${config.apiUrl}`);
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(
            `Unsupported API URL protocol "${url.protocol}" (expected http or https)`,
        );
    }

    if (url.protocol === 'http:' && !config.allowInsecure) {
        throw new Error(
            `Insecure API URL "${config.apiUrl}" uses plain http. ` +
                'Data encryption requires https. Use an https API URL or ' +
                'set PROBE_ALLOW_INSECURE=true to override (not recommended).',
        );
    }

    return url.protocol === 'https:';
}

async function runValidate(config) {
    assertCredentials(config);
    const encrypted = assertEncryptedTransport(config);

    log(`Validating probe ${config.key} against ${config.apiUrl}`);
    log(`Transport encryption: ${encrypted ? 'TLS (https)' : 'INSECURE (http, explicitly allowed)'}`);

    await pollAndAnswerValidation(config);

    const startedAt = Date.now();
    const data = await heartbeat(config);
    const latency = Date.now() - startedAt;

    if (!data || typeof data !== 'object') {
        throw new Error('Heartbeat returned an unexpected payload');
    }

    if (!data.probe || typeof data.probe !== 'object') {
        throw new Error('Heartbeat response is missing probe metadata');
    }

    if (data.probe.id !== config.key) {
        throw new Error(
            `Probe key mismatch: expected "${config.key}", got "${data.probe.id}"`,
        );
    }

    const monitors = Array.isArray(data.monitors) ? data.monitors : [];

    log('Connectivity check: OK (heartbeat round-trip)');
    log(`Probe identity: id=${data.probe.id} status=${data.probe.status}`);
    log(`Assigned monitors: ${monitors.length}`);
    log(`Server time: ${data.serverTime ?? 'n/a'} (round-trip ${latency}ms)`);

    return {
        ok: true,
        probeId: data.probe.id,
        status: data.probe.status,
        monitorCount: monitors.length,
        latency,
        encrypted,
    };
}

async function runHeartbeat(config) {
    assertCredentials(config);
    const data = await heartbeat(config);
    console.log(JSON.stringify(data, null, 2));
    return data;
}

async function runCycle(config, schedule) {
    assertCredentials(config);
    assertEncryptedTransport(config);

    let roundError = null;
    let probeId = 'unknown';
    let status = 'unknown';
    let assigned = 0;

    try {
        await pollAndAnswerValidation(config);

        const data = await heartbeat(config);
        const monitors = Array.isArray(data && data.monitors)
            ? data.monitors
            : [];
        probeId = data && data.probe ? data.probe.id : 'unknown';
        status = data && data.probe ? data.probe.status : 'unknown';
        assigned = monitors.length;

        const stats = schedule.sync(monitors);

        log(
            `Heartbeat OK: probe=${probeId} status=${status} monitors=${assigned} ` +
                `(tracked=${stats.tracked} added=${stats.added} ` +
                `rescheduled=${stats.rescheduled} removed=${stats.removed})`,
        );
    } catch (err) {
        // A missed heartbeat must not stop local checks: the schedule keeps
        // running on its own intervals and results stay buffered until the
        // backend is reachable again.
        roundError = err;
        warn(
            `Heartbeat failed, keeping the local schedule ` +
                `(${schedule.size()} monitor(s)): ${err.message}`,
        );
    }

    const outcome = await schedule.runDue(config);

    if (outcome.executed > 0) {
        log(`Checked ${outcome.executed}/${outcome.due} due monitor(s)`);
    }

    let reported = 0;
    try {
        reported = await schedule.flush(config);
        if (reported > 0) log(`Reported ${reported} result(s)`);
    } catch (err) {
        warn(
            `Reporting failed, keeping ${schedule.buffered()} result(s) buffered: ${err.message}`,
        );
        if (!roundError) roundError = err;
    }

    if (roundError) throw roundError;

    return {
        probeId,
        monitors: assigned,
        checked: outcome.executed,
        reported,
    };
}

function createShutdownSignal() {
    const controller = new AbortController();

    const shutdown = () => {
        log('Shutdown signal received, stopping...');
        controller.abort();
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return controller.signal;
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal && signal.aborted) {
            resolve();
            return;
        }

        const timer = setTimeout(() => {
            signal && signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        function onAbort() {
            clearTimeout(timer);
            resolve();
        }

        signal && signal.addEventListener('abort', onAbort, { once: true });
    });
}

async function runLoop(config) {
    assertCredentials(config);

    const signal = createShutdownSignal();
    const schedule = createSchedule();
    let consecutiveFailures = 0;

    log(
        `Probe agent started: probe=${config.key} heartbeat=${config.intervalSeconds}s ` +
            `concurrency=${DEFAULT_CONCURRENCY} (checks follow each monitor's interval)`,
    );

    while (!signal.aborted) {
        try {
            await runCycle(config, schedule);
            consecutiveFailures = 0;
        } catch (err) {
            consecutiveFailures += 1;
            warn(`Cycle failed (${consecutiveFailures} consecutive): ${err.message}`);
        }

        if (signal.aborted) break;

        let delayMs = config.intervalSeconds * 1000;
        if (consecutiveFailures > 0) {
            // Retry sooner after failures so a transient network blip recovers
            // quickly, but never wait longer than the configured interval.
            delayMs = Math.min(
                delayMs,
                1000 * 2 ** Math.min(consecutiveFailures - 1, 6),
            );
        }
        delayMs = Math.max(1000, delayMs);
        await sleep(delayMs, signal);
    }

    log('Probe agent stopped');
}

// -- Entrypoint ----------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        console.log(HELP);
        return;
    }

    const config = loadConfig(args);

    if (args.command === 'validate') {
        await runValidate(config);
        return;
    }

    if (args.command === 'heartbeat') {
        await runHeartbeat(config);
        return;
    }

    if (args.once) {
        await runCycle(config, createSchedule());
        return;
    }

    await runLoop(config);
}

if (require.main === module) {
    void main().catch((err) => {
        error(err.message);
        process.exitCode = 1;
    });
}

module.exports = {
    loadConfig,
    parseArgs,
    createSchedule,
    runCycle,
    runValidate,
    runHeartbeat,
    pollAndAnswerValidation,
    heartbeat,
};

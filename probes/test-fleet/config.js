'use strict';

const path = require('node:path');

const HELP = `Beacon local system probe test fleet (Node.js >= 22)

Usage: node probes/test-fleet/index.js [run|provision] [options]

  --api-url <url>             BEACON_API_URL (include /api)
  --email <email>             BEACON_ADMIN_EMAIL (SUPER_ADMIN required)
  --password <password>       BEACON_ADMIN_PASSWORD (prefer environment input)
  --count <1..1000>           PROBE_FLEET_COUNT (default 100)
  --prefix <name>             PROBE_FLEET_PREFIX (default docker-system-test)
  --state-dir <path>          PROBE_FLEET_STATE_DIR (default .beacon/test-fleet)
  --allow-insecure            PROBE_ALLOW_INSECURE=true (local HTTP only)
  -h, --help                 Show this help

run starts real agents; provision only prepares and saves their credentials.
Existing secrets cannot be fetched from the API. Keep the persistent volume.
Never share a state directory between concurrently running fleets.
`;

function integer(value, name, fallback, min, max) {
    const number =
        value === undefined || value === '' ? fallback : Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return number;
}

function loadConfig(argv = process.argv.slice(2), env = process.env) {
    const args = {};
    let command = 'run';
    const options = new Map([
        ['--api-url', 'apiUrl'],
        ['--email', 'email'],
        ['--password', 'password'],
        ['--count', 'count'],
        ['--prefix', 'prefix'],
        ['--state-dir', 'stateDir'],
    ]);
    let hasCommand = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') return { help: true };
        if (arg === '--allow-insecure') {
            args.allowInsecure = true;
        } else if (options.has(arg)) {
            const value = argv[++i];
            if (value === undefined) throw new Error(`${arg} requires a value`);
            args[options.get(arg)] = value;
        } else if (!hasCommand && ['run', 'provision'].includes(arg)) {
            command = arg;
            hasCommand = true;
        } else {
            // Do not reflect unknown arguments: an accidental password may be one.
            throw new Error('Unknown argument; use --help');
        }
    }

    let url;
    try {
        url = new URL(
            args.apiUrl ??
                env.BEACON_API_URL ??
                'http://host.docker.internal:3000/api',
        );
    } catch {
        throw new Error('Invalid API URL');
    }
    const allowInsecure =
        args.allowInsecure ?? ['true', '1'].includes(env.PROBE_ALLOW_INSECURE);
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new Error(
            'API URL must be HTTP(S), without credentials, query or fragment',
        );
    }
    if (url.protocol === 'http:' && !allowInsecure) {
        throw new Error(
            'Local HTTP requires --allow-insecure or PROBE_ALLOW_INSECURE=true',
        );
    }
    const email = (args.email ?? env.BEACON_ADMIN_EMAIL ?? '')
        .trim()
        .toLowerCase();
    const password = args.password ?? env.BEACON_ADMIN_PASSWORD ?? '';
    if (!email || !password) {
        throw new Error(
            'BEACON_ADMIN_EMAIL and BEACON_ADMIN_PASSWORD are required',
        );
    }
    const prefix =
        args.prefix ?? env.PROBE_FLEET_PREFIX ?? 'docker-system-test';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(prefix)) {
        throw new Error(
            'Fleet prefix must be 1..64 letters, digits, underscores or hyphens',
        );
    }
    return {
        command,
        email,
        password,
        prefix,
        allowInsecure,
        apiUrl: url.toString().replace(/\/+$/, ''),
        stateDir: path.resolve(
            args.stateDir ?? env.PROBE_FLEET_STATE_DIR ?? '.beacon/test-fleet',
        ),
        count: integer(
            args.count ?? env.PROBE_FLEET_COUNT,
            'count',
            100,
            1,
            1000,
        ),
        intervalSeconds: integer(
            env.PROBE_INTERVAL_SECONDS,
            'interval',
            60,
            5,
            3600,
        ),
        timeoutMs: integer(env.PROBE_TIMEOUT_MS, 'timeout', 5000, 100, 300000),
        concurrency: integer(env.PROBE_CONCURRENCY, 'concurrency', 3, 1, 20),
        apiTimeoutMs: integer(
            env.PROBE_FLEET_API_TIMEOUT_MS,
            'API timeout',
            30000,
            100,
            300000,
        ),
        startupDelayMs: integer(
            env.PROBE_FLEET_STARTUP_DELAY_MS,
            'startup delay',
            250,
            0,
            60000,
        ),
        readyTimeoutSeconds: integer(
            env.PROBE_FLEET_READY_TIMEOUT_SECONDS,
            'ready timeout',
            180,
            1,
            3600,
        ),
        shutdownTimeoutSeconds: integer(
            env.PROBE_FLEET_SHUTDOWN_TIMEOUT_SECONDS,
            'shutdown timeout',
            15,
            1,
            300,
        ),
        rateRetries: integer(
            env.PROBE_FLEET_RATE_RETRIES,
            'rate retries',
            12,
            0,
            100,
        ),
    };
}

module.exports = { loadConfig, HELP };

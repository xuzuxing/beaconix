'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
    DEFAULT_API_URL,
    DEFAULT_INTERVAL_SECONDS,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_RESULTS,
} = require('./constants');
const { CREDENTIALS_PATH } = require('./paths');

const COMMANDS = [
    'run',
    'validate',
    'heartbeat',
    'login',
    'enroll',
    'logout',
    'revoke',
    'start',
    'stop',
    'restart',
    'status',
    'self-update',
    'version',
    'help',
];

function parseArgs(argv) {
    const args = {
        command: 'run',
        once: false,
        help: false,
        version: false,
        config: undefined,
        apiUrl: undefined,
        key: undefined,
        token: undefined,
        enrollToken: undefined,
        intervalSeconds: undefined,
        timeoutMs: undefined,
        allowInsecure: undefined,
        revoke: false,
        foreground: false,
        noOpen: false,
        check: false,
    };
    const positionals = [];

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else if (arg === '--version' || arg === '-v') {
            args.version = true;
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
        } else if (arg === '--enroll-token') {
            args.enrollToken = requireValue(argv, ++i, arg);
        } else if (arg === '--interval-seconds') {
            args.intervalSeconds = Number(requireValue(argv, ++i, arg));
        } else if (arg === '--timeout-ms') {
            args.timeoutMs = Number(requireValue(argv, ++i, arg));
        } else if (arg === '--allow-insecure') {
            args.allowInsecure = true;
        } else if (arg === '--revoke') {
            args.revoke = true;
        } else if (arg === '--foreground') {
            args.foreground = true;
        } else if (arg === '--no-open') {
            args.noOpen = true;
        } else if (arg === '--check') {
            args.check = true;
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            positionals.push(arg);
        }
    }

    if (positionals.length > 1) {
        throw new Error(
            `Unexpected arguments: ${positionals.slice(1).join(' ')}`,
        );
    }

    if (positionals[0]) {
        if (!COMMANDS.includes(positionals[0])) {
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
        throw new Error(
            `Invalid JSON in config file ${resolved}: ${err.message}`,
        );
    }
}

/**
 * Config file lookup order: an explicit `--config` / `PROBE_CONFIG`, then the
 * credentials written by `login`/`enroll`.
 */
function resolveConfigPath(args, env) {
    if (args.config) return args.config;
    if (env.PROBE_CONFIG) return env.PROBE_CONFIG;
    if (fs.existsSync(CREDENTIALS_PATH)) return CREDENTIALS_PATH;
    return undefined;
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
    const file = readConfigFile(resolveConfigPath(args, env));

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
        throw new Error(
            'maxResultsPerReport must be an integer between 1 and 100',
        );
    }

    return config;
}

module.exports = {
    COMMANDS,
    parseArgs,
    readConfigFile,
    resolveConfigPath,
    loadConfig,
};

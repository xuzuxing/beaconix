'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { PID_FILE, LOG_FILE } = require('../paths');
const { ensureStateDirs } = require('../credentials');

/**
 * pidfile backend: used when no init system is available (containers, dev
 * hosts, non-Linux/macOS). A detached `run` process is tracked via a pidfile.
 */

function readPid() {
    try {
        const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

function isProcessAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means the process exists but belongs to another user.
        return err.code === 'EPERM';
    }
}

function isInstalled() {
    return false;
}

function isRunning() {
    return isProcessAlive(readPid());
}

function start(env) {
    ensureStateDirs();

    const existing = readPid();
    if (isProcessAlive(existing)) {
        return { ok: true, pid: existing, already: true };
    }

    const logFd = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [process.argv[1], 'run'], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: env || process.env,
    });
    child.unref();

    fs.writeFileSync(PID_FILE, String(child.pid));
    return { ok: true, pid: child.pid };
}

function stop() {
    const pid = readPid();
    if (!isProcessAlive(pid)) {
        fs.rmSync(PID_FILE, { force: true });
        return { ok: true, stopped: false };
    }

    try {
        process.kill(pid, 'SIGTERM');
    } catch (err) {
        fs.rmSync(PID_FILE, { force: true });
        return { ok: false, stopped: false, pid, error: err.message };
    }

    fs.rmSync(PID_FILE, { force: true });
    return { ok: true, stopped: true, pid };
}

async function action(verb, env) {
    if (verb === 'start') return start(env);
    if (verb === 'stop') return stop();
    if (verb === 'restart') {
        stop();
        return start(env);
    }
    return { ok: true };
}

function status() {
    const pid = readPid();
    return { running: isProcessAlive(pid), pid };
}

module.exports = {
    readPid,
    isProcessAlive,
    isInstalled,
    isRunning,
    start,
    stop,
    action,
    status,
};

'use strict';

const { Socket } = require('node:net');

const { MAX_ERROR_MESSAGE_LENGTH, USER_AGENT } = require('./constants');
const { describeError, truncate } = require('./util');

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

module.exports = { failure, checkHttp, checkTcp, checkMonitor, parseTcpTarget };

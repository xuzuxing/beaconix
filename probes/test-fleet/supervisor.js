'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { setTimeout: sleep } = require('node:timers/promises');

const AGENT = path.resolve(__dirname, '../agent/bin/beaconix-probe.js');

function agentEnvironment(config, credential, inherited = process.env) {
    const env = Object.fromEntries(
        Object.entries(inherited).filter(
            ([key]) => !/^(BEACON_|PROBE_)/i.test(key),
        ),
    );
    return {
        ...env,
        BEACON_API_URL: config.apiUrl,
        BEACON_HOME: path.join(config.stateDir, 'agents', credential.id),
        PROBE_KEY: credential.id,
        PROBE_TOKEN: credential.secret,
        PROBE_ALLOW_INSECURE: String(config.allowInsecure),
        PROBE_INTERVAL_SECONDS: String(config.intervalSeconds),
        PROBE_TIMEOUT_MS: String(config.timeoutMs),
        PROBE_CONCURRENCY: String(config.concurrency),
    };
}

async function supervise(
    config,
    credentials,
    api,
    signal,
    log = console.log,
    spawnAgent = spawn,
) {
    const records = credentials.map((credential) => ({
        credential,
        child: null,
        closed: null,
        restart: null,
        ready: false,
        failures: 0,
    }));
    let stopping = false;
    let launched = false;
    let rebalancing = false;
    let fleetReady = false;
    let pendingRebalance;
    const workController = new AbortController();
    let readyTimer;
    let killTimer;
    let resolveFinished;
    let rejectFinished;
    const finished = new Promise((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = reject;
    });
    // Startup can still be staggering children when a terminal failure occurs.
    finished.catch(() => {});

    function stop() {
        if (stopping) return;
        stopping = true;
        workController.abort();
        clearTimeout(readyTimer);
        for (const record of records) {
            clearTimeout(record.restart);
            record.child?.kill('SIGTERM');
        }
        killTimer = setTimeout(() => {
            for (const record of records) record.child?.kill('SIGKILL');
        }, config.shutdownTimeoutSeconds * 1000);
    }

    function onAbort() {
        stop();
        resolveFinished();
    }

    function checkReady() {
        if (
            stopping ||
            !launched ||
            rebalancing ||
            fleetReady ||
            records.some((record) => !record.ready)
        )
            return;
        rebalancing = true;
        const children = records.map((record) => record.child);
        pendingRebalance = api
            .request('/admin/system-probes/rebalance', {
                method: 'POST',
                signal: workController.signal,
            })
            .then(async (assignments) => {
                if (
                    stopping ||
                    records.some(
                        (record, index) =>
                            !record.ready ||
                            !record.child ||
                            record.child.killed ||
                            record.child.exitCode !== null ||
                            record.child.signalCode !== null ||
                            record.child !== children[index],
                    )
                )
                    return;
                if (
                    !assignments ||
                    Array.isArray(assignments) ||
                    typeof assignments !== 'object' ||
                    records.some(
                        (record) =>
                            !Object.hasOwn(assignments, record.credential.id) ||
                            !Array.isArray(assignments[record.credential.id]),
                    )
                ) {
                    log(
                        'Rebalance returned an incomplete assignment table; waiting to retry',
                    );
                    await sleep(1000, undefined, {
                        signal: workController.signal,
                    });
                    return;
                }
                fleetReady = true;
                clearTimeout(readyTimer);
                log(
                    `Fleet ready: ${records.length} distinct agents completed heartbeats; assignments rebalanced`,
                );
            })
            .catch((error) => {
                if (stopping) return;
                stop();
                rejectFinished(error);
            })
            .finally(() => {
                rebalancing = false;
                if (!stopping && !fleetReady) checkReady();
            });
    }

    function launch(record) {
        if (stopping) return;
        const startedAt = Date.now();
        record.ready = false;
        const child = spawnAgent(process.execPath, [AGENT, 'run'], {
            env: agentEnvironment(config, record.credential),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        record.child = child;
        record.closed = new Promise((resolve) => child.once('close', resolve));
        for (const stream of [child.stdout, child.stderr]) {
            const lines = readline.createInterface({ input: stream });
            lines.on('line', (line) => {
                const safe = line
                    .split(record.credential.secret)
                    .join('[REDACTED]');
                log(`[${record.credential.name}] ${safe}`);
                if (
                    line.includes(
                        `Heartbeat OK: probe=${record.credential.id} `,
                    )
                ) {
                    record.ready = true;
                    checkReady();
                } else if (
                    line.includes(
                        'Heartbeat failed, keeping the local schedule',
                    )
                ) {
                    record.ready = false;
                    fleetReady = false;
                }
            });
            child.once('close', () => lines.close());
        }
        child.once('error', () =>
            log(`[${record.credential.name}] Agent process failed to start`),
        );
        child.once('exit', () => {
            record.ready = false;
            fleetReady = false;
        });
        child.once('close', (code, exitSignal) => {
            record.child = null;
            record.ready = false;
            fleetReady = false;
            if (stopping) return;
            record.failures =
                Date.now() - startedAt >= 60000 ? 1 : record.failures + 1;
            const delay = Math.min(
                30000,
                1000 * 2 ** Math.min(record.failures - 1, 5),
            );
            log(
                `[${record.credential.name}] Exited (${code ?? exitSignal}); restarting in ${delay}ms`,
            );
            record.restart = setTimeout(() => launch(record), delay);
        });
    }

    signal.addEventListener('abort', onAbort, { once: true });
    try {
        if (signal.aborted) onAbort();
        for (let i = 0; i < records.length && !stopping; i += 1) {
            launch(records[i]);
            if (i + 1 < records.length && config.startupDelayMs > 0) {
                await sleep(config.startupDelayMs, undefined, { signal });
            }
        }
        launched = true;
        if (!stopping) {
            readyTimer = setTimeout(() => {
                const online = records.filter((record) => record.ready).length;
                stop();
                rejectFinished(
                    new Error(
                        `Fleet readiness timed out: ${online}/${records.length} agents completed heartbeats. ` +
                            'Check API reachability, secrets, local THROTTLE_LIMIT and rebalance',
                    ),
                );
            }, config.readyTimeoutSeconds * 1000);
            checkReady();
        }
        await finished;
    } catch (error) {
        if (!signal.aborted) throw error;
    } finally {
        stop();
        await Promise.all(records.map((record) => record.closed));
        await pendingRebalance;
        clearTimeout(killTimer);
        signal.removeEventListener('abort', onAbort);
    }
}

module.exports = { supervise, agentEnvironment };

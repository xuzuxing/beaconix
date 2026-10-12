'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function acquireStateLock(stateDir) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const file = path.join(stateDir, 'fleet.lock');
    let fd;
    try {
        fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new Error(
            'Fleet state is locked. Stop the other fleet; after an unclean stop, ' +
                'remove fleet.lock only after verifying no fleet is running',
        );
    }
    fs.closeSync(fd);
    return () => fs.unlinkSync(file);
}

function saveState(config, state) {
    const file = path.join(config.stateDir, 'credentials.json');
    const temporary = path.join(
        config.stateDir,
        `.credentials-${randomUUID()}.tmp`,
    );
    try {
        fs.writeFileSync(temporary, JSON.stringify(state, null, 4) + '\n', {
            mode: 0o600,
            flag: 'wx',
        });
        fs.renameSync(temporary, file);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function readState(config) {
    const file = path.join(config.stateDir, 'credentials.json');
    if (!fs.existsSync(file)) {
        return {
            version: 1,
            apiUrl: config.apiUrl,
            email: config.email,
            prefix: config.prefix,
            probes: [],
        };
    }
    let state;
    try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        throw new Error(
            'Cannot read credential manifest; restore the state volume backup',
        );
    }
    if (
        state?.version !== 1 ||
        state.apiUrl !== config.apiUrl ||
        state.email !== config.email ||
        state.prefix !== config.prefix ||
        !Array.isArray(state.probes)
    ) {
        throw new Error(
            'State belongs to a different API/account/prefix, or has an invalid format; ' +
                'use a separate state volume',
        );
    }
    const names = new Set();
    const ids = new Set();
    const secrets = new Set();
    for (const probe of state.probes) {
        if (
            typeof probe.name !== 'string' ||
            !probe.name.startsWith(`${config.prefix}-`) ||
            typeof probe.id !== 'string' ||
            !/^[a-zA-Z0-9_-]+$/.test(probe.id) ||
            !/^sys_[0-9a-f]{64}$/.test(probe.secret) ||
            names.has(probe.name) ||
            ids.has(probe.id) ||
            secrets.has(probe.secret)
        ) {
            throw new Error(
                'Credential manifest has invalid or duplicate probe credentials',
            );
        }
        names.add(probe.name);
        ids.add(probe.id);
        secrets.add(probe.secret);
    }
    return state;
}

async function provision(config, api, signal, log = console.log) {
    const state = readState(config);
    await api.login();
    const existing = await api.request('/admin/system-probes');
    if (!Array.isArray(existing))
        throw new Error('System probe list is not an array');

    const saved = new Map(state.probes.map((probe) => [probe.name, probe]));
    const wanted = Array.from(
        { length: config.count },
        (_, i) => `${config.prefix}-${String(i + 1).padStart(4, '0')}`,
    );
    const records = new Map();
    // Preflight the complete requested namespace before making any mutations.
    for (const name of wanted) {
        const matches = existing.filter((probe) => probe.name === name);
        if (matches.length > 1)
            throw new Error(`Duplicate system probe name: ${name}`);
        const probe = matches[0];
        const credential = saved.get(name);
        if (probe && (probe.scope !== 'SYSTEM' || !probe.enabled)) {
            throw new Error(
                `Test probe ${name} is disabled or has an unexpected scope; no changes made`,
            );
        }
        if (probe && (!credential || credential.id !== probe.id)) {
            throw new Error(
                `Test probe ${name} exists without its saved secret. The API cannot ` +
                    'recover it; restore the state volume or choose a new prefix and volume',
            );
        }
        records.set(name, probe);
    }

    // Check cached secrets before creating any missing probes.
    for (const name of wanted) {
        if (!records.get(name)) continue;
        signal.throwIfAborted();
        const credential = saved.get(name);
        const heartbeat = await api.raw('/probes/heartbeat', {
            method: 'POST',
            secret: credential.secret,
            body: { intervalSeconds: config.intervalSeconds },
        });
        if (heartbeat?.probe?.id !== credential.id) {
            throw new Error(
                `Saved credential identity mismatch for ${name}; restore the manifest`,
            );
        }
    }

    const selected = [];
    for (const name of wanted) {
        signal.throwIfAborted();
        let credential = saved.get(name);
        if (!records.get(name)) {
            const created = await api.request('/admin/system-probes', {
                method: 'POST',
                body: {
                    name,
                    provider: 'CUSTOM',
                    region: 'local-docker',
                    callbackUrl: `https://probe-test.invalid/${name}`,
                    enabled: true,
                    maxTenants: 0,
                    priority: 0,
                },
            });
            if (
                typeof created?.id !== 'string' ||
                !/^[a-zA-Z0-9_-]+$/.test(created.id) ||
                !/^sys_[0-9a-f]{64}$/.test(created.secret)
            ) {
                throw new Error(
                    `Creation of ${name} did not return valid credentials; ` +
                        'inspect the test namespace before retrying',
                );
            }
            if (
                selected.some(
                    (probe) =>
                        probe.id === created.id ||
                        probe.secret === created.secret,
                ) ||
                state.probes.some(
                    (probe) =>
                        probe.name !== name &&
                        (probe.id === created.id ||
                            probe.secret === created.secret),
                )
            ) {
                throw new Error('API returned duplicate probe credentials');
            }
            credential = { name, id: created.id, secret: created.secret };
            state.probes = state.probes.filter((probe) => probe.name !== name);
            state.probes.push(credential);
            // Persist each secret before the next network call: creation only returns it once.
            saveState(config, state);
            log(`Created ${name} (${selected.length + 1}/${config.count})`);
        } else {
            log(`Reusing ${name} (${selected.length + 1}/${config.count})`);
        }
        selected.push(credential);
    }
    return selected;
}

module.exports = { provision, acquireStateLock, readState, saveState };

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { SERVICE_NAME } = require('../paths');

/** systemd **system** unit (installed by install.sh with sudo). */
const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;

function runCommand(command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: 'ignore' });
        child.on('error', (err) => resolve({ ok: false, error: err.message }));
        child.on('exit', (code) =>
            resolve({ ok: code === 0, code: code ?? 1 }),
        );
    });
}

function isInstalled() {
    return fs.existsSync(UNIT_PATH);
}

function action(verb) {
    return runCommand('systemctl', [verb, SERVICE_NAME]);
}

function daemonReload() {
    return runCommand('systemctl', ['daemon-reload']);
}

/**
 * Render the systemd system unit.
 *
 * Runs as the dedicated `beaconix` user; credentials and the optional env file
 * live under /etc/beaconix, so the unit never needs access to an interactive
 * user's home directory.
 */
function renderUnit({
    execStart,
    runUser = 'beaconix',
    runGroup = 'beaconix',
    workDir,
    envFile = '/etc/beaconix/probe.env',
}) {
    return `[Unit]
Description=Beacon probe agent
Documentation=https://get.beaconix.app/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${runUser}
Group=${runGroup}
WorkingDirectory=${workDir}
ExecStart=${execStart}
Restart=always
RestartSec=5
EnvironmentFile=-${envFile}
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/etc/beaconix /var/log/beaconix /run/beaconix

[Install]
WantedBy=multi-user.target
`;
}

async function install(unitContent) {
    fs.mkdirSync('/etc/systemd/system', { recursive: true });
    fs.writeFileSync(UNIT_PATH, unitContent, { mode: 0o644 });
    await daemonReload();
    return runCommand('systemctl', ['enable', SERVICE_NAME]);
}

async function uninstall() {
    await runCommand('systemctl', ['disable', '--now', SERVICE_NAME]);
    fs.rmSync(UNIT_PATH, { force: true });
    return daemonReload();
}

module.exports = {
    UNIT_PATH,
    SERVICE_NAME,
    user: os.userInfo().username,
    runCommand,
    isInstalled,
    action,
    daemonReload,
    renderUnit,
    install,
    uninstall,
};

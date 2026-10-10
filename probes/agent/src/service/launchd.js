'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SERVICE_NAME } = require('../paths');

/** launchd user agent (macOS), the counterpart of the systemd backend. */
const LABEL = `dev.beacon.${SERVICE_NAME}`;
const PLIST_PATH = path.join(
    os.homedir(),
    'Library',
    'LaunchAgents',
    `${LABEL}.plist`,
);

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
    return fs.existsSync(PLIST_PATH);
}

function renderPlist({ execStart, workDir, logFile }) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${execStart}</string>
        <string>run</string>
    </array>
    <key>WorkingDirectory</key><string>${workDir}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${logFile}</string>
    <key>StandardErrorPath</key><string>${logFile}</string>
</dict>
</plist>
`;
}

async function install(plistContent) {
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.writeFileSync(PLIST_PATH, plistContent, { mode: 0o644 });
    return runCommand('launchctl', ['load', PLIST_PATH]);
}

async function uninstall() {
    await runCommand('launchctl', ['unload', PLIST_PATH]);
    fs.rmSync(PLIST_PATH, { force: true });
    return { ok: true };
}

async function action(verb) {
    if (verb === 'start') {
        return runCommand('launchctl', ['load', PLIST_PATH]);
    }
    if (verb === 'stop') {
        return runCommand('launchctl', ['unload', PLIST_PATH]);
    }
    if (verb === 'restart') {
        await runCommand('launchctl', ['unload', PLIST_PATH]);
        return runCommand('launchctl', ['load', PLIST_PATH]);
    }
    return { ok: true };
}

async function status() {
    const result = await runCommand('launchctl', ['list', LABEL]);
    return { running: result.ok };
}

module.exports = {
    LABEL,
    PLIST_PATH,
    runCommand,
    isInstalled,
    renderPlist,
    install,
    uninstall,
    action,
    status,
};

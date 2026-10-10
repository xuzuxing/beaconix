'use strict';

const { parseArgs, loadConfig } = require('./config');
const { VERSION } = require('./version');
const { createSchedule } = require('./schedule');
const { runCycle, runLoop } = require('./commands/run');
const { runValidate } = require('./commands/validate');
const { runHeartbeat } = require('./commands/heartbeat');
const { runLogin } = require('./commands/login');
const { runEnroll } = require('./commands/enroll');
const { runLogout } = require('./commands/logout');
const { runRevoke } = require('./commands/revoke');
const { runStart } = require('./commands/start');
const { runStop } = require('./commands/stop');
const { runRestart } = require('./commands/restart');
const { runStatus } = require('./commands/status');
const { runSelfUpdate } = require('./commands/self-update');

const HELP = `Beacon probe agent ${VERSION}

Usage:
  beacon-probe <command> [options]

Enrollment:
  login                      Enroll this host through an OAuth2 device-code flow
  enroll --enroll-token <t>  Enroll using a one-time token issued in the web UI
  logout [--revoke]          Remove the stored credentials (optionally revoke)
  revoke                     Revoke the probe on the backend, keep the file

Service:
  start [--foreground]       Start the probe (systemd unit, else background process)
  stop                       Stop the probe
  restart                    Restart the probe
  status                     Show service and credential status
  self-update [--check]      Update the CLI to the latest published version

Probe:
  run [--once]               Run the probe in the foreground (default command)
  validate                   One-shot deployment validation
  heartbeat                  Send a single heartbeat and print the response

Options:
  --config <path>            JSON config file (default: /etc/beacon/probe.json)
  --api-url <url>            Beacon API base URL
  --key <probeId>            Probe id returned by the backend (the "key")
  --token <secret>           Probe secret returned by the backend (the "token")
  --enroll-token <token>     One-time enrollment token (used by "enroll")
  --interval-seconds <n>     Heartbeat interval for run mode
  --timeout-ms <n>           Per-request/check timeout
  --allow-insecure           Allow http:// API URL (not recommended in production)
  --revoke                   With "logout": also revoke the probe on the backend
  --no-open                  With "login": do not open the verification URL
  --foreground               With "start": run in the foreground instead
  --check                    With "self-update": only check, do not install
  -v, --version              Print the version and exit
  -h, --help                 Show this help
`;

async function main(argv) {
    const args = parseArgs(argv);

    if (args.version || args.command === 'version') {
        console.log(VERSION);
        return;
    }

    if (args.help || args.command === 'help') {
        console.log(HELP);
        return;
    }

    const config = loadConfig(args);

    switch (args.command) {
        case 'validate':
            await runValidate(config);
            return;
        case 'heartbeat':
            await runHeartbeat(config);
            return;
        case 'login':
            await runLogin(config, args);
            return;
        case 'enroll':
            await runEnroll(config, args);
            return;
        case 'logout':
            await runLogout(config, args);
            return;
        case 'revoke':
            await runRevoke(config);
            return;
        case 'start':
            await runStart(config, args);
            return;
        case 'stop':
            await runStop();
            return;
        case 'restart':
            await runRestart(config, args);
            return;
        case 'status':
            await runStatus();
            return;
        case 'self-update':
            await runSelfUpdate(args);
            return;
        default:
            break;
    }

    if (args.once) {
        await runCycle(config, createSchedule());
        return;
    }

    await runLoop(config);
}

module.exports = { main, HELP };

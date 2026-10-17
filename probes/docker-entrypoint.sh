#!/bin/sh
#
# Beacon probe agent container entrypoint.
#
# First start: download the published payload into the /data volume, then run
# the device-code login and print the verification URL. Later starts reuse the
# installed agent and the stored credential, so they go straight to `run`.
#
# Everything is best kept on the /data volume:
#   /data/agent      installed payload (PROBE_INSTALL_DIR)
#   /data/etc        credential store (BEACON_HOME/probe.json)
#   /data/logs|run   paths the CLI expects to be writable
set -eu

INSTALL_DIR="${PROBE_INSTALL_DIR:-/data/agent}"
DOWNLOAD_BASE="${BEACON_DOWNLOAD_BASE:-https://get.beaconix.app/probe}"
VERSION="${PROBE_VERSION:-latest}"
CLI="$INSTALL_DIR/bin/beaconix-probe.js"
CREDENTIALS="${BEACON_HOME:-/data/etc}/probe.json"

log() { printf '[probe] %s\n' "$*"; }

installed_version() {
    node "$CLI" version 2>/dev/null || echo unknown
}

if [ ! -f "$CLI" ] || [ "${PROBE_FORCE_INSTALL:-0}" = "1" ]; then
    log "installing beacon probe agent ($VERSION) from $DOWNLOAD_BASE"
    mkdir -p "$INSTALL_DIR"
    tmp="$(mktemp)"
    curl -fsSL "$DOWNLOAD_BASE/beaconix-probe-$VERSION.tar.gz" -o "$tmp"
    tar -xzf "$tmp" -C "$INSTALL_DIR"
    rm -f "$tmp"
    log "installed to $INSTALL_DIR ($(installed_version))"
else
    log "using installed agent at $INSTALL_DIR ($(installed_version))"
fi

# Explicit args (validate, run --once, status, ...) pass straight through and
# never trigger the interactive login.
if [ "$#" -gt 0 ]; then
    exec node "$CLI" "$@"
fi

# The first `run` prints the device-authorization URL itself (PROBE_ENROLL_TOKEN,
# when set, is redeemed there instead). The entrypoint only fails fast when it
# cannot know which backend to enroll against.
if [ ! -f "$CREDENTIALS" ] && [ -z "${BEACON_API_URL:-}" ]; then
    log "ERROR: BEACON_API_URL is required for the first-time authorization"
    log "       e.g. docker run ... -e BEACON_API_URL=https://api.example.com/api"
    exit 1
fi

exec node "$CLI" run

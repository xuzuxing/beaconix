#!/bin/sh
#
# Beacon probe agent container entrypoint.
#
# Mirrors install.sh: with `latest`, read `<base>/latest.json` first (version +
# sha256) and download the immutable `beaconix-probe-<version>.tar.gz`. That way
# a CDN that still serves a stale `latest` alias cannot pin the container to an
# old build; the alias is only used when the manifest is unreachable.
#
# The /data volume keeps both the payload and the credential:
#   /data/agent      installed payload (PROBE_INSTALL_DIR)
#   /data/etc        credential store (BEACON_HOME/probe.json)
#   /data/logs|run   paths the CLI expects to be writable
#
# Knobs:
#   PROBE_AUTO_UPDATE=0     do not re-download on start (reuse /data/agent)
#   PROBE_VERSION=2.1.0     pin a release instead of `latest`
#   PROBE_FORCE_INSTALL=1   force a re-download even with PROBE_AUTO_UPDATE=0
set -eu

INSTALL_DIR="${PROBE_INSTALL_DIR:-/data/agent}"
DOWNLOAD_BASE="${BEACON_DOWNLOAD_BASE:-https://get.beaconix.app/probe}"
VERSION="${PROBE_VERSION:-latest}"
AUTO_UPDATE="${PROBE_AUTO_UPDATE:-1}"
CLI="$INSTALL_DIR/bin/beaconix-probe.js"
CREDENTIALS="${BEACON_HOME:-/data/etc}/probe.json"

log() { printf '[probe] %s\n' "$*"; }

installed_version() {
    node "$CLI" version 2>/dev/null || echo unknown
}

manifest_field() {
    printf '%s' "$MANIFEST" |
        node -p "JSON.parse(require('fs').readFileSync(0, 'utf8'))['$1'] || ''" \
            2>/dev/null || true
}

# Resolve `latest` through the manifest; fall back to the moving alias only when
# the manifest cannot be fetched.
resolve_payload() {
    RESOLVED_VERSION="$VERSION"
    EXPECTED_SHA=""

    if [ "$VERSION" = "latest" ]; then
        RESOLVED_VERSION=""
        MANIFEST="$(curl -fsSL -H 'cache-control: no-cache' \
            --connect-timeout 10 --max-time 30 \
            "$DOWNLOAD_BASE/latest.json?ts=$(date +%s)" 2>/dev/null || true)"
        if [ -n "$MANIFEST" ]; then
            RESOLVED_VERSION="$(manifest_field version)"
            EXPECTED_SHA="$(manifest_field sha256)"
        fi
        if [ -z "$RESOLVED_VERSION" ]; then
            log "warning: latest.json unavailable; falling back to the latest alias"
            RESOLVED_VERSION="latest"
        fi
    fi

    TARBALL_URL="$DOWNLOAD_BASE/beaconix-probe-${RESOLVED_VERSION}.tar.gz?ts=$(date +%s)"
}

# Download into a staging directory and swap it in, so a failed download, a
# checksum mismatch or a broken archive never leaves a half-written install.
install_payload() {
    resolve_payload
    log "installing beacon probe agent ($RESOLVED_VERSION) from $DOWNLOAD_BASE"

    staging="$INSTALL_DIR.new"
    archive="$(mktemp)"
    rm -rf "$staging"

    if ! curl -fsSL --connect-timeout 10 --max-time 120 \
        "$TARBALL_URL" -o "$archive"; then
        rm -f "$archive"
        return 1
    fi

    if [ -n "$EXPECTED_SHA" ] && command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$archive" | awk '{print $1}')"
        if [ "$actual" != "$EXPECTED_SHA" ]; then
            log "checksum mismatch for $TARBALL_URL (stale CDN cache?)"
            rm -f "$archive"
            return 1
        fi
    fi

    mkdir -p "$staging"
    if ! tar -xzf "$archive" -C "$staging"; then
        rm -f "$archive"
        rm -rf "$staging"
        return 1
    fi
    rm -f "$archive"

    rm -rf "$INSTALL_DIR.old"
    if [ -d "$INSTALL_DIR" ]; then
        mv "$INSTALL_DIR" "$INSTALL_DIR.old"
    fi
    mv "$staging" "$INSTALL_DIR"
    rm -rf "$INSTALL_DIR.old"

    log "installed to $INSTALL_DIR ($(installed_version))"
    return 0
}

if [ ! -f "$CLI" ]; then
    if ! install_payload; then
        log "ERROR: could not install beacon probe agent ($VERSION) and nothing is installed"
        exit 1
    fi
elif [ "$AUTO_UPDATE" = "1" ] || [ "${PROBE_FORCE_INSTALL:-0}" = "1" ]; then
    if ! install_payload; then
        log "update failed; keeping installed agent ($(installed_version))"
    fi
elif [ "$VERSION" != "latest" ] && [ "$(installed_version)" != "$VERSION" ]; then
    if ! install_payload; then
        log "ERROR: installed $(installed_version) but $VERSION was requested and the update failed"
        exit 1
    fi
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

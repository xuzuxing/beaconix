#!/bin/sh
#
# Beacon probe agent container entrypoint.
#
# Mirrors install.sh. With `latest`, read `<base>/latest.json` first (version +
# sha256 + tarball) and download the immutable
# `<base>/<version>/beaconix-probe-<version>.tar.gz`. Resolution degrades in the
# same order as the installer, so neither a stale CDN cache nor an older
# published layout can pin the container to an old build:
#
#   1. <base>/<version>/beaconix-probe-<version>.tar.gz
#   2. manifest `tarball` (absolute URL written by build-release.js)
#   3. <base>/beaconix-probe-latest.tar.gz        (moving alias)
#
# There is no flat compatibility path; if none of the three answers, the
# container refuses to start from a partial download.
#
# Keep this block in sync with probes/agent/install/install.sh.
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

fetch_manifest() {
    MANIFEST="$(curl -fsSL -H 'cache-control: no-cache' \
        --connect-timeout 10 --max-time 30 "$1" 2>/dev/null || true)"
    [ -n "$MANIFEST" ]
}

# Checksum fallback when the manifest carries none.
sha_from_sums() {
    [ "$RESOLVED_VERSION" = "latest" ] && return 0
    sums="$(curl -fsSL --connect-timeout 10 --max-time 30 \
        "$DOWNLOAD_BASE/$RESOLVED_VERSION/SHA256SUMS" 2>/dev/null || true)"
    [ -n "$sums" ] || return 0
    printf '%s\n' "$sums" | \
        awk -v file="beaconix-probe-$RESOLVED_VERSION.tar.gz" \
            '$2 == file { print $1; exit }'
}

# Most specific source first; the configured base stays authoritative.
candidate_urls() {
    if [ "$RESOLVED_VERSION" != "latest" ]; then
        printf '%s\n' "$DOWNLOAD_BASE/$RESOLVED_VERSION/beaconix-probe-$RESOLVED_VERSION.tar.gz"
    fi
    if [ -n "$MANIFEST_TARBALL" ]; then
        printf '%s\n' "$MANIFEST_TARBALL"
    fi
    printf '%s\n' "$DOWNLOAD_BASE/beaconix-probe-latest.tar.gz"
}

# Resolve `latest` through the manifest; explicit PROBE_VERSION values read that
# version's own manifest, then fall back to its SHA256SUMS.
resolve_payload() {
    RESOLVED_VERSION="$VERSION"
    EXPECTED_SHA=""
    MANIFEST_TARBALL=""

    if [ "$VERSION" = "latest" ]; then
        if fetch_manifest "$DOWNLOAD_BASE/latest.json?ts=$(date +%s)"; then
            RESOLVED_VERSION="$(manifest_field version)"
            EXPECTED_SHA="$(manifest_field sha256)"
            MANIFEST_TARBALL="$(manifest_field tarball)"
        fi
        if [ -z "$RESOLVED_VERSION" ]; then
            log "warning: latest.json unavailable; falling back to the latest alias"
            RESOLVED_VERSION="latest"
        fi
    elif fetch_manifest "$DOWNLOAD_BASE/$VERSION/latest.json?ts=$(date +%s)"; then
        EXPECTED_SHA="$(manifest_field sha256)"
        MANIFEST_TARBALL="$(manifest_field tarball)"
    fi

    if [ -z "$EXPECTED_SHA" ]; then
        EXPECTED_SHA="$(sha_from_sums)"
    fi
}

# Download into a staging directory and swap it in, so a failed download, a
# checksum mismatch or a broken archive never leaves a half-written install.
install_payload() {
    resolve_payload
    log "installing beacon probe agent ($RESOLVED_VERSION) from $DOWNLOAD_BASE"

    staging="$INSTALL_DIR.new"
    archive="$(mktemp)"
    rm -rf "$staging"

    TARBALL_URL=""
    while IFS= read -r url; do
        [ -n "$url" ] || continue
        log "downloading $url"
        if curl -fsSL --connect-timeout 10 --max-time 120 "$url" -o "$archive"; then
            TARBALL_URL="$url"
            break
        fi
        log "warning: $url is unavailable; trying the next source"
    done <<EOF
$(candidate_urls)
EOF

    if [ -z "$TARBALL_URL" ]; then
        log "no release payload found under $DOWNLOAD_BASE (every fallback failed)"
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

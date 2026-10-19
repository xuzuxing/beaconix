#!/bin/sh
#
# Beacon probe agent installer.
#
#   curl -fsSL https://get.beaconix.app/install.sh | sudo sh -s -- [options]
#
# Installs the CLI under /opt/beaconix-probe as the dedicated `beaconix` system
# user and registers a systemd **system** unit.
#
# The payload is resolved through `<download-base>/latest.json` (version +
# sha256 + tarball) and fetched from the immutable
# `<download-base>/<version>/beaconix-probe-<version>.tar.gz` URL:
#
#   1. <download-base>/<version>/beaconix-probe-<version>.tar.gz
#   2. manifest `tarball` (absolute URL written by build-release.js)
#   3. <download-base>/beaconix-probe-latest.tar.gz   (moving alias)
#
# Nothing else is published: there is no flat compatibility path. If none of the
# three sources answers, the installer fails loudly instead of guessing.
#
# The configured download base wins over the manifest's absolute URL, so a
# mirror that overrides BEACON_DOWNLOAD_BASE never falls back to the public host.
#
# Checksums come from the manifest, then from `<version>/SHA256SUMS`, and are
# skipped only when neither is reachable.
#
# Enrollment is optional at install time:
#   --token <t>   redeem a one-time token issued in the web UI (no interaction)
#   --login       run the interactive device-code login right now
#   (neither)     install only — the first probe start prints the approval URL
#
set -eu

DOWNLOAD_BASE="${BEACON_DOWNLOAD_BASE:-https://get.beaconix.app/probe}"
MANIFEST_URL="${BEACON_MANIFEST_URL:-}"
API_URL="${BEACON_API_URL:-}"
ENROLL_TOKEN=""
VERSION="latest"
MANAGE_SERVICE=1
DO_UNINSTALL=0
DO_LOGIN=0

INSTALL_DIR="/opt/beaconix-probe"
BIN_LINK="/usr/local/bin/beaconix-probe"
RUN_USER="beaconix"
CONF_DIR="/etc/beaconix"
LOG_DIR="/var/log/beaconix"
RUN_DIR="/run/beaconix"
UNIT_PATH="/etc/systemd/system/beaconix-probe.service"
SERVICE_NAME="beaconix-probe"

log() { printf '[beaconix-probe] %s\n' "$*"; }
die() { printf '[beaconix-probe] ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
    cat <<'EOF'
Beacon probe agent installer

Usage:
  curl -fsSL https://get.beaconix.app/install.sh | sudo sh -s -- [options]

Options:
  --token <t>       One-time enrollment token issued in the web UI
  --login           Start the interactive device-code login after installing
  --api-url <url>   Beacon API base URL
  --version <v>     Install a specific CLI version (default: latest, resolved via latest.json)
  --no-service      Install/update the payload only; do not touch the unit
  --uninstall       Remove the agent and its systemd unit
  -h, --help        Show this help

Without --token/--login the installer only installs; the first probe start
prints the approval URL (systemd: journalctl -u beaconix-probe -f).
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --token)
            [ $# -ge 2 ] || die "--token needs a value"
            ENROLL_TOKEN="$2"
            shift 2
            ;;
        --api-url)
            [ $# -ge 2 ] || die "--api-url needs a value"
            API_URL="$2"
            shift 2
            ;;
        --version)
            [ $# -ge 2 ] || die "--version needs a value"
            VERSION="$2"
            shift 2
            ;;
        --no-service)
            MANAGE_SERVICE=0
            shift
            ;;
        --login)
            DO_LOGIN=1
            shift
            ;;
        --uninstall)
            DO_UNINSTALL=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "unknown option: $1"
            ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root (use: curl … | sudo sh)"

uninstall() {
    log "removing $SERVICE_NAME"
    if have systemctl; then
        systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
    fi
    rm -f "$UNIT_PATH"
    if have systemctl; then
        systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    rm -rf "$INSTALL_DIR"
    rm -f "$BIN_LINK"
    log "removed the agent (credentials in $CONF_DIR were kept)"
    exit 0
}

if [ "$DO_UNINSTALL" -eq 1 ]; then
    uninstall
fi

ensure_node() {
    if ! have node; then
        die "Node.js >= 18 is required but 'node' was not found; install it and re-run"
    fi
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$major" -lt 18 ]; then
        die "Node.js >= 18 required (found $(node -v))"
    fi
}

ensure_user() {
    if ! id -u "$RUN_USER" >/dev/null 2>&1; then
        log "creating system user '$RUN_USER'"
        useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null \
            || adduser -S -D -H -s /sbin/nologin "$RUN_USER"
    fi
}

prepare_dirs() {
    mkdir -p "$CONF_DIR" "$LOG_DIR" "$RUN_DIR"
    chown "$RUN_USER:$RUN_USER" "$CONF_DIR" "$LOG_DIR" "$RUN_DIR"
    chmod 750 "$CONF_DIR" "$LOG_DIR" "$RUN_DIR"
}

# Fetch a manifest into $MANIFEST (default: the root pointer). Non-zero when
# the manifest cannot be read at all.
fetch_manifest() {
    manifest_url="${1:-${MANIFEST_URL:-$DOWNLOAD_BASE/latest.json}}"
    if have curl; then
        MANIFEST="$(curl -fsSL -H 'cache-control: no-cache' "$manifest_url" 2>/dev/null || true)"
    elif have wget; then
        MANIFEST="$(wget -qO- "$manifest_url" 2>/dev/null || true)"
    else
        MANIFEST=""
    fi
    [ -n "$MANIFEST" ]
}

manifest_field() {
    printf '%s' "$MANIFEST" | \
        node -p "JSON.parse(require('fs').readFileSync(0, 'utf8'))['$1'] || ''" \
            2>/dev/null || true
}

fetch_to() {
    if have curl; then
        curl -fsSL -H 'cache-control: no-cache' "$1" -o "$2"
    elif have wget; then
        wget -qO "$2" "$1"
    else
        return 1
    fi
}

fetch_text() {
    if have curl; then
        curl -fsSL -H 'cache-control: no-cache' "$1" 2>/dev/null || true
    elif have wget; then
        wget -qO- "$1" 2>/dev/null || true
    fi
}

# Resolve version + expected checksum. `latest` reads the root manifest; an
# explicit --version reads that version's own manifest when it exists.
resolve_manifest() {
    resolved_version="$VERSION"
    expected_sha=""
    manifest_tarball=""

    if [ "$VERSION" = "latest" ]; then
        if fetch_manifest; then
            resolved_version="$(manifest_field version)"
            expected_sha="$(manifest_field sha256)"
            manifest_tarball="$(manifest_field tarball)"
        fi
        if [ -z "$resolved_version" ]; then
            log "warning: latest.json unavailable; falling back to the latest alias"
            resolved_version="latest"
        fi
    elif fetch_manifest "$DOWNLOAD_BASE/$VERSION/latest.json"; then
        expected_sha="$(manifest_field sha256)"
        manifest_tarball="$(manifest_field tarball)"
    fi
}

# Fallback checksum source when the manifest did not carry one (or was down).
sha_from_sums() {
    [ "$resolved_version" = "latest" ] && return 0
    sums="$(fetch_text "$DOWNLOAD_BASE/$resolved_version/SHA256SUMS")"
    [ -n "$sums" ] || return 0
    printf '%s\n' "$sums" | \
        awk -v file="beaconix-probe-$resolved_version.tar.gz" \
            '$2 == file { print $1; exit }'
}

# Every place the payload may live, most specific first. The base-derived
# versioned URL comes before the manifest's absolute URL so an overridden
# BEACON_DOWNLOAD_BASE (mirror / staging) stays authoritative.
candidate_urls() {
    if [ "$resolved_version" != "latest" ]; then
        printf '%s\n' "$DOWNLOAD_BASE/$resolved_version/beaconix-probe-$resolved_version.tar.gz"
    fi
    if [ -n "$manifest_tarball" ]; then
        printf '%s\n' "$manifest_tarball"
    fi
    printf '%s\n' "$DOWNLOAD_BASE/beaconix-probe-latest.tar.gz"
}

download_payload() {
    resolve_manifest
    if [ -z "$expected_sha" ]; then
        expected_sha="$(sha_from_sums)"
    fi

    tmp="$(mktemp -d)"
    chosen=""
    while IFS= read -r url; do
        [ -n "$url" ] || continue
        log "downloading $url"
        if fetch_to "$url" "$tmp/agent.tgz"; then
            chosen="$url"
            break
        fi
        log "warning: $url is unavailable; trying the next source"
    done <<EOF
$(candidate_urls)
EOF

    if [ -z "$chosen" ]; then
        rm -rf "$tmp"
        die "no release payload found under $DOWNLOAD_BASE (every fallback failed)"
    fi

    if [ -n "$expected_sha" ] && have sha256sum; then
        printf '%s  agent.tgz\n' "$expected_sha" > "$tmp/agent.sha256"
        if ! ( cd "$tmp" && sha256sum -c agent.sha256 >/dev/null 2>&1 ); then
            rm -rf "$tmp"
            die "payload checksum mismatch for $chosen (stale CDN cache?); try again"
        fi
        log "checksum ok ($expected_sha)"
    fi

    mkdir -p "$INSTALL_DIR"
    tar -xzf "$tmp/agent.tgz" -C "$INSTALL_DIR"
    rm -rf "$tmp"

    chmod +x "$INSTALL_DIR/bin/beaconix-probe.js"
    ln -sf "$INSTALL_DIR/bin/beaconix-probe.js" "$BIN_LINK"
    log "installed CLI to $INSTALL_DIR ($resolved_version, linked at $BIN_LINK)"
}

maybe_enroll() {
    if [ -n "$ENROLL_TOKEN" ]; then
        log "redeeming enrollment token"
        if [ -n "$API_URL" ]; then
            "$BIN_LINK" enroll --enroll-token "$ENROLL_TOKEN" --api-url "$API_URL"
        else
            "$BIN_LINK" enroll --enroll-token "$ENROLL_TOKEN"
        fi
    elif [ "$DO_LOGIN" -eq 1 ]; then
        log "starting interactive device-code login"
        if [ -n "$API_URL" ]; then
            "$BIN_LINK" login --api-url "$API_URL" || \
                log "login did not complete; the probe will retry on startup"
        else
            "$BIN_LINK" login || \
                log "login did not complete; the probe will retry on startup"
        fi
    else
        log "no --token/--login given; the probe will print an approval URL on first start"
    fi

    if [ -f "$CONF_DIR/probe.json" ]; then
        chown "$RUN_USER:$RUN_USER" "$CONF_DIR/probe.json"
        chmod 640 "$CONF_DIR/probe.json"
    fi
}

write_unit() {
    node_bin="$(command -v node)"
    log "writing $UNIT_PATH"
    cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Beacon probe agent
Documentation=https://get.beaconix.app/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$node_bin $INSTALL_DIR/bin/beaconix-probe.js run
Restart=always
RestartSec=5
EnvironmentFile=-$CONF_DIR/probe.env
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$CONF_DIR $LOG_DIR $RUN_DIR

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME" >/dev/null
}

main() {
    ensure_node
    ensure_user
    prepare_dirs
    download_payload
    maybe_enroll

    if [ "$MANAGE_SERVICE" -eq 1 ]; then
        write_unit
        systemctl restart "$SERVICE_NAME"
        "$BIN_LINK" status || true
        if [ ! -f "$CONF_DIR/probe.json" ]; then
            log "authorize this probe; the approval URL is printed by the service:"
            log "  journalctl -u $SERVICE_NAME -f"
        fi
    elif [ ! -f "$CONF_DIR/probe.json" ]; then
        log "authorize this probe by starting it in the foreground:"
        log "  sudo $BIN_LINK run"
    fi

    log "done"
}

main

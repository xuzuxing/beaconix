#!/bin/sh
#
# Beacon probe agent installer.
#
#   curl -fsSL https://get.beacon.dev/install.sh | sudo sh -s -- [options]
#
# Installs the CLI under /opt/beacon-probe as the dedicated `beacon` system
# user, registers a systemd **system** unit, and enrolls the probe — either by
# redeeming a one-time token (handed out by the web UI) or through the
# interactive device-code login.
#
set -eu

DOWNLOAD_BASE="${BEACON_DOWNLOAD_BASE:-https://get.beacon.dev/probe}"
API_URL="${BEACON_API_URL:-}"
ENROLL_TOKEN=""
VERSION="latest"
MANAGE_SERVICE=1
DO_UNINSTALL=0

INSTALL_DIR="/opt/beacon-probe"
BIN_LINK="/usr/local/bin/beacon-probe"
RUN_USER="beacon"
CONF_DIR="/etc/beacon"
LOG_DIR="/var/log/beacon"
RUN_DIR="/run/beacon"
UNIT_PATH="/etc/systemd/system/beacon-probe.service"
SERVICE_NAME="beacon-probe"

log() { printf '[beacon-probe] %s\n' "$*"; }
die() { printf '[beacon-probe] ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
    cat <<'EOF'
Beacon probe agent installer

Usage:
  curl -fsSL https://get.beacon.dev/install.sh | sudo sh -s -- [options]

Options:
  --token <t>       One-time enrollment token issued in the web UI
  --api-url <url>   Beacon API base URL
  --version <v>     Install a specific CLI version (default: latest)
  --no-service      Install/update the payload only; do not touch the unit
  --uninstall       Remove the agent and its systemd unit
  -h, --help        Show this help
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

download_payload() {
    tmp="$(mktemp -d)"
    url="$DOWNLOAD_BASE/beacon-probe-$VERSION.tar.gz"
    log "downloading $url"
    if have curl; then
        curl -fsSL "$url" -o "$tmp/agent.tgz"
    elif have wget; then
        wget -qO "$tmp/agent.tgz" "$url"
    else
        die "curl or wget is required"
    fi

    mkdir -p "$INSTALL_DIR"
    tar -xzf "$tmp/agent.tgz" -C "$INSTALL_DIR"
    rm -rf "$tmp"

    chmod +x "$INSTALL_DIR/bin/beacon-probe.js"
    ln -sf "$INSTALL_DIR/bin/beacon-probe.js" "$BIN_LINK"
    log "installed CLI to $INSTALL_DIR (linked at $BIN_LINK)"
}

enroll_probe() {
    if [ -n "$ENROLL_TOKEN" ]; then
        log "redeeming enrollment token"
        if [ -n "$API_URL" ]; then
            "$BIN_LINK" enroll --enroll-token "$ENROLL_TOKEN" --api-url "$API_URL"
        else
            "$BIN_LINK" enroll --enroll-token "$ENROLL_TOKEN"
        fi
    else
        log "no --token given; starting interactive device-code login"
        if [ -n "$API_URL" ]; then
            "$BIN_LINK" login --api-url "$API_URL" || \
                log "login did not complete; run later: sudo $BIN_LINK login"
        else
            "$BIN_LINK" login || \
                log "login did not complete; run later: sudo $BIN_LINK login"
        fi
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
Documentation=https://get.beacon.dev/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$node_bin $INSTALL_DIR/bin/beacon-probe.js run
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
    enroll_probe

    if [ "$MANAGE_SERVICE" -eq 1 ]; then
        write_unit
        systemctl restart "$SERVICE_NAME"
        "$BIN_LINK" status || true
    fi

    log "done"
}

main

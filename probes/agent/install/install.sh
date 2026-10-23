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
# The API base URL is resolved from --api-url, then BEACON_API_URL, then
# https://beaconix.app/api, and is written to /etc/beaconix/probe.env, the file
# the unit loads. Without it a plain install would run with the agent's built-in
# development default (http://localhost:3000/api), which preflight rejects with
# "Insecure API URL" and the service would restart-loop. An address already in
# probe.env is kept unless --api-url/BEACON_API_URL overrides it, so re-running
# the installer never repoints a mirror/staging probe at production silently.
#
# Node.js >= 18 is a prerequisite. `sudo` resets PATH to `secure_path`, so a node
# installed per-user (nvm / fnm / volta / asdf) is invisible to this script even
# when `node -v` works in the invoking shell. `ensure_node` therefore also probes
# the usual install roots, and `BEACON_NODE_BIN=/path/to/node` overrides the
# lookup outright.
#
# `sudo` also runs with env_reset, so an exported BEACON_NODE_BIN never reaches
# this script; pass it *after* sudo instead:
#
#   curl -fsSL https://get.beaconix.app/install.sh \
#       | sudo BEACON_NODE_BIN="$(command -v node)" sh -s --
#
# The CLI is linked through a small wrapper that execs the resolved node binary,
# so `beaconix-probe …` keeps working when `node` is not on the caller's PATH
# (the systemd unit does not need it: it calls node directly).
#
set -eu

DOWNLOAD_BASE="${BEACON_DOWNLOAD_BASE:-https://get.beaconix.app/probe}"
MANIFEST_URL="${BEACON_MANIFEST_URL:-}"
DEFAULT_API_URL="https://beaconix.app/api"
API_URL="${BEACON_API_URL:-}"
# Whether the address came from --api-url / BEACON_API_URL rather than the
# default: only an explicit address overwrites one already in probe.env.
API_URL_EXPLICIT=0
if [ -n "$API_URL" ]; then
    API_URL_EXPLICIT=1
fi
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
  --api-url <url>   Beacon API base URL (default: https://beaconix.app/api);
                    recorded in /etc/beaconix/probe.env
  --version <v>     Install a specific CLI version (default: latest, resolved via latest.json)
  --no-service      Install/update the payload only; do not touch the unit
  --uninstall       Remove the agent and its systemd unit
  -h, --help        Show this help

Without --token/--login the installer only installs; the first probe start
prints the approval URL (systemd: journalctl -u beaconix-probe -f).

Environment:
  BEACON_API_URL    Beacon API base URL (default: https://beaconix.app/api).
                    An address already in /etc/beaconix/probe.env is kept
                    unless this (or --api-url) is given explicitly.
  BEACON_NODE_BIN   Absolute path to the node binary (default: PATH, then the
                    usual install roots such as /usr/local/bin, nvm, fnm).
                    `sudo` clears the environment, so with `curl | sudo sh` set
                    it after sudo, e.g.
                      … | sudo BEACON_NODE_BIN=/path/to/node sh -s --
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
            API_URL_EXPLICIT=1
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

if [ -z "$API_URL" ]; then
    API_URL="$DEFAULT_API_URL"
fi

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
    log "removed the agent (credentials and probe.env in $CONF_DIR were kept)"
    exit 0
}

if [ "$DO_UNINSTALL" -eq 1 ]; then
    uninstall
fi

NODE_BIN=""

# Major version of a node binary; empty when it cannot be determined.
node_major_of() {
    version_out="$("$1" -v 2>/dev/null || true)"
    printf '%s' "${version_out#v}" | cut -d. -f1
}

# Roots used by the per-user version managers (nvm, fnm, volta, asdf).
node_version_roots() {
    printf '%s\n' \
        "${NVM_DIR:-}" \
        "${HOME:-}/.nvm" \
        /root/.nvm \
        /usr/local/nvm \
        /usr/local/share/nvm \
        /opt/nvm
    if [ -n "${SUDO_USER:-}" ]; then
        sudo_home="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6 || true)"
        if [ -n "$sudo_home" ]; then
            printf '%s\n' "$sudo_home/.nvm" "$sudo_home/.fnm" "$sudo_home/.volta" "$sudo_home/.asdf"
        fi
    fi
}

# Print a usable node path, preferring one >= 18. Empty when nothing was found.
find_node_bin() {
    first_any=""
    for candidate in \
        /usr/local/bin/node /usr/bin/node /bin/node /snap/bin/node \
        /opt/node/bin/node /opt/nodejs/bin/node /opt/nodejs/*/bin/node \
        /usr/local/node/bin/node /usr/local/nodejs/bin/node
    do
        [ -x "$candidate" ] || continue
        [ -n "$first_any" ] || first_any="$candidate"
        candidate_major="$(node_major_of "$candidate")"
        if [ -n "$candidate_major" ] && [ "$candidate_major" -ge 18 ] 2>/dev/null; then
            printf '%s' "$candidate"
            return 0
        fi
    done

    roots="$(node_version_roots)"
    while IFS= read -r root; do
        [ -n "$root" ] || continue
        for candidate in \
            "$root"/versions/node/*/bin/node \
            "$root"/node-versions/*/installation/bin/node \
            "$root"/bin/node \
            "$root"/shims/node
        do
            [ -x "$candidate" ] || continue
            [ -n "$first_any" ] || first_any="$candidate"
            candidate_major="$(node_major_of "$candidate")"
            if [ -n "$candidate_major" ] && [ "$candidate_major" -ge 18 ] 2>/dev/null; then
                printf '%s' "$candidate"
                return 0
            fi
        done
    done <<EOF
$roots
EOF

    printf '%s' "$first_any"
    return 0
}

ensure_node() {
    node_source="PATH"
    NODE_BIN="${BEACON_NODE_BIN:-}"
    if [ -n "$NODE_BIN" ]; then
        node_source="BEACON_NODE_BIN"
        [ -x "$NODE_BIN" ] || die "BEACON_NODE_BIN=$NODE_BIN is not an executable file"
    else
        NODE_BIN="$(command -v node 2>/dev/null || true)"
    fi

    if [ -z "$NODE_BIN" ]; then
        node_source="install-root scan"
        NODE_BIN="$(find_node_bin)"
        [ -n "$NODE_BIN" ] || die "Node.js >= 18 is required but 'node' was not found. \
PATH is '$PATH' and no node binary exists in the usual install roots. \
'sudo' resets PATH, so an nvm/fnm install needs 'sudo env \"PATH=\$PATH\" sh' \
or BEACON_NODE_BIN=/path/to/node."
        log "node is not on PATH (sudo resets it); using $NODE_BIN"
    fi

    case "$NODE_BIN" in
        /*) ;;
        *)
            # A relative BEACON_NODE_BIN (or a non-absolute PATH hit) would land
            # verbatim in ExecStart=, which systemd refuses.
            node_abs_dir="$(cd "$(dirname "$NODE_BIN")" 2>/dev/null && pwd)" || node_abs_dir=""
            [ -n "$node_abs_dir" ] || die "cannot resolve $NODE_BIN to an absolute path"
            NODE_BIN="$node_abs_dir/$(basename "$NODE_BIN")"
            ;;
    esac

    node_dir="$(dirname "$NODE_BIN")"
    case ":$PATH:" in
        *":$node_dir:"*) ;;
        *)
            PATH="$node_dir:$PATH"
            export PATH
            ;;
    esac

    node_version="$("$NODE_BIN" -v 2>/dev/null || true)"
    node_major="${node_version#v}"
    node_major="${node_major%%.*}"
    case "$node_major" in
        ''|*[!0-9]*)
            die "could not determine the Node.js version of $NODE_BIN (got '$node_version')"
            ;;
    esac
    [ "$node_major" -ge 18 ] || die "Node.js >= 18 required (found $node_version at $NODE_BIN)"

    case "$NODE_BIN" in
        /root/*|/home/*)
            if [ "$MANAGE_SERVICE" -eq 1 ]; then
                die "Node.js was found at $NODE_BIN, which the '$RUN_USER' service user \
cannot reach (the unit sets ProtectHome=true). Install a system-wide Node.js \
(apt/nodesource to /usr/bin/node, or the official tarball under /usr/local) and re-run, \
or install with --no-service."
            fi
            log "warning: $NODE_BIN lives in a home directory, which the unit's"
            log "         ProtectHome=true hides; only manual runs will work:"
            log "           sudo $BIN_LINK run"
            ;;
    esac

    log "using Node.js $node_version from $NODE_BIN ($node_source)"
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

# Record the API URL in probe.env, the file the unit loads via
# `EnvironmentFile=-`. Without it a plain install falls through to the agent's
# built-in default (http://localhost:3000/api), which preflight rejects and the
# service restart-loops. Unknown keys are preserved so a hand-edited probe.env
# survives a reinstall, and an address already configured there is kept unless
# --api-url / BEACON_API_URL overrides it explicitly.
write_env_file() {
    env_file="$CONF_DIR/probe.env"
    tmp_env="$env_file.new.$$"
    existing=""
    : > "$tmp_env"
    if [ -f "$env_file" ]; then
        while IFS= read -r line || [ -n "$line" ]; do
            case "$line" in
                BEACON_API_URL=*)
                    existing="${line#BEACON_API_URL=}"
                    continue
                    ;;
            esac
            printf '%s\n' "$line" >> "$tmp_env"
        done < "$env_file"
    fi

    if [ "$API_URL_EXPLICIT" -eq 0 ] && [ -n "$existing" ]; then
        API_URL="$existing"
        log "keeping the API url already set in $env_file"
    fi

    printf 'BEACON_API_URL=%s\n' "$API_URL" >> "$tmp_env"
    mv "$tmp_env" "$env_file"
    chown root:"$RUN_USER" "$env_file" 2>/dev/null || true
    chmod 640 "$env_file"
    log "api url: $API_URL (in $env_file)"
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
        "${NODE_BIN:-node}" -p "JSON.parse(require('fs').readFileSync(0, 'utf8'))['$1'] || ''" \
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

# /usr/local/bin/beaconix-probe is a wrapper, not a symlink: the CLI is a
# `#!/usr/bin/env node` script, which would not find a node missing from the
# caller's PATH (sudo's secure_path, an nvm-only install, …).
write_bin_link() {
    mkdir -p "$(dirname "$BIN_LINK")"
    # `>` follows a symlink, so drop a pre-existing link before writing.
    rm -f "$BIN_LINK"
    cat > "$BIN_LINK" <<EOF
#!/bin/sh
# Generated by the Beacon probe installer; reinstall to point it elsewhere.
exec "$NODE_BIN" "$INSTALL_DIR/bin/beaconix-probe.js" "\$@"
EOF
    chmod 755 "$BIN_LINK"
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
    write_bin_link
    log "installed CLI to $INSTALL_DIR ($resolved_version, linked at $BIN_LINK)"
}

maybe_enroll() {
    if [ -n "$ENROLL_TOKEN" ]; then
        log "redeeming enrollment token"
        "$BIN_LINK" enroll --enroll-token "$ENROLL_TOKEN" --api-url "$API_URL"
    elif [ "$DO_LOGIN" -eq 1 ]; then
        log "starting interactive device-code login"
        "$BIN_LINK" login --api-url "$API_URL" || \
            log "login did not complete; the probe will retry on startup"
    else
        log "no --token/--login given; the probe will print an approval URL on first start"
    fi

    if [ -f "$CONF_DIR/probe.json" ]; then
        chown "$RUN_USER:$RUN_USER" "$CONF_DIR/probe.json"
        chmod 640 "$CONF_DIR/probe.json"
    fi
}

write_unit() {
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
ExecStart="$NODE_BIN" $INSTALL_DIR/bin/beaconix-probe.js run
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
    write_env_file
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

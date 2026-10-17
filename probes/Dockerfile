# Beacon probe agent — runtime bootstrap image.
#
# The image contains no agent code. On first start the entrypoint downloads the
# published payload into the /data volume, runs the device-code login and prints
# the verification URL; later starts reuse both and go straight to `run`.
#
# Build:
#   docker build -f probes/Dockerfile -t beacon-probe probes
#
# Run (mount a volume so the install and credentials survive restarts):
#   docker run -d --name beacon-probe --restart unless-stopped \
#     -e BEACON_API_URL=https://api.example.com/api \
#     -v beacon-probe-data:/data \
#     beacon-probe
#
#   docker logs -f beacon-probe     # open the printed URL to approve
#
# Optional: pin a release (PROBE_VERSION=2.0.0), use a one-time token instead of
# the device flow (PROBE_ENROLL_TOKEN=...), or point at an internal mirror
# (BEACON_DOWNLOAD_BASE=https://cdn.example.com/probe).
#
# Outbound only: do not publish ports. No healthcheck: there is no local
# endpoint; watch the backend's "last heartbeat" instead.

FROM node:22-alpine

RUN apk add --no-cache curl

ENV BEACON_HOME=/data/etc \
    BEACON_LOG_DIR=/data/logs \
    BEACON_RUN_DIR=/data/run \
    PROBE_INSTALL_DIR=/data/agent

# A named volume mounted on /data inherits this ownership on first use, so the
# unprivileged `node` user can install the payload and write credentials.
RUN mkdir -p /data/agent /data/etc /data/logs /data/run \
    && chown -R node:node /data

COPY docker-entrypoint.sh /usr/local/bin/beaconix-probe-entrypoint
RUN chmod 0755 /usr/local/bin/beaconix-probe-entrypoint

USER node
WORKDIR /data
VOLUME ["/data"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/beaconix-probe-entrypoint"]

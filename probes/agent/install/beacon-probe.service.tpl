[Unit]
Description=Beacon probe agent
Documentation=https://get.beaconix.app/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__RUN_USER__
Group=__RUN_USER__
WorkingDirectory=__INSTALL_DIR__
ExecStart=__NODE_BIN__ __INSTALL_DIR__/bin/beaconix-probe.js run
Restart=always
RestartSec=5
EnvironmentFile=-__CONF_DIR__/probe.env
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=__CONF_DIR__ __LOG_DIR__ __RUN_DIR__

[Install]
WantedBy=multi-user.target

# Beacon 探针（Probe Agent）

本目录是 Beacon 的**探针执行程序**：部署在用户侧（服务器 / 容器 / 云函数），
主动**出站**连接 Beacon API，拉取分配给自己的监控目标，回报检测结果。

- **纯出站**：不监听任何端口，无需公网入站。
- **零运行时依赖**：只需 Node.js ≥ 18，无第三方包。
- **两条注册路径**：CLI 设备码登录，或 Web 下发一次性 token。
- **凭据安全**：服务端只存 sha256 哈希，支持吊销与平滑轮换。

## 目录结构

```
probes/agent/
├── bin/beaconix-probe.js      # CLI 入口
├── src/
│   ├── cli.js               # 命令分发
│   ├── config.js            # 参数 / 环境变量 / 配置文件解析
│   ├── paths.js             # 运行时路径（凭据、日志、pid）
│   ├── credentials.js       # 凭据读写
│   ├── api.js               # Beacon API 客户端（心跳 / 上报 / 校验）
│   ├── enroll.js            # 设备码 + 一次性 token 注册
│   ├── checks.js            # HTTP / TCP 检测
│   ├── schedule.js          # 本地检查调度（并发 / 背压 / 退避）
│   ├── validation.js        # 校验挑战应答（AES-256-GCM）
│   ├── preflight.js         # 凭据与 TLS 前置校验
│   ├── commands/            # 各子命令的实现
│   └── service/             # systemd / launchd / pidfile 集成
├── functions/scf.js         # 腾讯云 SCF 入口（单次执行）
├── install/                 # install.sh 与 systemd unit 模板
├── scripts/build-release.js # 发布打包（tar.gz / SCF zip / latest.json）
├── docker-entrypoint.sh     # 容器入口（首次下载安装 + 登录）
├── docker-compose.yml       # 容器部署（运行时下载安装 + 登录，配套 probe.env.example）
└── test/                    # node --test 用例
```

## 部署形态

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| systemd 常驻 | `install/install.sh` → `beaconix-probe run` | 生产推荐；安装只装程序，首次启动自动打印设备码授权链接（`journalctl -u beaconix-probe -f`） |
| 容器 | [`Dockerfile`](Dockerfile) / [`agent/docker-compose.yml`](agent/docker-compose.yml) | 首次启动自动下载安装并打印设备码登录地址，登录后常驻 `run`；`/data` 卷保存安装与凭据 |
| 云函数 | `functions/scf.js` | 每次触发执行**一轮**；无本地调度，见下方文档 |

`install.sh` 默认只安装并启动服务，授权在首次启动时由 `run` 自动发起：

```bash
curl -fsSL https://get.beaconix.app/install.sh | sudo sh
```

- `--token <t>`：用 Web「添加探针」下发的一次性 token 直接注册（无交互）；
- `--login`：安装时立即走设备码登录（阻塞到授权成功或超时）；
- `--no-service`：只装程序，之后手动 `sudo beaconix-probe run`。

本地批量测试可使用 [系统探针测试容器](test-fleet/README.md)：启动时通过管理员账号登录，
自动补齐默认 100 个专用系统探针，并在一个容器里运行独立 Agent 进程。
创建返回的凭据保存在持久卷中供重启复用；需要在测试后端显式提高同 IP 限流额度。
测试容器配置集中在本目录的 `Dockerfile.probe-test` 和 `docker-compose.probe-test.yml`，
从仓库根目录运行 `docker compose -f probes/docker-compose.probe-test.yml up --build -d`。

> 云函数与常驻模型有本质差异（无本地调度、凭据靠环境变量、心跳周期必须等于触发器周期），
> 部署前请阅读 [云函数（SCF）部署指南](../docs/guides/probe-scf-deployment.md)。

## 命令

**注册**

| 命令 | 说明 |
| --- | --- |
| `login` | OAuth2 设备码登录：打印验证链接与用户码并轮询至授权 |
| `enroll --enroll-token <t>` | 用 Web「添加探针」下发的一次性 token 注册 |
| `logout [--revoke]` | 删除本地凭据；`--revoke` 同时在后端吊销 |
| `revoke` | 仅在后端吊销凭据（保留本地文件） |

**服务生命周期**

| 命令 | 说明 |
| --- | --- |
| `start [--foreground]` | 启动（优先 systemd/launchd unit，否则 pidfile 后台进程） |
| `stop` / `restart` | 停止 / 重启 |
| `status` | 显示凭据、服务单元与后台进程状态 |
| `self-update [--check]` | 比对已发布版本；`--check` 只检查不安装 |

**探针运行**

| 命令 | 说明 |
| --- | --- |
| `run [--once]` | 前台常驻（默认命令）；无凭据时自动发起设备码授权并打印链接，`--once` 只跑一轮（仍需先注册） |
| `validate` | 部署校验：TLS + 心跳往返 + key 匹配 |
| `heartbeat` | 发送单次心跳并打印响应（排查用） |

其它：`version`、`help`（`-h` / `--help`）。

## 配置

优先级：**CLI 参数 > 环境变量 > `--config` / `PROBE_CONFIG` > 凭据文件 > 默认值**。

| 配置 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `apiUrl` | `BEACON_API_URL` | `http://localhost:3000/api` | 后台 API 根地址 |
| `key` | `PROBE_KEY` | — | 探针 id |
| `token` | `PROBE_TOKEN` / `PROBE_SECRET` | — | 探针 secret |
| `intervalSeconds` | `PROBE_INTERVAL_SECONDS` | `60` | 心跳间隔；**云函数下必须等于定时触发器周期** |
| `timeoutMs` | `PROBE_TIMEOUT_MS` | `5000` | 单次请求 / 检测超时 |
| `maxResultsPerReport` | `PROBE_MAX_RESULTS` | `100` | 单次上报条数上限（≤ 100） |
| `allowInsecure` | `PROBE_ALLOW_INSECURE` | `false` | 允许 `http://`（仅测试，生产禁用） |
| — | `PROBE_CONCURRENCY` | `3` | 单轮并发检查数（上限 20） |
| — | `PROBE_ENROLL_TOKEN` | — | 无凭据时用一次性 token 自动注册（容器 / 无人值守） |
| — | `BEACON_HOME` / `BEACON_CREDENTIALS` | 见 `src/paths.js` | 凭据与运行目录覆盖 |

## 凭据与安全

- secret 形如 `tnt_<64hex>`，**只在创建 / 轮换的响应里返回一次**。
- 服务端只存其 **sha256 哈希**（`probe_secrets` 表），不落明文。
- 支持**吊销**（`revokedAt`）与**平滑轮换**：轮换后旧 secret 保留 24h 宽限，探针不掉线。
- 常驻部署凭据落在 `/etc/beaconix/probe.json`（`0640`，属主 `beaconix`）；
  容器 / 云函数改为环境变量注入，不写盘。
- 强制 HTTPS；仅 `localhost` 或显式 `PROBE_ALLOW_INSECURE=true` 时才允许明文。

## 本地运行与测试

```bash
# 从仓库根直接运行 CLI
node probes/agent/bin/beaconix-probe.js --help
node probes/agent/bin/beaconix-probe.js run --once

# 单元测试（注册、服务生命周期、self-update、SCF 单次执行）
cd probes/agent && node --test
# 从仓库根跑同一套用例
pnpm probe:test

# 打发布包（tar.gz / SCF zip / latest.json，输出到 probes/agent/dist）
pnpm probe:pack

# 本地调试 SCF 入口
BEACON_API_URL=https://api.example.com/api \
PROBE_KEY=<probe id> PROBE_TOKEN=<probe secret> PROBE_INTERVAL_SECONDS=300 \
node probes/agent/functions/scf.js
```

## 相关文档

- [探针 Agent 与 CLI 设计](../docs/design/probe-agent.md)
- [云函数（SCF）部署指南](../docs/guides/probe-scf-deployment.md)
- [打包与发布指南](RELEASE.md)

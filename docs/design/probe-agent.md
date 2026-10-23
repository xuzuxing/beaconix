# 探针 Agent 与 CLI 设计

> 探针执行端（`probes/agent/`）是一个独立 CLI 工程：零运行时依赖、纯出站、两条注册路径、`install.sh` 一键装成 systemd 常驻服务。本文说明它的注册与凭据模型、命令与配置、安装方式，以及和后端之间的心跳 / 上报 / 校验协议。

日常安装与运行见 [探针使用说明](../../probes/README.md)；上报可靠性与归属规则见 [监控运行指南](../guides/monitoring-operations.md)；云函数部署见 [SCF 部署指南](../guides/probe-scf-deployment.md)。

## 1. 设计要点

| 决策项     | 结论                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| CLI 形态   | `probes/agent/` 独立工程（`@beaconix/probe-agent`），多文件结构 + 版本号 + `self-update`，零运行时依赖      |
| 运行时     | Node.js ≥ 18，只用标准库；`bin/beaconix-probe.js` 是唯一入口                                                |
| 注册方向   | 两条都支持：CLI 发起 Device Flow（RFC 8628），或 Web 端下发一次性安装命令                                   |
| 安装终点   | `curl … \| sudo sh` 一路做到「安装 → 注册 → 启动」，无需后续手工命令                                        |
| 常驻方式   | systemd **system** unit（`/etc/systemd/system/beaconix-probe.service`），以专用 `beaconix` 用户运行         |
| 落盘位置   | 安装目录 `/opt/beaconix-probe`；凭据 `/etc/beaconix/probe.json`；日志 `/var/log/beaconix`；运行目录 `/run/beaconix` |
| 通信方向   | 纯出站，不监听任何端口；身份只通过请求头 `x-probe-secret` 表达                                              |
| 凭据存储   | 服务端只存 secret 的 sha256（`probe_secrets`），明文仅在注册 / 轮换响应中返回一次                           |

## 2. 目录结构

```
probes/agent/
├── package.json                     # name / version / bin（beaconix-probe）
├── bin/beaconix-probe.js            # CLI 入口，只做 argv → 调度
├── src/
│   ├── cli.js                       # 命令分发 + help
│   ├── config.js                    # 参数解析与配置合并（参数 > env > 文件 > 默认）
│   ├── constants.js                 # 协议常量（header、UA、默认值、并发/背压上限）
│   ├── paths.js                     # 凭据 / 日志 / pid / unit 名
│   ├── credentials.js               # 凭据读写（0640）
│   ├── api.js                       # HTTP 客户端：heartbeat / results / validation / revoke
│   ├── enroll.js                    # 设备码流程 + 一次性 token 兑换
│   ├── checks.js                    # HTTP / TCP 检测
│   ├── schedule.js                  # 本地调度：到期判定、并发、背压、结果缓冲
│   ├── validation.js                # 校验挑战解密 / 应答加密
│   ├── preflight.js                 # 凭据齐全性 + 强制 HTTPS
│   ├── logger.js / util.js          # 输出与工具
│   ├── version.js
│   ├── commands/                    # login enroll logout revoke start stop restart status run validate heartbeat self-update
│   └── service/                     # systemd / launchd / pidfile 三种后端
├── functions/scf.js                 # 腾讯云 SCF 入口（每次触发执行一轮）
├── install/
│   ├── install.sh                   # 安装脚本（托管在 get.beaconix.app）
│   └── beacon-probe.service.tpl     # unit 占位符模板（install.sh 内联生成同等内容）
└── test/                            # node --test 用例（注册、上报、SCF、self-update、服务后端）
```

## 3. 注册与凭据

### 3.1 路径 A：CLI 发起设备码（RFC 8628）

```
$ sudo beaconix-probe login
Requesting access for host-01 (linux) ...
Open:  https://beaconix.app/activate?code=WDJB-MJHT
Code:  WDJB-MJHT
Waiting for approval ...
Enrollment approved: probe=probe_xxx
Credentials saved to /etc/beaconix/probe.json
```

1. CLI `POST /api/probes/enroll/device`，上报 `client` / `hostname` / `platform` / `runtime` 供确认页展示。
2. 后端返回 `deviceCode`、`userCode`（`XXXX-XXXX`，易读字符集）、`verificationUri(-Complete)`、`expiresIn`(600s)、`interval`(5s)。
3. 运维在浏览器确认页登录后点击授权：`POST /api/probes/enroll/approve` 建探针并写一次性凭据。
4. CLI 按 `interval` 轮询 `POST /api/probes/enroll/token`，拿到 `approved` 后取走凭据并落盘；`denied` / `expired` 终止，`slow_down` 增加等待。

浏览器自动打开失败不影响流程，验证地址与用户码始终打印在终端；`--no-open` 可禁用自动打开。

### 3.2 路径 B：Web 发起一次性 token

1. Web 端「添加探针」调 `POST /api/organizations/:orgId/probes/enroll-token`，返回 `token`（`bet_<48hex>`）、`expiresAt`、`command`、`apiUrl`。
2. 页面展示可复制命令（已带上 API 地址，避免机器回落到内置默认值）：

    ```bash
    curl -fsSL https://get.beaconix.app/probe/install.sh | sudo sh -s -- --token=bet_xxx --api-url=https://api.example.com/api
    ```

3. `install.sh` 把 `--token` 转成 `beaconix-probe enroll --enroll-token=bet_xxx`。
4. CLI 调 `POST /api/probes/enroll/redeem`，用 token 换 `{ probeId, secret, apiUrl }` → 写凭据 → 启动服务。

此路径**无浏览器交互**，适合管理员在 Web 上分配探针、把命令交给运维或机器执行。

### 3.3 后端端点

实现位于 `src/modules/probes/probe-enrollment.controller.ts` / `probe-enrollment.service.ts`。

| 端点                                                 | 鉴权                 | 说明                                                                     |
| ---------------------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `POST /api/probes/enroll/device`                     | `@Public()`          | 生成 `deviceCode` + `userCode`，返回 `verificationUri`、`expiresIn`、`interval` |
| `POST /api/probes/enroll/token`                      | `@Public()`          | 轮询换凭据：`pending` / `approved` / `denied` / `expired`                |
| `GET /api/probes/enroll/activate?code=`              | `@Public()`          | 待授权信息 JSON，供前端 SPA 渲染确认页                                   |
| `POST /api/probes/enroll/approve`                    | JWT + org OWNER/ADMIN | 建探针（校验 `tenantProbe` 功能与 `probes` 配额），写一次性凭据          |
| `POST /api/probes/enroll/redeem`                     | `@Public()`          | 用 Web 下发的一次性 token 换凭据                                         |
| `POST /api/organizations/:orgId/probes/enroll-token` | JWT + org ADMIN      | 生成一次性安装 token                                                     |
| `POST /api/probes/revoke`                            | `x-probe-secret`     | 探针自吊销（`logout --revoke` / `revoke` 调用）                          |

- `approve` 的权限判定在服务层：`SUPER_ADMIN` 直接通过，其余要求目标组织的 `OWNER` / `ADMIN` 成员。
- 确认页由前端 SPA 渲染，本仓库只提供 `activate`（数据）与 `approve`（授权），不新增 `views/*.hbs`。
- 探针创建统一走 `ProbesService.create`，因此配额、默认值（名称、`provider`、`region`）与后台手工添加完全一致。
- 下发给探针/运维的三个对外地址统一由 `ProbeEndpointsService` 解析：管理页「探针」
  分组的 `probe.endpoint.activateUrl` / `probe.endpoint.publicApiUrl` /
  `probe.endpoint.installUrl` 优先（SUPER_ADMIN 可改），留空则回退环境变量
  `BEACON_ACTIVATE_URL` / `BEACON_PUBLIC_API_URL` / `BEACON_INSTALL_URL`，最后落到内置
  默认值（`https://beaconix.app/activate`、`https://beaconix.app/api`、
  `https://get.beaconix.app/install.sh`）。`BEACON_DOWNLOAD_BASE` 属于发布侧/客户端
  变量，后端不消费。

### 3.4 Redis 键

复用 `RedisService`，注册态不落库（授权历史走 `AuditLog`，不新增表）：

| 键                               | 值                                                           | TTL  |
| -------------------------------- | ------------------------------------------------------------ | ---- |
| `probe:enroll:dc:<deviceCode>`   | `{ status, userCodeHash, client, organizationId?, probeId?, createdAt }` | 600s |
| `probe:enroll:uc:<userCodeHash>` | `<deviceCode>`                                               | 600s |
| `probe:enroll:cred:<deviceCode>` | 一次性凭据 `{ probeId, secret, apiUrl }`（`consumeJson`）    | 60s  |
| `probe:enroll:tok:<enrollToken>` | `{ organizationId, createdById, name?, provider?, region? }` | 900s |

`userCode` 只存 hash，比对时先归一化（去空格/连字符、转大写）；凭据与 token 均为一次性消费，重复使用返回未授权。

### 3.5 凭据模型

- **生成**：secret 形如 `tnt_<64hex>`，仅在创建 / 轮换响应中返回一次；库里只存 sha256（`probe_secrets`）。
- **校验**：请求头 `x-probe-secret` → sha256 → 查 `probe_secrets`，再校验 `revokedAt`、`expiresAt` 与 `probe.enabled`。
- **吊销**：`POST /api/probes/revoke` 或后台操作写入 `revokedAt`。
- **轮换**：签发新 secret 后旧值保留 24h 宽限，探针不掉线。
- **落盘**：常驻部署写 `/etc/beaconix/probe.json`（`0640`，属主 `beaconix`）；容器与云函数改为环境变量注入，不写盘。
- **配额**：探针数量与 `tenantProbe` 功能由 `QuotaService` 在校验，超限时注册请求直接失败。

## 4. CLI

### 4.1 命令矩阵

| 命令                                    | 行为                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `login`                                 | 设备码注册（路径 A）；`--no-open` 不自动打开浏览器                            |
| `enroll --enroll-token=…`               | 一次性 token 注册（路径 B）                                                   |
| `logout [--revoke]`                     | 删除本地凭据，`--revoke` 同时在后端吊销                                       |
| `revoke`                                | 仅吊销后端凭据，保留本地文件                                                  |
| `start [--foreground]`                  | 启动：优先已安装的 init unit，否则用 pidfile 拉起后台进程                     |
| `stop` / `restart` / `status`           | 停止 / 重启 / 查看凭据与服务状态                                              |
| `run [--once]`                          | 前台常驻（默认命令，`--once` 只跑一轮）                                       |
| `validate`                              | 部署校验：凭据 → HTTPS → 心跳往返 → key 匹配                                  |
| `heartbeat`                             | 单次心跳并打印响应，用于排查                                                  |
| `self-update [--check]`                 | 比对 `latest.json`；只提示安装命令，不自行改写系统文件                        |
| `version` / `help`                      | 版本 / 帮助                                                                   |

配置加载优先级：**CLI 参数 > 环境变量 > `--config` / `PROBE_CONFIG` > 凭据文件 > 默认值**。未显式指定配置文件时，`login` / `enroll` 写下的凭据文件即配置文件。

### 4.2 配置项

| 配置                  | 环境变量                               | 默认                        | 说明                                             |
| --------------------- | -------------------------------------- | --------------------------- | ------------------------------------------------ |
| `apiUrl`              | `BEACON_API_URL`                       | `http://localhost:3000/api` | API 根地址，自动去尾部 `/`                       |
| `key`                 | `PROBE_KEY`                            | —                           | 探针 id（注册时下发）                            |
| `token`               | `PROBE_TOKEN` / `PROBE_SECRET`         | —                           | 探针 secret                                      |
| `intervalSeconds`     | `PROBE_INTERVAL_SECONDS`               | `60`                        | 心跳间隔；云函数下必须等于定时触发器周期         |
| `timeoutMs`           | `PROBE_TIMEOUT_MS`                     | `5000`                      | 单次请求 / 检测超时（≥ 100）                     |
| `maxResultsPerReport` | `PROBE_MAX_RESULTS`                    | `100`                       | 单次上报条数（1–100，与后端 `ArrayMaxSize(100)` 对齐） |
| `allowInsecure`       | `PROBE_ALLOW_INSECURE`                 | `false`                     | 允许明文 `http://`（仅本地/测试）                |
| 检查并发              | `PROBE_CONCURRENCY`                    | `3`                         | 单轮并发检查数，上限 `20`                        |
| 路径覆盖              | `BEACON_HOME` / `BEACON_CREDENTIALS` / `BEACON_LOG_DIR` / `BEACON_RUN_DIR` | 见 `src/paths.js` | 测试与本地运行避免写入系统目录                   |

对应 CLI 参数：`--api-url`、`--key`、`--token`/`--secret`、`--enroll-token`、`--interval-seconds`、`--timeout-ms`、`--allow-insecure`、`--config`，以及 `--once` / `--check` / `--revoke` / `--foreground` / `--no-open` 等命令修饰符。

## 5. 安装与常驻服务

### 5.1 install.sh

```bash
curl -fsSL https://get.beaconix.app/probe/install.sh | sudo sh -s -- [--token=…] [--api-url=…] [--version=…] [--no-service] [--uninstall]
```

1. 校验 root（system unit 需要）。
2. 校验 `node` 与主版本 ≥ 18；缺失直接报错退出，不代装。
3. 创建系统用户 `beaconix`（`--system --no-create-home --shell nologin`）。
4. 建目录并授权：`/etc/beaconix`、`/var/log/beaconix`、`/run/beaconix`（`0750`，属 `beaconix`）。
5. 下载 `beaconix-probe-<version>.tar.gz` 解压到 `/opt/beaconix-probe`，软链 `/usr/local/bin/beaconix-probe`。
6. 注册：带 `--token` 走 `enroll --enroll-token`；否则打印设备码指引并执行 `login`。随后把 `probe.json` 交给 `beaconix` 用户（`0640`）。
7. 写 unit → `daemon-reload` → `enable` → `restart` → 打印 `status`（`--no-service` 跳过本步）。

脚本幂等，可重复执行（升级即重跑并带 `--version`）。`--uninstall` 停止并删除 unit 与安装目录，**保留** `/etc/beaconix` 下的凭据。

### 5.2 systemd system unit

```ini
[Unit]
Description=Beacon probe agent
Documentation=https://get.beaconix.app/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=beaconix
Group=beaconix
WorkingDirectory=/opt/beaconix-probe
ExecStart=<node> /opt/beaconix-probe/bin/beaconix-probe.js run
Restart=always
RestartSec=5
EnvironmentFile=-/etc/beaconix/probe.env
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/etc/beaconix /var/log/beaconix /run/beaconix

[Install]
WantedBy=multi-user.target
```

`start` / `stop` / `restart` / `status` 在 Linux 驱动 systemd，macOS 回退 launchd，两者都不可用时用 pidfile 管理后台进程；后台进程通过环境变量继承前台参数，行为与前台 `run` 一致。

### 5.3 其它部署形态

| 形态       | 入口                                   | 说明                                                                 |
| ---------- | -------------------------------------- | -------------------------------------------------------------------- |
| systemd    | `install/install.sh` → `run`           | 生产推荐；凭据落 `/etc/beaconix`，本地调度常驻                       |
| 云函数 SCF | `functions/scf.js`（`main_handler`）   | 每次触发执行**一轮**，无本地调度；`PROBE_INTERVAL_SECONDS` 必须等于触发周期 |
| 容器       | `probes/Dockerfile.probe-test`         | 本地批量验证用测试探针车队，详见 [test-fleet/README](../../probes/test-fleet/README.md) |

容器与云函数都用环境变量注入凭据、不写盘；`login` / `logout` / `start` / `stop` / `restart` / `status` / `self-update` 在云函数中没有意义。SCF 的完整步骤见 [SCF 部署指南](../guides/probe-scf-deployment.md)。

## 6. 运行时协议

### 6.1 一轮循环

```
pull validation           # 无挑战则跳过
  -> 解密 challenge -> 加密 answer -> POST /probes/validation/:id/answer
heartbeat                 # { probe, monitors[], serverTime }
  -> schedule.sync(monitors)   # 新增 / 更新 / 移除本地任务
run due checks            # 按每个 monitor 自己的 interval 到期执行
report results            # 分批 POST /probes/results
sleep(intervalSeconds)
```

- 校验挑战拉取失败只告警，不中断心跳与检查链路。
- 心跳失败保留本地调度继续检查（配置漂移由下一次心跳的 `configRevision` 修正）。
- 上报失败保留缓冲，下一轮重试；`SIGINT` / `SIGTERM` 中止主循环与 sleep，当前一轮结束后退出。
- 连续失败时缩短下一轮等待（1s、2s、4s…上限为配置的 `intervalSeconds`），恢复后回到正常节奏。
- `run --once` 只执行一轮后退出，云函数即复用这条路径。

### 6.2 本地调度

- 每个 monitor 按自身 `interval` 判定到期，低于 10s 的异常值按 10s 处理（后端已按套餐下限约束）。
- 单轮并发由 `PROBE_CONCURRENCY` 决定（默认 3，上限 20），与云函数超时对齐。
- 结果缓冲上限 500 条；写满后暂停发起新检查（背压），而不是无界增长。
- 心跳携带 `intervalSeconds`，后端据此推导离线阈值（`3 × interval`），探针不再需要满足固定窗口。

### 6.3 心跳与上报

| 端点                              | 请求头           | 内容                                                                 |
| --------------------------------- | ---------------- | -------------------------------------------------------------------- |
| `POST /api/probes/heartbeat`      | `x-probe-secret` | `{ intervalSeconds }`；返回探针状态 + 分配任务（`id`/`type`/`target`/`interval`/`timeout`/`expectedStatus`/`configRevision`）+ `serverTime` |
| `POST /api/probes/results`        | `x-probe-secret` | `{ results: [...] }`，每批 ≤ 100 条；`monitorId`、`reportId`、`configRevision`、`target`、`success`、`latency`，可选 `statusCode` / `error` / `checkedAt` |
| `POST /api/probes/validation/pull` / `…/:id/answer` | `x-probe-secret` | 校验挑战的拉取与应答（见 §6.4）                                      |
| `POST /api/probes/revoke`         | `x-probe-secret` | 吊销当前凭据                                                         |

上报语义（完整规则见 [监控运行指南](../guides/monitoring-operations.md)）：

- `reportId` 标识一次观测，重试必须复用；相同 `probe + reportId + 内容` 幂等返回既有结果，内容不同则 `409`。
- `monitorId` / `target` / `configRevision` 必须与授权任务一致；配置已变更的结果会被拒绝并要求刷新心跳，过旧、解绑或配置变更的缓冲直接丢弃。
- `checkedAt` 只接受接收时间前 15 分钟至后 1 分钟内的值。

### 6.4 校验挑战应答

用于验证「HTTP 往返 + TLS + 凭据有效」三件事，探针仍不监听任何端口。

后台触发：

| 端点                                            | 权限          |
| ----------------------------------------------- | ------------- |
| `POST /api/organizations/:orgId/probes/:id/validate` | org `ADMIN`+  |
| `POST /api/admin/system-probes/:id/validate`         | `SUPER_ADMIN` |

算法（`src/modules/probes/probe-validation.service.ts` 与 `probes/agent/src/validation.js`）：

1. 触发时生成 `nonce`（32 字节 hex）与 `expiresAt`，明文存 `probe:validation:<probeId>`，TTL 120s。此时不加密——密钥取决于探针出示哪个 secret（可能处于轮换宽限期）。
2. 探针 `validation/pull` 时，服务端用该 secret 的 sha256 派生密钥，加密 `{ nonce, issuedAt }` 并返回 `{ validationId, challenge, expiresAt }`。
3. 密钥派生：`HKDF-SHA256`，IKM = `sha256(secret)`（hex 字符串），salt 为空，info = `beaconix-probe-validation-v1`，输出 32 字节。
4. 加密：`AES-256-GCM`，12 字节随机 IV，`{ iv, tag, data }` 均为 base64。
5. 探针解密挑战，回传加密的 `{ nonce, answeredAt }`；服务端解密后 `timingSafeEqual` 比对 nonce、校验过期时间。
6. 成功：删除 Redis 挑战、探针置 `ONLINE` 并刷新 `lastHeartbeat`、写 `ProbeExecution`（`trigger=MANUAL`、`target=validation`、`status=SUCCESS`）。nonce 不匹配或已过期一律 `400`，不更新状态。

## 7. 安全要点

- 强制 HTTPS：仅 `localhost` 或显式 `PROBE_ALLOW_INSECURE=true` 时允许明文。
- 凭据一次性下发、库内只存 hash；`userCode` 只存 hash；一次性 token TTL 15 分钟且消费即失效。
- 常驻凭据 `0640` + 专用 `beaconix` 用户；目录 `0750`；日志与错误消息不打印 secret（错误截断 500 字符）。
- unit 加固：`NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=strict`、`ProtectHome`，仅放行三个可写目录。
- 创建探针（含注册）始终要求目标组织 `OWNER` / `ADMIN`（或 `SUPER_ADMIN`），并走功能与配额校验。

## 8. 回归不变量

改动 Agent 时必须保持：

- 心跳 / 上报 / 校验协议不变，`User-Agent` 仍为 `Beacon-Probe/2.0`，请求头仍为 `x-probe-secret`。
- 本地调度语义不变：按各 monitor 的 `interval` 到期、默认并发 3、缓冲上限 500、失败后缩短重试间隔（上限为配置间隔）、可被信号中断的睡眠。
- `run --once` 与 `functions/scf.js` 的单轮语义一致；SCF 不依赖本地磁盘状态。
- 容器 / 云函数仍走环境变量凭据，不写盘；`login` / `enroll` 只服务常驻部署。
- 探针端到端验收：`validate` 返回 key 匹配、`run --once` 完成「校验应答 → 心跳 → 检查 → 上报」，后台能看到 `ProbeExecution` 与最新结果。

## 9. 相关文档

- [探针使用说明](../../probes/README.md)
- [监控运行指南](../guides/monitoring-operations.md)
- [SCF 部署指南](../guides/probe-scf-deployment.md)
- [探针测试车队](../../probes/test-fleet/README.md)

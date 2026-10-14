# 探针 Agent 与 CLI 设计

> 文档类型：设计演进记录。v2 为独立 CLI 注册方案，v1 为挑战应答的历史方案；旧脚本路径、目录示例和待确认项不作为当前部署说明。

日常安装与运行见 [探针使用说明](../../probes/README.md)，可靠上报协议见 [监控运行指南](../guides/monitoring-operations.md)。

## CLI 与注册设计（v2）

> v2 相对 v1 的整体调整：探针不再是对 `scripts/probe-agent.js` 的功能追加，而是一个
> **独立 CLI 工程**；注册支持 **CLI 发起** 与 **Web 发起**两条路径；`install.sh`
> 一路做到「安装 → 登录 → 启动」；常驻使用 **systemd system unit**。

### 1. 已确认的方向

| 决策项   | 结论                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------- |
| CLI 形态 | **B：独立 CLI 工程** `probes/agent/`，多文件结构 + 版本号 + `self-update`，零运行时依赖（Node ≥ 18） |
| 注册方向 | **两者都支持**：CLI 发起 Device Flow ＋ Web 端生成一次性安装命令                                     |
| 安装终点 | **一路做到登录 + 启动**：`curl …                                                                     | sudo sh` 后无需额外命令 |
| 常驻方式 | **systemd system unit**（`/etc/systemd/system/beacon-probe.service`，需 sudo）                       |

### 2. 目录结构

```
probes/agent/                       # 独立 CLI 工程（零运行时依赖）
├── package.json                    # name / version / bin
├── bin/beacon-probe.js             # 入口（#!/usr/bin/env node）
├── src/
│   ├── cli.js                      # 参数解析 + 命令分发
│   ├── config.js                   # 配置加载（参数 > env > 文件 > 默认）
│   ├── credentials.js              # 凭据读写（0600）与路径解析
│   ├── api.js                      # HTTP 客户端：heartbeat / results / validation / enroll
│   ├── enroll.js                   # Device Flow 客户端 + 一次性 token 兑换
│   ├── checks/{http,tcp}.js         # 检测实现（迁移，行为不变）
│   ├── schedule.js                 # 本地队列调度（迁移 createSchedule，行为不变）
│   ├── service/
│   │   ├── systemd.js              # systemctl 驱动（system unit）
│   │   ├── launchd.js              # macOS 回退
│   │   ├── pidfile.js              # 无 init 系统的回退
│   │   └── install.js              # 写 unit 文件 / 卸载
│   ├── commands/                   # login logout start stop restart status run validate heartbeat self-update
│   └── version.js
├── install/
│   ├── install.sh                  # 安装脚本（托管在 get.beacon.dev）
│   ├── beacon-probe.service.tpl     # systemd system unit 模板
│   └── dev.beacon.probe.plist.tpl   # launchd 模板
└── test/                           # 单测（node --test）
```

`scripts/probe-agent.js` 与 `scripts/probe-agent-scf.js` **保持原样**：SCF 与容器部署
继续使用；新 CLI 独立演进，避免两套实现分叉。

### 3. 两条注册路径

#### 3.1 路径 A：CLI 发起（Device Authorization Grant, RFC 8628）

```
$ sudo beacon-probe login
[..] Requesting access for host-01 …
     Open:  https://app.beacon.dev/activate?code=WDJB-MJHT
     Code:  WDJB-MJHT
[..] Waiting for approval …
[..] Enrollment approved: probe=probe_xxx
[..] Credentials saved to /etc/beacon/probe.json
[..] systemd unit enabled — beacon-probe started
```

适用：用户先 `curl | sh` 装了 CLI，再在服务器上登录。

#### 3.2 路径 B：Web 发起

1. Web 端「添加探针」→ `POST /api/organizations/:orgId/probes/enroll-token`（JWT + ADMIN）
   → 返回一次性 `enrollToken`（Redis，TTL 15 分钟）。
2. 页面展示可复制的安装命令：

    ```bash
    curl -fsSL https://get.beacon.dev/install.sh | sudo sh -s -- --token=bet_xxx
    ```

3. `install.sh` 把 `--token` 透传给 CLI：`beacon-probe enroll --token=bet_xxx`。
4. CLI 调 `POST /api/probes/enroll/redeem` 用 token 换 `{ probeId, secret, apiUrl }`
   → 写凭据 → 启动服务。

适用：管理员在 Web 上分配好探针，把命令丢给运维/机器执行。**无浏览器交互**。

### 4. 后端端点（新增）

新增 `src/modules/probes/enrollment/`：

| 端点                                                 | 鉴权                      | 说明                                                                                       |
| ---------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `POST /api/probes/enroll/device`                     | `@Public()`               | 生成 `deviceCode` + `userCode`，返回 `verificationUri(-Complete)`、`expiresIn`、`interval` |
| `POST /api/probes/enroll/token`                      | `@Public()`               | 轮询换凭据：`pending` / `approved` / `denied` / `expired` / `slow_down`                    |
| `GET /api/probes/enroll/activate?code=`              | `@Public()`               | 待授权信息 JSON，供前端 SPA 渲染确认页                                                     |
| `POST /api/probes/enroll/approve`                    | JWT + `RolesGuard(ADMIN)` | 校验 org 成员资格与 `maxProbes` 配额，建 `Probe`，写一次性凭据                             |
| `POST /api/probes/enroll/redeem`                     | `@Public()`               | 用 Web 下发的一次性 `enrollToken` 换凭据（路径 B）                                         |
| `POST /api/organizations/:orgId/probes/enroll-token` | JWT + `RolesGuard(ADMIN)` | 生成一次性安装 token（路径 B）                                                             |
| `POST /api/probes/revoke`                            | `x-probe-secret`          | 探针自吊销（供 `logout --revoke`）                                                         |

**确认页由前端 SPA 渲染**：本仓库只提供 `activate`（数据）与 `approve`（授权），不新增
`views/*.hbs`。

Redis 键（复用 `RedisService`，不新增表）：

| 键                               | 值                                                           | TTL  |
| -------------------------------- | ------------------------------------------------------------ | ---- |
| `probe:enroll:dc:<deviceCode>`   | `{ status, userCodeHash, orgId?, probeId?, userId? }`        | 600s |
| `probe:enroll:uc:<userCode>`     | `<deviceCode>`                                               | 600s |
| `probe:enroll:cred:<deviceCode>` | 一次性凭据 JSON（`consumeJson`）                             | 60s  |
| `probe:enroll:tok:<enrollToken>` | `{ organizationId, createdById, name?, provider?, region? }` | 900s |

授权历史走 `AuditLog`，暂不新增数据库表（避免 schema 变更与 `prisma generate` 波及）。

### 5. install.sh（一路到底）

`curl -fsSL https://get.beacon.dev/install.sh | sudo sh -s -- [--token=…] [--api-url=…] [--version=…]`

1. 校验 root（system unit 需要）；检测 OS/arch
2. 检测 Node ≥ 18；缺失则提示安装方式（可选 `--install-node` 用发行版包管理器安装）
3. 安装 CLI 到 `/opt/beacon-probe/`，软链 `/usr/local/bin/beacon-probe`
4. 写 `/etc/systemd/system/beacon-probe.service`，`daemon-reload` + `enable`
5. 凭据与运行用户按 §6 的模型处理
6. 注册：
    - 带 `--token` → `beacon-probe enroll --token=…`（无交互）
    - 不带 → 打印 Device Flow 登录指引并执行 `beacon-probe login`
7. `systemctl restart beacon-probe` 并输出 `beacon-probe status`

参数：`--token`、`--api-url`、`--version`、`--no-service`、`--install-node`、`--uninstall`。
幂等、可重复执行。

### 6. systemd system unit

```ini
[Unit]
Description=Beacon probe agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__RUN_USER__
Group=__RUN_GROUP__
WorkingDirectory=/opt/beacon-probe
ExecStart=/usr/local/bin/beacon-probe run
Restart=always
RestartSec=5
EnvironmentFile=-/etc/beacon/probe.env
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`__RUN_USER__` / 凭据路径的取值见 §7（待确认项）。

### 7. CLI 命令矩阵

| 命令                                    | 行为                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `login`                                 | Device Flow 注册（路径 A）                                                      |
| `enroll --token=…`                      | 用一次性 token 注册（路径 B）                                                   |
| `logout [--revoke]`                     | 删本地凭据，可选调 `/probes/revoke`                                             |
| `start` / `stop` / `restart` / `status` | 驱动 systemd unit（无 systemd 时回退 launchd / pidfile）                        |
| `run [--once]`                          | 前台常驻（心跳 + 本地队列调度，**逻辑与现版本逐字一致**）                       |
| `validate` / `heartbeat`                | 部署校验 / 单次心跳调试                                                         |
| `self-update [--check]`                 | 比对 `https://get.beacon.dev/probe/latest.json`，下载覆盖并 `systemctl restart` |
| `version` / `--help`                    | 版本 / 帮助                                                                     |

配置加载优先级：`CLI 参数 > 环境变量 > --config/PROBE_CONFIG > /etc/beacon/probe.json > 默认值`。

### 8. 保留与回归

- 心跳 / 批量上报 / `validation/pull`+`answer` 协议不变。
- 本地 `createSchedule()`（并发 3、`MAX_PENDING_RESULTS` 背压、指数退避、优雅退出）
  从现脚本**逐字迁移**，行为不变。
- `scripts/probe-agent-scf.js`（SCF）与 `Dockerfile.probe` 继续走环境变量凭据。

### 9. 安全要点

- 强制 HTTPS（localhost 或显式 `PROBE_ALLOW_INSECURE=true` 除外）。
- `deviceCode` 32 字节随机；`userCode` 8 位易读码，仅存 hash；`enrollToken` 一次性、TTL 15 分钟。
- 凭据一次性返回；轮询限速；`probe.json` `0600`；日志脱敏。
- unit 用 `NoNewPrivileges` / `PrivateTmp`；仅需出站网络。
- 创建探针仍要求 org `ADMIN`。

### 10. 分期与验收

| 期     | 内容                                                                                                 | 验收                                                             |
| ------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **P1** | 拆分 `probes/agent/`：迁移 config/credentials/api/checks/schedule，`run∥validate∥heartbeat` 行为不变 | `run --once` 报文与现脚本逐字节一致                              |
| **P2** | 后端 enrollment 端点（device / token / activate / approve / redeem / enroll-token / revoke）+ 单测   | `pnpm type-check`；enrollment 单测全绿                           |
| **P3** | `login` / `enroll` / `logout` 客户端 + 凭据落盘                                                      | 端到端两条注册路径均可拿到凭据                                   |
| **P4** | `install.sh` + systemd system unit + `start/stop/restart/status`                                     | `curl … \| sudo sh` 后 `systemctl status beacon-probe` 为 active |
| **P5** | `self-update`、卸载、文档、SCF/Docker 回归                                                           | `self-update --check` 正确比对版本                               |

统一门槛：`pnpm type-check` 通过；心跳与本地调度行为与现版本一致。

### 11. 待确认

- **systemd unit 的运行用户与凭据路径**（决定 §6 模板与 `install.sh` 的写盘位置）。
- 是否保留 CLI 工程内的 `test/`（`node --test`）作为回归网。

## 挑战应答与初代脚本设计（v1 历史记录）

> 历史规划说明：当前实际入口已迁至 `probes/agent/bin/beacon-probe.js`，
> SCF 为 `probes/agent/functions/scf.js`，下文旧 `scripts/probe-agent*.js` 路径不再使用。
> 2026-10-10 起上报携带 monitorId/reportId/configRevision，可靠归属、重试幂等与
> 升级规则以 `docs/guides/monitoring-operations.md` 为准。

### 1. 背景与目标

Beacon 后台已有监控探针（`Probe`）：后台添加探针时生成唯一 `id + secret`
（即 key + token），探针通过 `x-probe-secret` 请求头与 `/api/probes/*` 交互。

本次在**方案 B（挑战-应答校验）**上做增量实现：

- 探针仍是**纯出站 agent**，不监听任何端口。
- 后台手动触发校验 → 创建加密挑战（Redis，TTL 120s）→ 探针轮询拉取 → 解密并应答
  → 后端验签 → 记录校验执行日志。
- 校验同时完成三件事：接口互通（HTTP 往返）、数据加密（TLS + AES-256-GCM）、
  token 有效性（后端验签 nonce）。
- 计划挂钩（指定哪些 Plan 的 org 可用）本次不做，后续再考虑。

### 2. 范围界定

| 项目     | 结论                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 后端改动 | 增量：新增校验服务/端点，不改动现有 heartbeat/results 行为，不新增数据库表 |
| 挑战存储 | Redis（`probe:validation:<probeId>`，TTL 120s），过期自动失效              |
| 探针脚本 | `scripts/probe-agent.js`（纯 Node.js，零第三方依赖）                       |
| 通信方向 | 纯出站：探针不开放 HTTP/TCP 端口                                           |
| 计划挂钩 | 本次不做，规划文档预留扩展点                                               |

### 3. 接口盘点

#### 3.1 探针侧（agent，`x-probe-secret` 认证）

| 接口                                          | 方法   | 用途                                                      |
| --------------------------------------------- | ------ | --------------------------------------------------------- |
| `/api/probes/heartbeat`                       | `POST` | 上报心跳、标记 ONLINE、返回分配的监控任务与 `serverTime`  |
| `/api/probes/results`                         | `POST` | 批量上报检测结果                                          |
| `/api/probes/validation/pull`                 | `POST` | 拉取待处理校验挑战（无挑战时返回 `{ validation: null }`） |
| `/api/probes/validation/:validationId/answer` | `POST` | 提交加密应答，后端验签后标记校验成功                      |

响应统一被 `TransformInterceptor` 包装为 `{ data, meta }`。

#### 3.2 后台侧（手动触发）

| 接口                                            | 方法   | 权限          |
| ----------------------------------------------- | ------ | ------------- |
| `/api/organizations/:orgId/probes/:id/validate` | `POST` | org `ADMIN`+  |
| `/api/admin/system-probes/:id/validate`         | `POST` | `SUPER_ADMIN` |

### 4. 校验算法

- 密钥派生：`HKDF-SHA256`，IKM = `probe.secret`，salt 为空，info =
  `beacon-probe-validation-v1`，输出 32 字节。
- 加密：`AES-256-GCM`，12 字节随机 IV，`{ iv, tag, data }` 均 base64。
- 挑战明文：`{ nonce, issuedAt }`，其中 `nonce` 为 32 字节随机 hex。
- 应答明文：`{ nonce, answeredAt }`。
- 后端比对 `nonce`（`timingSafeEqual`）与 `expiresAt`，成功后：
    - 删除 Redis 挑战；
    - 探针标记 `ONLINE` 并刷新 `lastHeartbeat`；
    - 写入 `ProbeExecution`（`trigger=MANUAL`、`target=validation`、`status=SUCCESS`）。

### 5. 脚本设计

#### 5.1 命令

| 命令          | 说明                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| `run`（默认） | 常驻模式：先应答校验挑战 → 心跳 → 执行监控 → 批量上报；`--once` 只跑一轮 |
| `validate`    | 部署校验：HTTPS 检查 → 应答待处理挑战（如有）→ 心跳往返 → 校验 key 匹配  |
| `heartbeat`   | 只发送一次心跳并打印响应，用于排查                                       |

#### 5.2 配置

优先级：CLI 参数 > 环境变量 > 配置文件（`--config` / `PROBE_CONFIG`）。

| 配置项                | 环境变量                             | 默认值                      | 说明                                             |
| --------------------- | ------------------------------------ | --------------------------- | ------------------------------------------------ |
| `apiUrl`              | `BEACON_API_URL`                     | `http://localhost:3000/api` | 后台 API 根地址，自动去尾部 `/`                  |
| `key`                 | `PROBE_KEY`                          | —                           | 后台生成的探针 `id`                              |
| `token`               | `PROBE_TOKEN`（兼容 `PROBE_SECRET`） | —                           | 后台生成的探针 `secret`                          |
| `intervalSeconds`     | `PROBE_INTERVAL_SECONDS`             | `60`                        | 常驻模式心跳间隔                                 |
| `timeoutMs`           | `PROBE_TIMEOUT_MS`                   | `5000`                      | 单个监控检测/请求超时                            |
| `allowInsecure`       | `PROBE_ALLOW_INSECURE`               | `false`                     | 是否允许 `http://` 明文 API 地址                 |
| `maxResultsPerReport` | `PROBE_MAX_RESULTS`                  | `100`                       | 单次上报结果上限（对齐后端 `ArrayMaxSize(100)`） |

#### 5.3 常驻循环

```
loop:
  pullValidation()          # 无挑战则跳过
    -> 解密挑战 -> 加密应答 -> POST /probes/validation/:id/answer
  heartbeat() -> { probe, monitors, serverTime }
  for monitor in monitors:
      HTTP: GET target，status === expectedStatus，记录 latency
      TCP : 解析 host:port，建立连接，记录 latency
      其他: 上报失败
  report(results) -> POST /probes/results
  sleep(intervalSeconds)
```

- 检测逻辑与后端 `HttpChecker` / `TcpChecker` 保持一致。
- 校验挑战轮询失败只告警，不中断心跳链路。
- 心跳失败指数退避，连续失败不退出。
- 支持 `SIGINT` / `SIGTERM` 优雅退出。

### 6. 数据安全

- `token` 只从环境变量或本地配置文件读取，日志中永不打印明文。
- 生产环境强制 `https://`，传输层 TLS 加密。
- 挑战/应答使用 `AES-256-GCM`，`nonce` 一次性且 120s 过期，防重放。
- 配置文件建议权限 `chmod 600`；云厂商部署建议使用 secret 管理注入环境变量。

### 7. 部署方式

```bash
# 部署校验（也会应答待处理挑战）
BEACON_API_URL=https://api.example.com/api \
PROBE_KEY=<probe.id> \
PROBE_TOKEN=<probe.secret> \
node scripts/probe-agent.js validate

# 常驻
BEACON_API_URL=https://api.example.com/api \
PROBE_KEY=<probe.id> \
PROBE_TOKEN=<probe.secret> \
PROBE_INTERVAL_SECONDS=60 \
node scripts/probe-agent.js run
```

生产可套用 `pm2`、`systemd`、`docker` 或云厂商函数/容器；脚本无状态、无本地存储。

#### 7.1 腾讯云 SCF 部署

云函数使用 `scripts/probe-agent-scf.js`，每次触发执行一轮（校验应答 → 心跳 → 执行 → 上报）。

1. 上传部署包：包含 `scripts/probe-agent.js` 与 `scripts/probe-agent-scf.js`（无第三方依赖）。
2. 控制台配置执行方法：`probe-agent-scf.main_handler`。
3. 配置环境变量：
    - `BEACON_API_URL`（必须 https）
    - `PROBE_KEY` / `PROBE_TOKEN`
    - 可选：`PROBE_SCF_MODE=run|validate`、`PROBE_TIMEOUT_MS`、`PROBE_MAX_RESULTS`
4. 创建定时触发器（如每 60 秒一次），执行频率与监控 `interval` 对齐。
5. 本地调试：`node scripts/probe-agent-scf.js` 或 `pnpm probe:scf`。

### 8. 文件清单

| 文件                                                                        | 变更                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------- |
| `src/modules/probes/probe-validation.service.ts`                            | 新增：挑战创建/拉取/验签/审计                     |
| `src/modules/probes/probe-validation.module.ts`                             | 新增模块                                          |
| `src/modules/probes/dto/answer-probe-validation.dto.ts`                     | 新增应答 DTO                                      |
| `src/modules/probes/probe-ingest.controller.ts`                             | 新增 `validation/pull`、`validation/:id/answer`   |
| `src/modules/probes/probes.controller.ts`                                   | 新增租户手动触发 `POST :id/validate`              |
| `src/modules/admin/system-probes/system-probes.controller.ts`               | 新增系统探针手动触发 `POST :id/validate`          |
| `src/modules/probes/probes.module.ts` / `src/modules/admin/admin.module.ts` | 模块接线                                          |
| `src/modules/probes/probe-validation.service.spec.ts`                       | 新增单测（8 用例）                                |
| `scripts/probe-agent.js`                                                    | 新增挑战轮询/解密/应答逻辑，并导出为可复用模块    |
| `scripts/probe-agent-scf.js`                                                | 新增腾讯云 SCF 单次执行入口                       |
| `package.json`                                                              | 新增 `probe:run` / `probe:validate` / `probe:scf` |
| `docs/design/probe-agent.md`                                                | 本文档                                            |

### 9. 验收标准

1. `pnpm type-check` 通过。
2. `pnpm test -- src/modules/probes/probe-validation.service.spec.ts` 全绿。
3. 后台触发 `POST .../probes/:id/validate` 返回挑战；探针下个周期自动应答，后端记录
   `ProbeExecution(trigger=MANUAL, status=SUCCESS)`。
4. `node scripts/probe-agent.js run --once`：先应答挑战 → 心跳 → 执行监控 → 上报结果。
5. 探针全程无监听端口，纯出站。

### 10. 后续扩展点

- **计划挂钩**：新增 `ProbePlan` 关联表或复用现有 `Plan`/`QuotaService`，控制哪些
  计划的 org 可使用探针；脚本侧无需变化。

# 探针部署到腾讯云 SCF（云函数）

> 2026-10-10：监控概览已启用可靠观测归属。部署包必须包含当前 `src/checks.js` 与
> `src/schedule.js`，心跳的 monitor.id/configRevision 会一路携带到 results 的
> monitorId/configRevision；每个独立观测具有 reportId。重试不得重建 ID 或时间。
> 旧版 target-only 多义上报会被拒绝，完整协议见 [监控运行指南](monitoring-operations.md)。

云函数是**事件驱动、短生命周期**的执行环境，与 systemd 常驻模型有本质差异。本文说明如何
把 `probes/agent` 部署成 SCF 函数，以及必须调整的地方。

## 1. 模型差异

| 维度     | 常驻（systemd）                   | 云函数（SCF）                      |
| -------- | --------------------------------- | ---------------------------------- |
| 生命周期 | 长驻进程                          | 每次触发数秒~数分钟                |
| 本地调度 | 按每个 monitor 的 `interval` 排队 | 内存状态跨调用不保留，**无法排队** |
| 结果缓冲 | `pending` 数组跨轮保留            | 每次调用结束即销毁                 |
| 凭据     | `/etc/beacon/probe.json`          | 只读文件系统，靠环境变量           |
| 注册     | `login` / `enroll` 写盘           | **无法交互、不写盘**               |
| 服务化   | systemd unit                      | 定时触发器                         |

因此云函数**只使用单次执行路径**：`beacon-probe run --once` 的语义正是"新建空 schedule →
所有 monitor 视为首次到期 → 全量检查 → 上报一次 → 退出"。

`login` / `logout` / `start` / `stop` / `restart` / `status` / `self-update` 在云函数上**没有意义**。

## 2. 部署步骤

### 2.1 先注册，拿到凭据（在本地或 CI 执行，不在云函数里）

```bash
# 方式 A：CLI 发起设备码登录
node probes/agent/bin/beacon-probe.js login --api-url https://api.example.com/api

# 方式 B：用 Web 端「添加探针」下发的一次性 token
node probes/agent/bin/beacon-probe.js enroll \
  --enroll-token bet_xxx --api-url https://api.example.com/api
```

拿到 `~/.beacon/probe.json` 里的 `key` / `token`，稍后写入函数环境变量。

### 2.2 打包

上传 `probes/agent/` 目录即可（零第三方依赖）：

```
probes/agent/
├── package.json
├── bin/beacon-probe.js
├── src/**            # 必需
└── functions/scf.js  # 入口（也可放在包根，见 2.3）
```

### 2.3 配置函数

- **运行环境**：Node.js 18 及以上
- **执行方法**：`functions/scf.main_handler`（若把 `scf.js` 放到包根则是 `scf.main_handler`）
- **超时**：按"监控数 ÷ 并发 × 单次超时"估算，建议 ≥ 30s
- **环境变量**：见 §3

### 2.4 定时触发器

新建定时触发器（cron），**周期必须等于 `PROBE_INTERVAL_SECONDS`**，例如每 60 秒一次。

## 3. 环境变量

| 变量                     | 必需 | 说明                                    |
| ------------------------ | ---- | --------------------------------------- |
| `BEACON_API_URL`         | 是   | 后台 API 根地址，必须 `https`           |
| `PROBE_KEY`              | 是   | 探针 id                                 |
| `PROBE_TOKEN`            | 是   | 探针 secret                             |
| `PROBE_INTERVAL_SECONDS` | 是   | **必须等于定时触发器周期**，见 §4.1     |
| `PROBE_TIMEOUT_MS`       | 否   | 单个请求/检测超时，默认 5000            |
| `PROBE_MAX_RESULTS`      | 否   | 单次上报上限，默认 100                  |
| `PROBE_CONCURRENCY`      | 否   | 单次调用内的并发检查数，默认 3、上限 20 |
| `PROBE_SCF_MODE`         | 否   | `run`（默认）或 `validate`              |
| `PROBE_ALLOW_INSECURE`   | 否   | 仅测试用；生产禁止 `http`               |

## 4. 必须注意的三点

### 4.1 心跳周期 = 触发器周期（最容易踩）

后端按 `lastHeartbeat + heartbeatIntervalSeconds × 3` 判定离线。若触发器每 300 秒跑一次，
却让探针上报 `60`，**后端会在 180 秒后把探针标记为离线**，而它其实还在正常上报。

```bash
PROBE_INTERVAL_SECONDS=300   # 与触发器周期一致
```

### 4.2 触发频率 = 检查频率

云函数每次触发会检查**全部**被分配的 monitor。触发器频率应当与这些 monitor 的
**最小 `interval`** 对齐：

- 触发器比 monitor interval **更快** → 监控被超额检查（结果更密，但更耗资源）；
- 触发器比 monitor interval **更慢** → 监控漏检（可用率统计失真）。

如果同一个探针上既有 60s 又有 300s 的监控，云函数无法像常驻模式那样分别节流——
建议把不同周期的监控拆到不同探针/函数。

### 4.3 单次调用要能在超时内跑完

所有检查在一次调用里完成。监控多时提高 `PROBE_CONCURRENCY` 并相应放大函数超时：

```
并发 3 × 5s 超时 × 40 个监控 ≈ 67s  →  函数超时至少 90s
```

## 5. 其他限制

- **冷启动**：首个请求要建 DNS/连接，测出的延迟偏高。建议配置**预置并发**（预热）以获得稳定数据。
- **出网 IP 漂移**：探针从函数的 NAT 公网 IP 出去，被监控目标若按 IP 白名单放行需注意。
- **并发实例重复心跳**：SCF 可能并发启动多个实例，同一探针在短时间内心跳/上报多次；
  后端按 secret 鉴权且结果写入幂等，可接受。
- **不使用本地磁盘**：凭据全程来自环境变量，无需 `BEACON_HOME`；若确需可设 `BEACON_HOME=/tmp/.beacon`。

## 6. 本地调试

```bash
BEACON_API_URL=https://api.example.com/api \
PROBE_KEY=<probe id> \
PROBE_TOKEN=<probe secret> \
PROBE_INTERVAL_SECONDS=300 \
node probes/agent/functions/scf.js
```

或使用 `pnpm probe:scf`。输出为 `{ code, mode, result }`，`code: 1` 表示本轮失败（不会抛未捕获异常）。

## 7. 与常驻部署的对照

| 事项     | 常驻 / 容器                          | SCF                                 |
| -------- | ------------------------------------ | ----------------------------------- |
| 入口     | `bin/beacon-probe.js run`            | `functions/scf.js` → `main_handler` |
| 安装     | `install.sh` + systemd unit          | 上传代码 + 定时触发器               |
| 调度     | 每个 monitor 按自身 interval         | 每次触发全量检查                    |
| 周期配置 | `PROBE_INTERVAL_SECONDS`（心跳间隔） | 同上，且必须等于触发器周期          |
| 凭据     | `login` / `enroll` 写盘              | 部署前注册，注入环境变量            |

> 容器部署（`Dockerfile.probe`）仍走常驻模式：`docker run` 即 `beacon-probe run`。

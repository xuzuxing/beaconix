# 云函数探针调度触发（Scheduler → BullMQ → SDK 远程调用）规划文档

> 文档类型：未实施提案。远程云函数 SDK 调用与现有 SCF 定时拉取模型不同；文中共享队列、调度基线和旧脚本路径需在实施前重新核对。当前可用部署方式见 [SCF 部署指南](../guides/probe-scf-deployment.md)。

> 状态：规划稿，未开始实现。
> 目标：后端调度器在 monitor 到期时，扫描到期数据并投递到 BullMQ，由队列 processor 负责真实执行：
> 本地检测，以及通过腾讯云 SCF / 阿里云 FC 的 SDK 对云函数探针发起远程函数调用。
> 云函数作为被调度的远程执行单元，不再依赖自身定时器；常规服务部署的探针继续使用现有心跳拉取模型。

## 1. 背景与目标

当前探针全部是**拉模型**：探针（含云函数入口 `probe-agent-scf.js`）依赖自身定时器，周期执行
`心跳 → 领任务 → 检测 → 上报`。云函数是否执行、何时执行，由云函数自己的触发器决定，
后端无法按 monitor 的调度节奏直接驱动它。

本方案把云函数探针改为**调度器驱动的推模型**，并引入 BullMQ 解耦：

- `CheckerScheduler` 只做“扫描到期 monitor + 投递队列”，不再直接执行检测或 SDK 调用。
- 真实执行由 BullMQ processor 完成：
    - `monitor-checks` processor：本地检测。
    - `probe-invocations` processor：云厂商 SDK 远程调用云函数探针。
- 云函数收到调用 payload 后执行检测，再走现有 `POST /api/probes/results` 上报。
- 常规服务探针保持拉模型，两条线共享上报、存储、双源聚合与审计链路。

**非目标**：不是做“管理员手动点击触发”为主要形态；手动触发接口只作为调试/按需执行的辅助旁路。

## 2. 现状回顾

| 项           | 现状                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| 中心调度     | `CheckerScheduler` 每 10s tick，扫描到期 monitor，并发 5 执行本地检测                             |
| 本地检测     | `CheckerService.execute` 调 `HttpChecker` / `TcpChecker`                                          |
| 探针任务来源 | `POST /api/probes/heartbeat` 返回该探针绑定/分配的 monitors                                       |
| 上报结果     | `POST /api/probes/results` 批量上报，后端做双源聚合                                               |
| 云函数入口   | `scripts/probe-agent-scf.js`，`main_handler` 忽略 event，跑一轮拉模型                             |
| Probe 模型   | 有 `provider`（`TENCENT`/`ALIYUN`/`CUSTOM`）、`region`、`callbackUrl`，但无云函数名/命名空间/版本 |
| 云厂商 SDK   | 当前未引入                                                                                        |
| 系统探针分配 | `SystemProbeScheduler` 只选 `status=ONLINE` 的 `SYSTEM` 探针，分配表存 Redis                      |
| 掉线扫描     | `probe-offline-sweep` 每分钟把超过 2 分钟无心跳的探针标记为 `OFFLINE`                             |
| 队列         | 已有 `@nestjs/bullmq`，`notifications` 队列用于通知投递；根连接在 `NotifierModule` 中配置         |

## 3. 目标架构

```text
常规服务探针（保持不变）：
  agent 定时 heartbeat -> 领 monitors -> 检测 -> report

云函数探针（调度器驱动，BullMQ 解耦）：
  CheckerScheduler tick（每 10s）
    -> 扫描到期 monitors
    -> 入队 monitor-checks job（本地检测）
    -> 找出云函数探针，按 probe 分组
    -> 入队 probe-invocations job（云函数 SDK 调用）
    -> tick 结束

  monitor-checks processor
    -> CheckerService.executeMonitor(monitorId)
    -> 本地检测 + 状态聚合 + 通知（走现有 notifications 队列）

  probe-invocations processor
    -> CloudProbeInvoker.invoke(probe, payload)
    -> 腾讯云 SCF / 阿里云 FC SDK InvokeFunction(Event)
    -> 成功：标记 probe ONLINE + 写 probe_executions(SCHEDULED/invoke)
    -> 失败：写 probe_executions(FAILED/invoke) + 按策略重试

  云函数收到 event -> 按 payload.monitors 检测 -> report results
    -> 后端 recordResults -> probe_results + 双源聚合 + 状态/通知
```

关键点：

- **扫描与执行解耦**：tick 永远轻量，慢检测/慢 SDK 调用不会阻塞调度扫描。
- **云函数不再需要自己的定时触发器**，由后端调度器按 monitor 的 `interval` 节奏远程调用。
- **本地检测仍然保留**，作为双源之一。

## 4. 数据模型设计

### 4.1 推荐方案：Probe 增加 `invocationConfig Json?`

```prisma
model Probe {
  // ...existing fields
  invocationConfig Json?
}
```

`invocationConfig = null`：探针走现有拉模型（普通服务探针，或仍用云函数定时器的探针）。
`invocationConfig != null`：该探针可被后端调度器通过 SDK 远程调用。

按 `provider` 约定结构：

```jsonc
// provider = TENCENT（腾讯云 SCF）
{
  "type": "SCF",
  "namespace": "default",
  "functionName": "beacon-probe",
  "qualifier": "$LATEST"
}

// provider = ALIYUN（阿里云 FC）
{
  "type": "FC",
  "serviceName": "beacon-probe-svc",
  "functionName": "beacon-probe",
  "qualifier": "LATEST"
}
```

- `namespace`（腾讯）与 `serviceName`（阿里）语义相同，按厂商分开命名。
- `qualifier` 缺省：腾讯 `$LATEST`，阿里 `LATEST`。
- JSON 字段便于后续扩展厂商特有参数；云账号 AK/SK 不落库。

### 4.2 备选方案

加三列 `cloudFunctionName`、`cloudNamespaceOrService`、`cloudQualifier`。优点是强类型、可索引；
缺点是厂商概念不齐、扩展性差。**规划推荐 4.1**。

### 4.3 迁移与 DTO

- 迁移：`ALTER TABLE "probes" ADD COLUMN "invocationConfig" JSONB;`（走 Prisma migrate）。
- `CreateProbeDto` / `UpdateProbeDto` / `CreateSystemProbeDto` / `UpdateSystemProbeDto`
  增加可选 `invocationConfig`，按 `provider` 校验必填字段。
- `ProbeEntity` 返回 `invocationConfig`（不含密钥）。

## 5. 云厂商调用服务设计

### 5.1 依赖

- 腾讯云：`tencentcloud-sdk-nodejs-scf`（或完整 `tencentcloud-sdk-nodejs`）。
- 阿里云：`@alicloud/fc-open20210406`。

### 5.2 凭据管理

只放后端环境变量：

| 环境变量                                            | 用途                                |
| --------------------------------------------------- | ----------------------------------- |
| `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`          | 腾讯云 SCF 调用                     |
| `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` | 阿里云 FC 调用                      |
| `ALIYUN_FC_ENDPOINT`（可选）                        | 阿里云 FC endpoint，默认公网        |
| region                                              | 优先取 `probe.region`，否则全局默认 |

### 5.3 `CloudProbeInvoker`

```ts
interface CloudInvocationResult {
  provider: ProbeProvider;
  providerRequestId: string;
}

interface CloudProbeInvoker {
  invoke(probe: ProbeWithInvocationConfig, payload: CloudProbeInvocationPayload): Promise<CloudInvocationResult>;
}
```

- 工厂按 `probe.provider` 路由到 `TencentScfInvoker` / `AliyunFcInvoker`。
- 统一使用**异步调用**（Event invocation）：
    - 腾讯：`InvokeFunction`，`InvocationType: 'Event'`。
    - 阿里：`invokeFunction`，请求头 `x-fc-invocation-type: Async`。
- SDK 调用只拿 `requestId`，后端不等待检测结果；结果由云函数稍后上报。

### 5.4 调用 payload 契约

```json
{
  "version": "beacon-cloud-probe-v1",
  "invocationId": "uuid",
  "trigger": "SCHEDULED",
  "probe": { "id": "probe_xxx", "name": "Tokyo cloud probe" },
  "monitors": [
    {
      "id": "monitor_1",
      "name": "订单API",
      "type": "HTTP",
      "target": "https://api.example.com/health",
      "timeout": 5000,
      "expectedStatus": 200
    }
  ]
}
```

- `trigger` 取值：`SCHEDULED`（调度器）或 `MANUAL`（手动触发接口）。
- 一个 payload 可携带同一探针本次需要执行的多个 monitors（按探针分组，减少调用次数）。
- 腾讯云 SCF event 可能是对象或 JSON 字符串，阿里云 FC event 可能是对象或 Buffer，
  云函数侧需 `normalizeInvocationEvent`。

## 6. 调度与队列设计（核心改动）

### 6.1 队列定义

新增两个 BullMQ 队列：

| 队列名              | 用途                | Job data                                         |
| ------------------- | ------------------- | ------------------------------------------------ |
| `monitor-checks`    | 本地检测            | `{ monitorId }`                                  |
| `probe-invocations` | 云函数 SDK 远程调用 | `{ probeId, monitorIds, invocationId, trigger }` |

- 队列常量与类型放 `src/modules/checker/checker.queue.ts`（或独立 `queue.constants.ts`）。
- BullMQ 根连接需要抽到共享模块（见 6.5），两个队列与现有 `notifications` 队列共用 Redis。

### 6.2 `CheckerScheduler`：只扫描、只入队

现有 tick 流程：

```text
扫描到期 monitors -> 并发执行本地检测 -> 返回 { due, checked }
```

改为：

```text
tick（每 10s）
  1. findDueMonitors()：扫描 enabled 且 lastCheckAt 到期的 monitors
  2. 每个到期 monitor -> add monitor-checks job（jobId 去重）
  3. 找出这些 monitor 对应的云函数探针（见 6.6）
  4. 按 probe 分组 -> add probe-invocations job
  5. tick 结束，返回 { due, enqueuedChecks, enqueuedInvocations }
```

- `running` 防重入保留，但此时只防“扫描重复”，不再承担“执行慢导致堆积”的职责。
- 入队失败（如 Redis 抖动）记录日志，tick 不因单条失败中断。

### 6.3 `monitor-checks` processor

```ts
@Processor(MONITOR_CHECK_QUEUE)
class MonitorCheckProcessor extends WorkerHost {
  async process(job: Job<MonitorCheckJobData>) {
    await this.checkerService.executeMonitor(job.data.monitorId);
  }
}
```

- `CheckerService` 从现有 `runDueChecks` 中拆出 `executeMonitor(monitorId)`：
    - 按 id 重新查库（含 `state`），避免消费到已删除/停用的 monitor；
    - 复用现有 `execute(monitor, CheckSource.LOCAL, undefined, ExecutionTrigger.SCHEDULED)`；
    - 单个 monitor 失败 catch 后记日志并 `throw`，交给 BullMQ 重试。
- Worker 并发建议沿用 5；`removeOnComplete` / `removeOnFail` 按保留策略配置。

### 6.4 `probe-invocations` processor

```ts
@Processor(PROBE_INVOCATION_QUEUE)
class ProbeInvocationProcessor extends WorkerHost {
  async process(job: Job<ProbeInvocationJobData>) {
    // 1. 查 probe（enabled + invocationConfig != null）
    // 2. 查 job.data.monitorIds 对应的 monitors（enabled 且未删除）
    // 3. 组装 CloudProbeInvocationPayload
    // 4. cloudProbeInvoker.invoke(probe, payload)
    // 5. 成功后标记 probe ONLINE + 写 probe_executions(SCHEDULED/invoke)
  }
}
```

- Worker 并发建议 3–5；单次 SDK 调用短超时（如 3–5s）。
- 调用失败：
    - 写 `probe_executions(FAILED/invoke)`；
    - `throw` 交给 BullMQ 按退避策略重试（重试次数需控制，避免重复调用云函数）。
- 重试时使用同一个 `invocationId`，便于云函数/后端按 invocationId 幂等对账。

### 6.5 BullMQ 根连接抽取

当前 `BullModule.forRootAsync` 在 `NotifierModule`。新增两个队列后，根连接应抽到共享模块：

```text
src/infra/queue/queue.module.ts   # BullModule.forRootAsync(redis url/keyPrefix)
```

- `NotifierModule` 改为只 `registerQueue({ name: NOTIFICATION_QUEUE })`。
- `CheckerModule` / `CloudProbeModule` 只 `registerQueue` 各自队列。
- 避免多个 `forRoot` 重复注册连接。

### 6.6 云函数探针选择规则

对到期 monitor `M`，找出需要远程调用的云函数探针：

**租户云函数探针**（`scope=TENANT`）：

- 通过 `monitor_probes` 显式绑定到 `M`；
- `probe.enabled = true`；
- `probe.provider ∈ { TENCENT, ALIYUN }`；
- `probe.invocationConfig != null`。

**系统云函数探针**（`scope=SYSTEM`）：

- `SystemProbeScheduler.getAssignedProbes(M.id)` 返回的探针；
- 再过滤 `provider ∈ { TENCENT, ALIYUN }` 且 `invocationConfig != null`。

### 6.7 去重策略（防重复入队）

tick 每 10s 一次，检测/调用可能超过 10s，必须去重：

- `monitor-checks`：`jobId = monitor-check:<monitorId>`，配合 BullMQ `deduplication`
  （或入队前检查是否有 pending job），保证同一 monitor 在上一 job 完成前不重复入队。
- `probe-invocations`：`jobId = probe-invocation:<probeId>:<trigger>`，同一探针同一触发类型
  只保留一个 pending job；若新到期 monitor 在 pending 期间被合并遗漏，下一 tick 会重新入队，
  属于可接受的短延迟。

### 6.8 `SystemProbeScheduler` 的最小调整

当前 rebalance 只选 `status=ONLINE` 的系统探针。云函数系统探针在首次被调度前没有心跳，
会被判为 `OFFLINE` 而永远分不到 monitor。因此需要一处最小调整：

> 对 `invocationConfig != null` 的 `SYSTEM` 探针，参与分配的条件改为 `enabled = true`，
> 不再要求 `status = ONLINE`；拉模型的系统探针仍要求 `ONLINE`。

这样调度器可以给云函数系统探针分配 monitor；调用成功后由 processor 把探针标记为 `ONLINE`，
后续 `probe-offline-sweep` 仍按现有 2 分钟规则回收状态。

### 6.9 调用成功后的状态维护

`probe-invocations` processor 每次成功发起 SDK 调用后：

- `probe.lastHeartbeat = now`
- `probe.status = ONLINE`

这样云函数上报结果时，双源聚合查询 `probe.status = 'ONLINE'` 能命中。
云函数侧仍可选择先 `heartbeat` 一次作为兜底（见 7.2），但不再是必需。

### 6.10 执行记录

`probe-invocations` processor 每次发起调用，写一条 `probe_executions`：

```ts
{
  probeId: probe.id,
  monitorId: null,            // 一次调用可能覆盖多个 monitor
  target: 'invoke',
  trigger: ExecutionTrigger.SCHEDULED,
  status: ExecutionStatus.SUCCESS,   // 失败时写 FAILED
  success: true,
  requestMeta: { invocationId, monitorIds, trigger: 'SCHEDULED' },
  responseMeta: { provider, providerRequestId }
}
```

本地检测的执行记录仍由 `CheckerService.execute` 写（`probeId: null`）。
云函数实际检测结果由上报路径写各自的 `probe_executions`。

## 7. 云函数侧设计

### 7.1 入口

新增 `scripts/probe-agent-scf-push.js`（或扩展 `probe-agent-scf.js` 增加 push 模式）：

- 部署包仍为 `probe-agent.js` + 入口文件，零第三方依赖。
- 腾讯云 SCF handler：`probe-agent-scf-push.main_handler`。
- 阿里云 FC handler：按实际部署配置（如 `index.handler`）。

### 7.2 push 模式执行流程

```text
main_handler(event, context)
  1. 从环境变量 loadConfig（BEACON_API_URL、PROBE_KEY、PROBE_TOKEN）
  2. normalizeInvocationEvent(event) -> payload
  3. 校验 payload.version、payload.monitors
  4. 可选兜底：POST /probes/heartbeat（标记 ONLINE；后端调度时通常已标记）
  5. 对 payload.monitors 逐个 checkMonitor
  6. POST /probes/results 批量上报
  7. 返回 { code: 0, invocationId, results: [...] }
```

### 7.3 复用现有代码

需要从 `probe-agent.js` 额外导出（或封装）：

- `checkMonitor(monitor, config)`
- `reportResults(config, results)`
- 可选：`heartbeat(config)`

拉模型行为完全不变。

### 7.4 云函数环境变量

| 环境变量         | 说明                      |
| ---------------- | ------------------------- |
| `BEACON_API_URL` | 必须 https                |
| `PROBE_KEY`      | 探针 id                   |
| `PROBE_TOKEN`    | 探针 secret，用于上报认证 |

云函数不再需要定时触发器。如需保留定时拉取作为兜底，可继续部署现有 `probe-agent-scf.js`，
两条线互不影响。

## 8. 可选：手动触发接口（辅助旁路）

除调度器自动入队外，保留探针级手动接口，用于“新增监控后立即验证”“运维排查”等场景：

```http
POST /api/organizations/:orgId/probes/:id/invoke        # 租户探针，org ADMIN+
POST /api/admin/system-probes/:id/invoke                 # 系统探针，SUPER_ADMIN
```

请求体（可选）：

```json
{ "monitorIds": ["monitor_1"] }
```

- 缺省 `monitorIds` 时：租户探针用其已绑定 monitors；系统探针用 `getAssignedMonitorIds(id)`。
- controller 只做校验并 **入队 `probe-invocations` job**（`trigger = MANUAL`），不直接调 SDK。
- 返回 `202 Accepted`：`{ invocationId, queued: true, monitorCount }`；
  实际 `providerRequestId` 由 processor 执行后写入 `probe_executions`。
- `AuditLog({ entity: 'Probe', action: 'INVOKE' })`。

## 9. 关键时序

### 9.1 调度器驱动（主流程）

```text
CheckerScheduler          BullMQ                          Beacon 后端                    云厂商             云函数探针
    | tick(10s)              |                                |                           |                    |
    |--扫描到期 monitors----->|                                |                           |                    |
    |--add monitor-checks job>|                                |                           |                    |
    |--add probe-invocations->|                                |                           |                    |
    |                         |--monitor-checks processor----->| 本地检测/状态聚合/通知    |                    |
    |                         |--probe-invocations processor-->| CloudProbeInvoker.invoke()|                    |
    |                         |                                |-------------------------->|                    |
    |                         |                                |<--------------------------| requestId          |
    |                         |                                | 标记 probe ONLINE          |                    |
    |                         |                                | 写 probe_executions        |                    |
    |                         |                                |                           | 异步调用 event     |
    |                         |                                |                           |------------------->|
    |                         |                                |                           |                    | 检测
    |                         |                                |<-----------------------------------------------| report results
    |                         |                                | recordResults              |                    |
    |                         |                                | -> probe_results           |                    |
    |                         |                                | -> ingestProbeReport       |                    |
    |                         |                                | -> 双源聚合/状态/通知       |                    |
```

### 9.2 手动触发（辅助）

管理员调 `POST .../invoke` → 后端入队 `probe-invocations`（`trigger=MANUAL`）→ processor
执行 SDK 调用 → 云函数上报，后续与 9.1 相同。

## 10. 安全设计

- 云账号凭据只存后端环境变量；`Probe.invocationConfig` 只存函数标识，不存 AK/SK。
- 云函数上报用探针自己的 `secret`（`x-probe-secret`），与后端调用云函数的云账号权限解耦。
- 后端调用云函数的最小权限：仅允许对指定函数执行 `InvokeFunction`。
- 云函数环境变量建议用云厂商密钥托管能力注入 `PROBE_TOKEN`。
- 全程 https；payload 中不传 secret。

## 11. 文件清单与改动点（规划）

| 文件                                                          | 变更                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `prisma/schema.prisma`                                        | `Probe` 增加 `invocationConfig Json?`                   |
| `prisma/migrations/...`                                       | 新迁移                                                  |
| `src/modules/probes/dto/*.dto.ts`                             | 增加可选 `invocationConfig` 及校验                      |
| `src/modules/probes/entities/probe.entity.ts`                 | 返回 `invocationConfig`                                 |
| `src/infra/queue/queue.module.ts`                             | 新增：抽取 BullMQ `forRootAsync` 根连接                 |
| `src/modules/notifier/notifier.module.ts`                     | 改为 `registerQueue`，移除本地 `forRootAsync`           |
| `src/modules/cloud-probe/cloud-probe-invoker.interface.ts`    | 新增                                                    |
| `src/modules/cloud-probe/tencent-scf-invoker.ts`              | 腾讯云 SDK 调用实现                                     |
| `src/modules/cloud-probe/aliyun-fc-invoker.ts`                | 阿里云 SDK 调用实现                                     |
| `src/modules/cloud-probe/cloud-probe.module.ts`               | 模块接线 + `registerQueue(probe-invocations)`           |
| `src/modules/cloud-probe/probe-invocation.processor.ts`       | 新增 processor                                          |
| `src/config/`                                                 | 增加腾讯/阿里凭据配置工厂                               |
| `src/modules/checker/checker.queue.ts`                        | 新增队列常量与 job data 类型                            |
| `src/modules/checker/monitor-check.processor.ts`              | 新增本地检测 processor                                  |
| `src/modules/checker/checker.scheduler.ts`                    | 改为只扫描 + 入队，不再直接执行                         |
| `src/modules/checker/checker.service.ts`                      | 拆出 `findDueMonitors` / `executeMonitor`；保留聚合逻辑 |
| `src/modules/admin/system-probes/system-probe-scheduler.ts`   | 云函数系统探针参与分配时不再要求 `ONLINE`               |
| `src/modules/probes/probes.controller.ts`                     | 可选：新增 `POST :id/invoke`（入队）                    |
| `src/modules/admin/system-probes/system-probes.controller.ts` | 可选：新增 `POST :id/invoke`（入队）                    |
| `src/modules/probes/probes.service.ts`                        | 手动触发的 payload 组装、入队与执行记录                 |
| `scripts/probe-agent.js`                                      | 导出 `checkMonitor` / `reportResults`（无行为变化）     |
| `scripts/probe-agent-scf-push.js`                             | 新增 push 模式入口                                      |
| `docs/proposals/cloud-probe-invocation.md`                    | 本文档                                                  |

## 12. 实施阶段建议

1. **阶段 0**：确认 `invocationConfig` 结构、云函数部署规范、凭据注入方式。
2. **阶段 1**：Prisma 迁移 + DTO/Entity 扩展。
3. **阶段 2**：抽取 BullMQ 根连接到 `infra/queue`，新增两个队列常量和 processor 骨架。
4. **阶段 3**：`CloudProbeInvoker` + 腾讯云实现；先跑通“手动接口 → 入队 → processor → SDK 调用 → 云函数上报”。
5. **阶段 4**：改造 `CheckerScheduler` 为扫描 + 入队，接入 `monitor-checks` / `probe-invocations`。
6. **阶段 5**：阿里云实现 + `SystemProbeScheduler` 最小调整。
7. **阶段 6**：`probe-agent-scf-push.js` 脚本 + 云函数部署文档。
8. **阶段 7**：单测 + e2e（mock invoker + mock queue）+ 腾讯/阿里真机联调。

## 13. 验收标准

1. `pnpm type-check` / `pnpm lint` / `pnpm build` 通过。
2. `CheckerScheduler` tick 只做扫描和入队，不再直接执行检测或 SDK 调用。
3. `monitor-checks` / `probe-invocations` 队列能被各自 processor 正常消费；
   同一 monitor 在 pending 期间不重复入队。
4. monitor 到期时，绑定/分配到云函数探针的 monitor 会通过 `probe-invocations` 触发一次 SDK
   远程调用，且本地检测结果不受影响。
5. 腾讯云 SCF 与阿里云 FC 各完成一次调度器驱动的真实调用：云函数执行 → 上报 →
   `probe_results` 有记录 → `probe_executions` 有 `trigger=SCHEDULED` 的 `invoke` 记录与检测记录。
6. 云函数上报后，目标 monitor 的双源聚合与通知行为符合现有逻辑。
7. 现有拉模型探针、本地调度和通知队列无回归（相关单测全绿）。

## 14. 开放问题 / 风险

1. **重复入队 vs 任务遗漏**：`probe-invocations` 按 probe 去重时，pending 期间新到期的 monitor
   可能被合并遗漏，下一 tick 才能补；需在实现时用 BullMQ deduplication + 可重入扫描验证。
2. **调用频率与云函数成本**：monitor 到期即调用云函数，调用次数与 monitor 数量、interval 直接
   相关；需要按探针分组批量传 monitors，并评估云函数调用费。
3. **冷启动**：云函数冷启动可能超过 monitor `timeout`，首轮可能失败；需给函数运行时间留余量，
   或在双源聚合中容忍首轮失败（现有 2 分钟窗口 + 本地结果兜底可缓解）。
4. **系统探针状态语义**：云函数系统探针不再要求 `ONLINE` 才能分配，`status` 退化为
   “最近一次调用/上报状态”，需确认 `probe-offline-sweep` 与 `SystemProbeScheduler` 的交互
   不会造成分配抖动。
5. **异步调用无返回值**：后端只能确认“已发起调用”，执行失败需靠 `probe_executions` 和云厂商
   日志定位；是否需要按 invocationId 对账（调用记录 vs 上报记录）可后续增强。
6. **重试幂等**：`probe-invocations` 失败重试可能重复调用云函数；需固定 `invocationId`，
   云函数侧对同一 invocationId 做幂等。
7. **SDK 依赖体积**：评估只引入 SCF/FC 子包。
8. **队列积压**：Redis 故障或 processor 挂起时任务会积压；需配置队列监控与告警。
9. **限流**：云厂商 API 限流与后端 `ThrottlerGuard` 需要压测验证。

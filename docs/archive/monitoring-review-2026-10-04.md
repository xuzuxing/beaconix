# 监控差异分析与优化建议（2026-10-04）

> 文档类型：历史归档。原文中的“当前状态”、缺口、示例和阶段计划均属于当时的设计快照，不代表最新实现；日常使用请从 [文档索引](../README.md) 查找现行接口与运行指南。

## 设计与实现差异

生成时间：2026-10-04

### 结论摘要

当前仓库已经把“暗哨 / Beacon Watch”的核心模型和主要模块接入进来了：`Monitor`、`MonitorState`、`Probe`、`ProbeResult`、`CheckLog`、`NotificationChannel`、`NotificationLog`、`StatusPage` 已写入 Prisma schema，代码层也已有 `monitors`、`probes`、`checker`、`state`、`notifier` 模块。

但实现还没有完全等同于 `docs/archive/monitoring-v1.0-design.md` 中的原设计。最关键的偏差在核心链路：原设计是“本地检测 + 探针结果做双源汇总，然后状态机只消费汇总结论”；当前实现是“本地结果和探针结果分别直接推进状态机”。这会改变告警语义，可能导致探针单独失败也累计故障，或本地成功直接覆盖探针失败。

另外，通知实现目前是同步 fan-out 到渠道，未接入 Redis/BullMQ 队列；状态页只有数据模型没有 API；监控创建/更新也还缺少部分业务校验和调度联动。

### 已实现部分

| 设计项             | 当前状态                   | 证据                                                                                                                    |
| ------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 监控数据模型       | 已实现                     | `prisma/schema.prisma:617` 定义 `Monitor`，`prisma/schema.prisma:647` 定义 `MonitorState`                               |
| 探针数据模型       | 已实现                     | `prisma/schema.prisma:662` 定义 `Probe`，`prisma/schema.prisma:702` 定义 `ProbeResult`                                  |
| 监控 CRUD          | 基本实现                   | `src/modules/monitors/monitors.service.ts:21` 创建监控并创建状态；`src/modules/monitors/monitors.service.ts:109` 软删除 |
| 暂停 / 恢复        | 已实现，但接口和原设计不同 | 当前是 `POST :id/pause` / `POST :id/resume`，而原设计是 `PATCH /monitors/:id/toggle`                                    |
| 定时检测           | 已实现，但调度方式不同     | `src/modules/checker/checker.scheduler.ts` 每 10 秒扫描 due monitors，而不是为每个 monitor 注册独立定时器               |
| HTTP / TCP 检测器  | 已实现                     | `src/modules/checker/checkers/http.checker.ts`、`src/modules/checker/checkers/tcp.checker.ts`                           |
| 状态机             | 已实现                     | `src/modules/state/state.service.ts:46` 的 `deriveState` 实现 UNKNOWN/UP/DEGRADED/DOWN/PAUSED                           |
| 探针心跳和结果上报 | 已实现，接口形态有调整     | `src/modules/probes/probe-ingest.controller.ts` 提供 `/probes/heartbeat` 和 `/probes/results`                           |
| 通知渠道           | 已实现多渠道               | `src/modules/notifier/channel-config.ts` 支持飞书、企微、钉钉、微信订阅、邮件                                           |
| 通知日志           | 已实现                     | `src/modules/notifier/notifier.service.ts:200` 写入 `NotificationLog`                                                   |
| 监控状态查询       | 已补强                     | `src/modules/state/state.service.ts:153` 返回当前状态、24h uptime、平均延迟                                             |

### 关键偏差

#### 1. 双源汇总尚未按设计实现

原设计：本地检测失败后，需要结合 2 分钟内探针结果，按规则得到最终结论：

| 场景                       | 原设计判定       |
| -------------------------- | ---------------- |
| 本地成功                   | UP               |
| 本地失败，任意探针成功     | UP               |
| 本地失败，所有有效探针失败 | DOWN             |
| 无有效探针                 | 仅以本地结果为准 |

当前实现：`CheckerService.ingestProbeReport()` 在找到同 target monitor 后，直接调用 `execute(..., CheckSource.PROBE, reported)`，而 `execute()` 直接调用 `stateService.record()` 推进状态。

证据：

- `src/modules/checker/checker.service.ts:60` 定义 `ingestProbeReport`
- `src/modules/checker/checker.service.ts:75` 把探针结果传入 `execute`
- `src/modules/checker/checker.service.ts:178` 调用 `stateService.record`
- `src/modules/state/state.service.ts:93` 状态机只看单次 outcome 的 `success`

影响：状态机消费的是单源结果，不是汇总结论。原设计中“探针用于过滤本地网络抖动”的核心价值还没落地。

#### 2. ProbeResult 与 CheckLog 的语义混在一起

当前探针上报时既写 `probe_results`，又通过 `StateService.record()` 写一条 `check_logs`，source 为 `PROBE`。

证据：

- `src/modules/probes/probes.service.ts:284` 批量写 `ProbeResult`
- `src/modules/probes/probes.service.ts:304` 逐条调用 `checkerService.ingestProbeReport`
- `src/modules/state/state.service.ts:113` 所有 outcome 都写 `CheckLog`

这不是绝对错误，但需要重新定义表语义：`ProbeResult` 是原始探针样本，`CheckLog` 是状态机消费记录。如果未来实现双源汇总，`CheckLog` 更适合记录“最终汇总结论”，而不是每个探针单点样本。

#### 3. 通知未使用 Redis/BullMQ 队列

原设计写明通知链路为 `NotifierService.notify() -> Redis queue -> NotificationProcessor`，失败由 BullMQ 指数退避重试。

当前实现是进程内同步 fan-out：

- `src/modules/notifier/notifier.service.ts:105` 查询渠道
- `src/modules/notifier/notifier.service.ts:118` `Promise.all` 直接发送
- `package.json` 没有 `bullmq` / `@nestjs/bullmq`

影响：检测请求或定时任务会等待渠道发送完成。代码中对单个渠道失败做了隔离和日志记录，这是好的；但没有队列级重试、积压处理、异步解耦和 worker 可观测性。

#### 4. DEGRADED 通知规则与原设计不同

原设计：`DEGRADED` 是缓冲态，不通知；只有 DOWN 告警、DOWN 后 UP 恢复通知。

当前实现：`NOTIFIABLE_STATUSES` 包含 `DEGRADED`。

证据：`src/modules/notifier/notifier.service.ts:28`

虽然 `shouldNotify()` 会跳过首次 `UNKNOWN -> UP`，但没有跳过 `UP -> DEGRADED`。这会让连续失败未达阈值时就通知，和原设计“不让单次抖动误报”的目标冲突。

#### 5. 首次失败可能触发通知

原设计：首次检测只建基线，不通知。当前逻辑只特别跳过 `UNKNOWN -> UP`，未跳过 `UNKNOWN -> DEGRADED` 或 `UNKNOWN -> DOWN`。

证据：

- `src/modules/notifier/notifier.service.ts:77` 只处理 `UNKNOWN -> UP`
- `src/modules/notifier/notifier.service.ts:84` 其他状态只比较 `lastNotifiedStatus`

如果新建 monitor 首次检测失败，且组织已有渠道，可能立即通知。这与原设计相反，但也可能是产品上更激进的合理选择；需要明确。

#### 6. 创建 / 更新监控缺少原设计中的部分业务动作

原设计要求：

- 创建时校验 HTTP/TCP target 格式
- 创建后注册调度器
- 创建后立即检测一次建立基线
- target/type 变更时重置状态
- 更新时重注册调度
- 删除时注销调度

当前实现：

- DTO 仅做字符串长度和数值范围校验，未按 monitor type 校验 target 格式：`src/modules/monitors/dto/create-monitor.dto.ts:30`
- 创建仅写 monitor 和 state：`src/modules/monitors/monitors.service.ts:21`
- 更新直接写 dto，不重置状态：`src/modules/monitors/monitors.service.ts:51`
- 当前调度器是统一扫描 due monitors，不需要手动注册/注销，这是实现选择变化，但设计文档应同步更新

#### 7. 探针绑定方式与设计不一致

原设计写“创建监控时可选 probeIds，更新时全量替换”。当前实现把绑定放在 Probe 侧接口：

- `POST /organizations/:orgId/probes/:id/monitors`
- `DELETE /organizations/:orgId/probes/:id/monitors/:monitorId`

证据：`src/modules/probes/probes.controller.ts`

这不是坏事，甚至更清晰，但文档需要改：当前不是 monitor 创建时配置 probeIds。

#### 8. Probe callback 形态已变更

原设计是 `POST /probe/callback`，当前是两个 agent API：

- `POST /api/probes/heartbeat`
- `POST /api/probes/results`

证据：`src/modules/probes/probe-ingest.controller.ts`

这个设计比单 callback 更适合“探针先拉取任务再批量回传结果”，建议保留当前接口并更新设计文档。

#### 9. StatusPage 只有模型，没有功能模块

`StatusPage` 已在 schema 里存在，但没有 `status-pages` module/controller/service。

证据：

- `prisma/schema.prisma:772` 定义 `StatusPage`
- `rg` 未发现 `src/modules/status-pages`

如果 V1.0 不做状态页，应从原设计“核心表关系”中标为预留；如果要做，需要补 API 和公开读取端点。

#### 10. Redis 已在 compose 中，但应用未使用

`docker-compose.yml` 启动 Redis；原设计也把 Redis/BullMQ 作为通知队列。但应用依赖和模块中未接入 Redis。

证据：

- `docker-compose.yml:18` 定义 redis service
- `package.json` 未声明 BullMQ 相关依赖

如果短期不引入 BullMQ，应把 Redis 从“必需基础设施”降为“通知队列启用时需要”，避免开发环境误解。

### 已优于原设计的地方

| 当前实现                                      | 价值                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 复用了现有 JWT、OrgMemberGuard、RolesGuard    | 监控模块已经符合 Beacon 现有多租户和 RBAC 体系                                                           |
| 监控 API 挂在 `/projects/:projectId/...` 下   | 与 User -> Organization -> Project -> business resources 的业务边界一致，并继续通过 project 反推组织权限 |
| 探针 heartbeat/results 分离                   | 更适合 agent 拉取任务和批量上报                                                                          |
| 支持企微、钉钉、微信订阅、邮件                | 比原设计只展开飞书更完整                                                                                 |
| `getSummary()` 提供 24h uptime 和 avg latency | 已经开始补监控产品需要的读模型                                                                           |
| 定时扫描 due monitors                         | 比“每 monitor 注册一个 timer”更易恢复、更适合单进程重启                                                  |

### 文档需要同步修改

建议把 `docs/archive/monitoring-v1.0-design.md` 从“设计期蓝图”更新为“当前 V1 实现设计”，重点修改：

1. 技术栈：如果未接 BullMQ，先不要写 Redis + BullMQ 是通知主链路。
2. 核心链路：明确当前是统一调度器扫描 due monitors。
3. 探针接口：改为 heartbeat/results。
4. 双源汇总：要么补实现，要么标注为“待实现”。
5. 通知规则：明确 DEGRADED 是否通知、首次失败是否通知。
6. API 总览：按当前 `/api/organizations/:orgId/...` 路径更新。
7. 状态页：标为预留或补模块计划。

## 优化路线与实施建议

生成时间：2026-10-04

### 优先级总览

| 优先级 | 事项                             | 为什么先做                        | 预计工作量 |
| ------ | -------------------------------- | --------------------------------- | ---------- |
| P0     | 实现真正的双源汇总               | 决定告警可信度，是原设计核心卖点  | M          |
| P0     | 修正通知触发规则                 | 防止 DEGRADED / 首次失败误报      | S          |
| P1     | 明确 CheckLog / ProbeResult 语义 | 避免历史数据、统计和状态机混乱    | M          |
| P1     | 监控创建/更新业务校验和状态重置  | 避免非法 target、旧状态污染新目标 | S          |
| P1     | 通知队列化或明确暂不队列化       | 影响检测链路延迟和失败重试        | M          |
| P2     | 状态页模块                       | schema 已有，但产品能力未闭环     | M          |
| P2     | 更新设计文档和 OpenAPI 描述      | 避免团队按旧接口开发 agent/UI     | S          |

### P0-1：实现真正的双源汇总

#### 当前问题

探针结果现在会直接推进状态机。代码路径是：

1. `ProbesService.recordResults()` 写入 `ProbeResult`
2. 逐条调用 `CheckerService.ingestProbeReport()`
3. `ingestProbeReport()` 调用 `execute(..., CheckSource.PROBE, reported)`
4. `execute()` 调用 `StateService.record()`

这意味着探针结果不是“辅助本地失败判断”，而是“另一次独立检测”。

#### 目标行为

保留原设计判定规则：

- 本地成功：最终成功。
- 本地失败且任意有效探针成功：最终成功。
- 本地失败且所有有效探针失败：最终失败。
- 本地失败但没有有效探针：按本地失败处理。
- 探针结果超过窗口期不参与汇总，默认窗口建议 2 分钟。

#### 建议实施

1. 在 `CheckerService` 中新增汇总方法，例如 `evaluateMonitor(monitor, localResult)`。
2. 本地检测完成后，先写原始本地结果，再查询该 monitor 绑定探针在窗口期内的 `ProbeResult`。
3. 只把汇总后的 final result 交给 `StateService.record()`。
4. 探针上报时只写 `ProbeResult`，不要直接推进 `MonitorState`。
5. 如果希望探针上报后能立即刷新状态，可以让 `recordResults()` 找到关联 monitor 后调用 `aggregateMonitor(monitorId)`，但该方法必须读取最新本地结果和探针结果再得出最终结果。

#### 需要特别小心

- 不能仅按 `target` 匹配探针结果。当前 `ProbeResult` 只有 target，没有 monitorId。如果同一组织有两个 monitor 监控同一 target，不好区分。建议给 `ProbeResult` 增加 `monitorId` 可空字段，agent 上报结果时优先带 monitor id。
- 原 `CheckLog.source` 是 `String`，schema 里已有 `CheckSource` enum。建议改成 `CheckSource`，并考虑增加 `AGGREGATED` 或新增 `EvaluationLog`，否则无法表达“最终汇总结论”。

#### 验收测试

新增或改写 `src/modules/checker/checker.service.spec.ts`：

- 本地成功时，不查询探针也能得到 UP。
- 本地失败 + 2 分钟内任意探针成功，最终 success 为 true，failCount 清零。
- 本地失败 + 所有有效探针失败，最终 success 为 false。
- 本地失败 + 探针结果过期，按本地失败。
- 探针上报结果不会单独调用 `StateService.record()` 推进状态。

### P0-2：修正通知触发规则

#### 当前问题

当前 `NotifierService` 把 `DEGRADED` 放进可通知状态，并且只跳过 `UNKNOWN -> UP`。

证据：`src/modules/notifier/notifier.service.ts:28`

#### 推荐规则

建议回到原设计：

- `DOWN`：发送故障告警。
- `UP` 且上一已通知状态为 `DOWN`：发送恢复通知。
- `DEGRADED`：不通知。
- `UNKNOWN` / `PAUSED`：不通知。
- 首次检测不通知，无论首次结果是 UP、DEGRADED 还是 DOWN。

#### 建议实施

1. 将 `NOTIFIABLE_STATUSES` 缩小为 `UP` 和 `DOWN`，或直接在 `shouldNotify()` 中显式判断。
2. 引入“是否已有基线”的判断。可以使用 `transition.previousStatus === UNKNOWN && lastNotifiedStatus === null` 作为近似规则，但更稳妥的是在 `MonitorState` 增加 `hasBaseline` 或用 `lastCheckAt` 判断。
3. 更新 `src/modules/notifier/notifier.service.spec.ts`，加入 `UP -> DEGRADED` 不通知、`UNKNOWN -> DOWN` 不通知、`DOWN -> UP` 通知。

#### 可选产品决策

如果你希望“新建监控首次就是 DOWN 也要提醒”，那就明确偏离原设计，并在文档中写成产品规则。否则按上面规则执行。

### P1-1：整理 CheckLog / ProbeResult / 状态评估语义

#### 推荐数据语义

| 表                | 推荐职责                                                          |
| ----------------- | ----------------------------------------------------------------- |
| `ProbeResult`     | 探针原始样本，一条结果对应一个 probe 对一个 monitor/target 的观测 |
| `CheckLog`        | 本地检测原始样本，或最终评估记录；二选一要明确                    |
| `MonitorState`    | 当前聚合状态，只保存最新状态，不承担历史审计                      |
| `NotificationLog` | 每个渠道的一次发送尝试                                            |

更推荐的做法是：

- `CheckLog` 记录本地检测原始样本。
- 新增 `MonitorEvaluation` 或 `StateTransitionLog` 记录汇总后的最终结论。

如果不想新增表，则 `CheckLog` 应改名/改语义为“状态机消费记录”，并避免把每条探针原始结果再写进去。

#### 索引建议

如果继续使用窗口查询：

- `ProbeResult` 建议增加 `[probeId, checkedAt]` 已有。
- 如果增加 `monitorId`，补 `@@index([monitorId, checkedAt])`。
- `CheckLog` 当前有 `[monitorId, checkedAt]`，够用。

### P1-2：补齐监控创建/更新规则

#### 需要补的行为

1. HTTP target 必须是 `http://` 或 `https://`。
2. TCP target 必须可解析为 `host:port`，port 在 1-65535。
3. TCP monitor 不应强制要求有意义的 `expectedStatus`。
4. target 或 type 变更时重置状态：`status=UNKNOWN`、`failCount=0`、`lastError=null`、`lastLatency=null`。
5. 恢复 soft-deleted monitor 时，建议如果 `enabled=true`，让下一轮调度尽快检测，或提供立即检测选项。

#### 建议实现位置

- DTO 继续做类型和范围校验。
- 与 type 相关的 target 校验放在 `MonitorsService` 私有方法中，因为 class-validator 做跨字段校验会增加复杂度。
- 更新时先读取旧 monitor，比较 `type` / `target` 是否变化，再决定是否重置 state。

#### 验收测试

新增 `src/modules/monitors/monitors.service.spec.ts` 用例：

- HTTP target 不带协议会失败。
- TCP target 没有端口会失败。
- target 变更后 state 被重置。
- 只改 name/interval 不重置 state。

### P1-3：通知队列化

#### 选择 A：按原设计引入 BullMQ

适合目标：生产可用、渠道重试、通知高峰不阻塞检测。

实施建议：

1. 增加 `@nestjs/bullmq` 和 `bullmq`。
2. 在 `NotifierModule` 注册 `notification` queue。
3. `NotifierService.notifyTransition()` 只负责创建 job。
4. 新增 `NotificationProcessor` 消费 job，调用现有 sender 并写 `NotificationLog`。
5. 保留 `sendTestMessage()` 同步发送，因为测试按钮需要即时结果。

验收：

- 渠道失败时 job 按指数退避重试。
- 一个渠道失败不影响其他渠道。
- 检测服务不等待外部 webhook 请求完成。

#### 选择 B：短期不引入队列

适合目标：先把 MVP 跑通。

需要同步修改：

1. `docs/archive/monitoring-v1.0-design.md` 不再把 Redis/BullMQ 写成当前主链路。
2. `docker-compose.yml` 中 Redis 标为可选，或说明目前预留。
3. 风险章节写清楚：通知发送仍在应用进程内，外部渠道慢会占用检测任务时间。

### P2-1：补状态页模块

#### 当前状态

`StatusPage` schema 已有，但没有模块。若前端或公开页面要用，缺口包括：

- 管理端 CRUD。
- 公开读取：`GET /api/status-pages/:slug` 或 `/api/public/status/:slug`。
- 只暴露 `visibleMonitorIds` 指定的 monitor。
- 汇总状态规则，例如任一 DOWN 则整体 DOWN，任一 DEGRADED 则 DEGRADED。

#### 建议 MVP 接口

| 方法   | 路径                                     | 鉴权   | 说明       |
| ------ | ---------------------------------------- | ------ | ---------- |
| POST   | `/organizations/:orgId/status-pages`     | ADMIN  | 创建状态页 |
| GET    | `/organizations/:orgId/status-pages`     | MEMBER | 列表       |
| PATCH  | `/organizations/:orgId/status-pages/:id` | ADMIN  | 更新       |
| DELETE | `/organizations/:orgId/status-pages/:id` | ADMIN  | 删除       |
| GET    | `/status/:slug`                          | Public | 公开状态页 |

### P2-2：补监控模块 e2e 测试

当前单测已有基础覆盖，但缺少完整链路 e2e。建议补：

1. 创建 monitor -> 手动 check -> 生成 CheckLog -> state 更新。
2. 创建 probe -> bind monitor -> heartbeat 返回 monitor。
3. probe results 上报 -> ProbeResult 写入。
4. 通知渠道 test endpoint 行为。
5. RBAC：VIEWER 不能创建/更新 monitor，MEMBER 能查看，ADMIN 能管理。

### 建议执行顺序

1. 先决定通知策略：DEGRADED 是否通知，首次失败是否通知。
2. 修正通知触发规则和测试。
3. 重构双源汇总，让状态机只消费最终结论。
4. 重新定义并迁移 CheckLog / ProbeResult 语义。
5. 补监控创建/更新校验和状态重置。
6. 决定是否立即上 BullMQ；若不上，先更新文档和环境说明。
7. 状态页作为 V1.1 或 V1.2 功能补齐。

### 推荐更新 `docs/archive/monitoring-v1.0-design.md` 的方向

把原文档拆成两层：

1. `README.md`：保留产品目标、模块总览、当前实现架构和 API。
2. `docs/archive/monitoring-review-2026-10-04.md`：记录待实现能力和优先级。

这样团队不会把旧设计误认为当前事实，也不会丢掉最初设计里的好判断。

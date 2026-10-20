# 003：探针成功率批次判定实施方案（合并最终版）
> 状态：已实施，本地验收通过，未部署。更新日期：2026-10-18，合并稿。
> 基准：`e2895cc` 加设计时的实时工作区；仓库根目录是 `D:/WorkSpace/beacon`。
> 本文件由两条方案合并而成，是唯一实施依据：
> 1. 见 `plans/003-probe-success-ratio.md`（滑动窗口快照 + 探针主力 + 本地兜底）；
> 2. 本轮提案（roundId 批次 + `CheckLog.appliedAt` 批次级幂等 + 先到先结算）。
> 合并结论：**判定语义采用旧 003（探针主力可否决本地成功、固定分母 N）**。
> **聚合组织方式采用本轮提案：roundId 批次与批次级幂等**。
> **批次结算触发点改为「到齐可提前、否则批次截止」**。
> 见第 12 节逐条记录采纳与驳回，见第 14 节记录全部代码事实的来源位置。
## 1. 目标与范围
判定主次反转：显式绑定的有效租户探针构成主力证据。**成功比例只按这些探针计算**。本地检测降级为兜底，只在没有主力证据时决定结论。新增 `Monitor.probeSuccessRatio`，与现有 `failureThreshold` 独立。
| 参数 | 作用 |
| --- | --- |
| `probeSuccessRatio` | 有主力探针证据时，这些探针需要达到多少成功百分比 |
| `failureThreshold` | 状态与告警现有的连续失败/连续异常门槛，算法不变 |
| `availabilityThreshold` | 规则健康可用率阈值，算法不变 |
| `availabilityWindow` | 规则健康可用率统计样本数，算法不变 |

优先级 P1，风险 MED。工作量从 1– 个工程日升到 **3– 个工程日**（合并稿新增
批次生命周期、截止结算队列、状态结算入口与对应测试）。不包含真轮次协调和生产容量调优。无计划编号依赖，但目标数据库必须已有当前迁移历史。
保持项目作用域、多租户隔离、现有动态系统探针分配，以及当前 HTTP/TCP 的兼容边界。不新增聚合模式枚举，不把探针比例写进规则树，不升级 Agent/SCF 协议。
首版的两个边界必须一并保留，不能只实现「探针主力」而丢掉兜底：

- 系统探针是自动分配的（`system-probe-scheduler.ts` 只给活跃租户探针少于 2 个的
  HTTP/TCP monitor（1 个）**不参与主力判定**，仍只承担救回角色。 这样没有显式绑定租户探针的存量监控行为完全不变。
- 有主力探针但没有一条有效结果时（探针刚分配、掉线、监控刚启用），
  本地结论兜底，不把「没有证据」解释成「探针全部失败」。
## 2. 合并决策记录

### 2.1 本轮提案被采纳的部分

| 提案条款 | 采纳方式 | 说明 |
| --- | --- | --- |
| `Monitor.probeSuccessRatio` 字段与默认值 1 | 原样采纳 | 语义按第 3 节重写，默认值 1 = 「至少 1 个有效租户探针成功」 |
| `ProbeResult.roundId` 批次标识与两个索引 | 采纳 | 索引名按 `prisma/schema.prisma` 现有 `@@map` 风格生成 |
| `CheckLog.roundId`、`CheckLog.appliedAt` 与索引 | 采纳，并升级为唯一约束 | `@@unique([monitorId, roundId])` 取代普通索引，见 2.3 |
| 批次级幂等：探针多次到达不重复累加 `failCount` | 采纳 | 载体从「settleRound 直接 update」改为 `StateService.settle`，见第 9 节 |
| 本地与探针同批次判定 | 采纳 | 批次由本地检查锚定，探针结果归属当前未结算批次，见第 6 节 |
| 三层告警独立，批次只影响 CONNECTIVITY 与 `failCount` | 采纳 | 与原 003 一致，且不新增告警通道 |
| 迁移里的 CHECK 约束、触发器同步、`definitionChanged`、DTO/Entity | 原样采纳 | 见第 5、6 节） |

### 2.2 本轮提案被驳回或改写的部分
| 提案条款 | 结论 | 理由 |
| --- | --- | --- |
| 「本地成功⇒本轮成功（不查探针）」 | **驳回** | 与本方案的产品目标冲突：本地成功必须能被探针否决，否则「探针主力」退化成旧行为 |
| 分母 = ` 本地 1 票+ 有结果的探针数 ` | **驳回** | 分母必须固定为当前有效绑定租户探针数 N，缺失/过期探针计为未成功；否则「绑定 5 个只报 3 个上报且全成功）= 100%」 |
| 「本地也算一票」 | **驳回** | 本地是兜底不是证据，与 N 分母语义冲突 |
| 系统探针与租户探针合并进同一投票集合 | **驳回** | 系统探针自动分配，参与主力会改变全部存量 HTTP/TCP 监控的判定 |
| 默认值 1「升级无感知」 | **驳回** | 新语义下 N 个探针全失败时本地成功也会被判失败（`failureKind='AGGREGATE'`），发布说明必须写明 |
| `settleRound` 直接在事务里 `monitorState.update` 改 `failCount` | **驳回，改为** | 会绕过唯一的告警评估路径 `AlertEventsService.record`，导致 `connectivityFailCount` 与 CONNECTIVITY 事件不同步。改为走新增的 `StateService.settle`（第 9 节） |
| 「先到先结算（本地写完立即结算）」 | **改写** | 本地周期性主动调度、探针被动上报，而 `ingestProbeReportForMonitor` 要求先有本地 CheckLog。本地一写完就结算，则结算时样本通常为 0，主力永远不生效。改为「到齐可提前，否则批次截止」（见 10 节） |
| `buildRoundId` 按墙钟 interval 对齐 | **改写** | 本地检查由 `lastLocalCheckAt + interval` 驱动，与墙钟不对齐；按墙钟对齐会让本地与探针系统性落在不同窗口。改为由本地检查时刻锚定批次，探针结果归属当前未结算批次（见 6 节） |
| 测试清单「`roundId` 隔离不同批次样本不串」 | **部分改写** | 样本范围 = `roundId ∈ {本批, 前一批}` + `checkedAt >= roundStart - probeResultWindowMs`。允许复用前一批样本，是因为探针上报节拍与监控 interval 不同相，只看本批会系统性缺票（见 8.1 节） |

### 2.3 唯一约束取代普通索引的理由

本轮提案给 `CheckLog` 加的是 `@@index([monitorId, roundId])`。本方案改为
`@@unique([monitorId, roundId])`。
- 批次幂等必须由数据库兜底，否则本地结算与探针结算并发时会写出两行 CheckLog， 两次累加 `failCount`，而 `appliedAt` 只在应用层顺序执行时才有效。
- `roundId` 为 `null` 的旧数据在 PostgreSQL 中不参与唯一约束（`NULL` 不等于 `NULL`），
  历史行可以任意多行，升级安全。
- 唯一冲突（`P2002`）即表示「本批次已结算」，结算入口捕获后按重复处理，不报错。
## 3. 固定产品语义

以下是实施决策，不留给执行者自行选择：
| 项目 | 首版决策 |
| --- | --- |
| 聚合组织 | 由本地检查锚定的批次（`roundId`），不是多探针共享的同步检测轮次 |
| 判定主次 | 显式绑定的有效租户探针为主力；本地检测为兜底；系统探针只做救回 |
| 主力探针集合 | 当前 `ProbeScope.TENANT`、`enabled=true`、`status=ONLINE` 且绑定该 monitor 的探针 |
| 主力生效条件 | 有效租户探针数 N > 0，且批次样本集合非空；否则本地结论生效 |
| 成功率分母 | N（当前有效绑定的租户探针数）；未上报、结果过期、离线、解绑的探针计为未成功 |
| 成功率分子 | 各租户探针在本批次样本范围内最新有效结果中 `success=true` 的探针数 M |
| 每探针票数 | 最多一票，取该探针 tuple `(checkedAt, receivedAt, id)` 最大的样本 |
| 样本范围 | `monitorId` + `target` + `configRevision` + `roundId ∈ {本批, 前一批, null}` + `checkedAt >= roundStart - probeResultWindowMs(interval)` |
| 达标 | `M * 100 >= probeSuccessRatio * N`；达标即整体成功，可救回本地失败 |
| 不达标 | 整体失败；本地成功也被否决，`localSuccess` 仍保留为 true |
| 系统探针 | 仅在 N=0 且本地失败时沿用现有「任一成功即救回」；不做主力，不否决本地成功 |
| 零有效结果 | N>0 但批次内无任何有效结果⇒本地结论兜底；不能把空集合解释为全部失败 |
| 本地阻断/断言失败 | 沿用当前保护，不被探针覆盖，且**不等探针**，立即结算 |
| 本地成功 | 不再免检：N>0 且有样本时，探针比例决定最终成功/失败 |
| 比例阈值 | 1–00 的整数百分比；默认值 1 = 「至少 1 个有效租户探针成功」 |
| 比较 | `successCount * 100 >= probeSuccessRatio * N`；不先四舍五入，不用浮点 |
| 结算次数 | 每批次（`monitorId + roundId`）恰好结算一次；由 `appliedAt` + 唯一约束保证 |
| 结算时点 | 到齐（每个有效租户探针都有样本）即结算；否则在批次截止（`roundStart + interval`）结算 |
| 状态计数 | 每批次只推进一次 `failCount`；这是相对旧行为的变化，见 8.5 与 12.1 |
| SSL | SSL 总体结论与服务连通性结论保持独立，探针不覆盖证书判定 |

`100` 表示所有*有效绑定的租户探针*成功，缺失探针会拉低比例。绑定 5 个、只报 3 个上报且全部成功时是 3/5=60%，不是 3/3=100%。首版不引入覆盖率或最少样本数配置；「至少有一个样本才开始判定」是证据存在性门槛，
不是覆盖率门槛。
默认值 1 的准确含义是「N 个有效租户探针中至少 1 个成功」。N=5 有 0 个成功时是 0%，不达标；N=5 有 1 个成功时是 20%，达标。需要「全部探针通过」的用户应设为 100。
判定失败时 `failureKind` 的取值规则：

- 本地失败：保留本地 `failureKind`，只把聚合错误串拼到 `error` 上。
- 本地成功但被探针否决：`failureKind = 'AGGREGATE'`（本次新增的唯一失败类型），
  `serviceVerdict = 'FAILURE'`，`error` 说明比例，`latency`/`statusCode`/`ssl`/`meta`
  等本地证据保持原样。`CheckLog.localSuccess` 为 true、`success` 为 false。 无需新增列即可识别否决场景；`rescuedByProbe` 保持 false。
## 4. 当前系统与需要保留的约束

### 4.1 实际执行链路（已核对 `e2895cc` 后工作区）
```text
本地执行：checker.scheduler -> monitor-check 队列 -> CheckerService.executeMonitor -> execute -> probe()
探针上报：probes.service.recordResults 事务内ProbeResult -> applyStoredResult
          -> CheckerService.ingestProbeReportForMonitor -> execute(PROBE)
两条路径都汇入StateService.record：
  行锁 monitor FOR UPDATE
  -> 配置版本/修订校验、observationId 幂等、sameRound 折叠
  -> deriveState(success, failureThreshold) 决定 status/failCount
  -> CheckLog.create
  -> AlertEventsService.record：CONNECTIVITY / AVAILABILITY / SSL，事务内写outbox
  -> MonitorState.upsert（failCount、connectivityFailCount、lastAppliedObservationAt/Id）
```

不得恢复已经被替代的 `evaluateAvailabilityAlert` 调用，也不得绕过 outbox 直接通知。聚合成功不保证高级规则不命中；保留规则引擎内部算法，但允许比例变化影响 success 输入。
### 4.2 单一状态写入点（合并稿最重要的约束）

`src/modules/state/state.service.ts:129` 的 `record` 是生产代码里唯一的状态写入路径（唯一调用点 `src/modules/checker/checker.service.ts:492`）。批次结算必须复用它的事务骨架与告警评估，不能另起一个 `prisma.monitorState.update`。
因此合并稿**解除旧 003 的「需要修改 `state.service.ts` 就停止」限制**，改为：只允许在 `state.service.ts` 中**新增** `settle` 与共用私有方法，
不改变 `record` 的既有对外行为（见第 9 节）。
### 4.3 现有幂等与去重
| 机制 | 位置 | 语义 | 批次结算后是否保留 |
| --- | --- | --- | --- |
| `CheckLog.observationId @unique` | `schema.prisma:1260` | 单条观察幂等 | 保留 |
| `MonitorState.lastAppliedObservationAt/Id` | `schema.prisma:1050-1051` | 单条结果单调应用 | 保留 |
| `MonitorState.connectivityFailCount` | `state.service.ts:250-254` | 连通性连续失败计数 | 保留 |
| `probeReportDedupWindowMs` 窗口折叠 | `checker.service.ts:69-76, 248-260` | 多条探针回调只折叠一次 | 保留为「避免重复尝试结算」的节流 |
| `StateService.record` 的 `sameRound` | `state.service.ts:215-242` | 回调同轮折叠 | 保留，结算路径不依赖它 |
| `ProbeResult.appliedAt` | `schema.prisma:1207`、`probes.service.ts:756-805` | 探针结果已投递 | 保留，语义不变 |

新增的 `CheckLog.appliedAt` 是*批次级*幂等，与上面「单条级」幂等不冲突。单条幂等回答「这条观察是否已被应用」，批次幂等回答「这一轮聚合是否已写进状态」。
### 4.4 现已存在的关键代码位置
| 关注点 | 位置 |
| --- | --- |
| `evaluateResult` 当前以本地成功提前返回开头 | `checker.service.ts:626-631` |
| `acceptsLegacyProbe`（HTTP/TCP、空 config、SSL 兼容） | `checker.service.ts:612-624` |
| 主体探针查询（`target`/`monitorId`/`configRevision`/窗口/组织/绑定） | `checker.service.ts:656-697` |
| 系统探针分配 | `checker.service.ts:678-679`、`admin/system-probes/system-probe-scheduler.ts` |
| 窗口函数 `probeResultWindowMs`（×interval，夹在 2–5 分钟） | `checker.service.ts:37-54` |
| 回调折叠窗口 `probeReportDedupWindowMs`（interval/4，夹在 5–10 秒） | `checker.service.ts:56-76` |
| `execute` 的 `serviceVerdict ?? localResult.serviceVerdict` 回退 | `checker.service.ts:505` |
| AVAILABILITY 窗口查询（`evaluated`+ `revision`，按 `checkedAt desc`） | `alert-events.service.ts:126-135` |
| `definitionChanged` 字段列表 | `monitors.service.ts:269-288` |
| 配置版本触发器 `beacon_monitor_config()` | `prisma/migrations/20261011100000_merge_monitor_revision_tracking/migration.sql` |

`execute` 的 `serviceVerdict` 回退仍然存在，所以否决分支必须显式写
`serviceVerdict = 'FAILURE'`，否则会退回本地的 `SUCCESS`，出现状态 DOWN
但连通性计数不增长。
代码遵循 pnpm：4 空格、单引号、尾逗号；控制器薄、PrismaService 注入服务；不增加 Repository 层，不调整 guards、审计、配额或模块依赖。
## 5. 数据模型与迁移
### 5.1 Schema

`prisma/schema.prisma` 的 `Monitor`，紧跟 `failureThreshold` 后：
```prisma
  failureThreshold Int @default(3)
  /// 主力租户探针的成功比例门槛（1-100）；默认 1 表示至少 1 个有效租户探针成功。 probeSuccessRatio Int @default(1)
```

`ProbeResult`：
```prisma
  /// 该结果归属的批次标识；未归属到任何批次时保留 null。 roundId String?

  @@index([monitorId, roundId, checkedAt])
  @@index([projectId, monitorId, roundId])
```

`CheckLog`：
```prisma
  /// 批次标识：由一次本地检查锚定的一轮聚合；旧数据为 null。 roundId String?
  /// 批次结论已写入状态与告警的时间；null 表示该批次尚未结算。 appliedAt DateTime?

  @@unique([monitorId, roundId])
  @@index([monitorId, appliedAt])
```

`MonitorState`、`ProbeExecution` 不加列。
### 5.2 新迁移
使用当前时间戳创建 `<timestamp>_add_probe_success_ratio`，仅在新增迁移中执行：
```sql
-- 1. Monitor 比例阈值
ALTER TABLE "monitors"
  ADD COLUMN "probeSuccessRatio" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "monitors"
  ADD CONSTRAINT "monitors_probeSuccessRatio_check"
  CHECK ("probeSuccessRatio" BETWEEN 1 AND 100);

-- 2. ProbeResult 批次标识
ALTER TABLE "probe_results" ADD COLUMN "roundId" TEXT;
CREATE INDEX "probe_results_monitorId_roundId_checkedAt_idx"
  ON "probe_results" ("monitorId", "roundId", "checkedAt");
CREATE INDEX "probe_results_projectId_monitorId_roundId_idx"
  ON "probe_results" ("projectId", "monitorId", "roundId");

-- 3. CheckLog 批次标识、结算标记与批次幂等
ALTER TABLE "check_logs" ADD COLUMN "roundId" TEXT;
ALTER TABLE "check_logs" ADD COLUMN "appliedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "check_logs_monitorId_roundId_key"
  ON "check_logs" ("monitorId", "roundId");
CREATE INDEX "check_logs_monitorId_appliedAt_idx"
  ON "check_logs" ("monitorId", "appliedAt");
```

第 4 步：读取部署链路中最新的 `beacon_monitor_config()`，完整保留现有 OLD/NEW 字段列表，在两个 tuple 的相同位置加入 `"probeSuccessRatio"`；继续只增加 `configRevision`；不在触发器中重复增加应用 `revision`。
```sql
CREATE OR REPLACE FUNCTION beacon_monitor_config() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (OLD.type,OLD.target,OLD.interval,OLD.timeout,OLD."expectedStatus",OLD.enabled,
        OLD."checkSsl",OLD."sslExpiryThreshold",OLD."failureThreshold",OLD."probeSuccessRatio",
        OLD."availabilityEnabled",OLD."availabilityThreshold",OLD."availabilityWindow",OLD."deletedAt",
        OLD.config,OLD."configVersion",OLD."credentialsEnc")
        IS DISTINCT FROM
       (NEW.type,NEW.target,NEW.interval,NEW.timeout,NEW."expectedStatus",NEW.enabled,
        NEW."checkSsl",NEW."sslExpiryThreshold",NEW."failureThreshold",NEW."probeSuccessRatio",
        NEW."availabilityEnabled",NEW."availabilityThreshold",NEW."availabilityWindow",NEW."deletedAt",
        NEW.config,NEW."configVersion",NEW."credentialsEnc")
    THEN NEW."configRevision" := OLD."configRevision" + 1; END IF;
    RETURN NEW;
END $$;
```

约束：
- 不执行主体 UPDATE，不重算历史日志，不为了升级重置全体监控状态。
- 新增列给既有行提供默认值，不应因「添加配置列」主动推进每行的配置版本；
  真正修改阈值时才由触发器推进 `configRevision`。
- 不得修改或重命名已存在的历史迁移。
- 唯一索引允许 `roundId` 为 null 的多行（PostgreSQL `NULL` 不参与唯一约束），
  旧数据无需回填。
### 5.3 生成与夹具
实施后 `pnpm prisma:generate`，由工具生成 `src/generated/prisma/`，不得手写客户端。模拟数据库返回值不会自动获得默认值，相关 monitor 测试夹具必须补上新字段：

- monitor 夹具补 `probeSuccessRatio: 1`。
- `probeResult` 夹具补 `roundId`，旧「只有 `success`」的样本不能继续作为有效样本。
- `checkLog` 夹具补 `roundId: null`、`appliedAt: <Date>`（旧行视为已结算）。
## 6. 批次（roundId）语义
### 6.1 生成规则

批次由**本地检查**锚定，用服务端时钟，不信任 Agent 时钟。
```typescript
/** Batch id anchored at the local check start; probes join the open batch. */
export function buildRoundId(monitorId: string, startedAt: Date): string {
    return `${monitorId}:${startedAt.getTime()}`;
}
```

`startedAt` 是 `execute` 中本地 `probe()` 开始前的服务端时间，不用墙钟 interval 对齐（本轮提案原方案）——本地检查由
`lastLocalCheckAt + interval` 驱动，与墙钟窗口不对齐，按墙钟对齐会让本地与探针
系统性落在不同窗口。
### 6.2 探针结果归属规则

`ProbeResult.roundId` 在 `probes.service.recordResults` 的事务内计算，是同一 monitor 的一次查询：

```typescript
const open = await tx.checkLog.findFirst({
    where: { monitorId: item.monitor.id, roundId: { not: null }, appliedAt: null },
    orderBy: { checkedAt: 'desc' },
    select: { roundId: true, checkedAt: true },
});
const roundId =
    open &&
    receivedAt.getTime() - open.checkedAt.getTime() <=
        roundAttributionWindowMs(item.monitor.interval)
        ? open.roundId!
        : `${item.monitor.id}:orphan:${Math.floor(receivedAt.getTime() / 1000)}`;
```

- 优先归入该 monitor **尚未结算**的批次（批量上报时同一事务内已建好的批次顺序确定）。
- 没有开放批次时写入 `orphan` 前缀标识，只用于审计与排查，不参与任何批次聚合；
  `orphan:` 前缀保证不会与任何本地批次的 `monitorId:epochMs` 形态相撞。
- 继承窗口 `roundAttributionWindowMs(interval) = interval*1000 + probeReportDedupWindowMs(interval)`。
一个批次最长存活 `interval + 折叠窗口 `，超时到达的样本不追溯。
### 6.3 批次生命周期

```text
本地检查开始（服务端时间 T） -> roundId = `${monitorId}:${T}`
  -> beginRound（第 8.2 节）
       先强制结算同一 monitor 更早的未结算批次（幂等，见下） create CheckLog(roundId, source=LOCAL, appliedAt=null,
                       success=本地结论, localSuccess=true,
                       meta.aggregation={protected, protectedReason})
       upsert MonitorState 只推进 lastCheckAt / lastLocalCheckAt
  -> 受保护批次（ASSERTION / evaluated=false / 非兼容协议/ SSL 保护）立即结算 -> 否则采样：ready ? 立即结算 : 登记截止结算任务

探针上报（服务端时间 R） -> recordResults 事务内 ProbeResult(roundId)（第 6.2 节）
  -> applyStoredResult -> ingestProbeReportForMonitor -> settleRound（不新建 CheckLog）
截止结算任务到期（roundStart + interval） -> settleRound(force=true)，按当前样本结算

settleRound
  -> 建 CheckLog(roundId)：不存在 -> NOT_FOUND；appliedAt 非空 -> DUPLICATE
  -> 采样 N 个 samples（第 8.1 节）-> 聚合判定（第 8.3 节）
  -> StateService.settle（第 9 节）：update CheckLog + 状态+ 告警 + appliedAt
```

「先强制结算更早的未结算批次」是必要规则：批次最长存活一个 interval。下一轮本地检查开始时上一批必然已到期，先按截止规则结算它，保证 `failCount` 的时间顺序与批次顺序一致。
### 6.4 已知边界

- 探针上报节拍与监控 interval 不同相，一个批次窗口内不保证收到每个探针的新样本；
  样本范围因此包含**前一批次的 `roundId`**（第 8.1 节），以现有 2×interval 或 `probeResultWindowMs` 作为时间下界。这仍然不是「跨探针同步检测轮次」。
- 批次截止上限为一个 interval，所以状态与告警最坏滞后约一个 interval
  （到齐则提前）。发布说明必须写明，见 12.1。
- 探针在网络抖动下迟到超过 `roundAttributionWindowMs` 时记为 `orphan`，本轮不生效。
## 7. API 与配置生命周期
### 7.1 Create/Update DTO

在两个 DTO 中加入可省略但不可为 null 的新字段：
```typescript
@ApiPropertyOptional({
    example: 100,
    minimum: 1,
    maximum: 100,
    default: 1,
    description:
        'Minimum success percentage of the currently bound tenant probes; the probe verdict overrides a local success and rescues a local failure',
})
@ValidateIf((_, value: unknown) => value !== undefined)
@IsInt()
@Min(1)
@Max(100)
probeSuccessRatio?: number;
```

Create 的 default 表示数据库默认值；Update 可以省略 default 元信息，省略字段表示不修改；不要使用跳过 null 与 `@IsOptional()` 作为唯一可选条件，不给 DTO 设置运行时默认值，沿用生产 ValidationPipe 的隐式转换；JSON 数值和可转换的整数数值字符串有效；非数值字符串、空字符串、null、非整数、< 或 >101 均应拒绝。
### 7.2 返回和文档
`src/modules/monitors/entities/monitor.entity.ts` 加必填 `probeSuccessRatio: number` 与 @ApiProperty、范围、默认值和「主力租户探针比例、本地兜底」描述；`toEntity` 已有 `...rest`，无需新增投影；测试验证列表、详情、创建、更新都返回值；开发者 API 复用同样 DTO/服务/Entity，不新增另一种字段语义或聚合模式。
不向 Agent 心跳监控清单新增该字段：这是服务端聚合策略，Agent 无需知道阈值或 `roundId` 也不下发给 Agent，由服务端生成。
### 7.3 修改阈值
时，`probeSuccessRatio` 加入 `MonitorsService` 的 `definitionChanged` 比较列表
（`monitors.service.ts:269-288`）：

- 改成不同值：沿用当前 `revision` +1、运行状态重置及重新调度机会。
- `configRevision`：由迁移后的数据库触发器 +1，应用不得再额外增加。
- 不- revision/configRevision 的本地在途执行不生效；旧 Agent 结果被拒绝或不参与聚合。
- 修改后需要新版本的本地基线和探针证据，不用旧比例策略的历史成功立即救回。
- 修改同值、仅改名称、未提供该字段：不因新字段引入额外版本推进或状态清空。
- 暂停监控修改阈值保留 PAUSED；启用监控沿用现状 UNKNOWN 重置。
运行状态重置仅通过现有 service 路径进行。数据库触发器不负责代替 API 做状态重置；
不得把直接 SQL 更新阈值当作一个完整的管理操作或正在进行的告警及通知继续沿用现有配置变化处理，不新增主动关闭事件或补发逻辑。
## 8. Checker 批次实现

### 8.1 `fetchTenantProbeVerdict`

主力探针集合来自绑定关系，不来自结果行：

```typescript
type ProbeVerdictSample = Pick<
    ProbeResultModel,
    'id' | 'probeId' | 'success' | 'checkedAt' | 'receivedAt'
>;

interface TenantProbeVerdict {
    /** Currently bound, enabled and online tenant probes: the ratio denominator. */
    effectiveProbeCount: number;
    /** One latest valid sample per tenant probe. */
    samples: ProbeVerdictSample[];
}
```

类型从现有 `../../generated/prisma/models` 导入，只 select 上述字段，不伪装为完整模型，不新增独立可注入聚合服务，不使用每探针一次的 `findFirst`。
第一步取**当前有效绑定的租户探针**，它同时决定分母。
```typescript
const tenantProbes = await this.prisma.probe.findMany({
    where: {
        organizationId: monitor.organizationId,
        scope: 'TENANT',
        enabled: true,
        status: 'ONLINE',
        monitors: { some: { monitorId: monitor.id } },
    },
    select: { id: true },
});
```

空数组立即返回 `{ effectiveProbeCount: 0, samples: [] }`，不再查询结果表在非空时计算窗口与批次集合，再按探针 ID 查询样本。
```typescript
const since = new Date(roundStart.getTime() - probeResultWindowMs(monitor.interval));
const previousRoundId = await this.findPreviousRoundId(monitor.id, roundId);
const rows = await this.prisma.probeResult.findMany({
    where: {
        monitorId: monitor.id,
        target: monitor.target,
        configRevision: monitor.configRevision,
        checkedAt: { gte: since },
        probeId: { in: tenantProbes.map((probe) => probe.id) },
        OR: [
            { roundId },
            ...(previousRoundId ? [{ roundId: previousRoundId }] : []),
            { roundId: null },
        ],
    },
    select: { id: true, probeId: true, success: true, checkedAt: true, receivedAt: true },
    orderBy: [{ checkedAt: 'desc' }, { receivedAt: 'desc' }, { id: 'desc' }],
});
```

结果已按 `checkedAt DESC, receivedAt DESC, id DESC` 排序，用 Map 按 `probeId`
保留首条即为「该探针最新有效结果」。`id` 同时间戳下只是确定性 tie-break，不宣称 id 更大代表观测更晚。
分母用第一步的 `tenantProbes.length`，分子用去重后 `success=true` 的条数；
未上报或结果过期的探针留在分母里、计为未成功，这是本方案的严格口径：`roundId: null` 的目的是让升级前的历史样本仍可参与一次判定，避免升级瞬间全部零样本。
`findPreviousRoundId(monitorId, roundId)` 取同 monitor、`checkedAt < roundStart`
的最近一条带 `roundId` 的 CheckLog，返回其 `roundId`；没有则返回 `null`。把前一批次纳入样本范围的原因见 6.4：探针上报节拍与监控 interval 不同相，
只取本批会系统性缺票，用 `checkedAt >= roundStart - probeResultWindowMs` 已经限定了时间上界，不会把两轮之前的陈旧样本拉进来。
系统探针不在主力集合内，本方法不查询、不合并系统结果：只有在 `effectiveProbeCount === 0` 且本地失败时，才走保留的旧系统探针查询（`systemProbeScheduler.getAssignedProbes` + 一条 `probeResult.findMany`，where/排序保持 `checker.service.ts:678-697` 的现状）。
查询预算：`effectiveProbeCount > 0`：1 次 `probe.findMany` + 1 次 `checkLog.findFirst`
（上一批的 `roundId`）+ 1 次 `probeResult.findMany`；`effectiveProbeCount === 0` 时只调 1 次 `probe.findMany`（本地成功也需这一次，否则无法判断主力证据是否存在）。系统探针路径只在 N=0 且本地失败时发生的窗口样本查询可用现有 `@@index([probeId, checkedAt])`（`schema.prisma:1222`）、`@@index([target, checkedAt])`；新增的 `@@index([monitorId, roundId, checkedAt])`
服务批次过滤，不需要额外索引；不做任意 `take: N` 截断，否则高频探针可能挤掉其他探针。
保留现有错误处理：数据库或探针读取失败不能假装成「没有探针结果」，
不增加 catch 后返回空集合的隐性成功路径。
### 8.2 `beginRound` 与保护判定
`CheckerService.beginRound(monitor, roundId, startedAt, localResult)` 负责：
1. 强制结算同 monitor 更早的未结算批次（`settleRound(oldRoundId, force: true)`）
2. 计算保护结论并落库 `CheckLog.meta.aggregation`，供结算时读取：

```typescript
type AggregationGuards = {
    /** true 表示本批次不允许探针参与，直接按本地结论结算。*/
    protected: boolean;
    protectedReason:
        | 'LEGACY_UNSUPPORTED'
        | 'UNEVALUATED'
        | 'ASSERTION'
        | 'SSL'
        | null;
};
```

保护条件（顺序不变，逐条对应现有 `evaluateResult` 的前置块）：

| 条件 | 依据 |
| --- | --- |
| `!acceptsLegacyProbe(monitor)` | `checker.service.ts:612-624`；HTTP/TCP、空 config、旧 revision/SSL 兼容 |
| `localResult.evaluated === false` | 现有提前返回 |
| `localResult.failureKind === 'ASSERTION'` | 现有提前返回 |
| 证书策略失败且（本地服务成功或本地带 `ssl` 详情） | 现有 `certificatePolicyFailure` ） |

`'AGGREGATE'` 是加到 `CheckFailureKind` 联合类型的新值（`checkers/check-result.ts`），
表示「主力探针聚合判定失败」。`CheckLog.failureKind` 是 `String?`，不需要迁移；
当前只有 `checker.service.ts` 的 `'ASSERTION'` 做分支判断，新增值不改变既有逻辑。
受保护的批次在 `aggregation.protected` 写进 `meta`，结算时直接按本地结论落库，
**不等探针、不查探针**，避免 `ASSERTION` 或 SSL 场景被延迟。
`beginRound` 落的就是这一批次的 CheckLog 行，必须写全本地证据，否则结算时无从恢复
（本次 `CheckResult` 不会留在内存里跨进程/跨请求）。
| 字段 | beginRound 写入） |
| --- | --- |
| `roundId` | `buildRoundId(monitorId, startedAt)` |
| `source` | `CheckSource.LOCAL` |
| `checkedAt` | 本地检测开始时刻（服务端时钟） |
| `appliedAt` | `null`（未结算） |
| `success` | 本地结论（结算时按聚合结论覆盖） |
| `localSuccess` | `true`（本行就是本地证据） |
| `error`、`latency`、`statusCode`、`failureKind` | 本地结果原样 |
| `serviceVerdict`、`localServiceVerdict` | 均为 `localResult.serviceVerdict` |
| `sslVerdict` | `localResult.sslVerdict ?? null` |
| `evaluated` | `localResult.evaluated !== false` |
| `configRevision`、`revision` | monitor 当前值（结算时用于拒绝陈旧批次） |
| `ruleMatched`、`ruleGroupIds`、`meta.ruleEvidence` | 与**本地结论**求值一次（`evaluateRuleTree`）；结算时按聚合结论重算并覆盖 |
| `rescuedByProbe` | `false` |
| `meta.aggregation` | `{ protected, protectedReason }` |

`MonitorState` 在同一事务里只推进 `lastCheckAt` 与 `lastLocalCheckAt`，不动 `status`/`failCount`/`connectivityFailCount`/`availabilityAlertActive`——这些只在结算时写。这些 pending 行不会推进计数，也不会因占位值污染可用率窗口
（窗口查询已按第 9 节排除未结算的批次行）。
### 8.3 聚合判定 `evaluateRound`

```typescript
private evaluateRound(
    monitor: MonitorModel,
    localVerdict: { success: boolean; error: string | null; failureKind: string | null },
    verdict: TenantProbeVerdict,
): { passed: boolean; successCount: number; error: string | null };

// 主力生效：N > 0 且样本非空：if (verdict.effectiveProbeCount > 0 && verdict.samples.length > 0) {
    const successCount = verdict.samples.filter((sample) => sample.success).length;
    const passed =
        successCount * 100 >= monitor.probeSuccessRatio * verdict.effectiveProbeCount;
    return {
        passed,
        successCount,
        error: passed
            ? null
            : this.buildAggregatedError(
                  localVerdict,
                  successCount,
                  verdict.effectiveProbeCount,
                  monitor.probeSuccessRatio,
              ),
    };
}
// 零样本或 N=0：本地兜底：return { passed: localVerdict.success, successCount: 0, error: localVerdict.error };
```

组合成最终结论时，否决分支必须显式写 verdict。
```typescript
if (passed && localVerdict.success) {
    // 维持本地结论，不改写任何字段
} else if (passed) {
    // 救回：success=true, error=null, failureKind=null, serviceVerdict='SUCCESS'，rescuedByProbe=true
} else if (localVerdict.success) {
    // 否决：success=false, error=<聚合>, failureKind='AGGREGATE',
    // serviceVerdict='FAILURE', rescuedByProbe=false
} else {
    // 本地失败且不达标：保留本地 failureKind，仅替换 error
}
```

要点：
- `localSuccess`、`localServiceVerdict` 仍保存原始本地证据；
  否决场景的记录形态是 `localSuccess=true, success=false, failureKind='AGGREGATE'`。 不需要新增列。
- 不使用 probe latency 替换本地 latency；不抹掉 `statusCode`、`bodyContains`、 `ssl`/`sslVerdict`、`checkedAt`、`meta` 或其他 CheckResult 字段。
- 达标救回时 `rescuedByProbe=true`；否决时保持 false，避免污染 `monitor-insights` 的 rescued 统计。
- 比例诊断写入 `CheckLog.meta.aggregation`（结构化：`effectiveProbeCount`、 `sampleCount`、`successCount`、`ratio`、`threshold`、`decision`、`settledAt`），
  不写入带协议联合类型：`CheckResult.meta`。
```typescript
/** 批次结算后写入 CheckLog.meta.aggregation 的结构化诊断。*/
interface AppliedAggregation {
    protected: boolean;
    protectedReason: AggregationGuards['protectedReason'];
    /** 结算时刻的有效绑定租户探针数，即分母 N。*/
    effectiveProbeCount: number;
    /** 参与投票的样本数（每探针最多一票）。*/
    sampleCount: number;
    successCount: number;
    /** 实际百分比，仅用于展示；判定始终用整数交叉乘法。*/
    ratio: number;
    threshold: number;
    decision: 'RESCUED' | 'OVERTURNED' | 'CONFIRMED_SUCCESS' | 'CONFIRMED_FAILURE' | 'FALLBACK_LOCAL';
    /** 结算时刻（ISO 字符串），与 CheckLog.appliedAt 一致。*/
    settledAt: string;
}
```

`decision` 的取值与第 8.3 节的四个分支一一对应，便于事后区分「探针救回与「本地被否决」「本地兜底」三种形态，不依赖 `rescuedByProbe` 单列推断。
- 首版不新增公开 CheckExecution/CheckLog 聚合字段。
`buildAggregatedError` 签名：`(localResult, probeFailureCount)` 改为
`(localVerdict, successCount, probeCount, threshold)`，按本地是否成功给出两种措辞：
```text
Request timed out; probe success ratio 1/2 below 100%
Probe success ratio 1/2 below 100% (local check succeeded)
```

`successCount=0` 也用同一格式，更新原有 `all N ... failed` 的断言。
### 8.4 `settleRound` 状态机

```typescript
type SettleOutcome = 'SETTLED' | 'DUPLICATE' | 'PENDING' | 'NOT_FOUND' | 'NOT_READY';

private async settleRound(
    monitorId: string,
    roundId: string,
    options: { force?: boolean } = {},
): Promise<SettleOutcome>;
```

1. 读 `CheckLog(monitorId, roundId)`；不存在 → `NOT_FOUND`（探针先到、本地未跑）
2. `appliedAt` 非空 → `DUPLICATE`
3. `meta.aggregation.protected === true` 时直接按本地结论结算
4. `fetchTenantProbeVerdict`：`ready = effectiveProbeCount === 0 || samples.length >= effectiveProbeCount`
5. 不 ready 且 `!options.force` 则返回 `PENDING`（截止任务已登记则不重复登记）
6. `evaluateRound`：规则树求值（事务外，复用 `evaluateRuleTree`）→
   `StateService.settle(monitorId, roundId, verdict)`
7. `StateService.settle` 返回 `null`（并发已结算/配置已变）→ `DUPLICATE`；否则 `SETTLED`。
**本地成功同样按 3 票计**：本地成功不再提前终止判定，这是「探针主力」的实质。
### 8.5 相对旧行为的两处计数变化

1. **每批次一次计数**：旧路径下同一 `interval` 内本地与回调可能分别被接受。
   分别推进 `failCount`（`state.service.ts` 的 `sameRound` 只折叠 5–10 秒内的重复回调）。
   合并稿每批次只有一行 CheckLog、只结算一次，`failCount` 每批次至多 +1。
2. **状态时间语义**：`lastAppliedObservationAt` 从「观察时间」改为「结算时间」，
   保证批次结算按顺序单调应用；`CheckLog.checkedAt` 仍是本地检测时间。
这两点必须进发布说明（12.1），不得写成「行为完全不变」。
## 9. 状态结算入口 `StateService.settle`

在 `state.service.ts` 中**新增**（不改变 `record` 的对外行为）。
```typescript
async settle(
    monitorId: string,
    roundId: string,
    verdict: SettledRoundVerdict,
): Promise<{ transition: MonitorTransition; deliveries: number } | null>;
```

事务骨架与 `record` 一致，差异只在于「先更新既有 CheckLog，再应用状态与告警」。
`SettledRoundVerdict` 就是「已算出聚合结论：CheckOutcome」，字段同 `state.service.ts:27` 的 `CheckOutcome` 对齐，只多一个 `roundId` 语义封闭。
```typescript
interface SettledRoundVerdict {
    roundId: string;
    /** 聚合后的最终结论，不是本地结论。*/
    success: boolean;
    error: string | null;
    latency: number;
    statusCode: number | null;
    localSuccess: boolean;
    rescuedByProbe: boolean;
    failureKind: string | null;
    serviceVerdict: CheckResult['serviceVerdict'];
    localServiceVerdict: CheckResult['serviceVerdict'];
    ssl: CheckResult['ssl'];
    sslVerdict: CheckResult['sslVerdict'];
    failureReason?: CheckResult['failureReason'];
    ruleMatched: boolean;
    ruleGroupIds: string[];
    ruleEvidence?: Prisma.InputJsonValue[];
    aggregation: AppliedAggregation;
    configRevision: number;
    revision: number;
}
```

`settle` 事务的步骤：

1. `SELECT id FROM monitors WHERE id = $1 FOR UPDATE`（与 `record` 相同行锁）
2. 锁 monitor（含 `state`、`project`、`organization`）并校验： 存在、未删除、`enabled`、`configRevision === verdict.configRevision`、 `revision === verdict.revision`；任一不符 时返回 `null`（与 `record` 的丢弃语义一致）
3. 重读 `CheckLog(monitorId, roundId)`；`appliedAt` 非空 时返回 `null`
4. `derived = deriveState(previous, verdict.success, monitor.failureThreshold)`
5. `connectivityFailCount` 按 `record` 的同一规则（`SUCCESS` 归零；
   `FAILURE` +1，`NO_EVIDENCE` 不变）
6. `tx.checkLog.update`：`success`、`error`、`failureKind`、`serviceVerdict`，
   `rescuedByProbe`、`ruleMatched`、`ruleGroupIds`、`meta.aggregation`、`appliedAt`
7. `tx.monitorState.update`：`status`、`failCount`、`connectivityFailCount`、
   `lastCheckAt`、`lastError`、`lastLatency`、`lastAppliedObservationAt = 结算时刻 `、
   `lastAppliedObservationId`、SSL 四列（当本地结果有 ssl 时）
   不重写 `lastLocalCheckAt`（已由 `beginRound` 推进），避免回退调度锚点
8. `AlertEventsService.record(tx, monitor, previousState, outcome, {...derived, connectivityFailCount})`
   与 `record` 完全同一调用，复用 CONNECTIVITY / AVAILABILITY / SSL 写 outbox
9. 清理遗留：`tx.checkLog.updateMany({ where: { monitorId, appliedAt: null,
   roundId: { not: null, notIn: [roundId] } }, data: { appliedAt: new Date() } })`
   把崩溃或强制结算失败留下的未结算行标记为已结算，保留其本地结论，防止窗口长期污染
10. 捕获唯一约束冲突（`P2002`，同一 `(monitorId, roundId)` 并发）→ 返回 `null`。
**`AlertEventsService` 的唯一必要改动**（一行，不改判定算法）：
AVAILABILITY 的窗口查询 `alert-events.service.ts:126-135` 增加
`OR: [{ appliedAt: { not: null } }, { roundId: null }]`。
让尚未结算的批次行不进入可用率窗口；旧数据 `roundId=null` 仍然计入。
`record` 保留不动，供无批次上下文的路径与既有测试使用；生产路径全部改走 `beginRound`/`settle`。两者共用抽出的私有方法（`applyStateValues`、`buildConnectivityCount`），避免两份 `deriveState`/告警逻辑。
## 10. 队列与截止结算
`checker.queue.ts` 新增：
```typescript
/** Queue job that settles a batch once its window closed without all probes reporting. */
export const MONITOR_SETTLE_JOB = 'monitor-settle';

export interface MonitorSettleJobData {
    monitorId: string;
    roundId: string;
}
```

- 复用 `MONITOR_CHECK_QUEUE`，`jobId = `${MONITOR_CHECK_DEDUP_PREFIX}-settle:${roundId}``；
  `delay = max(roundStart + interval*1000 - Date.now(), 1000)`；
  `removeOnComplete/removeOnFail` 与现有 check job 一致。
- 新增 `MonitorSettleProcessor`（与 `monitor-check.processor.ts` 同构；
  异常只记录日志不抛出），调用 `checkerService.settleRound(monitorId, roundId, { force: true })`。
- 到齐提前结算不需要取消该 job：到期后 `settleRound` 命中 `DUPLICATE`，直接返回，
  这是有意保留的（删除 job 会引入「取消失败则永不结算」的新故障面）。
- 进程重启后 BullMQ 会重放未完成的延迟 job；`force=true` 的结算对已结算批次是幂等的，
  对已删除/已改配置的 monitor 走第 9 节第 2 步的校验返回 `null`。
- 不新增 cron 扫描：延迟 job 是主路径，`beginRound` 的「强制结算更早未结算批次。
  若 job 丢失时的兜底，两者叠加已覆盖 `interval` 级的时间尺度。
## 11. 回调、计数与告警边界

保留 `ingestProbeReportForMonitor` 的近期回调过滤与 `probes.service.applyStoredResult`
- `appliedAt` 行为，但**不再**在回调路径新增 CheckLog 或调用 `record`；
- `ingestProbeReportForMonitor` 保留的职责：校验 monitor（未删除、启用、`acceptsLegacyProbe`）；
  配额资格、存在本地 CheckLog、`revision`/`failureKind === 'ASSERTION'` 拒绝；
  然后调用 `settleRound(monitorId, <开放批次的 roundId>)`。
- `reportId`/`observationId` 是幂等身份，`configRevision` 是配置版本，
  都不当作 `roundId`；`roundId` 只由 6.1/6.2 生成。
- 回调路径传入的本地最近结论仍用于兜底，但主力判定不依赖它：
  只要 N>0 且有样本，最终成功/失败由探针比例决定。
告警三层保持独立，批次只影响 CONNECTIVITY。
- CONNECTIVITY：`serviceVerdict` 的 `connectivityFailCount/failureThreshold`
  （`alert-events.service.ts:82-121`），指向同一的 batch 结算后的计数。
- AVAILABILITY：`availabilityEnabled`、规则健康比例、`availabilityThreshold`、 `availabilityWindow` 和连通 `ruleMatched` 次数
  （`alert-events.service.ts:125-177`）；窗口过滤见第 9 节的一行改动。
- SSL：独立证书 verdict，不被比例成功抹掉。
- 初始 UNKNOWN 的基线抑制、事件恢复、投递 outbox 及通知接收人策略保持不变。
单批次失败只累加 `failCount`，不直接通知。`failCount >= failureThreshold` 才通知与恢复：`failCount = 0` 触发恢复通知——与本轮提案一致，且不需要改
`AlertEventsService.record` 的判定。
### 11.1 到达顺序不再影响结论，但结论有时间
批次化后，同一批次内「谁先到」不再改变最终结论（这与原 003 第 7 节的抖动不同）：

```text
interval=60s，N=2，ratio=100
T+0s 本地成功，beginRound(R0)，样本 0/2 -> 未到齐-> PENDING
T+8s 探针 A 成功到达 -> 1/2 -> 未到齐-> PENDING
T+20s 探针 B 成功到达 -> 2/2 -> 到齐 -> SETTLED 成功
（若 B 一直不上报：T+60s 截止结算 -> 1/2 < 100% -> 判定失败，本地成功被否决。
```

代价是状态与告警最坏滞后一个 interval。这是取得「批次结论稳定」的必要代价，不得宣称既有系统本来就是同步轮次。
## 12. 兼容性与上线

### 12.1 有意变化

新行为不是旧行为的小幅收紧，而是判定主次的反转：

- **主力探针生效的监控**（存在有效绑定租户探针，且批次内有样本）：
  最终成功/失败由 M/N 决定，本地成功可以被否决（`failureKind='AGGREGATE'`），
  本地失败可以被救回。缺失或过期的探针计入分母并计为未成功。
- **没有有效绑定租户探针的监控**：N=0，完全走现有本地判定 + 系统探针救回。
  判定行为与今天一致（只多一次探针查询）。系统探针自动分配的存量 HTTP/TCP 监控不受影响。
- **有绑定探针但没有样本**：本地结论兜底，不会因为探针刚分配或掉线而假 DOWN。
- **默认值 1** 的含义是「至少 1 个有效租户探针成功」，不是「任意旧成功记录」。
  旧行为是窗口内存在任意成功记录即救回；新行为只看各探针最新一票。
  默认 1 下仍需注意：N 个租户探针全部失败时，本地成功也会被判失败。
- **每批次一次计数**，且 `CheckLog` 每批次只有一行（`source` 记录首次触发方，
  通常为 LOCAL）；探针证据不再单独成行，改为 `ProbeResult` + `meta.aggregation` 诊断。
- **状态时间**：`lastAppliedObservationAt` 改为结算时刻；批次结算最坏滞后一个 interval。
- `ratio=100` 且多探针时，缺失/过期探针会直接拉低比例，发布说明必须写明。
上线前应给出真实绑定关系的影响面：哪些监控有 N>0、各自的 N 与建议阈值。
旧 CheckLog 和告警不按新策略回算，可用率历史不能因策略切换被重写。
### 12.2 发布顺序

1. 在专用测试库验证升级、新列默认值、CHECK、唯一索引和触发器。
2. 生产按既有部署流程先部署新迁移，再部署包含生成客户端的新应用。
3. 协调检查 worker 的滚动升级，避免旧新聚合策略长期同时处理同一监控。
   所有运行实例升级完成之前不要对外开放阈值配置。
   旧实例不会写 `roundId`，产生的 `roundId=null` 行按第 8.1 节仍可参与一次判定。
4. 观察采样变化引起的状态变化、告警、检查处理耗时、`monitor-settle` 队列积压
   和数据库查询量。
阈值变化会使旧 Agent 缓冲结果的 `configRevision` 过期，Agent 通过既有心跳获取新版本，
无需新增心跳字段或升级包。无需把已存在的系统探针调度算法纳入本次重构。
回滚应用时保留新增列、CHECK、唯一索引和触发器，不通过删除列、reset 或修改已应用迁移回滚。
旧应用不会遵守非默认比例策略，也不会读取/写入 `roundId`；因此应用回滚是判定策略降级，需要运维明确批准，不能将「数据库向后兼容」当作「业务判定无损回滚」。
真实需要撤销触发器逻辑时另写前向修复迁移，不编辑历史文件。
### 12.3 真机验收脚本

1. 创建 monitor，绑定 3 个探针，`probeSuccessRatio = 60`。
2. 本地失败，3 个探针中 2 个成功 ⇒ 批次到齐结算 ⇒ 成功，`failCount = 0`。
3. 下一轮本地失败，3 个探针全失败 ⇒ 批次失败，`failCount = 1`。
4. 连续 3 轮批次失败 ⇒ `failCount = 3 >= failureThreshold` ⇒ CONNECTIVITY 告警。
5. 下一轮成功 ⇒ `failCount = 0` ⇒ 恢复通知。
6. 断开一个探针，`ratio = 100`：确认分母仍为 3，该轮在截止时结算为失败
   （缺失探针计为未成功），
`CheckLog.meta.aggregation` 记录 `2/3`。
## 13. 文件边界

唯一允许的业务改动：

| 文件 | 改动 |
| --- | --- |
| `prisma/schema.prisma` | Monitor 加 `probeSuccessRatio`；ProbeResult 加 `roundId`+2 索引；CheckLog 加 `roundId`、`appliedAt`+唯一索引+索引 |
| `prisma/migrations/<timestamp>_add_probe_success_ratio/migration.sql` | 新列、CHECK、索引、唯一索引、触发器函数更新 |
| `src/generated/prisma/` | `prisma:generate` 的相关自动输出 |
| `src/modules/monitors/dto/create-monitor.dto.ts` | 新字段及校验 |
| `src/modules/monitors/dto/update-monitor.dto.ts` | 新字段及校验 |
| `src/modules/monitors/entities/monitor.entity.ts` | 返回类型与 Swagger |
| `src/modules/monitors/monitors.service.ts` | `definitionChanged` 列表 |
| `src/modules/checker/checker.service.ts` | `buildRoundId`、`beginRound`、`fetchTenantProbeVerdict`、`evaluateRound`、`settleRound`；保留系统救回路径 |
| `src/modules/checker/checker.queue.ts` | `MONITOR_SETTLE_JOB`、`MonitorSettleJobData`、delay 计算 |
| `src/modules/checker/monitor-settle.processor.ts`（新增） | 截止结算消费器 |
| `src/modules/checker/checker.module.ts` | 注册该 processor |
| `src/modules/checker/checkers/check-result.ts` | `CheckFailureKind` 增加 `'AGGREGATE'` |
| `src/modules/state/state.service.ts` | **新增** `settle` 与共用私有方法；`record` 行为不变 |
| `src/modules/alert-events/alert-events.service.ts` | **加** AVAILABILITY 窗口查询加一行 `OR`（第 9 节） |
| `src/modules/probes/probes.service.ts` | `recordResults` 事务内计算并写入 `roundId`；`applyStoredResult` 走结算 |
| `src/modules/checker/checker.service.spec.ts` | 批次采样、比例、否决、保护、到齐/截止、幂等 |
| `src/modules/checker/monitor-settle.processor.spec.ts`（新增） | 截止结算消费器 |
| `src/modules/monitors/monitors.service.spec.ts` | 配置更新/状态重置 |
| `src/modules/monitors/monitors.http.spec.ts` | API 默认、校验、返回、Swagger 验收 |
| `src/modules/state/state.service.spec.ts` | 结算/成功判定/双计数回归 |
| `src/modules/probes/probes.service.spec.ts` | `roundId` 归属与 `orphan` 兜底 |
| `src/modules/alert-events/alert-events.service.spec.ts` | 独立告警回归 + 窗口过滤 |
| `test/monitor-postgres/harness.ts` | 将新迁移延后到新增升级验收阶段 |
| `test/monitor-postgres/monitor.integration-spec.ts` | 升级、触发器、批次隔离和真实状态验证 |
| `test/monitor-postgres/README.md` | 新验收阶段与用例说明 |
| `src/**/*.spec.ts` 的其他 monitor/probe/checkLog 夹具 | 仅补模型新默认值，不顺便重写测试 |
| `plans/003-probe-success-ratio.md` | 实施结果与状态（`plans/` 目前没有 README 索引，不要引用不存在的文件） |

只读回归文件、不修改其业务逻辑：`src/modules/admin/system-probes/`、`src/modules/rules/`、`src/modules/notifier/`、`probes/agent/`、`src/modules/checker/checkers/*`（除 `check-result.ts` 的类型联合）。
不调整前端、权限设计、生成 ValidationPipe、通知结构、配额、依赖或其他计划。
若无法在以上业务边界内实现，应停止并报告，不通过「顺手修复」扩大范围。
## 14. 执行步骤与验证
执行者先完整阅读本方案，保留工作区既有修改。需要隔离实施时使用 `codex/` 分支，基于当前确认的代码，不自动覆盖工作区或把其他未提交修改带入提交；不要自行推送、发 PR、提交代码或执行生产迁移。
### 步骤 0：基线与漂移检查
```powershell
git status --short
git diff --stat e2895cc..HEAD -- prisma src/modules/checker src/modules/monitors src/modules/state src/modules/probes src/modules/alert-events test/monitor-postgres
pnpm type-check
pnpm test -- --runInBand --watch=false src/modules/checker/checker.service.spec.ts src/modules/monitors/monitors.service.spec.ts src/modules/monitors/monitors.http.spec.ts src/modules/state/state.service.spec.ts src/modules/probes/probes.service.spec.ts src/modules/alert-events/alert-events.service.spec.ts
```

预期：类型与相关基线测试通过。Git 检查不包含未提交内容，需要同时读取实时文件；
若第 4 节的约束已变化，先更新方案，不机械应用旧代码片段。
### 步骤 1：迁移和模型

检查数据库 URL 确实指向允许使用的隔离开发库，仅在明确授权的开发库运行。
```powershell
pnpm prisma:migrate dev --create-only --name add_probe_success_ratio
```

`--create-only` 不等于完全不访问数据库；不能在未确认的应用生产库运行它；没有授权的开发库时可以人工创建新增迁移 SQL，并以第 5 节和专用测试库验证，
不要因此跳过数据库验收或直接连接默认 `DATABASE_URL` 后生成 `migration.sql` 还需手工补 CHECK、唯一索引和触发器函数到生成目录名固定后同步测试分期。补相关 monitor/probe/checkLog 夹具默认值，
使生成类型与现有测试一致；不掩盖真实字段缺失。
预期：生成与 `type-check` 退出 0；旧迁移无改动，新迁移包含第 5.2 节的四组 SQL。
### 步骤 2：API 与版本
完成两个 DTO、Entity、`definitionChanged`，以及 service/HTTP 测试。
```powershell
pnpm test -- --runInBand --watch=false src/modules/monitors/monitors.service.spec.ts src/modules/monitors/monitors.http.spec.ts
pnpm type-check
```

预期：默认显式值、校验、返回和应用 revision 测试通过，省略阈值不重置既有值的数据、`configRevision` 的真实验证留到步骤 5，不用 Jest 伪造触发器通过。
### 步骤 3：状态结算入口与批次骨架

先落 `StateService.settle`（第 9 节）。`AlertEventsService` 的一行窗口过滤，
再改 Checker：
- `beginRound`：写 pending CheckLog、推进调度锚点、强制结算更早批次；
- `fetchTenantProbeVerdict`、`evaluateRound`；
- `settleRound` 状态机与 `MONITOR_SETTLE_JOB`、`MonitorSettleProcessor`。
- 删除 `evaluateResult` 的本地成功提前返回，保护块判定移到 `beginRound`；
- `execute` 的 LOCAL 分支改为 `beginRound + settleRound`。
- `ingestProbeReportForMonitor` 改为 `settleRound`。
同步更新测试 mocks：`prisma.probe.findMany` 需返回绑定探针 ID；`probeResult.findMany` 样本必须带 `probeId`/`checkedAt`/`receivedAt`/`roundId`；`checkLog` 需要支持 `findFirst`（开放批次）、`update`（结算）、`stateService.record` 断言改为 `stateService.settle`。
```powershell
pnpm test -- --runInBand --watch=false src/modules/checker/checker.service.spec.ts src/modules/checker/monitor-settle.processor.spec.ts src/modules/state/state.service.spec.ts src/modules/probes/probes.service.spec.ts src/modules/alert-events/alert-events.service.spec.ts
pnpm type-check
```

预期：第 15 节的批次/主力/否决/兜底/幂等用例通过；达标救回不会保留失败 `serviceVerdict`，否决分支显式写 `FAILURE`。模拟 `HTTP 500` 的比例测试要注意真实 HTTP Checker 会把状态断言归类为 `ASSERTION`。
主力判定主路径用 TRANSPORT/TIMEOUT 本地失败，断言用例单独验证「不被探针覆盖」。
### 步骤 4：探针上报接入批次
`probes.service.recordResults` 在事务内计算 `roundId` 并写入 `ProbeResult`；`applyStoredResult` 的语义从「执行一次回调」改为「尝试结算开放批次」时保留 15 分钟过期的 `appliedAt` 标记行为。
```powershell
pnpm test -- --runInBand --watch=false src/modules/probes/probes.service.spec.ts src/modules/checker/checker.service.spec.ts
pnpm type-check
```

预期：归属优先开放批次、无开放批次写 `orphan`、重复上报不重复结算与迟到样本不追溯。
### 步骤 5：真实升级与配置版本

当前 harness `stageMigrations` 会把未排除的新迁移提前放进首阶段；直接增加测试而不修改分期，不能证明旧数据库升级；按下面的三阶段顺序扩展，保留已有安全门禁：
1. 新迁移放入单独的 feature migration 列表，并把 `stageMigrations` 初始复制中排除；
   既有 `localMigrations` 与 `compatibilityMigrations` 顺序保持；2. 先完成当前历史基线、legacy-fixtures、既有本地协议迁移和既有保留字段检查；3. **在创建 PrismaService 之前**，拍摄当前 SQL 快照，再追加新比例迁移并 deploy 后：
   可新增 `addProbeSuccessRatioMigration` 小函数，复用当前目录复制及安全边界。
4. 比较升级前后：仅新增 `probeSuccessRatio=1`、`roundId`/`appliedAt` = null。
   既有字段、`configRevision`、state/checkLog/plan/subscription 数据不变化；
   重复 deploy 不重放迁移。
5. 此后才初始化当前生成客户端，验证真实默认值：1/100 接受、0/101 拒绝；
   CHECK 约束、阈值变化推进 `configRevision`、同值修改不推进。
6. 用真实 `StateService` 验证 与 revision/configRevision 的结果拒绝应用；
   再用真实 Checker 查询与 `StateService`，mock 网络/规则/配额/分配依赖，验证：
   相同 `target` 不同 monitor/configRevision 不串样本；`roundId` 不同批次不串；
   探针解绑/离线/停用同时退出分子与分母；唯一索引阻止同批次二次结算。
不要修改旧的本地协议默认值断言来掩盖错误迁移阶段；
新字段默认值必须在独立的「当前系统升级到比例版本」阶段被验证。
```powershell
pnpm test:monitor:safety
pnpm test:monitor:postgres
```

预期：安全测试与新旧集成用例全部通过。后者只在已设置
`MONITOR_TEST_DATABASE_URL` 的空白、一次性、本地 `beacon_monitor_test*` 库执行；
沿用 harness 的名称与 host 校验、不读 `.env`、不回退 `DATABASE_URL`；不 执行 reset/db push/DROP、不复用已有应用数据；没有可用专用库时标记「数据库验收未完成」，不能将方案或功能状态改为「DONE」。
### 步骤 6：全量质量和发布说明

```powershell
pnpm prisma:generate
pnpm type-check
pnpm test -- --runInBand --watch=false
pnpm lint
pnpm build
git diff --check
git status --short
```

预期：全部退出 0；所有测试通过，仅允许文件有本次改动后 `lint` 使用 `--fix`，执行后检查 `git diff，不将其他工作区改动回退或纳入本次交付；不因为生成字段引发全项目格式化；提交范围按本方案精确核对；在本方案记录实际新测试数、专用库验收结果和已接受的快照边界，
再更新本方案头部的状态与更新日期（`plans/` 没有 README 索引）；未部署时明确注明「本地验收，待部署」。
## 15. 测试清单

| 层级/文件 | 必须覆盖 |
| --- | --- |
| Checker 比例 | N=3：3/3@100 达标、2/3@100 不达标；N=5：3/5@60 达标、2/5@60 不达标 ||
| Checker 边界 | 分母缺失：N=3 只有 2 个上报且都成功，@100 仍不达标（2/3 仍判定不达标 |
| Checker 默认值 | 默认 1：N=5 有 1 个成功达标；N=5 有 0 个成功不达标 |
| Checker 否决 | 本地成功 + 不达标，`success=false`、`failureKind='AGGREGATE'`、`serviceVerdict='FAILURE'`、`rescuedByProbe=false` |
| Checker 兜底 | N=0 本地成功/失败保持原结论；N>0 但零样本保持原结论，且不判失败 |
| Checker 系统探针 | N=0 且本地失败时任一系统探针成功仍救回；N>0 时系统结果不参与判定 |
| Checker 去重 | 按 `probeId` 多条只一票；新失败覆盖旧成功；`checkedAt` 同值按 `receivedAt`、`id` |
| Checker 分母 | 停用/离线/解绑的探针不计入 N；其他租户或 SYSTEM 探针不计入 N |
| Checker 保护 | HTTP/TCP 兼容范围；`ASSERTION`、`evaluated=false`、配置化 HTTP、应用协议不被探针覆盖，且不等探针直接结算 |
| Checker 查询预算 | N=0 只调用一次 `probe.findMany`、不查 `probeResult`；N>0 各一次；系统路径只在 N=0 且本地失败时发生 |
| 批次 生成/归属 | `buildRoundId` 用本地开始时刻；探针归入开放批次；无开放批次写 `orphan:`；超过归属窗口不追溯 |
| 批次 到齐/截止 | 全部探针上报后立即结算；未到齐返回 `PENDING` 且登记 job；`force=true` 按截止结算 |
| 批次 幂等 | `appliedAt` 非空 → `DUPLICATE`；`force` 前后两次调用只结算一次；并发唯一冲突按重复处理 |
| 批次 顺序 | 新一批 `beginRound` 先强制结算上一未结算批次；遗留未结算行被标记 `appliedAt` |
| Checker SQL 集成 | 相同 target 不同 monitor；不改 `configRevision`；过期样本；`roundId` 不同批次不串；关联探针失效同时退出分子与分母 |
| Checker/State | 救回：`success=true`、`serviceVerdict=SUCCESS`、`failureKind=null`；`localServiceVerdict` 保留 |
| Checker/State | 否决：`localSuccess=true`、`success=false`、`serviceVerdict=FAILURE`，原有 `latency`/`statusCode`/`ssl` 不丢 |
| Checker/规则 | `statusCode`、`bodyContains`、`latency`、`meta`、`checkedAt` 保留，规则依据聚合后的完整上下文 |
| Checker/SSL | `ssl` 对象证书失败原样返回；无 `ssl` 对象为 INVALID 不改整体 success，只允许独立服务判定 |
| State/告警 | 成功：`failCount`/`connectivityFailCount` 重置；否决按失败计数；CONNECTIVITY、AVAILABILITY、SSL 独立 |
| State/告警 | 单批次失败不通知；`failCount >= failureThreshold` 才通知；恢复时通知 |
| 告警窗口 | AVAILABILITY 窗口排除未结算批次行，`roundId=null` 的旧行仍计入 |
| 回调回归 | `report` 重试幂等、`appliedAt`、本地基线、local 与 callback 交错；不推进 `lastLocalCheckAt` |
| 队列 | `monitor-settle` job ：delay 与 `jobId`；到期调用 `force`；异常只记日志 |
| DTO/HTTP | 省略：0、100、可转换整数字符串；拒绝 null/空字符串/非数字、小数/0/101 |
| DTO/HTTP | create/list/detail/update 返回字段；OpenAPI optional 输入、必填输出、范围与默认描述 |
| Service | 改：revision+状态重置；同时 省略/仅名称不重置；暂停修改仍 PAUSED |
| PostgreSQL | 现有行默认 1 且旧字段不变；CHECK；唯一索引允许 `roundId=null` 多行；触发器改推 +1、同值不增；在途旧结果拒绝 |
| 全量回归 | 配额、通知、状态页、监控概览（rescued 统计不受否决样本影响）和开发者 API 的现有测试继续通过 |

测试按现有 `checker.service.spec.ts`、`state.service.spec.ts`、`probes.service.spec.ts`、`monitors.http.spec.ts` 与 factory/mock 风格编写；真实约束与归属筛选用独立 PostgreSQL
验收，不靠返回任意数组的 Jest mock 证明数据库隔离。保持基线测试，
新增测试不能仅检查私有方法调用。
## 16. 完成条件与停止条件
完成必须同时满足：
- Schema、迁移 SQL、自动生成类型、API 字段、更新版本链路都已实现；
- 主力探针集合、分母 N、每探针一票与比例判定通过单测和真实数据库隔离测试；
- 批次生命周期正确：`roundId` 生成与归属、到齐提前结算、截止结算；
  `appliedAt` 与唯一索引双重幂等、上一批强制结算；
- 否决分支、兜底分支、系统探针救回回归和既有执行保护测试通过；
- 类型检查、全量单测、lint、build、diff 检查全部通过；
- 专用 PostgreSQL 的真实升级、范围 CHECK、唯一索引和触发器测试通过；
  不接受「只有空库已建好」：- 新策略行为变化（判定主次反转、每批次一次计数、状态滞后一个 interval。
  `CheckLog` 每批一行）与回调异步限制已被如实记录；
- 本次改动没有跨越第 13 节边界，既有用户修改保留，本方案状态准确。
出现以下情况停止并报告：

- 聚合接口、配置版本触发器、状态回调去重已与第 4 节的实测位置不一致；
- 需要修改第 13 节之外的业务逻辑才能满足用户实际产品要求
  （`state.service.ts` 与 `settle` 与 `alert-events.service.ts` 的一行窗口过滤 已在边界内，超出即停止）；
- 产品要求「本地成功永不被否决」「系统探针参与主力」「所有绑定探针必须通过」，
  这些都是与本方案相反的产品决策，先改第 3 节再实施；
- 产品要求「跨探针同步检测轮次」（真正让所有探针在同一时刻采集），
  本方案的批次只是服务端聚合归属，不能用它冒充同步采集；
- 迁移需要重建、删除应用数据，或目标数据库不能确认是可用的隔离开的 测试环境；
- 校验失败两次后仍不能在既定边界内解释并修正；不要静默跳过失败用例；
- 批量窗口查询在目标规模下不可接受（单 monitor 有效探针数 > 200），
  需要原生 latest-per-probe SQL 或新索引；先补容量 查询计划证据；
  不以任意 `take` 或 catch-empty 临时掩盖问题。
后续维护重点：增加协议或 Agent 能力时重新评估 `acceptsLegacyProbe`；改变探针回调调度时重新评估归属窗口与截止时间；增加聚合元数据时不要破坏 `meta.aggregation` 的既有键；任何新配置字段都需要同步考虑应用 revision
和数据库 `configRevision`。
## 17. 验证与决策记录
### 17.1 设计阶段已核对的事实

- `StateService.record`（`state.service.ts:129`）是唯一状态写入点，含行锁、 `observationId` 幂等、`sameRound` 折叠、`deriveState`、`AlertEventsService.record`、 `MonitorState.upsert`；唯一生产调用点是 `checker.service.ts:492`。
- `evaluateResult`（`checker.service.ts:626`）当前以本地成功提前返回开头，
  主体探针查询在 656-697，`buildAggregatedError` 在 738。
- `ProbeResult` 已有 `appliedAt`（`schema.prisma:1207`）与
  `@@index([probeId, checkedAt])`（`schema.prisma:1222`）；`CheckLog` 已有 `observationId`、`localSuccess`、`rescuedByProbe`、`failureKind`，但没有 `roundId`/`appliedAt`；
- AVAILABILITY 窗口查询在 `evaluated: true` + `revision`，按 `checkedAt desc`
  （`alert-events.service.ts:126-135`），因此未结算批次行需要一行过滤；
- 配置版本触发器位于 `20261011100000_merge_monitor_revision_tracking`；
  当前 OLD/NEW 列表 16 个字段，本次需插入 `probeSuccessRatio`。
- `package.json` 已有 `test:monitor:safety`、`test:monitor:postgres` 与 `test/monitor-postgres/harness.ts` 使用 `localMigrations`/`compatibilityMigrations` 分期。
### 17.2 本轮决策

| 决策 | 选择 | 决策者 |
| --- | --- | --- |
| 判定主次 | 采用旧 003：探针主力，可否决本地成功 | 用户 |
| 分母口径 | 采用旧 003：固定 N，缺失/过期计未成功 | 用户 |
| 批次机制 | 引入 `roundId` 与 `CheckLog.appliedAt` 批次级幂等 | 用户 |
| 结算触发点 | 到齐可提前，否则批次截止（由延迟队列 job 驱动） | 用户 |
| 输出位置 | 直接改写本文件为合并最终版 | 用户 |
| `CheckLog(monitorId, roundId)` | 由普通索引升级为唯一索引 | 设计（本文 2.3） |
| `roundId` 生成 | 由本地检查时刻锚定，不按墙钟 interval 对齐 | 设计（本文 6.1） |
| 结算写入路径 | 新增 `StateService.settle`，不直接改 `monitorState` | 设计（本文第 9 节） |

### 17.3 未验证项

- 12.3 的真机多探针验收（归属窗口、截止时间、真实绑定关系影响面）未执行；
  本机没有真实探针，只验证了单元与专用 PostgreSQL 行为。
- 生产容量与 `monitor-settle` 队列积压未测；查询预算只覆盖单 monitor 的语句数；
- 数据库验收在一个本地一次性库上完成（`beacon_monitor_test_ratio`，验收后删除），
  未在 CI 的 PostgreSQL service 或类生产实例上回放；
- 未部署；应用滚动升级顺序与旧实例混跑窗口没有实测。
## 18. 实施结果（2026-10-18）
结论：**本地验收通过，待部署**。
实现范围与第 13 节一致（schema、新迁移、生成的客户端、DTO/Entity/definitionChanged、`StateService.settle`、`AlertEventsService` 一行窗口过滤、Checker 批次、`monitor-settle` 消费器、`probes.roundId` 归属、配套测试、harness 分期与本文）。未修改第 13 节之外的业务逻辑。
### 18.1 实施偏差（与本文正文的差异及原因）
1. **`MonitorSettleProcessor` 不是第二个 `@Processor`**（第 10 节）；
   BullMQ worker 消费队列里的所有 job、不按 name 过滤；两个 worker 监听
   `MONITOR_CHECK_QUEUE` 会互相吞掉对方的 job（`monitor-settle` 会被检查 worker 直接完成）。
   实现为普通 provider，由唯一的 `MonitorCheckProcessor` 在 `job.name` 分发。
2. **`jobId` 中的冒号被替换**（第 10 节）。BullMQ 拒绝包含 `:` 的自定义 job id。
   而 `roundId` 形态是 `${monitorId}:${epochMs}`，因此用 `monitor-check-settle-<roundId 去冒号 `。
3. **`CheckLog.localSuccess` 写真实本地结果**（第 8.2 节表格写 `true`）；
   既有列语义是「本地探测的原始结果」，下游统计依赖它；否决场景仍是
   `localSuccess=true, success=false, failureKind='AGGREGATE'`。
4. **`beginRound` 与 `CheckLog.meta` 额外保存本地证据**：
   `localSsl`、`localFailureReason`、`localBodyContains`（以及协议的 meta 的 `ruleEvidence`）。
   没有这三项，结算时就无法恢复 SSL 证据、CONNECTIVITY 证据与 `bodyContains` 规则上下文。
   `aggregation.settledAt` 由 `CheckerService` 在结算前生成，`StateService.settle`
   原样写入（与本进程内的 `appliedAt` 相差毫秒级），不做二次覆盖。
5. **`CheckerService.settleRound` 返回 `{ outcome, execution }`**（第 8.4 节的 `SettleOutcome` 扩展），
   让本地执行与探针回调共用同一入口时仍能返回 `CheckExecution`。
6. **未结算批次行仍计入 `monitor-insights` 与 `getSummary` 的窗口统计**（第 9 节只要求
   AVAILABILITY 窗口过滤）。pending 行的 `success` 是本地结论，因此概览的可用率/失败率
   在最坏情况下滞后一个 interval 才与最终判定一致；`rescued` 统计不受否决样本影响（否决时
   `rescuedByProbe=false`）。这是 8.5/12.1 里「状态与告警滞后一个 interval」的同一代价；
   不改动 `monitoring` 模块。
7. **`ingestProbeReportForMonitor` 不再做「近期回调过滤」**（第 11 节要求保留）。
   批次级幂等（`CheckLog.appliedAt` + 唯一索引）已覆盖「多个回调只结算一次」，
   `probeReportDedupWindowMs` 现在只用于 `roundId` 归属窗口
   （`roundAttributionWindowMs = interval*1000 + fold`）。
8. **`roundId` 在毫秒碰撞时追加后缀**（第 6.1 节只给了
   `${monitorId}:${epochMs}`）。同一 monitor 的两轮检查可能落在同一毫秒，
   唯一索引会拒绝第二轮，因此 `beginRound` 在同一批次 id 被占用时改用
   `${roundId}~${randomUUID()}` 重新锚定（最多 3 次），不再静默丢弃该轮检查。
   `roundId` 只被当作不透明键使用（`probes` 归属、样本过滤、结算入口），不解析其内容。
9. **只有已到期的旧批次才在 `beginRound` 里强制结算**（第 6.3 节假设
   「下一轮本地检查开始时上一批必然已到期」）。手动「立即检测」不受 `interval`
   约束，因此 `settleStaleRounds` 增加 `now - checkedAt >= interval` 判定：
   未到期的旧批次留给截止任务，避免按部分证据把它判成失败。
### 18.2 验证记录

- `pnpm prisma:generate`、`pnpm build`、`pnpm lint`、`git diff --check`：退出 0；
- `pnpm test`：243 suites / 1903 tests 全部通过（实施前 1880，新增 23 条）；
  覆盖第 15 节的 Checker 比例与边界、否决、兜底/系统救回、去重与分母；
  保护、查询预算、批次生成、归属/到齐/截止/幂等/顺序、State/告警、队列、DTO/HTTP、Service 用例。
- `pnpm test:monitor:postgres`：16 个用例，13 通过。新增的
  「升级到比例版本」「比例约束与版本推进」「每批一次结算 + 旧行不受唯一约束」
  「真实 Checker/StateService 的样本归属与分母」全部通过；
  2 条既有用例失败（`concurrent folds do not lose failure increments`、 `definition edit commits before a blocked old result is folded`），
  已用独立 worktree 在改动前的 `71aa056` 上复现同样失败，属既有基线问题，本次未修改；
- `pnpm type-check` 仍报 `test/project-access/fixtures.ts` 的两条既有错误
  （`buildObjectKey` 导出与参数个数），该文件不在本次改动范围，HEAD 上同样存在；
- 本地一次性库 `beacon_monitor_test_ratio` 用于真实迁移与结算验收，完成后已删除。
- **2026-10-18 补充：开发库 `beacon` 已执行本轮两个新迁移**
  （`20261018120000_add_probe_success_ratio`、`20261019120000_max_probes_per_monitor`），
  `pnpm prisma migrate status` 为 up to date（39 个迁移）。升级后实测结构：
  `monitors.probeSuccessRatio`（含 CHECK 1–100）、`probe_results.roundId`、
  `check_logs.roundId`/`appliedAt` 与唯一索引 `check_logs_monitorId_roundId_key`、
  `plans.maxProbesPerMonitor`（含 CHECK）全部就位；`beacon_monitor_config()` 的
  OLD/NEW 列表已包含 `probeSuccessRatio`。
- 同轮复跑质量闸门：`pnpm lint`、`pnpm test`（143 suites / 1915 tests）、`pnpm build` 全部通过；
  `pnpm type-check` 仍只有 `test/project-access/fixtures.ts` 的两条既有错误。
- 升级后的影响面复测（按 12.1 口径：同 organization、`TENANT`、`enabled`、`ONLINE`、
  已绑定该 monitor）：12 个未删除 monitor 的有效租户探针数全部为 0，
  `probeSuccessRatio` 全部为默认值 1，因此该库完全走 `N=0` 的本地兜底路径，判定行为不变。
  探针侧只有 1 个 `SYSTEM`/`OFFLINE` 探针，12.3 的真机多探针验收仍无法在本地执行。
- 影响面（本地开发库 `beacon` 只读统计，不代表生产）：12 个未删除 monitor；
  绑定有效租户探针的为 0，升级后该库全部走 `N=0` 的本地兜底路径，判定行为不变；
  生产上线前仍需按 12.1 统计真实绑定关系、各自的 N 与建议阈值。
- 本文件在 2026-10-18 的写入过程中损坏（979 处字符的第三字节被替换为 `?`，另有少量换行丢失），
  已按上下文逐处修复并校验为合法 UTF-8（30 组代码围栏闭合、无替换字符残留）。
  个别标点与空格是依据上下文重建的，与原稿措辞可能略有差异。

## 19. 复审与缺陷修复（2026-10-20）

对 18 节落地结果做复核后修正了三处偏差，其余实现与第 3、8、9 节一致。

### 19.1 已修复

1. **受保护批次曾被系统探针救回（回归旧行为）**。`settleRound` 的兜底分支只判断
   `evaluation === null && effectiveProbeCount === 0`，没有排除 `guards.protected`；
   受保护批次不采样租户探针，`effectiveProbeCount` 恒为 0，于是 `ASSERTION` /
   `evaluated=false` / 不兼容协议的本地失败仍会查询系统探针并可能被翻成成功
   （实测 `decision: 'RESCUED'`、`success: true`）。与第 8.2 节「不等探针、不查探针」
   及旧 `evaluateResult` 的保护块都不符。现改为
   `evaluation === null && effectiveProbeCount === 0 && !guards.protected`。
2. **同一毫秒的两轮检查会丢掉第二轮**（见 18.1 偏差 8）。`beginRound` 现在在同一
   `roundId` 被唯一索引占用时追加 `~<uuid>` 重新锚定（最多 3 次），`execute` 用返回的
   实际批次 id 结算。`checker.service.spec.ts` 的 console mock 也补上了唯一约束模拟，
   原先因此偶发失败的 `routes DNS and PING monitors through the registry without
   probe aggregation` 现在稳定通过。
3. **手动检测会提前结算未到期的上一批**（见 18.1 偏差 9）。`settleStaleRounds` 只在
   `now - checkedAt >= interval` 时强制结算，未到期的批次交给 `monitor-settle` 截止任务。

### 19.2 验证记录

- 新增用例：`does not let a system probe rescue a protected batch`、
  `keeps the previous batch open until its deadline`、
  `re-anchors the batch when its round id is taken`（`checker.service.spec.ts`）。
- `npx jest --runInBand`：147 suites / 1972 tests 全部通过（修复前 1967 tests 中 1 条失败）。
- `npx tsc --noEmit`：退出 0（此前记录的 `test/project-access/fixtures.ts` 两条既有错误
  当前已不存在）。
- 未复跑：`pnpm test:monitor:postgres`（需专用一次性库 `MONITOR_TEST_DATABASE_URL`）、
  `pnpm lint`（会 `--fix` 改动工作区）、`pnpm build`。仍未部署。

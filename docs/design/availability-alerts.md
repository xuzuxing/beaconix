# 可用率与连续异常告警

> 文档类型：设计记录。保留原方案、代码示例和阶段决策；当前行为以源码与 Swagger 为准。

> 本文档描述监控告警能力，两种能力**串成一条流水线**：
>
> - **节点异常条件规则（规则树）** —— 规则树存 `RuleGroup.tree`（JSON），`MonitorRuleBinding` 挂 Monitor。每轮检查对聚合结果递归 `evaluate()`，**只产出校验结论**（`ruleMatched` + 命中的 `ruleGroupIds`），随 `CheckLog` 落库，定义「什么算节点异常」。
> - **告警条件** —— Monitor 上直接配置「可用率 + 连续失败 + 通知渠道多选」。它**读取已落库的规则校验结论**统计可用率与连续失败，比对告警条件后发通知，定义「异常聚合到什么程度就告警」。
>
> 节点异常条件规则负责「这一轮算不算异常」，告警条件负责「异常聚合到阈值就告警」：检测结果来自规则校验，是否通知取决于结果与告警条件的比对。均依据当前仓库代码与 `docs/archive/monitoring-v1.1-roadmap.md` 的约定核对。

## 告警条件（可用率 + 连续失败 + 渠道绑定）

### 触发条件

- 告警形态：Monitor 内嵌字段配置（`availability*` + `failureThreshold`）。
- 可用率口径：**最近 `availabilityWindow` 次检查中「规则未命中（健康）」的比例**——规则校验结论来自 `CheckLog.ruleMatched`。
- 连续次数：**从最新一条往前连续 `ruleMatched = true` 的条数**，阈值复用 `Monitor.failureThreshold`。
- 命中条件：`可用率 < availabilityThreshold%` **且** `连续命中 >= failureThreshold`。
- 与节点异常条件规则的关系：**规则树产出校验结论并落库，告警条件消费该结论做聚合告警**，二者串成「校验 → 聚合告警」。

### Schema 增量

`Monitor` 新增可用率告警字段 + 渠道绑定关系：

```prisma
model Monitor {
  // ...existing
  failureThreshold Int @default(3)   // 已有：连续失败次数（复用为「连续 x 次」）

  // 新增：可用率告警
  availabilityEnabled  Boolean @default(false)  // 是否启用可用率告警
  availabilityThreshold Float?  @default(90)    // 可用率阈值 %，< 该值触发
  availabilityWindow    Int?     @default(10)   // 统计窗口（最近 N 次检查）

  // 新增：绑定的通知渠道（多选）
  notificationChannels MonitorNotificationChannel[]
}
```

新建绑定表（对齐现有 `MonitorProbe` 多对多先例）：

```prisma
model MonitorNotificationChannel {
  id        String   @id @default(cuid())
  monitorId String
  channelId String
  createdAt DateTime @default(now())

  monitor Monitor             @relation(fields: [monitorId], references: [id], onDelete: Cascade)
  channel NotificationChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)

  @@unique([monitorId, channelId])
  @@index([monitorId])
  @@index([channelId])
  @@map("monitor_notification_channels")
}
```

`NotificationChannel` 补反向关系 `monitors MonitorNotificationChannel[]`。

### DTO 变更

`CreateMonitorDto` / `UpdateMonitorDto` 增加：

```typescript
@IsOptional() @IsBoolean() availabilityEnabled?: boolean;
@IsOptional() @IsNumber() @Min(0) @Max(100) availabilityThreshold?: number;
@IsOptional() @IsInt() @Min(1) availabilityWindow?: number;
@IsOptional() @IsArray() @IsString({ each: true }) notificationChannelIds?: string[];
```

创建/编辑时校验 `notificationChannelIds` 都属于该 monitor 所属组织；服务层用 nested create / 重建绑定。

### 触发链路接入

在 `CheckerService.execute()` 里，规则树校验在 `stateService.record()` **之前**完成，结论随 `CheckLog` 落库；`record()` 之后再做可用率告警评估：

```
1. 规则树校验：对聚合结果构造 RuleContext，逐条 evaluate()
   → ruleMatched / ruleGroupIds 随 CheckLog 落库（无绑定规则组时回退 ruleMatched = !success）
2. 现有 deriveState 照常 → DOWN / DEGRADED / UP（不变，仍基于 success）
3. 若 availabilityEnabled：
   可用率   = 最近 availabilityWindow 次 CheckLog 中 ruleMatched=false 的比例
   连续失败 = 从最新往前连续 ruleMatched=true 的条数
   命中     = 可用率 < availabilityThreshold%  AND  连续失败 >= failureThreshold
4. 命中且通过状态化去重 → 向 monitor 绑定的渠道发告警
   未绑定任何渠道 → 回退发组织全部启用渠道（向后兼容）
```

新增 `CheckerService.evaluateRuleTree(monitor, result)`（求值）与 `evaluateAvailabilityAlert(monitor, state)`（聚合告警），命中时调用 `NotifierService.notifyAvailabilityAlert(...)`（复用渠道查找与 BullMQ 队列，`event` 用新值 `AVAILABILITY_ALERT`）。

### 状态化去重与恢复

可用率告警是状态化的（`MonitorState.availabilityAlertActive`）：

- 命中且未告警 → 发一次告警，置 `active=true`；
- `active` 期间持续异常 → 静默（不重复）；
- 可用率回升到阈值以上且 `active` → 发一次恢复通知（`AVAILABILITY_RECOVERED`），置 `active=false`。

与现有状态通知的 `lastNotifiedStatus` 去重相互独立。

### 测试告警

`POST /projects/:projectId/monitors/:id/test-alert` 用当前可用率发一条 `isTest` 告警，便于验证配置。

### 验收

- 可用率未跌破阈值或规则连续命中未达阈值时不发。
- 两个条件同时满足时，向**绑定渠道**发送一次；持续命中期间不重复。
- 未绑定渠道时回退发组织全部启用渠道。
- 创建 monitor 传入的 `notificationChannelIds` 跨组织会被拒绝。

---

规则树的模型、求值与检查链路接入见 [规则引擎](rule-engine.md)。

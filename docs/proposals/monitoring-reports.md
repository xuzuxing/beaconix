# 监控报表与定时报表通知设计方案

> 文档类型：未实施提案。监控概览的现行运行说明见 [监控运行指南](../guides/monitoring-operations.md)；报表与订阅是独立后续能力。

> 状态：待评审/待开发
> 关联模块：`src/modules/monitoring`、`src/modules/checker`、`src/modules/notifier`、`src/infra/scheduler`
>
> 2026-10-10 口径同步：监控概览全量实现已提供三端点、90 天原始历史、MonitorHistory 与 AlertEvent。本文仅是独立的报表/订阅设计，尚未实施，不属于概览功能的延期部分。

## 1. 背景与目标

当前 Beacon 已有监控概览及 90 天原始历史查询（`src/modules/monitoring`），尚无独立历史报表和按日/周/月/年自动推送报表。

本方案要落地两个能力：

1. **报表查看**：按组织或项目维度查看日/周/月/年监控报表（可用性、延迟、故障、SSL、趋势）。
2. **定时报表通知**：按日/周/月/年定时生成报表，并通过已有通知渠道推送（邮件、飞书、企业微信、钉钉、微信订阅消息）。

## 2. 现状与关键约束

- 原始检测数据在 `check_logs`（每次探测一行）。
- 数据清理策略（`src/modules/cron/jobs/monitor-data-cleanup.service.ts`）：
    - `check_logs` 保留 **90 天**
    - `probe_executions` 保留 **7 天**
    - 可可靠归属的 `probe_results` 保留 **90 天**
- 定时任务体系：`src/infra/scheduler/` 使用 `ScheduledJobRegistry` + BullMQ `scheduled-jobs` 队列。
    - 新增任务需在 `scheduled-jobs.constants.ts` 增加常量与五段 cron。
    - 业务服务在 `onModuleInit` 里 `registry.register(...)`。
- 通知渠道体系：`src/modules/notifier/` 已有组织级渠道 `FEISHU / WECOM / DINGTALK / WECHAT_SUBSCRIBE / EMAIL`。
- 原有 `MonitoringService` overview 保持兼容；`MonitoringDashboardService` 支持多窗口概览及各维度独立覆盖水位。

> 结论：长周期报表不能只查 `check_logs`，仍需**日粒度预聚合**，否则年报表会因 90 天清理而缺数据。旧策略已删除的历史不能补造。

## 3. 总体架构

```
check_logs / monitor_history / alert_events
        │
        ▼
[每日聚合 Job]  report-aggregation  00:10 UTC
        │  生成 monitor_daily_stats（按 monitor + 日期）
        ▼
[报表调度 Job]  report-dispatch     */15 * * * *
        │  扫描 ReportSchedule 是否到期
        ▼
ReportsService.generate(period)
        │  读 daily_stats + 当前状态 + incidents
        ▼
Report 快照（JSON） + ReportDelivery 投递
        │
        ├── EMAIL → EmailService（新增 REPORT 模板）
        ├── FEISHU/WECOM/DINGTALK → webhook 文本/Markdown 摘要
        └── WECHAT_SUBSCRIBE → 订阅消息短摘要
```

## 4. 数据模型（Prisma schema 新增）

### 4.1 枚举

```prisma
enum ReportPeriod {
  DAILY
  WEEKLY
  MONTHLY
  YEARLY
}

enum ReportScope {
  ORGANIZATION
  PROJECT
}

enum ReportStatus {
  SUCCESS
  PARTIAL
  FAILED
}
```

### 4.2 日聚合表（核心）

```prisma
// 监控日报聚合：周/月/年报表都基于此表汇总
model MonitorDailyStat {
  id             String   @id @default(cuid())
  organizationId String
  projectId      String
  monitorId      String
  date           DateTime // 归一化到 UTC 当天 00:00
  totalChecks    Int
  successChecks  Int
  failedChecks   Int
  probeRescued   Int      // 本地失败但被探针救回
  uptimePercent  Float
  avgLatency     Int?
  minLatency     Int?
  maxLatency     Int?
  incidentCount  Int      // 当天进入 DOWN 的次数
  downSeconds    Int      // 当天累计 DOWN 时长（v1 可先为 0）

  @@unique([monitorId, date])
  @@index([organizationId, date])
  @@index([projectId, date])
  @@map("monitor_daily_stats")
}
```

### 4.3 故障事件表

复用已实施的 `AlertEvent(kind=CONNECTIVITY)` 作为唯一连接故障来源，不再创建或写入 MonitorIncident。

- `startedAt` / `resolvedAt` 分别表示独立服务证据触发和真实恢复；持续时间按报表窗口截取。
- SSL 与 AVAILABILITY 是独立 kind，不能把证书失败或规则健康比例混为连接故障。
- 暂停、删除和关闭配置是抑制，不是恢复；BASELINE 不代表已知的历史故障开始。
- 数量/状态历史读取 MonitorHistory；notified 读取事件持久成功事实，不能把入队当投递成功。
- 报表读取可靠覆盖水位并据实标记缺口；不另建 StateService 状态转换事件 writer。

### 4.4 报表订阅（定时发送配置）

```prisma
// 报表订阅：用户配置的“日报/周报/月报/年报”发送计划
model ReportSchedule {
  id             String       @id @default(cuid())
  organizationId String
  name           String
  frequency      ReportPeriod
  scope          ReportScope  // ORGANIZATION | PROJECT
  projectId      String?      // scope=PROJECT 时必填
  timeOfDay      String       // "08:00"
  timezone       String       // IANA，如 "Asia/Shanghai"
  dayOfWeek      Int?         // WEEKLY：1-7
  dayOfMonth     Int?         // MONTHLY：1-28
  month          Int?         // YEARLY：1-12
  day            Int?         // YEARLY：1-28（与 month 组合）
  enabled        Boolean      @default(true)
  lastRunAt      DateTime?
  nextRunAt      DateTime?
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  channels ReportScheduleChannel[]
  reports  Report[]

  @@index([enabled, nextRunAt])
  @@map("report_schedules")
}

// 订阅与通知渠道的多对多关系
model ReportScheduleChannel {
  scheduleId String
  channelId  String

  @@id([scheduleId, channelId])
  @@map("report_schedule_channels")
}
```

### 4.5 报表快照与投递记录

```prisma
// 报表快照：每次生成一份，供前端查看历史
model Report {
  id             String       @id @default(cuid())
  scheduleId     String?
  organizationId String
  scope          ReportScope
  projectId      String?
  period         ReportPeriod
  periodStart    DateTime
  periodEnd      DateTime
  payload        Json         // 报表完整数据
  status         ReportStatus @default(SUCCESS)
  createdAt      DateTime     @default(now())

  deliveries ReportDelivery[]
  schedule   ReportSchedule? @relation(fields: [scheduleId], references: [id], onDelete: SetNull)

  @@index([organizationId, createdAt])
  @@map("reports")
}

// 报表投递记录：每个渠道一条
model ReportDelivery {
  id        String             @id @default(cuid())
  reportId  String
  channelId String
  status    NotificationStatus // 复用 SUCCESS / FAILED
  error     String?
  sentAt    DateTime           @default(now())

  report Report @relation(fields: [reportId], references: [id], onDelete: Cascade)

  @@index([reportId, sentAt])
  @@map("report_deliveries")
}
```

> 不复用 `NotificationLog`：其 `monitorId` 必填且语义绑定监控告警，报表投递单独建表更清晰。

## 5. 定时任务设计

在 `src/infra/scheduler/scheduled-jobs.constants.ts` 增加：

```ts
export const SCHEDULED_JOBS = {
  // ...existing
  reportAggregation: 'report-aggregation',
  reportDispatch: 'report-dispatch',
} as const;

export const SCHEDULED_JOB_PATTERNS = {
  // ...existing
  'report-aggregation': '10 0 * * *', // 每天 00:10 UTC，赶在 03:00 清理前
  'report-dispatch': '*/15 * * * *',  // 每 15 分钟扫描到期订阅
};
```

### 5.1 ReportAggregationService（每日聚合）

- 每天 00:10 跑，聚合**昨天**的 `check_logs`。
- 按 `monitorId` 分组计算：
    - `totalChecks`、`successChecks`、`failedChecks`
    - `probeRescued`（`localSuccess = false AND success = true`）
    - `uptimePercent`
    - `avg/min/max latency`
    - `incidentCount`（当天观察到的 CONNECTIVITY AlertEvent 开始数，排除 BASELINE）
- 使用 `upsert`（`[monitorId, date]`），保证重跑幂等。
- 失败处理沿用现有 job 风格：catch + log，单个监控失败不阻塞整体。

### 5.2 ReportDispatchService（扫描到期订阅）

- 每 15 分钟扫描 `ReportSchedule where enabled = true AND nextRunAt <= now()`。
- 对每个到期订阅：
    1. 用 `updateMany` 抢占（条件 `id` + `nextRunAt <= now`），防止多副本重复发送（与 `TaskDueSoonService` 的 claim 模式一致）。
    2. `ReportsService.generate(...)` 生成报表并落 `Report` 快照。
    3. 对 `ReportScheduleChannel` 逐个入队投递 job。
    4. 计算并更新 `nextRunAt`（按 frequency + timezone 计算下一次）。
- `nextRunAt` 统一存 UTC；计算建议使用 `luxon` 或原生 `Intl`。

> 不采用“每个订阅一个独立 BullMQ repeatable job”：那会绕过现有固定名 `ScheduledJobRegistry`，引入两套调度机制。单个 dispatch 扫描器更简单且与现有体系一致。

## 6. 报表内容（payload 结构）

```jsonc
{
  "period": "WEEKLY",
  "periodStart": "2026-05-11T00:00:00Z",
  "periodEnd": "2026-05-17T23:59:59Z",
  "summary": {
    "monitors": { "total": 12, "enabled": 10, "paused": 2 },
    "uptimePercent": 99.87,        // 全部监控按检测次数加权
    "avgLatency": 132,             // 加权平均
    "totalChecks": 100800,
    "failedChecks": 131,
    "probeRescued": 17,
    "incidents": 3,
    "sslExpiringSoon": 1
  },
  "trend": [
    { "date": "2026-05-11", "uptimePercent": 99.9, "avgLatency": 120, "incidents": 0 },
    { "date": "2026-05-12", "uptimePercent": 98.1, "avgLatency": 210, "incidents": 2 }
  ],
  "topIncidents": [
    { "monitorName": "Production API", "startedAt": "...", "durationSeconds": 540, "error": "..." }
  ],
  "monitors": [
    { "name": "Production API", "target": "https://...", "uptimePercent": 97.2, "avgLatency": 250, "checks": 10080, "incidents": 2 }
  ]
}
```

- **日/周/月/年** 只改变聚合时间窗口：
    - 日 = 当天 daily stat。
    - 周/月/年 = 多条 daily stat 聚合 + 当前快照补充。
- v1 后端只返回结构化数据供前端渲染，不生成 PDF；后续可加 CSV/PDF 导出。

## 7. 通知渠道复用

### 7.1 EMAIL

- `src/modules/email/email.types.ts` 增加 `EmailTemplate.REPORT = 'report'`。
- `EmailService` 增加 `buildReportEmail`：HTML 摘要表 + “查看完整报表”链接。
- 前端 URL 建议加入 `app` config（如 `APP_WEB_BASE_URL`）。
- 开发环境自动走现有 stdout 打印。

### 7.2 飞书 / 企业微信 / 钉钉

webhook 不适合塞完整报表，发送**摘要 Markdown/文本**：

```text
### [Beacon 周报] 2026-05-11 ~ 2026-05-17
- 监控总数: 12（启用 10）
- 可用性: 99.87%
- 平均延迟: 132ms
- 故障次数: 3
- 最长故障: Production API 9 分钟
查看完整报表: https://...
```

实现建议：

- 在 `reports` 模块内新建 `ReportChannelSender`。
- 复用 `src/modules/notifier/channel-config.ts` 的 `parseFeishuConfig / parseWecomConfig / parseDingtalkConfig`。
- 复用 `src/modules/notifier/http.util.ts` 的 `postJson / assertZeroCode`。
- 新增 `report-message.ts` 渲染摘要。
- **不改动现有 `NotifierService`**，避免影响现有监控告警。

### 7.3 微信订阅消息

只发短摘要（“报表已生成 + 可用性 + 故障数”），复用 `MiniprogramClient`。

### 7.4 投递队列

新增：

```ts
export const REPORT_QUEUE = 'reports';
export const REPORT_DELIVERY_JOB = 'report-delivery';
```

`ReportDeliveryProcessor` 调 `ReportDeliveryService.deliver()`：

- 成功 → 写 `ReportDelivery.status = SUCCESS`。
- 失败 → 写 `FAILED` 后抛错，让 BullMQ 按 `attempts: 3` + 指数退避重试（与 `NotificationsProcessor` 相同模式）。

## 8. API 设计

新模块建议放 `src/modules/reports/`（含订阅管理）。

### 8.1 查看报表

```
GET /api/organizations/:orgId/reports/overview?period=weekly&from=...&to=...
GET /api/projects/:projectId/reports/overview?period=weekly&from=...&to=...
GET /api/organizations/:orgId/reports             # 历史快照列表
GET /api/organizations/:orgId/reports/:id         # 快照详情
GET /api/organizations/:orgId/reports/:id/deliveries
```

- 读接口使用 `OrgMemberGuard`。
- `period = DAILY | WEEKLY | MONTHLY | YEARLY`。
- 不传 `from/to` 时按当前自然周期计算。
- 数据来源：`MonitorDailyStat` + CONNECTIVITY `AlertEvent` + 当前 `MonitorState`。

### 8.2 管理订阅

```
GET    /api/organizations/:orgId/report-schedules
POST   /api/organizations/:orgId/report-schedules          # ADMIN
GET    /api/organizations/:orgId/report-schedules/:id
PATCH  /api/organizations/:orgId/report-schedules/:id      # ADMIN
DELETE /api/organizations/:orgId/report-schedules/:id      # ADMIN
POST   /api/organizations/:orgId/report-schedules/:id/test # ADMIN，立即生成并发送一次
POST   /api/organizations/:orgId/report-schedules/:id/run  # ADMIN，立即生成（可选）
```

创建 DTO：

```ts
class CreateReportScheduleDto {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  name: string;
  scope: 'ORGANIZATION' | 'PROJECT';
  projectId?: string;
  channelIds: string[];
  timeOfDay: string;          // "08:00"
  timezone: string;           // "Asia/Shanghai"
  dayOfWeek?: number;         // WEEKLY
  dayOfMonth?: number;        // MONTHLY
  month?: number;             // YEARLY
  day?: number;               // YEARLY
  enabled?: boolean;
}
```

- 校验 `channelIds` 属于该组织且 `enabled`。
- `QuotaService`（`src/shared/quota/quota.service.ts`）增加资源类型 `reports`，限制每组织订阅数。

## 9. 模块文件规划

```
src/modules/reports/
├── dto/
│   ├── create-report-schedule.dto.ts
│   ├── query-reports.dto.ts
│   ├── update-report-schedule.dto.ts
│   └── index.ts
├── entities/
│   ├── report.entity.ts
│   ├── report-schedule.entity.ts
│   └── index.ts
├── jobs/
│   ├── report-aggregation.service.ts
│   ├── report-dispatch.service.ts
│   └── index.ts
├── senders/
│   ├── email.sender.ts
│   ├── feishu.sender.ts
│   ├── wecom.sender.ts
│   ├── dingtalk.sender.ts
│   ├── wechat-subscribe.sender.ts
│   └── index.ts
├── report-message.ts
├── reports.controller.ts
├── reports.service.ts
├── report-schedules.controller.ts
├── report-schedules.service.ts
├── report-delivery.processor.ts
├── report-delivery.service.ts
└── reports.module.ts
```

`reports.module.ts` 依赖：

- `NotificationsModule`（无需，复用其 `channel-config`/`http.util` 即可，注意将其导出或抽到 shared）
- `EmailModule`（全局可用）
- `WechatModule`
- `QueuesModule`
- `ScheduledJobsModule`（`ScheduledJobRegistry` 为全局）

> 落地时建议把 `channel-config.ts` / `http.util.ts` / `channel-message.ts` 中可复用的部分提升为共享工具（例如 `src/shared/notification/`），避免 `reports` 反向依赖 `notifier` 模块内部文件。

## 10. 分阶段实施

### Phase 1：能看日/周报表

1. Prisma 增加 `ReportPeriod`、`ReportScope`、`MonitorDailyStat` 等报表 schema，复用已存在的 AlertEvent，执行 `pnpm prisma:migrate` 与 `pnpm prisma:generate`。
2. 实现 `ReportAggregationService` 每日聚合 job。
3. 实现 `ReportsService.generate()` 与 `GET .../reports/overview`。
4. 从 AlertEvent 读取连接故障；不增加第二套生命周期写入。

### Phase 2：邮件日报

5. 增加 `ReportSchedule` / `ReportScheduleChannel` CRUD。
6. 增加 `report-dispatch` 扫描 job。
7. `EmailService` 增加 `REPORT` 模板，实现 EMAIL 渠道投递与 `ReportDelivery` 日志。

### Phase 3：全渠道 + 全频率

8. 实现飞书/企微/钉钉/微信订阅的报表摘要 sender。
9. 完善 WEEKLY/MONTHLY/YEARLY 的时区与 `nextRunAt` 计算。
10. 前端 URL 配置与报表查看页对接。

### Phase 4：增强

11. 报表导出 CSV/PDF。
12. 报表历史清理 job（`Report` 保留 12 个月，`MonitorDailyStat` 保留 25 个月）。
13. 组织/项目维度同比、环比。

## 11. 验收标准

- [ ] 能通过 API 查看组织/项目维度的日、周、月、年报表。
- [ ] 长周期报表数据基于 `MonitorDailyStat`，不依赖保留期外的 `check_logs`。
- [ ] 能创建/修改/删除/停用报表订阅，并绑定多个通知渠道。
- [ ] 订阅到期后只发送一次（多副本环境不重复）。
- [ ] EMAIL 渠道能收到带完整摘要和查看链接的报表邮件。
- [ ] 飞书/企微/钉钉/微信订阅能收到报表摘要。
- [ ] 每次投递有 `ReportDelivery` 成功/失败记录，失败自动重试。
- [ ] 报表生成/投递失败不影响监控检测主流程。
- [ ] `pnpm type-check`、`pnpm lint`、`pnpm build` 通过，关键逻辑有 Jest 单测。

## 12. 风险与注意事项

- **时区**：`SCHEDULED_JOB_PATTERNS` 是五段 cron（无秒）；`ReportSchedule.timezone` 单独处理，`nextRunAt` 统一存 UTC。
- **去重**：dispatch 扫描式任务必须用 `updateMany` 条件更新抢锁，防止多副本重复发送。
- **90 天清理**：预聚合必须可补偿重试，并在原始数据过保留期前完成；不能仅依赖 cron 先后顺序保证完整性。
- **大时间窗口查询**：周/月/年报表只查 `MonitorDailyStat`，不查 `check_logs`。
- **软删除的 monitor**：`MonitorDailyStat` 冗余 `organizationId/projectId/monitorId/date`，不依赖 join 当前 `monitors` 表。
- **渠道故障**：投递失败写 `ReportDelivery.status = FAILED`，并在 `Report.status = PARTIAL` 标记，避免“生成了但没发出去”无人知晓。
- **配额**：订阅数量应纳入 `QuotaService` 管理，避免无限创建。

## 13. 待确认问题

1. 报表前端查看 URL 的配置项名称与默认值。
2. 报表是否需要 PDF/CSV 导出（影响 Phase 4 排期）。
3. 周报默认一周起始日（周一还是周日）。
4. 故障时长 `downSeconds` 是否在 v1 就精确统计，还是先只报故障次数。
5. 是否需要在报表中展示通知渠道自身的投递成功率。

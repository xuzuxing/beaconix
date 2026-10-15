# 004：公开状态页逐小时可用率热力图实施方案

> 状态：设计完成（已对现有代码逐条核对），尚未实施。日期：2026-10-15。
>
> 后端基准：`D:/zuxcloud/nest-beacon`，提交 `04ca001`。
> 前端基准：`D:/zuxcloud/Beacon/beacon-vue3`，提交 `14944d4`（含未提交改动）。
> 原提案：前端侧契约文档《状态页热力图接口（公开逐小时可用率）》（2026-10-14），本文为其后端落位与修正版。
>
> 本文是实施依据与验收契约。与原提案的差异集中在 §9，实施时以本文为准；原提案中与现状不符的假设已逐条修正。
> 相关先例：`plans/001-monitoring-overview-api.md`（§6 availability 口径）、`src/modules/monitoring/monitoring-dashboard.service.ts`。

## 1. 目标与范围

公开状态页 `GET /api/status/:slug` 目前只有快照（`status` / `latency` / `uptimePercent` / `lastCheckAt`），画不出热力图。本次在每个 `monitors[]` 条目里补一个逐小时可用率数据组 `availability`，口径与概览页 `availability` 端点（`plans/001` §6）一致，只是把样本范围从"项目内全部监控"换成"该状态页的可见监控集合"，并允许跨项目。

| 项目 | 决策 |
| --- | --- |
| 承载方式 | 方案 A：挂在现有 `GET /api/status/:slug` 的 `monitors[]` 内，不新增端点 |
| 路由变化 | 仅新增可选 query 参数 `tz`（IANA，默认 `Asia/Shanghai`） |
| 天数 | 固定 3 天（含今天），不开放 `days` 参数 |
| 鉴权 | 保持 `@Public()` 匿名可用，不新增鉴权端点 |
| 统计样本 | `check_logs.source = 'LOCAL'`、`evaluated = true`、`monitorId IN (可见监控)` |
| 时区 | 按请求时区分桶；`tz` 缺失用默认时区，非法/固定偏移/重复/空值 400 |
| 与 `showUptime` 的关系 | `showUptime = false` 时不聚合、不返回 `availability` |
| 可见监控上限 | 新增 100 的上限，仅创建/更新时校验 |

优先级 P2，工作量 M，风险 MED（公开匿名端点 + 跨项目聚合 + 缓存/ETag）。不改数据库结构，不改鉴权模型，不新增依赖。

## 2. 现状核对（实施前事实）

下列事实已逐条核对，是本文所有口径的依据。

### 2.1 后端

| 位置 | 已核对现状 | 本次影响 |
| --- | --- | --- |
| `src/modules/status-pages/status-pages-public.controller.ts:27` | `getPublic(@Param('slug'))` 无 `@Query()` 绑定 | 必须加查询 DTO，否则 `tz` 被静默忽略 |
| `src/modules/status-pages/status-pages.service.ts:135` | `getPublicBySlug(slug)` 多次独立查询，无事务、无缓存 | 需要单快照 + 缓存 + ETag |
| `src/modules/status-pages/status-pages.service.ts:144` | 可见监控过滤：`id IN visibleMonitorIds` + 组织一致 + 监控/项目/组织均未软删除 | `availability` 的监控集合必须与它完全一致 |
| `src/modules/status-pages/status-pages.service.ts:179` | `buildPublicMonitor` 对每个监控并发 2 次 `checkLog.count`（`STATUS_PAGE_UPTIME_WINDOW_MS` = 24h） | 2N 次查询 → 1 条批量聚合 |
| `src/modules/status-pages/status-pages.service.ts:200` | 该 count 的 where **不含 `source` 过滤**，窗口是 `Date.now() - 24h` 的滑动窗口 | 与热力图口径不同，**不能复用同一份分组结果**（见 §9.1） |
| `src/modules/monitoring/monitoring-dashboard.service.ts:675` | `availability()`：单项目、按当地日期/小时聚合，已实现 DST 合并、水位截断、`worst` | 口径直接复用，改为按 `monitorId` 分组 |
| `src/modules/monitoring/monitoring-dashboard.service.ts:121` | `coverage()` 读 `monitoringCoverage` 的项目唯一行，`findUniqueOrThrow` | 状态页跨项目，需多行 + 取最差 |
| `src/modules/monitoring/monitoring-dashboard.service.ts:705` | 现有 SQL：`WHERE "projectId" = ... GROUP BY day, hour` | 换成 `monitorId IN (...)` + `GROUP BY "monitorId", day, hour` |
| `src/modules/monitoring/monitoring-window.util.ts:98` | `localHourIntervals(date, tz, asOf)` 纯函数，处理 DST 跳过/回拨 | 直接复用，无需改动 |
| `prisma/schema.prisma:1263` | `CheckLog` 有 `@@index([monitorId, checkedAt])` | 跨项目查询改用该索引，本次不新增索引 |
| `prisma/schema.prisma:1231` | `CheckLog.projectId` 是 `String?`（可空） | 水位不能靠 `check_logs.projectId` join（见 §6） |
| `prisma/migrations/20261010120000_monitoring_dashboard/migration.sql:80` | `projects` 的 trigger 保证每个项目一行 `monitoring_coverage` | 跨项目取水位不会缺行 |
| `src/modules/cron/jobs/monitor-data-cleanup.service.ts:12` | `check_logs` 保留 90 天 | 与 `retentionDays: 90` 一致 |
| `src/main.ts:42` | 全局 `ValidationPipe` 实际是 `forbidNonWhitelisted: false`（`AGENTS.md` 写的 `true` 已过时） | 未知参数不会自动 400，需要显式校验 |
| `src/modules/monitoring/monitoring-etag.interceptor.ts:52` | "重复/空/未知参数 400" 与弱 ETag 都在该拦截器内，`allowed` 按 endpoint 名硬编码，ETag 掺入 principal | `status/:slug` 无法直接复用 |
| `src/app.module.ts:181` | 全局 `JwtAuthGuard` + `ThrottlerGuard`；`throttler.config.ts` 默认 `limit=10 / ttl=60s` | 公开页已按 IP 限流，无需新增 |
| `src/infra/cache/cache.module.ts` | `CacheModule` 是 `@Global`，提供 `MultiLevelCacheService` | `StatusPagesService` 可直接注入，无需改 module imports |
| `src/common/interceptors/transform.interceptor.ts:44` | `@SkipTransform()` 时跳过包装 | ETag 拦截器需与 `@SkipTransform()` 搭配，自行包装 `{data, meta}` |

`MonitoringCoverage` 由 trigger 保证每项目一行，`findUniqueOrThrow` 在单项目场景永远安全；状态页跨项目时需要 `findMany`，见 §6。

### 2.2 前端（`Beacon/beacon-vue3`）

| 位置 | 已核对现状 | 本次影响 |
| --- | --- | --- |
| `src/api/modules/status-page.ts:49` | `getPublicStatusPage(slug, config)` 第二参数为 `undefined`，**不传 `tz`** | 前端必须改（§10.2） |
| `src/api/types/status-page.ts:49` | `PublicMonitorAvailability`：`days` / `hours` / `cells` / `unavailableCells?` / `worst?` / `simulated?` | 字段名与本文一致，类型无需改 |
| 同上 `:65`/`:78` | `PublicStatusPageMonitor.availability?: PublicMonitorAvailability` | 后端返回后自动生效 |
| `src/components/status-pages/PublicStatusPagePanel.vue:90` | `v-if="page.showUptime && monitor.availability"` | 与"`showUptime=false` 不返回"的口径一致 |
| `src/utils/status-page-simulated.ts` | 仅对"后端没返回 `availability`"的监控注入模拟值，真实数据不被覆盖 | 联调时置 `VITE_STATUS_PAGE_MOCK=0` |
| `src/locales/status-page.zh-CN.ts:95` | 灰格文案 `noData: '该小时没有检测数据'`，`tip` 同上；只有一种灰格语义 | 与本文 §3 决策冲突，需改文案（§9.2） |
| `src/utils/status-page-simulated.ts` | 模拟 `days` 生成 `MM-DD`（`03-05`），yAxis 直接用它 | 后端返回 `YYYY-MM-DD`，前端需格式化（§9.3） |

## 3. 已定决策

| 项目 | 决策 |
| --- | --- |
| 灰格语义（**已定**） | `unavailableCells` 只表示"历史数据不足（水位截断）"。未观测的小时在 `cells` 与 `unavailableCells` 中都不出现，前端渲染为空白。前端仅需把灰格文案改为"历史数据不足" |
| 天数轴 | `days` 固定 3 个当地自然日、升序、含今天；即使无样本也保留完整轴 |
| 小时轴 | `hours` 固定 `0..23`，不返回 24 |
| `asOf` | 单只读事务内取 `clock_timestamp()`，`asOf` 与全部聚合、`uptimePercent` 同源 |
| 缓存 | `status-page:v1:${slug}:${tz}`，TTL 60s（L1 60 / L2 60） |
| 协商 | 弱 ETag + `If-None-Match` → 304，ETag 只覆盖 `data`，不掺 principal |
| 聚合方式 | 全部可见监控**一条 SQL** 覆盖，按 `monitorId, day, hour` 分组 |
| 现状口径保持 | `uptimePercent` 的语义与数值口径不变（仍不含 `source` 过滤） |
| 上限 | `visibleMonitorIds` 最多 100，仅创建/更新时校验 |

## 4. 契约

### 4.1 路由与参数

| 方法与路径 | 变化 | 参数 |
| --- | --- | --- |
| `GET /api/status/:slug` | 新增可选 query | `tz`（IANA 时区，默认 `Asia/Shanghai`） |

- `days` 固定 3，不开放参数。
- `tz` 校验：非法 IANA、固定偏移字符串（`^[+-]`）、重复参数、空值一律 400；缺失用默认时区。
- `slug` 不存在或 `enabled=false` 仍是 404，不区分两者（保持现状）。
- 响应包装仍是 `{ data, meta: { timestamp, requestId } }`。

### 4.2 响应

`data.monitors[i]` 新增 `availability`（`showUptime = true` 时存在）：

```json
{
  "data": {
    "slug": "acme-status",
    "title": "Acme 服务状态",
    "overallStatus": "UP",
    "showLatency": true,
    "showUptime": true,
    "updatedAt": "2026-10-10T18:32:00.000Z",
    "monitors": [
      {
        "id": "uuid-monitor-1",
        "name": "Production API",
        "type": "HTTP",
        "target": "https://api.example.com/health",
        "status": "UP",
        "lastCheckAt": "2026-10-10T10:30:00.000Z",
        "latency": 128,
        "uptimePercent": 99.5,
        "availability": {
          "tz": "Asia/Shanghai",
          "asOf": "2026-10-10T18:32:00.000+08:00",
          "from": "2026-10-08",
          "to": "2026-10-10",
          "history": {
            "retentionDays": 90,
            "availableFrom": "2026-07-12T18:32:00.000+08:00",
            "status": "AVAILABLE"
          },
          "hours": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
          "days": ["2026-10-08", "2026-10-09", "2026-10-10"],
          "cells": [[0, 0, 100], [1, 0, 75], [18, 2, 50]],
          "unavailableCells": [[3, 0], [9, 1]],
          "worst": { "day": "2026-10-10", "hour": 18, "value": 50 }
        }
      }
    ]
  }
}
```

### 4.3 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tz` | string | 回显请求时区（已按 `Intl` 规范化） |
| `asOf` | string | 聚合快照时间，请求时区并保留偏移，格式与 `iso()` 一致（带毫秒） |
| `from` / `to` | string | 日期范围，两端包含；`to` 为 `asOf` 的当地日期 |
| `history.retentionDays` | number | 固定 90，与清理任务一致 |
| `history.availableFrom` | string | 该监控所属项目的可靠检查起点（含时区偏移） |
| `history.status` | string | 仅 `AVAILABLE` / `TRUNCATED`（与 `monitoring/availability` 一致，见 §9.4） |
| `hours` | number[] | 固定 `0-23` |
| `days` | string[] | 3 个当地日期，升序，含今天，格式 `YYYY-MM-DD` |
| `cells` | `[hourIndex, dayIndex, uptimePercent][]` | 按 `dayIndex`、`hourIndex` 升序，`uptimePercent` 保留 2 位小数 |
| `unavailableCells` | `[hourIndex, dayIndex][]` | 因保留期水位被截断的格子；与 `cells` 不重叠 |
| `worst` | object \| null | 从实际 `cells` 取最小可用率；同值按日期、小时升序取第一格；无 `cells` 为 `null` |

不返回 `simulated` 字段（前端演示数据标记，后端不产出）。
`tz` / `asOf` / `from` / `to` / `history` 前端当前不读，但照常返回，便于排查与后续做"历史不足"提示。

## 5. 聚合口径

与 `plans/001` §6 一致，只改样本范围与分组维度：

1. 样本：`check_logs`，条件 `source = 'LOCAL'`、`evaluated = true`、`"monitorId" IN (可见监控)`、`"checkedAt" >= max(窗口起点, 该项目水位)` 且 `< asOf`。
2. 分桶：`"checkedAt" AT TIME ZONE 'UTC' AT TIME ZONE tz` 取当地日期与小时；`hour` 用 24 小时制，不返回 24。
3. 每格 = 该小时该监控的 `COUNT(*) FILTER (WHERE success) / COUNT(*)`，保留 2 位小数；**没有样本的小时不生成格**，不填 0 或 100。
4. 夏令时：回拨产生的两个同名当地小时由 SQL 分组键天然合并（同当地日期 + 小时 → 同一行），合并成功数与总数后再算一格；时钟跳过的小时不返回格。
5. 水位截断：某格覆盖的时刻区间只要有任何部分早于该监控所属项目的可靠起点，整格省略并进入 `unavailableCells`；重复小时的合并格按全部区间检查。
6. 无观测、未来小时、时钟跳过的小时**不**进入 `unavailableCells`（**已定决策**，见 §3）。
7. 可见监控的过滤与 `getPublicBySlug` 现有查询完全一致（`deletedAt = null`、所属项目与组织未删除），不放宽。
8. 单页最多 `3 × 24 = 72` 格/监控；不用日聚合表还原逐小时。

分桶与格子组装的逻辑从 `MonitoringDashboardService.availability()` 抽出为**纯函数**（见 §10.1），两个 service 共用；注意把现有实现里的 `rows.find()` 线性查找改为 `Map`（跨 100 个监控会放大）。

## 6. 跨项目水位（本方案唯一的实现难点）

`MonitoringCoverage` 是**项目唯一行**，而状态页的可见监控可跨多个项目。规则：

- **格子级**：按该监控所属项目的 `coverage` 判断是否截断（`Monitor.projectId` 直接可得）。
- **页面级 `history`**：取相关项目里**最差**的覆盖起点（`checksStartedAt` 最晚者），避免虚假承诺覆盖；`status` 相应为 `TRUNCATED`。单个监控的 `history.availableFrom` 用它自己项目的水位。
- 水位统一为 `max(checksStartedAt, asOf - 90d)`，与 `coverage()` 一致。

**实现注意：不要用 `check_logs."projectId"` join 水位表。** 该列可空（`schema.prisma:1231`），经它 join 会漏掉水位。在聚合 SQL 里经 `monitors` 取：

```sql
JOIN monitors m ON m.id = c."monitorId"
JOIN monitoring_coverage cv ON cv."projectId" = m."projectId"
...
AND c."checkedAt" >= GREATEST(${from}::timestamp, cv."checksStartedAt", ${asOfMinus90d}::timestamp)
```

这样仍是一次聚合，同时天然落到"宽松下界 + 格子级判断"：SQL 取足数据，格子是否截断由每个监控自己的水位在组装阶段判定（不能把最差水位当 SQL 下界，否则会丢早期有效数据）。

## 7. 性能、缓存与限流

### 7.1 查询

- 热力图：**一条 SQL** 覆盖全部可见监控，`GROUP BY "monitorId", day, hour`，去掉 `"projectId" = ...`，改用 `"monitorId" IN (...)`；索引走 `@@index([monitorId, checkedAt])`（`schema.prisma:1263`），本次不新增索引，压测后再评估。
- `uptimePercent`：现状是 2 次 `count` × N 个监控。改为**一条 SQL 按 `monitorId` 分组**（`COUNT(*)` 与 `COUNT(*) FILTER (WHERE success)`），where 与现状逐字一致（`monitorId IN`、`checkedAt >= asOf - 24h`、`evaluated = true`，**不过滤 `source`**），数值语义不变。窗口起点从 `Date.now()` 改为事务内的 `asOf`，差异在毫秒级。
- 可见监控只有 1 条 `monitor.findMany`（现状已如此），加 1 条 `monitoringCoverage.findMany`（按涉及的 projectId 集合）。
- `showUptime = false` 时上述两条聚合都不执行。

### 7.2 快照

`getPublicBySlug` 整体放入一个 `RepeatableRead` 只读事务（参照 `monitoring-dashboard.service.ts:101-113` 的写法），事务内先取 `SELECT clock_timestamp() AT TIME ZONE 'UTC'` 作为 `asOf`，保证 `asOf`、`lastCheckAt`、`uptimePercent`、`availability` 同源。

### 7.3 缓存与协商

- 缓存键 `status-page:v1:${slug}:${tz}`，TTL 60s（公开页有手动刷新按钮，300s 会让"刷新"看起来无效）。
- `MultiLevelCacheService` 是 `@Global`，直接注入；匿名请求无 principal，缓存键不含任何身份维度。
- 弱 ETag 覆盖 `data`（不含 `meta.timestamp`），`If-None-Match` 命中返回 304 且无响应体；`main.ts` 的 CORS 已 `exposedHeaders: ['ETag']`。
- 复用 `monitoring-etag.interceptor.ts` 导出的纯函数 `weakEtag` / `etagMatches`，**不重构 monitoring 的现有拦截器**（降低回归面）；严格参数校验与匿名 ETag 各写一个 status-pages 侧拦截器。

### 7.4 体积与限流

- `days=3` 时每监控最多 72 格，约 1KB；20 个监控约 20KB。
- 上限 100 个可见监控（仅创建/更新校验，读取不受限，避免已有页面 500）。
- 限流**无需新增**：全局 `ThrottlerGuard` 的 `default` 桶（`limit=10 / ttl=60s`，按 IP）已覆盖 `/api/status/:slug`。若压测发现同 NAT 访客偏紧，再评估为该路由单独放宽（产品决策，不在本次范围）。

## 8. 边界与错误

| 情形 | 期望行为 |
| --- | --- |
| slug 不存在 / `enabled=false` | 404（保持现状，不区分两者） |
| `tz` 非法 / 固定偏移 / 重复 / 空 | 400 |
| `tz` 缺失 | 用默认 `Asia/Shanghai` |
| 未知 query 参数 | 复用严格参数校验：400（前端不传 `days`，无影响） |
| 可见监控为空或全部被删除 | `monitors: []`，不存在 `availability` |
| 该监控 3 天内无 LOCAL 样本 | `cells: []`、`unavailableCells: []`、`worst: null` |
| 3 天窗口超出可靠保留起点 | 对应格进 `unavailableCells`，`history.status = TRUNCATED` |
| 监控中途被暂停/改类型 | 按 `check_logs` 真实记录出格，不因当前状态改变历史 |
| 监控所属项目缺 `monitoring_coverage` 行 | 由 trigger 保证不会发生；仍按 `max(asOf-90d)` 兜底，不抛 500 |

## 9. 与原提案的差异（必须按本文执行）

**9.1 §5.1 的"复用同一份分组结果"不成立。** `buildPublicMonitor` 的 `uptimePercent` 窗口不过滤 `source`（含 PROBE 行）、且是 24h 滑动窗口而非当地整点分桶，与热力图口径不同。改为两个独立聚合（各 1 条 SQL），保持 `uptimePercent` 数值语义不变。

**9.2 灰格口径已定。** 原提案 §4.6/§3.3 的口径保留（`unavailableCells` 仅表示历史不足），但 §8 验收清单第 2 条"未观测的小时显示灰格，与'历史不足'的灰格在提示文案上可区分"与前端现状冲突（前端只有一种灰格语义 `noData: '该小时没有检测数据'`，且未观测的小时根本不在两个数组里 → 渲染为空白）。**结论：未观测 = 空白，水位截断 = 灰格**，前端只改文案。

**9.3 `days` 格式。** 后端返回 `YYYY-MM-DD`（与 `monitoring/availability` 一致，因为复用其组装逻辑）；前端模拟数据用的是 `MM-DD` 且 yAxis 直接渲染，联调前需前端格式化（或确认由前端 `slice(5)`）。后端不为公开页定制日期格式。

**9.4 `history.status` 取值收敛。** 原提案列了 `AVAILABLE/EMPTY/TRUNCATED/UNAVAILABLE`，但 `availability()` 实际只产出 `AVAILABLE/TRUNCATED`（`monitoring-dashboard.service.ts:747`）。本次只返回这两种，`EMPTY` 由 `cells: []` 表达。

**9.5 §4.1 水位 join 修正。** 见 §6：不能用 `check_logs."projectId"`（可空）join 水位表，必须经 `monitors`。

**9.6 §7 的共用方式修正。** 不注入 `MonitoringDashboardService`（它会牵入 `AdminModule` / `SystemProbeScheduler` / `ProjectAccessService`，且 `cached()` 依赖 `AccessPrincipal`，匿名端点用不上）。改为抽无 DI 的纯函数 util（§10.1）。

**9.7 §7 的实体复用修正。** `MonitoringAvailabilityEntity` 的类型来自 `MonitoringDashboardService['availability']` 的返回类型（`monitoring-dashboard.entity.ts:19-25`），直接 import 会把 status-pages 的类型耦合到 monitoring service；且公开版是"每监控一份"。在 `status-pages/entities/` 独立定义（可参照 `monitoring-schemas.ts` 的 `@ApiSchema` 风格）。

**9.8 前端工作项补齐。** 原提案把 tz、days 格式、灰格文案都归到"前端不用做"。实际三项都需要前端改动（§10.2），且 `tz` 直接影响分桶正确性。

**9.9 §5.3 限流已满足。** 现状全局限流即按 IP，无需新增（§7.4）。

## 10. 交付范围

### 10.1 后端文件

| 文件 | 改动 |
| --- | --- |
| `src/common/dto/query-timezone.dto.ts`（新） | 把 `MonitoringTimezoneDto` 的 `tz` 字段与校验（`Intl` 规范化、拒绝固定偏移）抽为公共 DTO `QueryTimezoneDto` |
| `src/modules/monitoring/dto/query-monitoring.dto.ts` | 三个 DTO 改为 `extends QueryTimezoneDto`，删除本地 `tz` 定义 |
| `src/modules/monitoring/availability.util.ts`（新，纯函数） | 分桶 SQL 片段（`monitorId IN` + join `monitors`/`monitoring_coverage` 取水位）、`buildAvailabilityCells(rows, days, tz, asOf, waterByMonitor)`、页面级 `history.status` 判定；`monitoring-dashboard.service.ts` 的 `availability()` 改用同一份 util，行为不变 |
| `src/modules/status-pages/dto/query-public-status-page.dto.ts`（新） | `extends QueryTimezoneDto`，不开放 `days` |
| `src/modules/status-pages/entities/status-page.entity.ts` | `PublicStatusPageMonitorEntity` 增 `availability?`；新增 `PublicMonitorAvailabilityEntity`（Swagger） |
| `src/modules/status-pages/status-pages.service.ts` | `getPublicBySlug(slug, tz)`：只读事务 + `clock_timestamp()` 快照；`showUptime` 时 2 条批量聚合；`buildPublicAvailability(...)`；`uptimePercent` 改批量；可见监控上限校验 |
| `src/modules/status-pages/status-pages-public.controller.ts` | 加 `@Query()` DTO、`@SkipTransform()`、ETag 拦截器、Swagger 参数与 400/304 注解 |
| `src/modules/status-pages/public-status-etag.interceptor.ts`（新） | 严格参数校验（重复/空/未知 → 400）+ 匿名弱 ETag + 304，复用 `weakEtag`/`etagMatches` |
| `src/modules/status-pages/status-pages.module.ts` | 注册新拦截器（缓存服务由全局 `CacheModule` 提供） |
| `src/modules/status-pages/dto/create-status-page.dto.ts` / `update-status-page.dto.ts` | `visibleMonitorIds` 加 `@ArrayMaxSize(100)`；service 侧常量 `STATUS_PAGE_VISIBLE_MONITOR_LIMIT = 100` 兜底 |

不改：`prisma/schema.prisma`（索引已足够）、`monitoring-window.util.ts`（`localHourIntervals` 直接复用）、`monitoring-etag.interceptor.ts`（只导出复用，不改行为）。

### 10.2 前端工作项（`Beacon/beacon-vue3`，同期交付）

1. `src/api/modules/status-page.ts`：`getPublicStatusPage(slug, config)` 增加 `tz`，取 `Intl.DateTimeFormat().resolvedOptions().timeZone` 作为 query。
2. `src/components/status-pages/PublicMonitorAvailability.vue`：`days` 来自后端 `YYYY-MM-DD`，yAxis 标签与 `worst` 提示需格式化为 `MM-DD`（当前模拟数据是 `MM-DD`）。
3. `src/locales/status-page.zh-CN.ts` / `status-page.en-US.ts`：灰格文案改为"该小时历史数据不足"（`tip` 同步），明确"未观测的小时 = 空白"。
4. 联调时 `VITE_STATUS_PAGE_MOCK=0`（或删除模拟调用）。

### 10.3 实施顺序

1. 抽 `QueryTimezoneDto` + `availability.util.ts`，让 monitoring 现有测试全绿（先证明重构无行为变化）。
2. status-pages 侧 DTO / entity / 拦截器 / 缓存。
3. `getPublicBySlug` 接入聚合与快照，补单测。
4. e2e 与前端联调。

## 11. 验收测试矩阵

单测（jest，mock `PrismaService`，沿用 `status-pages.service.spec.ts` 的风格）：

| 用例 | 断言 |
| --- | --- |
| `showUptime = false` | 不调用聚合 SQL，响应无 `availability` |
| 无样本 | `cells: []`、`unavailableCells: []`、`worst: null`、`days` 仍为 3 天 |
| `worst` | 等于 `cells` 最小值；同值按日期、小时升序取第一格 |
| DST 回拨 | 同名小时合并成功数/总数后算一格（不用两段百分比平均） |
| DST 跳过 | 被跳过的小时无格、不进 `unavailableCells` |
| 水位截断 | 覆盖区间部分早于水位 → 整格进 `unavailableCells`，不与 `cells` 重叠 |
| 跨项目水位 | 不同项目的监控各按自己项目水位判断；页面级 `history` 取最差起点 |
| 上限 | 创建/更新超过 100 个可见监控 → 400；已有页面读取不受限 |
| 参数 | 非法 IANA / 固定偏移 / 重复 / 空 → 400；缺失 → `Asia/Shanghai` |

e2e（参照 `test/monitoring-dashboard.e2e-spec.ts` 的 HTTP + Postgres 模式，需 Docker Postgres；CI 只跑单测）：

| 用例 | 断言 |
| --- | --- |
| 逐格一致 | 对同一批 `check_logs` 直查 `GROUP BY monitorId, day, hour` 的结果与响应 `cells` 逐格相同 |
| 跨项目 | 状态页可见监控来自两个项目时，两侧数据都能出格 |
| `If-None-Match` | 命中返回 304 且无响应体；首次响应体与重放一致 |
| `enabled = false` / 不存在的 slug | 404 |

## 12. 明确不做

- 不做超过 3 天的趋势（要长期曲线另立需求，届时更适合新端点 + `range`）。
- 不在公开响应里返回检查明细、`error`、`lastError` 等内部字段。
- 不用日聚合表还原逐小时。
- 不为热力图新增鉴权端点：公开页必须匿名可用。
- 不重构 `monitoring-etag.interceptor.ts` 的现有行为，不为其抽象配置层。
- 不移除前端模拟数据文件（由前端侧单独清理）。

## 13. 已知风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 公开端点响应变重 | 72×N 格 + 每请求 2 条聚合 | 60s 缓存 + 弱 ETag + 100 监控上限；上线后观察 P95 |
| 跨项目聚合失去 `projectId` 过滤 | 索引改走 `(monitorId, checkedAt)`，扫描面变大 | 监控数上限 100、`days` 固定 3；压测后评估组合索引 |
| `tz` 未按访客时区传入 | 后端默认 `Asia/Shanghai`，海外访客看到错位分桶 | 前端同期交付 tz 传参；联调验收项 |
| 前端文案与后端口径错位 | 灰格可能被读成"没有检测数据" | §9.2 已定口径并列入前端工作项 |
| 与 `uptimePercent` 数值不同被当成 bug | 24h 滑动窗口比例 vs 逐小时比例 | 写入联调清单，不作为缺陷 |

## 14. 实施记录（2026-10-15，后端已完成）

后端已实现，并通过 CI 四项本地门禁（`pnpm type-check`、`pnpm lint:check`、`pnpm test`、`pnpm build`；单测 127 suites / 1699 tests 全绿）。与本文计划有两处实现层面的偏离，**口径不变**：

| 计划 | 实际实现 | 原因 |
| --- | --- | --- |
| §6：在聚合 SQL 里经 `monitors` join `monitoring_coverage` 取每项目水位 | SQL 只用窗口起点（`availabilityWindowStart`）作下界；水位在 JS 侧逐格判断（`buildAvailabilityGrid` 的 `availableFrom`） | 行为等价：水位晚于窗口起点时 SQL 多扫的只是空区间，格子截断仍按监控所属项目水位判定。避免 `GREATEST(timestamp, timestamptz)` 混用与额外一次 join |
| §4.1：页面级 `history` 取相关项目里最差的覆盖起点 | 每个监控的 `availability.history` 用它自己项目的 `reliableHistoryStart(checksStartedAt, asOf)` | 响应形状（§3.2）里没有页面级 history 字段，只有每监控一份；前端也只读这一份 |

计划未细化、但按计划方向落地的实现细节：

- `availability.util.ts` 额外导出 `reliableHistoryStart()`，与 `MonitoringDashboardService.coverage()` 的 `max(checksStartedAt, asOf - 90d)` 一致。
- 严格参数校验没有单独抽公共拦截器，而是与匿名 ETag 合并在 `status-pages/public-status-etag.interceptor.ts`；`weakEtag` / `etagMatches` 仍复用 monitoring 的纯函数，`monitoring-etag.interceptor.ts` 本身未改。
- `MonitoringDashboardService.availability()` 改为复用同一套 util，逐行等价；`monitoring-merge.spec.ts` 的 `$queryRaw` mock 因 production 改用 `$queryRaw(Prisma.sql)` 形式而同步支持两种调用形式（断言未变）。
- 可见监控上限走 DTO `@ArrayMaxSize(100)`（`STATUS_PAGE_VISIBLE_MONITOR_LIMIT`），service 侧 `validateVisibleMonitors` 兜底；读取不受限。

尚未完成：

- 既有 `test/monitoring-dashboard.e2e-spec.ts` 有 2 个**基线失败**（与本次改动无关）：其 fixture 未提供 `quotaService.monitorEligibility`（而 `src/modules/checker/checker.service.ts` 已调用 3 处），以及一处 `401 vs 403` 断言。本次未触及 `src/modules/checker`、`src/common/guards`、`src/shared/quota`、`src/modules/probes`。

## 15. e2e 与前端交付记录（2026-10-15，已完成）

e2e：

- 新增 `test/status-pages-availability.e2e-spec.ts`（9 个用例，全部通过）。运行方式：
  ```bash
  # 一次性：起本地 Postgres 并迁移
  docker run -d --name beacon-e2e-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
    -e POSTGRES_DB=beacon_dashboard_test -p 55432:5432 postgres:16-alpine
  DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/beacon_dashboard_test" pnpm exec prisma migrate deploy
  # 运行
  MONITORING_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/beacon_dashboard_test" \
    pnpm test:e2e -- status-pages-availability
  ```
- 覆盖：与原始 `check_logs` 的独立 JS 分桶逐格一致、跨项目水位（只截断缺历史的项目）、非 UTC 时区分桶（服务端 SQL 口径一致且不同于 UTC）、`If-None-Match` 304、固定偏移/未知/重复/空参数 400、未知 slug 404。

前端（`Beacon/beacon-vue3`）：

- `src/api/modules/status-page.ts`：`getPublicStatusPage` 现在传 `{ tz: visitorTimeZone() }`（`Intl` 解析访客 IANA 时区，取不到则省略参数）。
- `src/components/status-pages/PublicMonitorAvailability.vue`：新增 `shortDay()` / `dayLabels`，Y 轴、tooltip 与 `worst` 提示统一显示 `MM-DD`（后端返回完整日期）。
- `src/locales/status-page.{zh-CN,en-US}.ts`：灰格文案改为“历史数据不足 / Not enough history for this hour”，并说明空白格才是没有检测数据。
- 已通过该仓库的 `pnpm type-check` 与 `pnpm lint`。

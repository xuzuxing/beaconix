# 001：监控概览接口全量实现方案

> 状态：全量业务已实现并完成本地验收；目标环境待执行迁移。日期：2026-10-10。
>
> 后端基准：`D:/zuxcloud/nest-beacon`，提交 `b5c8273`。
> 前端基准：`D:/zuxcloud/Beacon/beacon-vue3`，提交 `1bb9903`。
> 原始提案：`D:/zuxcloud/Beacon/beacon-vue3/docs/monitoring-overview-api.md`。
>
> 本文是实施依据及验收契约。三个新端点已实现，原有 `monitoring/overview` 保持兼容；前端接口文档已同步。运行与迁移说明见 `docs/guides/monitoring-operations.md`，实测记录见 `plans/monitoring-overview/progress.md`。第 2 节保留实施前事实作为设计背景。

## 1. 目标与决策

一次交付概览页全部功能及其数据基础：三个端点、全部 KPI 和迷你趋势、热力图、状态码、监控分布、探针耗时、慢项、真实告警事件、历史数量与长窗口环比，以及前端接入和验证。不存在精简版、功能占位或另行排期的必需能力。

| 项目 | 调整后的决策 |
| --- | --- |
| 端点划分 | 保留 dashboard、availability、status-codes 三个端点 |
| 权限 | 目标项目所属组织的成员可读，不新增项目成员模型 |
| 统计样本 | 仅 `CheckLog.source = LOCAL`，不混入 PROBE 回调行 |
| 可用率 | LOCAL 轮次中最终 `success` 的比例，可包含探针救回 |
| 延迟 | 同一批 LOCAL 轮次的本地检查耗时，包含失败和超时样本 |
| 状态 | 增加 unknown，五种状态合计等于 total |
| 协议 | 按实际 HTTP/TCP 模型分类；SSL 是证书维度，不重复计为协议 |
| 告警事件 | 实现完整生命周期、结构化原因、恢复与真实投递关联 |
| 数量历史 | 实现生命周期/状态历史、数量环比和两条数量趋势 |
| 探针范围 | 本项目绑定租户探针与实际分配系统探针的去重集合，仅返回安全只读字段 |
| 探针窗口耗时 | 补齐 monitorId/项目归属，计算完整窗口平均检查耗时 |
| 数据保留 | CheckLog 和可归属 ProbeResult 保留 90 天，支撑两个完整 30d 窗口 |
| 前端接入 | 新增适配层，并补 nullable、空态和异步状态 |

优先级 P1，整体工作量 L，风险 HIGH（涉及状态、通知、迁移和探针协议）。只接受统一完成标准，不以部分端点可访问视为完成。工作量不是交付日期承诺。

全量指本页所有真实数据能力，不额外扩张为定时报表订阅、支付或新的 PING/DNS 检查器。HTTP/TCP 与 SSL 维度分离是纠正分类口径，不是功能分期。

## 2. 当前事实与兼容边界

### 2.1 后端

- `src/modules/monitoring/monitoring.controller.ts` 已有组织和项目 overview 路由。
- `src/modules/monitoring/monitoring.service.ts` 只实现当前快照及最近 24 小时可用率，不能直接当作任意窗口聚合。
- `src/common/guards/org-member.guard.ts` 从 projectId 解析组织，并检查组织成员身份；SUPER_ADMIN 提前绕过成员校验。
- `prisma/schema.prisma` 的 `MonitorType` 为 HTTP/TCP，`MonitorStatus` 包含 UNKNOWN。
- `src/modules/cron/jobs/monitor-data-cleanup.service.ts` 保留 CheckLog 30 天、ProbeExecution 7 天、ProbeResult 2 天。
- `ProbeResult` 没有 monitorId；`NotificationLog` 没有告警事件归属。
- `docs/archive/project-scoping-migration.md` 的边界继续成立：Monitor 属于项目，Probe/通知渠道仍是组织基础设施。
- `test/` 当前只有 `jest-e2e.json`，没有可直接复用的 e2e 测试文件。本次建立最小 HTTP/数据库测试入口，不能假定现成套件已经覆盖鉴权。

现有控制器模式，新增端点沿用：

```ts
@Get('projects/:projectId/monitoring/overview')
@UseGuards(OrgMemberGuard)
async getProjectOverview(@Param('projectId') projectId: string) {
    return this.monitoringService.getProjectOverview(projectId);
}
```

当前 `CheckerService.execute()` 的写入摘录：

```ts
success: result.success,
latency: result.latency,
localSuccess: localResult.success,
rescuedByProbe,
statusCode: result.statusCode ?? null,
```

探针救回分支返回的 `result` 不保留 statusCode。必须让 LOCAL 行保存 `localResult.statusCode ?? null`，但不能改变最终 success、规则求值或通知判定。PROBE 行不进入本方案检查统计。历史 statusCode 空值保留为空，不能按 expectedStatus 推断。

### 2.2 前端

- `src/config/monitoring.ts` 的 `MonitorTimeline` 是 labels 和多个平行数组，不是 API 的 points 数组。
- `src/components/monitor/MonitorAvailabilityPanel.vue` 使用 `heatmap.hours.map()` 和 `heatmap.worst`。
- `src/components/monitor/MonitorDetailPanel.vue` 使用 avgLatency、p95、uptime、trend、messageKey 等视图字段。
- `src/components/overview/LineChart.vue` 目前不支持 nullable 数据点，不能把 null 直接传入数值运算。

因此删除“页面与图表组件无需改动”和“前端已有完整空态”的假设。API 返回业务数据，适配层负责视图模型，组件负责缺失数据和状态渲染。

## 3. 通用契约

### 3.1 路由和鉴权

```text
GET /api/projects/:projectId/monitoring/dashboard
GET /api/projects/:projectId/monitoring/availability
GET /api/projects/:projectId/monitoring/status-codes
```

- JWT 必填；未认证为 401。
- 使用 OrgMemberGuard；所属组织的 OWNER/ADMIN/MEMBER/VIEWER 均可读，非成员为 403。
- 项目或所属组织不存在、已软删除时为 404。
- 服务层必须自行验证项目与组织存在，保证 SUPER_ADMIN 绕过成员守卫后仍得到正确的 404。
- 所有数据库查询均限定本项目，不接受客户端传入 organizationId 扩大范围。
- 当前可见监控集合定义为 `projectId` 匹配且 `deletedAt = null`，包含暂停项；用于当前状态、协议、探针和慢项候选集合。
- 项目历史检查、数量历史和最近事件按采集时的项目归属查询，包含现已软删除的监控；删除监控不得改写过去的项目指标。慢项榜只展示当前可见项，其统计基于自身窗口样本。
- 最近事件保留监控名称/目标快照及 monitorDeleted 标记；当前 alertingCount 只计当前可见监控的未恢复事件。
- 列表只选择必要字段；不得返回 secret、回调控制地址或其他租户的监控目标。

响应由现有 TransformInterceptor 包装：

```json
{
  "data": {},
  "meta": {
    "timestamp": "2026-10-10T10:32:00.000Z",
    "requestId": "request-id"
  }
}
```

`meta.timestamp` 是响应包装时间，不表示缓存数据的新鲜度。业务体使用 asOf 表示本次统计快照时间。

### 3.2 参数校验

| 接口 | 参数 | 默认值 | 合法范围 |
| --- | --- | --- | --- |
| dashboard | range | `1h` | `1h` / `today` / `7d` / `30d` |
| dashboard | slowLimit | 6 | 整数 1-20 |
| dashboard | alertLimit | 10 | 整数 1-50 |
| availability | days | 30 | 整数 1-30；含今天 |
| status-codes | hours | 12 | 整数 1-48 |
| 三个接口 | tz | `Asia/Shanghai` | 服务端时区实现支持的有效 IANA 时区名 |

非法枚举、空字符串、无效时区、非整数、NaN、越界或额外查询参数返回 400。使用 class-transformer/class-validator 和全局 ValidationPipe；拒绝多值参数，不能把 `6abc` 宽松解析成 6。tz 规范化后用于响应和缓存键，不接受固定偏移字符串代替 IANA 名称。

### 3.3 时间窗口和分桶

- 每个未命中缓存的请求只捕获一次 asOf；所有子查询共用。
- dashboard/status-codes 的 `to = asOf`；availability 的 from/to 是日期，另行换算查询时刻。数据库时间条件统一使用左闭右开区间。
- 内部比较、存储和排序使用 UTC 时刻；业务时间戳序列化为请求时区的 ISO 8601，保留偏移。
- 不改全局 meta.timestamp 的 UTC 格式。
- 所有自然日期边界共用 `startOfDate(tz, date)`：取属于该日期的最早有效时刻；午夜重复取较早一次，午夜不存在则取当天第一个有效时刻。不能假定每个日期都有 00:00。
- 若整个当地日期因时区跳变不存在，日期轴仍可保留该日期但不生成样本桶；today 的比较日期不存在时 previousFrom/previousTo=null，history.previous=UNAVAILABLE，所有对应 delta=null。

| range | 当前窗口 | timeline 间隔 | 最大点数 |
| --- | --- | --- | --- |
| 1h | 最近 3600 秒 | 2 分钟 | 31 |
| today | tz 下今日 00:00 到 to | 1 小时 | 26 |
| 7d | 最近 7 × 24 小时 | 6 小时 | 29 |
| 30d | 最近 30 × 24 小时 | 24 小时 | 31 |

滚动窗口的桶按 UTC epoch 对齐；today 的桶从当地今日起点按实际经过的一小时递增。首尾桶只统计与请求窗口的交集。`points[].time` 是桶起点，允许首桶起点略早于 from；`durationSeconds` 是交集的实际秒数。24 小时滚动桶不等同于当地自然日；自然日视图由 availability 提供。

today 可能因夏令时出现重复或缺失的当地小时，不能假定一天固定 24 小时。重复时刻通过 ISO 偏移区分，不能按展示文本去重。恰好午夜时可返回空 points。

### 3.4 环比

- 1h、7d、30d 比较紧邻当前窗口之前的等长窗口。
- today 比较“昨日当地 00:00 到昨日相同当地钟表时刻”，不是紧邻当前窗口的等长窗口。夏令时下两个窗口实际秒数可能不同；比较比例和均值，不比较原始检查量。
- 昨日同钟表时刻若重复，选较早的时刻；若不存在，按当地时钟跳变向后平移。使用成熟 IANA 时区实现，不手写地区偏移表。
- 今日、昨日及热力图首日边界都使用 startOfDate。若昨日目标时刻经消歧后仍不属于昨日，比较不可用，按 UNAVAILABLE 处理。
- 响应返回 previousFrom/previousTo，客户端不得自行猜测。
- 百分比 delta 是百分点差，如 99.90 - 99.80 = 0.10，不是相对增长率。
- 两个窗口都允许查询、且相应指标都有样本时才计算 delta；否则为 null。
- 先使用未舍入的聚合值求差，再舍入展示值，避免累计舍入误差。

### 3.5 保留期和空值

CheckLog 和带有可靠 monitorId/项目归属的 ProbeResult 保留 90 天，ProbeExecution 继续保留 7 天，因为它不是统计源。数量历史保留可覆盖 90 天窗口的记录及每个监控在边界之前最近一条基线；未恢复事件和未完成投递不能按普通历史清理。

history 同时返回 retentionDays=90 与检查、数量、探针、告警各自的可靠覆盖起点。`availableFrom = max(asOf-90×24h, checksStartedAt)`；数量、探针和告警使用对应独立水位。覆盖水位不是首条样本时间，也不是采集在线率保证。

检查窗口由 history.current/previous 表示；数量、探针、告警分别增加 countsCurrent/countsPrevious、probeCurrent/probePrevious、alertsCurrent/alertsPrevious，不能用检查日志的 EMPTY/TRUNCATED 代替其他维度的状态。数量覆盖完整且基线可用时为 AVAILABLE，即使已知数量为零。

对当前和比较窗口分别返回：

| history 状态 | 含义 | 指标规则 |
| --- | --- | --- |
| AVAILABLE | 整个窗口在保留范围内，且存在选定样本 | 计算真实指标 |
| EMPTY | 整个窗口在保留范围内，但没有选定样本 | 次数为 0；比例/延迟为 null |
| TRUNCATED | 任一部分早于该维度可靠覆盖起点 | 受影响指标为 null；不得用残存样本计算完整窗口环比 |
| UNAVAILABLE | 比较日期整体不存在或没有有效比较边界 | previousFrom/previousTo=null，delta=null |

TRUNCATED 的 dashboard 检查 KPI（含 totalChecks/failedChecks）为 null；直方图 buckets=[]、slowestMonitors=[]，由 history 明确区分历史不足与正常空态。timeline 保留时间网格，只有与检查水位相交或早于它的桶的检查计数/频率/比例/耗时为 null，覆盖完整的桶继续真实计算。数量趋势与探针耗时独立按各自水位处理；当前 summary 永远不受历史缺口影响。recentAlerts 可以返回水位之后的真实事件，但前端必须提示列表历史不完整。

1h/today/7d/30d 环比全部实现；具有覆盖两个窗口的数据时必须返回真实差值，不能对 30d 固定返回 null。上线时已被旧策略删除的数据无法恢复，覆盖不足按水位据实标注；这属于历史数据事实，不是允许延期实现的功能。

迁移回填只能使用现存且可证明归属/语义的数据，不能把保留期配置改成 90 就宣称已有 90 天历史。集成测试必须创建两个完整 30d 窗口的 fixture，验证成熟数据下所有环比可计算。

没有日志也可能是监控尚未创建、暂停、调度中断或没有观测，不能推断为 100% 可用或发生故障。计数 0 与未知 null 分别处理：

- 已知规模和实际观测次数：0 合法。
- 无样本的比例、延迟、delta：null。
- 告警数量是非负整数；没有未恢复事件时为 0。缺失模型或未接线不能以 null 通过验收。
- 所有区块均实现，不返回 capability=false 或 unsupported 占位；无记录列表为 []。
- API 的 number 不允许 NaN、Infinity 或 -Infinity。

## 4. 样本口径

三个接口的检查统计统一使用：

```text
CheckLog
WHERE source = LOCAL
  AND 项目归属 = 当前项目（历史查询包含现已软删除监控）
  AND checkedAt >= from
  AND checkedAt < to
```

LOCAL 表示一次本地检查所触发的判定记录；既包含计划检查，也包含手动检查，当前 CheckLog 不区分二者。不能宣称这是计划执行次数或全网探针执行量。

| 指标 | 计算方法 |
| --- | --- |
| totalChecks | 选定 LOCAL 行数 |
| failedChecks | success = false 的行数 |
| uptimePercent | 100 × success=true 行数 / totalChecks |
| failureRatePercent | 100 × failedChecks / totalChecks |
| avgLatencyMs | 全部选定 LOCAL 行 latency 的算术平均 |
| P50/P95/P99 | 全部选定 LOCAL 行 latency 的连续分位数 |
| 直方图 | 同一组 latency 样本，固定六档 |

- success 是探针辅助后的最终判定，不是 localSuccess，也不是 !ruleMatched。
- latency 仍是本地执行耗时，不是探针网络 RTT，也不是“仅成功响应的延迟”。失败和超时耗时纳入，前端文案应为检查耗时。
- uptime 与 failureRate 使用同一分母，展示值之和应在舍入误差内等于 100%。
- 存在规则异常但请求成功时，可用率可以保持正常；规则告警是另一维度。
- 分位数确定算法：升序样本 x，位置 `(n-1)*p`，相邻样本线性插值；最后四舍五入为整数毫秒。
- 不能对各监控的均值再做不加权均值，不能对各桶 P95 取平均作为全窗口 P95。
- 不从 PROBE 行补齐缺失桶，不把缺失检查当作失败。

## 5. 接口一：dashboard

```text
GET /api/projects/:projectId/monitoring/dashboard?range=1h&tz=Asia/Shanghai
```

### 5.1 空项目完整示例

本示例的项目已于当日 00:00 建立可靠空基线，所以两个小时窗口及数量变化均已知。没有样本的统计仍是 null；空项目的已知规模和净变化是 0。

```json
{
  "range": "1h",
  "tz": "Asia/Shanghai",
  "asOf": "2026-10-10T18:32:00+08:00",
  "from": "2026-10-10T17:32:00+08:00",
  "to": "2026-10-10T18:32:00+08:00",
  "previousFrom": "2026-10-10T16:32:00+08:00",
  "previousTo": "2026-10-10T17:32:00+08:00",
  "metricBasis": {
    "sampleSource": "LOCAL",
    "availability": "EFFECTIVE_SUCCESS",
    "latency": "LOCAL_DURATION"
  },
  "history": {
    "retentionDays": 90,
    "availableFrom": "2026-10-10T00:00:00+08:00",
    "countsAvailableFrom": "2026-10-10T00:00:00+08:00",
    "probeAvailableFrom": "2026-10-10T00:00:00+08:00",
    "alertsAvailableFrom": "2026-10-10T00:00:00+08:00",
    "current": "EMPTY",
    "previous": "EMPTY",
    "countsCurrent": "AVAILABLE",
    "countsPrevious": "AVAILABLE",
    "probeCurrent": "EMPTY",
    "probePrevious": "EMPTY",
    "alertsCurrent": "EMPTY",
    "alertsPrevious": "EMPTY"
  },
  "summary": {
    "monitors": {
      "total": 0,
      "up": 0,
      "down": 0,
      "degraded": 0,
      "paused": 0,
      "unknown": 0
    },
    "probes": { "scope": "PROJECT_ASSIGNED", "total": 0, "online": 0 },
    "alertingCount": 0,
    "sslExpiringCount": 0,
    "expiringCertificates": []
  },
  "kpis": {
    "totalChecks": 0,
    "failedChecks": 0,
    "uptimePercent": null,
    "uptimeDeltaPercent": null,
    "avgLatencyMs": null,
    "avgLatencyDeltaMs": null,
    "p95LatencyMs": null,
    "p95LatencyDeltaMs": null,
    "failureRatePercent": null,
    "failureRateDeltaPercent": null,
    "monitorCount": 0,
    "monitorDelta": 0,
    "failingCount": 0,
    "failingDelta": 0
  },
  "timeline": { "interval": "2m", "points": [] },
  "sparklines": {
    "uptime": [],
    "avgLatency": [],
    "p95Latency": [],
    "failureRate": [],
    "monitorCount": [],
    "failing": []
  },
  "distribution": {
    "protocols": [],
    "probes": [],
    "latencyHistogram": { "unit": "ms", "buckets": [] }
  },
  "slowestMonitors": [],
  "recentAlerts": []
}
```

### 5.2 summary：当前快照，不随 range 切换

| 字段 | 类型 | 定义 |
| --- | --- | --- |
| monitors.total | integer | 当前可见监控项数，含暂停 |
| up/down/degraded/paused/unknown | integer | enabled=false 归 paused；enabled=true 且无状态或状态 UNKNOWN/PAUSED 归 unknown；其他按 state.status |
| probes.scope | literal | 固定 PROJECT_ASSIGNED |
| probes.total | integer | 当前可见监控绑定的同组织 TENANT 探针与实际分配 SYSTEM 探针去重数量 |
| probes.online | integer | 上述探针中 enabled=true 且 status=ONLINE 的数量 |
| alertingCount | integer | 当前可见监控的未恢复事件数，包含多种 kind，不受 range 和 alertLimit 限制 |
| sslExpiringCount | integer | checkSsl=true 且 sslExpiresAt 位于 `(asOf, asOf+30d]` 的监控项数 |
| expiringCertificates | array | 上述监控按到期时间升序，最多三条，稳定次序以 monitorId 破同值 |

五种状态之和必须等于 total。SSL 按监控项计数，不宣称按唯一物理证书去重；同主机多个监控可分别计数。已过期证书不计“即将到期”，通过 SSL 告警事件展示。30 天固定展示窗口与每个监控的告警阈值无关。

证书条目：`{ monitorId, host, expiresAt, daysLeft, issuer }`。daysLeft 根据 sslExpiresAt 和 asOf 重新计算并向上取整，不直接读取可能过期的 sslDaysRemaining；issuer 可为 null。host 从 HTTP 目标解析，只返回主机名。

### 5.3 kpis：窗口指标与当前规模

- totalChecks、failedChecks 在检查窗口完整时为非负整数，EMPTY 时为 0，TRUNCATED 时为 null。
- uptimePercent、failureRatePercent、avgLatencyMs、p95LatencyMs 及四个对应 delta 为 number|null。
- monitorCount 恒等于 summary.monitors.total；failingCount 恒等于 down+degraded。
- monitorDelta、failingDelta 均实现，只有 from 时点早于可靠数量历史起点时才返回 null。
- 数量 delta 定义为“to 时点数量减去 from 时点数量”，是窗口净变化，不是新增次数，也不是前后两个窗口的均值之差。
- 数量时点必须包含创建、删除、恢复、暂停和状态变化的真实历史；不能通过 updatedAt 或当前 deletedAt 倒推。

### 5.4 timeline

每个 point：

| 字段 | 类型 | 定义 |
| --- | --- | --- |
| time | string | 桶起点，ISO 8601 带偏移 |
| durationSeconds | number | 桶与请求窗口交集的秒数，必须 > 0 |
| checks | integer or null | 桶内实际 LOCAL 检查次数，单位“次”；桶受检查水位截断时 null |
| checksPerMinute | number or null | checks × 60 / durationSeconds，保留两位小数；checks=null 时 null |
| failures | integer or null | 桶内 success=false 次数；桶受检查水位截断时 null |
| avgLatencyMs | number or null | 同桶 LOCAL 耗时算术平均，供平均耗时迷你趋势使用 |
| latencyP50Ms/P95Ms/P99Ms | number or null | 同桶 LOCAL 耗时分位数 |
| uptimePercent | number or null | 同桶最终成功比例 |
| monitorCount | integer or null | 该桶与窗口交集终点的可见监控数量；早于数量水位则 null |
| failingCount | integer or null | 同一时点处于 DOWN/DEGRADED 的可见监控数量 |

时间升序，每桶最多一个 point。项目当前或已知历史中曾有监控时返回覆盖整个窗口的桶；完整且无观测的桶 checks/failures/checksPerMinute 为 0，延迟和可用率为 null，受历史截断的桶按第 3.5 节为 null。数量来自真实历史，不因没有检查而归零。只有可靠历史证明项目从未有监控或零长度窗口时 points=[]；水位不足时不能以当前没有监控推断“从未有过”，仍返回网格表达缺失。

前端“检查频率”图使用 checksPerMinute；失败次数图使用 failures。两者单位不同，不直接叠加成同一计数。

### 5.5 sparklines（六项全部实现）

固定返回 uptime、avgLatency、p95Latency、failureRate、monitorCount、failing 六个 `(number|null)[]`，与 timeline.points 等长、同序，禁止省略任意一项。

前三项分别来自桶的 uptimePercent/avgLatencyMs/latencyP95Ms；failureRate=100×failures/checks，checks=0/null 时 null。两个数量趋势来自同桶终点的历史快照。failureRate 始终是百分比，不是失败次数，avgLatency 不能拿 P50 改名。

数量基线之前的点为 null，基线之后必须完整计算。不能复制当前数量生成平坦历史曲线；无检查但数量已知时，数量趋势仍有数值。

### 5.6 distribution

协议分布：

- `protocols: Array<{type: 'HTTP'|'TCP', count: number}>`。
- 只返回当前集合中实际存在的协议，按 HTTP、TCP 顺序；计数之和等于 monitors.total。
- 不返回虚构的 PING/DNS/SSL 分类；新增协议需另行实现检查器、模型和前端能力。

探针分布：

- `probes: Array<{id, scope, name, region, enabled, online, latencyMs}>`。
- 与 summary.probes 完全同一集合，按 name、id 稳定排序。
- region 是数据库原始字符串，不限制为八个城市。前端维护展示映射，未知值显示原始 region；不能报错或静默改成其他地区。
- online 定义与 summary 一致；latencyMs 必须按可靠归属的探针观测计算窗口算术平均，不叫网络 RTT。离线、无样本或窗口早于探针覆盖起点时为 null；不能因未接入而固定返回 null。
- SYSTEM 行只公开 id/scope/region 和由地区生成的展示名，不公开内部名称、callbackUrl、密钥、容量、其他租户的绑定或负载。监控只读视图不复用管理员 ProbeEntity，也不开放系统探针管理权限。
- 不通过 target 关联共享系统探针的跨项目历史，不泄漏其他项目目标。

耗时直方图：

- 全部选定 LOCAL 耗时样本按 `[0,100)`、`[100,200)`、`[200,300)`、`[300,500)`、`[500,1000)`、`[1000,+∞)` 分桶。
- 格式 `Array<{from: number, to: number|null, count: number}>`。
- 有样本时固定返回六档，无命中档 count=0，所有 count 之和等于 totalChecks。
- 完全无样本时 buckets=[]；不能用六档零柱表示已有测量。

### 5.7 slowestMonitors

条目格式：

```ts
type SlowMonitor = {
    id: string;
    name: string;
    target: string;
    type: 'HTTP' | 'TCP';
    avgLatencyMs: number;
    p95LatencyMs: number;
    uptimePercent: number;
    sparkline: Array<number | null>;
};
```

仅返回当前可见且窗口内存在 LOCAL 样本的监控；暂停项如有窗口历史也可入榜。均值降序，id 升序破同值，最多 slowLimit 条。先按未舍入均值排序再格式化。聚合所有监控后取 top N，不能先截取日志再排名。

每项固定返回 sparkline，使用 timeline 相同时间网格表示每桶平均耗时，空桶 null；不能每项各选不同数量的非空样本点。

### 5.8 recentAlerts：真实告警事件

必须实现真实事件存储与生命周期。recentAlerts=[] 仅表示本窗口确实没有已记录事件，不能表示模块未实现；历史覆盖起点通过 history.alertsAvailableFrom 声明，不能把当前 DOWN 列表冒充事件历史。

事件条目：

```ts
type AlertEvent = {
    id: string;
    monitorId: string;
    monitorName: string;
    target: string;
    monitorDeleted: boolean;
    kind: 'CONNECTIVITY' | 'AVAILABILITY' | 'SSL';
    level: 'critical' | 'warning';
    status: 'ongoing' | 'resolved';
    suppressedReason: 'PAUSED' | 'DELETED' | 'CONFIG_DISABLED' | null;
    reason: 'TIMEOUT' | 'STATUS_MISMATCH' | 'CONNECTION_REFUSED'
        | 'SLOW_RESPONSE' | 'AVAILABILITY_LOW' | 'RULE_MATCHED'
        | 'SSL_EXPIRING' | 'SSL_INVALID' | 'CHECK_FAILED';
    threshold: number | null;
    actual: number | null;
    unit: 'ms' | 'percent' | 'days' | 'statusCode' | null;
    message: string | null;
    startedAt: string;
    resolvedAt: string | null;
    updatedAt: string;
    durationSeconds: number | null;
    notified: boolean;
};
```

- 一条记录表示一次告警生命周期，不是一次通知投递。同一 monitor+kind 最多一个 ongoing 事件；重复命中更新同一事件。
- 暂停、删除或关闭该类告警配置只抑制通知，suppressedReason 如实标记，不伪造 resolved；恢复检查后按新证据决定继续或恢复。已删除项不计当前 alertingCount，暂停的当前可见项仍可有未恢复事件。
- 恢复更新原记录的 status/resolvedAt/durationSeconds，保留最初 reason 和 level。RECOVERED 不再作为原因，recovered 不再作为持久化严重级别。
- 未恢复时 resolvedAt/durationSeconds 为 null；恢复时 durationSeconds 是非负整数。UI 可由秒数换算分钟。
- 若 UI 需要恢复的绿色标签，由 status=resolved 映射，不修改原始严重级别。
- CONNECTIVITY、AVAILABILITY、SSL 的触发、恢复、暂停及并发写入规则见第 10 节，必须一起落地，不能仅凭字符串猜测。
- 不为未实现的 PING 生成 PACKET_LOSS 事件。SLOW_RESPONSE/RULE_MATCHED 必须由规则求值提供结构化证据；无法分类时用 CHECK_FAILED 与安全纯文本 message。
- notified 表示该事件至少一次真实成功投递，不表示入队成功。通知日志/队列任务必须携带事件 ID；历史无事件归属的发送记录不能推断关联。
- alertingCount 是当前可见集合所有 ongoing 事件数，不受 range/alertLimit 限制，也不等于 failingCount。
- recentAlerts 取 updatedAt 位于 `[from,to)` 的事件，按 updatedAt 降序、id 升序，最多 alertLimit。持续更早且窗口内无更新的事件仍计入 alertingCount，但不进入最近列表。
- 事件保留 monitorName/target 快照；历史查询包含同项目已软删除监控，并设置 monitorDeleted=true。不能跨项目或组织返回事件。

## 6. 接口二：availability

```text
GET /api/projects/:projectId/monitoring/availability?days=30&tz=Asia/Shanghai
```

返回过去 days 个当地自然日期，含今天。from/to 是日期范围，两端均包含；当日只统计到 asOf，未来小时不返回格子。

以下为 `days=3` 的完整形状示例，UI 默认仍为 30：

```json
{
  "tz": "Asia/Shanghai",
  "asOf": "2026-10-10T18:32:00+08:00",
  "from": "2026-10-08",
  "to": "2026-10-10",
  "history": {
    "retentionDays": 90,
    "availableFrom": "2026-07-12T18:32:00+08:00",
    "status": "AVAILABLE"
  },
  "hours": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
  "days": ["2026-10-08", "2026-10-09", "2026-10-10"],
  "cells": [[0, 0, 100], [1, 0, 75], [18, 2, 50]],
  "unavailableCells": [],
  "worst": { "day": "2026-10-10", "hour": 18, "value": 50 }
}
```

- hours 改为固定 0-23 的数组，直接适配现有组件；不再返回数字 24。
- days 升序、长度等于请求 days，即使没有监控也保留完整日期轴。
- cells 是 `[hourIndex, dayIndex, uptimePercent]`，按 dayIndex、hourIndex 升序。
- 将选定 LOCAL 样本转为 tz 下的当地日期与小时后分组，按成功数/总数计算；没有样本不返回该格，不能填 0 或 100。
- 夏令时回拨的两个同名小时合并成功数和总数，再算一个格子；跳过的小时不返回格子。不要先平均两段百分比。
- 使用与 dashboard 相同的 90 天保留期及可靠检查起点。成熟数据下 30 个当地自然日（包括夏令时回拨）必须完整可查询；新安装或历史数据确实不足时 history.status=TRUNCATED，否则 AVAILABLE。这里 AVAILABLE 只表示覆盖可查询，是否有观测看 cells。
- 对每个真实存在且已开始的当地小时，检查其截至 asOf 的全部时刻区间；如果任何部分早于 availableFrom，整个格子省略，并在 unavailableCells 中返回 `[hourIndex, dayIndex]`。重复小时合并格子也按全部区间检查，不能仅算剩余的一次。
- unavailableCells 与 cells 不重叠；无观测、未来小时、时钟跳过的小时不加入 unavailableCells。前端据此区分“历史已不足”和“没有观测”，不能将清理前残留旧行用于补格。
- worst 从实际 cells 中取最小可用率；同值按日期、小时升序选第一格。没有 cells 时 worst=null，前端隐藏提示。
- 最大 720 个格子。不能用只有“每日可用率”的日聚合表还原逐小时热力图。

## 7. 接口三：status-codes

```text
GET /api/projects/:projectId/monitoring/status-codes?hours=12&tz=Asia/Shanghai
```

定义为“最近 hours 个 UTC 小时桶，含当前未完成桶”，不再模糊称作严格最近 hours 小时。tz 用于展示时间戳；分桶统一 UTC，非整小时偏移地区的标签可能为当地 `:30` 或 `:45`，这是预期行为。

- `to=asOf`。
- `currentHourStart` 为 to 所在 UTC 小时的起点。
- `from=currentHourStart-(hours-1)×1h`。
- 默认 12 桶，在上海 18:32 请求时覆盖 07:00 到 18:32。
- 仅统计采集时 monitorType=HTTP 的 LOCAL 行；记录采集时协议，避免监控改类型后把过去 HTTP 记录当 TCP。无法可靠回填协议的旧行不猜测，响应增加 unclassifiedChecks 记录其数量。

以下为 `hours=3`、窗口内有 HTTP 记录的示例：

```json
{
  "tz": "Asia/Shanghai",
  "asOf": "2026-10-10T18:32:00+08:00",
  "from": "2026-10-10T16:00:00+08:00",
  "to": "2026-10-10T18:32:00+08:00",
  "history": {
    "retentionDays": 90,
    "availableFrom": "2026-07-12T18:32:00+08:00",
    "status": "AVAILABLE"
  },
  "unclassifiedChecks": 0,
  "unavailableBuckets": [],
  "buckets": [
    { "time": "2026-10-10T16:00:00+08:00", "httpChecks": 4, "success2xx": 2, "redirect3xx": 0, "clientError4xx": 1, "serverError5xx": 0, "otherStatusCode": 0, "noStatusCode": 1 },
    { "time": "2026-10-10T17:00:00+08:00", "httpChecks": 0, "success2xx": 0, "redirect3xx": 0, "clientError4xx": 0, "serverError5xx": 0, "otherStatusCode": 0, "noStatusCode": 0 },
    { "time": "2026-10-10T18:00:00+08:00", "httpChecks": 3, "success2xx": 1, "redirect3xx": 1, "clientError4xx": 0, "serverError5xx": 1, "otherStatusCode": 0, "noStatusCode": 0 }
  ]
}
```

- 窗口完整且有 HTTP 检查记录时固定返回 hours 桶，时间升序、所有计数为非负整数，缺失桶补零。
- 整个窗口没有 HTTP 检查记录时 buckets=[]；有 HTTP 监控但未检查同样为空。
- noStatusCode 包含超时、连接错误和历史未记录状态码，不能把它当 5xx。
- otherStatusCode 包含不在 2xx-5xx 四档中的非空记录，不把它混入业务成功次数。
- 每桶四类状态码 + otherStatusCode + noStatusCode = httpChecks。
- 字段 success2xx 保留原命名，但仅表示 2xx 计数；预期 302 的监控可能成功且落在 3xx，不能用此字段替代 uptime。
- 历史已丢失状态码的行进入 noStatusCode，不能猜测实际值。
- history.status 与热力图一样表示窗口是否被可靠检查覆盖；TRUNCATED 时省略受截断的桶，unavailableBuckets 必填并返回这些桶的起点，当前未闭合桶只判断其截至 asOf 的交集。未截断部分有 HTTP 样本时，对所有完整可查桶补零；未截断部分没有 HTTP 样本时 buckets=[]。unclassifiedChecks 是完整可查桶内采集协议未知的 LOCAL 行数，不声称覆盖缺失的历史。

## 8. 前端接入方案

组件不能继续读取 mock 单例。由 DashboardView 或页面 composable 发请求，适配后通过 props/composable 状态传给区块；所有区块都必须接通。

| 区块 | 适配规则 |
| --- | --- |
| SummaryStrip | 新增 unknown；展示真实当前告警、项目参与探针和 SSL 信息；证书 issuer 可空 |
| KpiGrid | 原始数字转展示值；null 为缺失态；delta=null 时隐藏涨跌标签 |
| 数据概览/TrendCharts | points 转 labels/平行数组；检查频率使用 checksPerMinute；平均耗时趋势使用 avgLatencyMs，不拿 P50 替代 |
| AvailabilityPanel | 使用 hours 数组；worst=null 时隐藏提示；无 cells 时显示空态；unavailableCells 单独标记历史不足 |
| StatusCodes | buckets 转 labels/success/redirect/clientError/serverError；展示无状态码、其他状态码、未分类检查和历史不足，不能让未知数据静默消失 |
| DistributionCharts | HTTP/TCP；租户与系统探针只读展示；未知 region 兜底；真实延迟为空时显示缺失态 |
| DetailPanel 慢项 | avgLatencyMs→avgLatency，p95LatencyMs→p95，uptimePercent→uptime，sparkline→trend |
| DetailPanel 告警 | reason→参数化 i18n；未知原因回退纯文本 message；resolved 映射恢复样式 |

必须处理：

1. 处理 loading、error、empty 和历史覆盖不足，不出现 unsupported 功能占位；不能把请求失败降级成零或 mock。
2. `LineChart`/`MiniTrend` nullable 点形成断线，不参与 Math.min/Math.max，不把 null 转为 0；全部缺失时显示空态。
3. 空数组不调用无默认值的 Math.max；toFixed 前检查 number。
4. range/tz/项目切换取消旧请求或用请求序号丢弃旧响应，防止数据串项目。
5. range 切换只重新加载 dashboard；热力图和状态码按项目、tz、各自参数加载。
6. 时间按响应 tz 格式化，不能默认浏览器时区；重复小时保留偏移用于 tooltip。
7. 数据型 mock 移除线上依赖；只保留开发演示或测试 fixture。

完成适配层自动化断言、类型检查、构建和浏览器验收。优先用现有工具或 Node 内置测试能力验证纯函数；新增测试依赖必须必要且明确，不能因此省略覆盖。

## 9. 缓存、查询与一致性

### 9.1 缓存

- dashboard 整包 TTL 30 秒；避免把“当前状态”随 30d 历史数据缓存五分钟。
- availability TTL 5 分钟；status-codes TTL 60 秒，包含当前桶。
- 缓存业务体必须保留原 asOf/from/to；缓存命中不重新标成当前时间。
- 缓存键包含契约版本、projectId、规范化 tz、range/days/hours、slowLimit、alertLimit。
- 成员校验和项目存在检查先于缓存读取，成员移除后不能从共享缓存继续读取。
- Redis 不可用时复用现有缓存服务的降级能力；数据库查询失败仍返回错误，不用空数据伪装成功。
- HTTP 使用 `Cache-Control: private, no-cache`，不允许公共共享缓存敏感监控数据。
- 三个端点实现 ETag/If-None-Match：基于稳定业务快照生成弱标签 `W/"..."`，不能把每次变化的 meta.timestamp/requestId 纳入比较，也不能在包装体仍会变化时宣称字节一致的强标签；304 不带 JSON 包装体。条件请求仍先完成认证和项目校验，覆盖标签列表、弱比较和 `*`。

### 9.2 查询

- 使用现有 PrismaService；不增加 repository 层，不把 Prisma 查询放到控制器。
- 使用参数化数据库聚合处理 count/avg/分位数/时间桶；禁止把用户输入拼入 SQL 标识符或片段。
- 可以有固定数量的状态、窗口、慢项、探针查询，不要求强行一条 SQL 包含所有内容。
- 禁止逐监控查询历史；慢项趋势仅对 top N 批量查询。
- 全窗口分位数从选定样本计算，不从 timeline 已计算分位数回算。
- 同一请求使用同一 asOf 和当前监控集合；严格跨查询快照一致性如有必要，用短只读事务实现，不持锁等待外部服务。
- 增加本次历史/探针/事件查询必需索引，Prisma migration 与生成客户端同步提交；使用代表性数据的 EXPLAIN 验证，不凭响应点数推断扫描成本。
- ≤60 个时间点和约 50KB 响应是响应目标，不是数据库成本保证。发布前记录数据库行数、执行计划及冷/热缓存耗时。

## 10. 一次完整交付的实施范围

下列任务只有工程依赖顺序，不对应独立版本或部分上线。数据库、写入链路、三个端点、Agent/SCF、通知和前端必须全部接通并通过第 11、12 节后才能交付。

### 10.1 文件范围与现场核对

两个仓库均有用户未提交修改。先分别记录 `git status --short`、`git rev-parse --short HEAD` 和相关文件 diff；再运行基准漂移检查：

```text
git diff --stat b5c8273..HEAD -- prisma src/modules/monitoring src/modules/checker src/modules/state src/modules/monitors src/modules/probes src/modules/notifier src/modules/cron src/modules/admin/system-probes probes
git diff --stat 1bb9903..HEAD -- src/api src/config/monitoring.ts src/views/DashboardView.vue src/components/monitor src/components/overview/LineChart.vue src/components/charts/MiniTrend.vue src/composables src/utils src/locales docs/monitoring-overview-api.md
```

第二条在前端仓库执行；提交间 diff 不包含工作区改动，必须同时读取未提交 diff。仅在用户要求时建分支，默认 `codex/monitoring-dashboard`；不自动提交、推送、部署或清空数据库。

| 仓库与目录 | 本次允许变更 |
| --- | --- |
| 后端 `prisma/schema.prisma`、`prisma/migrations/*`、`src/generated/prisma/*` | 历史、事件、投递、数据归属模型及生成客户端；只能新增 migration，不改已执行迁移 |
| 后端 `src/modules/monitoring/*` | 三接口 DTO/Entity/控制器/服务/时区工具/缓存/ETag 与测试 |
| 后端 `src/modules/state/*`、`src/modules/monitors/*` | 监控状态及生命周期事务写入历史 |
| 后端 `src/modules/projects/*`、`src/modules/organizations/organizations.service.ts` 及对应测试 | 仅项目创建和 onboarding 创建项目时建立覆盖水位/空数量基线，保持原事务与幂等 |
| 后端 `src/modules/checker/*`、`src/modules/rules/*` | LOCAL 状态码和采集快照、结构化检查/规则证据、告警接线及测试；规则布尔判定保持兼容 |
| 后端新建 `src/modules/monitoring-history/*`、`src/modules/alert-events/*` | 历史服务、覆盖水位、告警生命周期服务及测试 |
| 后端 `src/modules/probes/*`、`src/modules/admin/system-probes/*` | 已授权 monitorId 上报、结果幂等归属、批量只读分配查询及测试；不重做凭据注册 |
| 后端 `src/modules/notifier/*`、`src/modules/cron/*` | 事件关联、数据库投递 outbox、重试扫描、保留清理及测试 |
| 后端 `test/*`、`src/app.module.ts`、相关模块接线 | 隔离 HTTP/数据库集成测试及必要依赖注册 |
| 后端 `probes/agent/src/*`、`probes/agent/functions/scf.js`、`probes/agent/test/*` | 实际 Agent/SCF 上报链路及契约测试；旧 `scripts/probe-agent*.js` 已删除，不恢复旧实现 |
| 前端 API/页面/图表 | `src/api/modules/monitor.ts`、`src/api/types.ts`、`src/config/monitoring.ts`、`src/views/DashboardView.vue`、`src/components/monitor/*`、`src/components/overview/LineChart.vue`、`src/components/charts/MiniTrend.vue`、`src/locales/zh-CN.ts`、`src/locales/en-US.ts` |
| 前端新增文件 | `src/composables/useMonitoringDashboard.ts`、`src/utils/monitoring-adapter.ts`、`src/utils/monitoring-request-state.ts`（仅请求隔离/304 状态纯函数）、`test/monitoring-adapter.test.mjs`、`test/monitoring-request-state.test.mjs` |
| 两边文档/必要依赖 | 前端 `docs/monitoring-overview-api.md` 同步本契约；后端 `docs/proposals/monitoring-reports.md` 只修正共用事件/保留口径；本方案、Agent 协议文档、必要的时区/测试依赖和锁文件 |

沿用薄控制器、PrismaService、四空格/单引号、Swagger 和组织权限模式。参考 `monitoring.controller.ts`、`monitoring.service.spec.ts`、`state.service.spec.ts`、`notifications.processor.spec.ts`。时间工具仅服务本功能，不建立无关全局框架。计费、OAuth、探针注册/密钥生命周期、全新协议检查器、定时报表订阅和原 overview 公共字段不在范围。

### 10.2 必需数据模型与索引

| 模型 | 必需字段与约束 |
| --- | --- |
| Monitor 扩展 | configRevision 在影响检查语义/启用状态的配置修改时原子递增；historyRevision 为独立递增历史序号，不能混用；心跳任务携带 configRevision 以识别迟到报告 |
| MonitorState 扩展 | lastAppliedObservationAt/Id 保证状态应用不倒退；connectivityFailCount 专门记录有效连接/服务失败证据的连续次数，不能用证书失败次数替代 |
| CheckLog 扩展 | 写入时快照 organizationId/projectId/monitorType；LOCAL 原始 statusCode；新增写入必须有归属和协议，旧协议不可证明时 nullable；索引 `(projectId,source,checkedAt)`、`(projectId,source,monitorType,checkedAt)`，保留 `(monitorId,checkedAt)` |
| ProbeResult 扩展 | 已验证 monitorId、organizationId/projectId、采集时类型、configRevision、reportId、receivedAt、原始探针身份快照及规范化 payloadHash；`(原始探针身份,reportId)` 唯一；索引 `(projectId,monitorId,checkedAt)`、`(projectId,原始探针身份,checkedAt)` |
| MonitorHistory 新建 | monitorId、organizationId/projectId、enabled、deleted、归一化 status、effectiveAt、单监控递增 revision、cause；`(monitorId,revision)` 唯一；索引 `(projectId,effectiveAt)`、`(monitorId,effectiveAt,revision)` |
| MonitoringCoverage 新建 | 每项目一条，记录 checksStartedAt/countsStartedAt/probeStartedAt/alertsStartedAt、初始化版本；记录可靠采集开始而非首条样本；各维度独立、持久化且不能被缓存时间替代 |
| AlertEvent 新建 | 第 5.8 节全部字段、organizationId/projectId、监控名/目标快照、origin（OBSERVED/BASELINE）、latestEvidence、firstNotifiedAt、lifecycleRevision、updatedAt；ongoing 的 `(monitorId,kind)` PostgreSQL 部分唯一索引；索引 `(projectId,updatedAt,id)`、`(projectId,status)` |
| AlertDelivery 新建 | 同时作为 durable outbox：eventId、eventRevision、phase（OPEN/RECOVERY）、channelId、payload 快照、status（PENDING/QUEUED/SENDING/SUCCESS/FAILED/SKIPPED）、attempts、nextAttemptAt、leaseUntil、deliveredAt、lastError；`(eventId,eventRevision,phase,channelId)` 唯一，索引 `(status,nextAttemptAt)` |
| NotificationLog 扩展 | eventId/deliveryId/phase/attempt；真实发送尝试关联投递和事件；历史旧日志允许无关联，禁止事后猜测 |

MonitorHistory 的 effectiveAt 使用数据库实际应用状态的时间，checkedAt 仍表示样本观测时间，不能将迟到上报倒写成过去的数量状态。相同时刻按 revision 排序。数量快照取 t 之前最后一条历史（`effectiveAt < t`），与 `[from,to)` 口径一致；新建、删除、恢复、暂停、启用状态变化及状态机迁移都必须记载。修改名称等不影响数量的操作不强制新增同值记录。

初始化基线是唯一边界例外：countsStartedAt 表示已经确认的存量快照，该 BASELINE 在 `t == countsStartedAt` 时也有效；普通迁移仍采用 `< t`。数量查询先载入适用的基线/anchor，再应用 `[countsStartedAt,t)` 的状态变化。新项目基线是已知空集合；迁移项目基线包含全部存量监控，不能将这些监控计为迁移时新增。测试必须包含 `from == countsStartedAt`、非空存量与同刻普通变化的稳定 revision 顺序。

监控当前状态按 enabled 优先归一化为 PAUSED/UNKNOWN/UP/DOWN/DEGRADED。删除历史记录 deleted=true，而不是把历史状态改成“已恢复”。保留每监控在 90 天边界前最近一条 anchor，包含已删除对象的锚点。

历史快照不能随 Monitor、Probe 或通知渠道删除级联消失。涉及物理删除的关系改为 nullable live reference + 不可变 ID/归属快照，live reference 使用 SetNull；查询和去重以快照身份为准。组织/项目软删除后仍拒绝读取；组织永久注销的数据销毁政策不在本次扩张。通知渠道删除后的待投递行转 SKIPPED，成功事实和事件 notified 不能被删除渠道抹去。

与 `docs/proposals/monitoring-reports.md` 的 MonitorIncident 统一：CONNECTIVITY AlertEvent 是唯一故障生命周期来源，将文档中的后续报表读取指向该来源，不创建另一套独立写入的故障历史。

### 10.3 写入链路、迁移与保留

1. 新建可重跑 migration，增加字段/表/索引、为现存监控建立迁移时点历史基线。初始数量历史不能回填到 createdAt；此前暂停/恢复/状态变化不可由当前状态推断。新项目创建时建立已知空基线，监控服务作为补偿入口，首次 dashboard 读取不得代替持续采集初始化。
2. 检查归属可在证明 Monitor 从未跨项目迁移的前提下按 monitorId 回填，包含软删除项；采集时协议只有存在实际历史证据才能回填，不能直接使用当前 Monitor.type。无法分类的行供通用延迟/可用率使用，状态码接口计 unclassifiedChecks。已被清理的数据不恢复、不补零。
3. 旧 ProbeResult 只在能证明采集时绑定、授权与唯一监控身份时回填；仅当前 target 相同不构成证明。无法证明的旧行不进入项目聚合，probeStartedAt 取可靠新链路启用时刻。历史 NotificationLog 不反推事件。
4. 对迁移时已有 DOWN/availabilityAlertActive，仅建立当时已知的 BASELINE ongoing 事件，startedAt 为迁移观察时刻；SSL 仅有有效证据才建事件。基线不触发补发告警，不伪造早期恢复/持续时间。alertsStartedAt 不能早于事件链路启用。
5. `StateService.record()` 改为交互式事务：在事务内锁定 Monitor 行并重读状态，统一 append CheckLog、更新 MonitorState、写 MonitorHistory、更新 AlertEvent、创建 AlertDelivery。监控修改/暂停/恢复/删除也取得同一锁，避免检查与生命周期操作竞争。外部 HTTP、Redis 分配查询与队列发送都在 SQL 事务外完成；持锁期间只做数据库工作。
6. 检查开始时记录 configRevision，提交时校验监控仍在原项目、目标/配置未变化且未删除/暂停。旧配置的迟到结果不回写新目标状态；合法旧观测可保留其原始归属快照。新上报 checkedAt 必填，未来超过 receivedAt+60 秒或早于 receivedAt-15 分钟拒绝；离线缓存的更早结果不能用于当前状态。合法迟到观测可入 ProbeResult，但只有 checkedAt 严格晚于已应用观测才可推进状态，比较键纳入来源/观测 ID，不能仅靠到达顺序。重复/过时报告不得倒退状态，测试覆盖检查、回调与暂停并发。
7. `CheckerService.execute()` LOCAL 保存 localResult.statusCode，不改变原有最终 success 与规则布尔值。CheckResult/规则求值附带结构化证据；不要只解析最终英文 error 推断告警 reason。
8. 将 CheckLog 和可靠 ProbeResult 清理阈值统一改为 90 天；ProbeExecution 保持 7 天。MonitorHistory 清理保留 anchor；ongoing AlertEvent、未完成 AlertDelivery 不清理，resolved 事件至少保留 90 天且未完成投递仍引用时不删除。保留 notified 成功事实，不能依赖会单独清理的 NotificationLog 动态推算。
9. 通过批处理、幂等索引和断点控制完成回填。记录实际各维度覆盖水位、迁移耗时与行数；回滚只回滚应用流量，不以破坏性 down migration 删除已产生历史。

以上 schema、回填及链路在同一次发布切换中完成。迁移与启用之间若不能原子切换，需要暂缓相关写入或使用经过验证的双写/追平步骤；追平完成后才提交水位，不能用历史缺口换取“完整覆盖”。

### 10.4 探针归属与 Agent/SCF

- `ProbeResultItemDto` 增加 monitorId/reportId/configRevision，并补完整嵌套校验（ValidateNested、布尔值、合法时间、非负耗时等）；新 Agent 每次检查生成稳定 reportId，网络重试复用它，不为同一观测重新生成 ID。
- configRevision 由服务端任务产生，沿心跳→Agent/SCF→上报 DTO→ProbeResult 原样传递；不允许收到报告时用当前 revision 覆盖。相同 reportId 的重试返回既有结果，不按新配置重新解释；相同 ID 但 payloadHash 不同返回 409，并且不产生额外日志或状态更新。
- 更新实际 `probes/agent/src/commands/run.js`、`src/checks.js`、`src/api.js` 和 SCF 共用 runCycle 的调用路径；心跳返回的 monitor.id 必须一路带到上报。禁止按 target 合并两个不同 monitorId 的结果。
- `ProbesService.recordResults()` 先解析凭据和授权，再落表。TENANT 校验同组织且实际 MonitorProbe 绑定；SYSTEM 校验实际分配 monitorId。target/type 必须匹配该授权任务；客户端 projectId/orgId 不作为可信数据源。
- 老版仅 target 上报只在当前授权集合内唯一匹配、附带 checkedAt 且能证明任务配置未变化时兼容接受；缺 reportId 时以 probeId/monitorId/checkedAt 和规范化观测内容生成确定性去重键。多义、无绑定或跨组织结果明确拒绝；缺 checkedAt 或无法校验旧任务版本时返回升级要求，不接受其作为统计观测，不能“随便取第一条”。
- 写原始结果、应用状态和去重处理须原子提交，或采用事务内 durable ingest 待应用标记及可恢复消费者；重复报告不能在原始表和状态机分别重复记账。数据库回滚后重试仍可应用，进程中断后不能出现结果已保存但状态永久漏更新。
- `CheckerService.evaluateResult()` 和回调应用改用已验证 monitorId 的观测筛选，保留既有探针救回语义，但排除共享 target 的其他监控结果。该改动属于本次归属完整性要求，不得仅在展示查询中修复。
- 给 SystemProbeScheduler 增加一次加载项目所有监控分配的批量只读入口，不逐监控访问 Redis。分配不可读且无法重建时返回明确错误，不能误报为零探针。
- 窗口探针均值读取可靠项目归属的 ProbeResult，先按探针汇总所有候选监控样本再计算，包含失败耗时。当前集合只决定展示哪些探针，历史样本不因解绑而篡改；offline 时 latencyMs=null。
- TENANT 与 SYSTEM 都有跨项目/重复 target/重复上报 fixture，安全字段白名单必须经过 HTTP 响应断言。

### 10.5 告警触发与生命周期

| kind | 打开条件 | 恢复条件 | 原因与级别 |
| --- | --- | --- | --- |
| CONNECTIVITY | 排除纯证书原因后的有效连接/服务失败证据连续达到原 failureThreshold；每次证据均求值，不仅监听进入 DOWN | 新鲜独立连接/服务成功证据；不能要求 SSL 也恢复 | critical；优先 TIMEOUT/STATUS_MISMATCH/CONNECTION_REFUSED，否则 CHECK_FAILED |
| AVAILABILITY | 沿用最近 availabilityWindow 次 ruleMatched 判定的健康比例及 failureThreshold；比例低于 availabilityThreshold 且连续异常达阈值 | 后续有效窗口健康比例达到阈值；仅连续异常数降低不算恢复 | warning；AVAILABILITY_LOW，unit=percent；保留窗口大小、样本数和命中规则证据 |
| SSL | checkSsl=true 且新检查提供证书无效、已过期或 daysRemaining<=sslExpiryThreshold 的证据 | 新鲜有效证书证据且剩余天数高于阈值 | 即将到期 warning/SSL_EXPIRING；已过期或验证失败 critical/SSL_INVALID |

AVAILABILITY 的规则健康比例不是 dashboard 的 success 可用率，必须保存 basis=RULE_HEALTHY 与阈值证据。保留当前取样源兼容性（LOCAL/PROBE 均可能参与原规则窗口），不偷偷改为本页 LOCAL 分母。规则求值新增 explain/evidence 路径，布尔 evaluate 结果不变；SLOW_RESPONSE/RULE_MATCHED 可在 latestEvidence 中表达命中条件，事件主原因保持生命周期最初原因。

SSL 只有本地/证书检查提供明确证据才打开或恢复；未拿到证书、网络失败、旧缓存 sslExpiresAt 或配置关闭都不能当作恢复。补充结构化 sslVerdict，区分无证据、有效、临期、过期和验证失败；不改变检查器原 success 判定。若 DOWN 纯由 SSL 失败造成，只开 SSL 事件，避免同一证书问题重复开 CONNECTIVITY；同时有独立连接故障证据才并存。

同时输出独立 serviceVerdict（SUCCESS/FAILURE/NO_EVIDENCE），表示不含证书策略的连接、超时及预期 HTTP 状态判定，保留探针辅助的有效成功语义。connectivityFailCount 只由 FAILURE 递增、SUCCESS 清零，NO_EVIDENCE 不递增、不恢复；无独立证据的 TLS 验证失败不能推断 HTTP 已恢复。状态机仍使用原最终 success，不因新增事件证据改变 MonitorStatus。SSL 已使状态 DOWN 后又出现独立服务失败，阈值达到仍开 CONNECTIVITY；服务恢复但 SSL 仍异常时，关闭 CONNECTIVITY 并保留 SSL。两个方向都需测试。

重复命中仅更新 latestEvidence/updatedAt；startedAt、原始 reason/level 不变。同一事件恢复后再次异常产生新 ID。AVAILABILITY 恢复采用上表明确定义，修正现有“任一打开条件不再满足即恢复”的误判，增加回归测试并在联调记录中注明行为修正。

暂停/软删除/关闭配置不发送恢复通知、不填写 resolvedAt；设置 suppressedReason，停止重复通知，事件仍 ongoing。恢复/还原/重新启用后先清除抑制标记，再由新检查证据决定继续或真正恢复。当前 alertingCount 只读当前可见监控的 ongoing 事件，包含暂停项，不受 range 限制；deleted 项仅在历史列表显示。

有无通知渠道都必须记录事件。首次 UNKNOWN→UP 继续只建正常基线，不发恢复；DOWN 首次触发是否通知沿用既有 shouldNotify 约束，事件建立不依赖通知是否允许。人工测试通知不生成真实告警事件，不影响 alertingCount。

### 10.6 真实投递与 durable outbox

- 事件打开/恢复和 AlertDelivery PENDING 行在同一 SQL 事务提交；channel 选择沿用当前各类通知绑定/回退规则。通知 payload 保存安全快照，不存渠道密钥。
- eventRevision 使用事件 lifecycleRevision，只在打开/恢复等生命周期边界递增；latestEvidence/updatedAt 的重复命中不递增投递版本、不创建新 OPEN 投递。初次真实告警与恢复各最多为同一渠道建立一条逻辑投递。
- outbox dispatcher 通过数据库租约领取待投递行，在事务外投递 BullMQ，jobId 使用 deliveryId。Redis 中断或进程在提交后崩溃，扫描任务仍可重试；QUEUED 租约到期但没有完成标记必须可重排。
- processor 按 deliveryId 读取并领取执行租约；SUCCESS 不再重复发送。每次真实发送写带 eventId/deliveryId 的 NotificationLog，成功时事务更新 delivery.deliveredAt 与 event.firstNotifiedAt；event.notified 根据持久成功事实返回。
- 入队成功不标 notified=true；全部失败时 false，任一真实成功后为 true。恢复投递和打开投递分别幂等，旧的慢任务不能覆盖更新事件或新故障周期的状态。
- 发送前重新检查渠道启用/存在与事件抑制状态；不可发送标 SKIPPED 并记录原因。不删除事件，不把跳过当成功。
- 保留现有三次指数退避（5 秒起），终态失败保留可观测记录与受控重试入口；不能每次扫描都无限重发 FAILED。测试模拟 SQL 提交后进程退出、入队失败、队列重复、渠道失效和发送失败。
- 外部渠道不支持幂等键时只能保证至少一次尝试，发送已成功但落库前进程崩溃仍可能重复；使用 deliveryId 作为支持渠道的幂等键，并在文档注明边界，不承诺无法实现的端到端 exactly-once。

### 10.7 聚合、时区、缓存与前端

- 原始 90 天数据精确计算连续分位数；采用参数化 SQL count/avg/percentile_cont、窗口条件和必要索引，不把所有日志加载到 Node 内存。top N 后批量查趋势；当前与上个窗口都真实查询。
- 任意 IANA 时区、缺失/重复午夜和夏令时按第 3 节实现。优先成熟时区库，依赖变更只增加所需能力，不升级无关包。小时统计可优化 count/sum，但不能替代精确分位数及非整小时地区的原始边界数据。
- 在短只读 repeatable-read 事务内取得数据库 asOf 并查询各区块，固定一次系统分配快照；所有写入使用统一 effectiveAt。事务外读取外部分配，不持锁等待 Redis。ETag 使用稳定业务体，304 通过端点专用响应路径跳过 TransformInterceptor，不能影响原端点包装。
- 联调三个端点与第 8 节所有区块，六条 KPI 趋势、慢项趋势、真实告警和探针耗时都必须渲染。前端请求层维护项目/参数隔离的 ETag+业务体缓存，304 复用原体，不按空响应解包；没有本地体时重发无条件请求。
- 标记真实 history 不足而非功能未实现；同时提供 loading/error/empty。图表 null 形成断线，项目切换取消或丢弃旧响应，系统探针使用安全名称。同步前端原接口文档以消除两份冲突契约。

### 10.8 工程任务顺序与逐项验证

每一项均为同一完整交付的必需工作。以下为工程顺序与原验证门槛；实际执行命令、测试数量及实现路径调整记录在 `plans/monitoring-overview/progress.md`。

| 顺序 | 工作与测试位置 | Verify 与期望 |
| --- | --- | --- |
| 1 | 确认现场差异、专用测试数据库、现有模块依赖；核对本文路径，不恢复已删除 Agent | 两仓库 `git status --short` 与提交/工作区 diff 已记录；确认不会清理开发或生产库 |
| 2 | schema/migration/回填/水位、90 天清理与 anchor；测试 `monitor-data-cleanup.service.spec.ts` | `pnpm prisma:validate`、`pnpm prisma:generate`、`pnpm type-check` 退出 0；`pnpm test -- src/modules/cron/jobs/monitor-data-cleanup.service.spec.ts --runInBand` 全通过；专用库迁移重跑验证无重复基线 |
| 3 | 新建 `monitoring-history.service.spec.ts`、更新 `monitors.service.spec.ts`、`state.service.spec.ts`；统一事务与配置 revision | `pnpm test -- --runInBand monitoring-history monitors.service state.service` 全通过，覆盖创建/暂停/恢复/删除/还原/并发及 anchor |
| 4 | 新建 `alert-events.service.spec.ts`、`alert-outbox.service.spec.ts`，更新 checker/notifier/processor 测试 | `pnpm test -- --runInBand alert-events alert-outbox checker.service notifier.service notifications.processor` 全通过；三 kind 生命周期和 durable delivery 故障注入均覆盖 |
| 5 | 改 Probe DTO/授权/幂等/救回筛选与 Agent/SCF；新增 `probes/agent/test/reporting.test.js` | `pnpm test -- --runInBand probes.service checker.service system-probe-scheduler` 全通过；Agent 目录 `pnpm test` 全通过，重复 target 与 SCF payload 不丢 monitorId |
| 6 | 新增三套 query DTO/响应 Entity、`monitoring-dashboard.service.ts`、`monitoring-window.util.ts` 与对应 `.spec.ts`；接线 controller/module/Swagger | `pnpm test -- src/modules/monitoring --runInBand` 全通过；四 range、三个端点、ETag/304、历史数量/事件/探针均有断言，原 overview 回归通过 |
| 7 | `test/monitoring-dashboard.e2e-spec.ts` 建隔离 Nest 应用，真实守卫/ValidationPipe/包装器/聚合 SQL，60 天成熟数据 fixture | `pnpm test:e2e -- --runInBand test/monitoring-dashboard.e2e-spec.ts` 全通过；迁移后空库与现存数据升级均验证，不能只 mock SQL 或直接调用控制器 |
| 8 | 前端全区块接入、适配/竞态/304 测试与浏览器验收 | 前端 `node --experimental-strip-types --test test/monitoring-adapter.test.mjs test/monitoring-request-state.test.mjs`、`pnpm type-check`、`pnpm build` 退出 0；测试直接导入无运行时别名的纯 TS 工具，沿用项目 Node>=22.18；桌面/移动端截图无溢出，网络失败不回退 mock |
| 9 | 两仓库整体验证、代表性数据执行计划、统一交付检查 | 后端 `pnpm prisma:generate`、`pnpm type-check`、`pnpm lint`、`pnpm build`、`pnpm test -- --runInBand` 全通过；前端检查/构建及 Agent 测试通过，保存冷/热缓存耗时 |

e2e 使用经核对的专用 PostgreSQL 数据库，fixture 独立 ID，仅清理自己创建的数据；不运行 reset 或无范围清表。避免全量 AppModule 意外启动真实调度和通知，外部 HTTP/渠道模拟，SQL 与鉴权使用真实实现。lint 自动修复后逐项检查任务 diff，保留用户已有修改，不顺手格式化无关文件。

## 11. 验收测试矩阵

| 场景 | 必须验证的结果 |
| --- | --- |
| 非法参数、重复参数、额外参数 | 400，不执行昂贵聚合 |
| 无 JWT / 非组织成员 | 分别 401 / 403，缓存不能绕过 |
| 项目/组织删除或不存在 | 404，包括 SUPER_ADMIN |
| 同组织两个项目、跨组织、相同 target | 数据、探针及缓存互不串用 |
| 新建/恢复/暂停监控 | UNKNOWN 与 PAUSED 归类正确，五状态合计正确 |
| LOCAL 与 PROBE 行混合 | 只计算 LOCAL；手动 LOCAL 如实计入 |
| 探针救回本地失败 | uptime 按最终成功；延迟仍本地耗时；保留本地状态码 |
| 全部成功 / 全部失败 / 空样本 | 比例 100/0、0/100 或 null/null，计数准确 |
| 延迟 10/90/100/200ms | 均值 100，P50 95，P95 185，P99 197 |
| 直方图边界 100/200/300/500/1000 | 每个样本只进一档，档数之和等于总样本 |
| 成熟数据的 1h/today/7d/30d 比较 | 当前与上一窗口全覆盖且有样本时返回真实 delta；使用两个完整 30d fixture 验证，不得固定 null |
| 历史确实不足、上一窗口无样本 | 分别 TRUNCATED / EMPTY，只有受影响维度的 delta=null；数量历史与检查水位独立 |
| 创建/暂停/恢复/删除/还原/状态迁移 | 数量净变化与六条趋势来自历史，软删除不移除过去检查；90 天清理保留前置 anchor |
| from 等于数量水位、非空存量基线 | 基线仍适用，迁移存量不算窗口新增；普通变更继续半开边界语义 |
| 并发检查/重复回调/配置变化 | 单监控状态与历史 revision 一致；事件无重复 ongoing；旧配置结果不覆盖新状态 |
| from/to 边界及部分桶 | from 包含、to 不包含；检查频率使用实际交集秒数 |
| UTC/Asia/Shanghai/夏令时/半小时偏移 | 无固定偏移假设；today/热力图/状态码各按已定义规则 |
| Santiago 2026-09-06、Havana 2026-11-01 | 分别跳过/重复午夜，startOfDate 取当天最早有效时刻 |
| New York 2026-11-02 23:30，days=30 | 自然日期跨度 720.5 小时；成熟 90 天数据下 AVAILABLE；另造不足水位，跨边界格子只进 unavailableCells |
| 热力图无记录/重复小时 | 缺失格省略，worst=null 或正确按样本合并 |
| 六条 sparklines 与慢项趋势 | 全部存在且同 timeline 等长；平均趋势用 avgLatencyMs，失败率按次数推导，零样本为 null |
| HTTP 302/500/无响应/历史缺码/TCP/监控改类型 | 按采集类型分档，计数守恒；TCP 不进入；不可证明协议的历史计 unclassifiedChecks |
| TENANT/SYSTEM 绑定、离线、同 target、幂等上报 | 探针去重/耗时真实，跨项目样本不串用；多义旧上报拒绝；不泄漏内部字段 |
| 三种告警打开/重复/恢复/再异常 | 生命周期唯一、原始级别/原因保留，真实恢复才填写时长；规则证据和 SSL 证据准确 |
| SSL→连接异常及连接恢复但 SSL 未恢复 | 不依赖重复 DOWN 转换；两种事件按各自独立证据开关，无漏报或伪恢复 |
| 暂停/删除/关闭配置 | 抑制而非恢复；不发伪恢复通知，删除项不计当前告警，历史可读 |
| 入队成功/全失败/部分成功/渠道删除 | notified 仅真实成功为 true；删除渠道不抹去成功事实；无渠道仍保存事件 |
| 提交后崩溃/Redis 中断/重复任务/租约到期 | outbox 可恢复，成功行不重复执行；外部至少一次边界有记录 |
| 全量功能 | 不存在未接线的字段、功能开关占位或线上 mock；无样本与未实现不得混淆 |
| 空数组、全 null、项目切换竞态 | 无 toFixed/Infinity 错误，无旧项目响应覆盖 |
| 冷/热缓存与 Redis 异常 | asOf 不被刷新；键隔离；合法降级且错误不伪装空态 |
| ETag/If-None-Match | 同业务体但 meta 不同仍按弱标签比较，返回无体 304；JWT/成员/项目校验仍执行；前端复用正确项目的旧体 |

后端服务测试沿用 `src/modules/monitoring/monitoring.service.spec.ts` 的 Prisma mock 风格。窗口测试用固定时钟。SQL 聚合和实际路由边界至少各有数据库/HTTP 集成覆盖；单纯 mock 出聚合结果不能证明 SQL 正确。

## 12. 完成标准与停止条件

### 唯一完成标准

所有条件同时满足才可标记 DONE；不存在“端点完成、告警以后再做”的完成口径。

- [x] 三个 GET 端点及前端全部区块使用真实数据，原 overview 回归通过。
- [x] 所有必需模型、迁移、回填、水位、90 天清理及数量 anchor 实际落地；不存在仅写在文档中的 schema。
- [x] 六项 KPI、六条 sparklines、三分位数、热力图、HTTP 分类、协议/探针/耗时分布、慢项趋势全部验证。
- [x] 成熟 fixture 下 30d 当前与上一窗口可计算真实环比；数量 delta/历史趋势与已删除对象历史正确。
- [x] Agent/SCF 携带 monitorId/reportId；服务端先授权再存储，重复 target/跨项目/重复回调测试通过。
- [x] 三种真实告警完整生命周期和抑制行为实现；outbox 崩溃恢复/重试幂等测试通过；notified 关联真实投递。
- [x] DTO/Swagger/TS 类型与第 3–7 节一致；鉴权、SUPER_ADMIN、空态、时区和 ETag 的 HTTP/SQL 集成测试全部通过。
- [x] 后端 CI 四步、相关全量单测、专用库 e2e、Agent 测试、前端 type-check/build 与适配/竞态测试均退出 0。
- [x] 浏览器完成桌面/移动端、UNKNOWN、未知 region、历史不足、空数组/全 null、错误/加载、项目/range/tz 切换和 304 验收；页面无线上 mock。
- [x] 代表性数据的数据库行数、EXPLAIN、冷/热缓存耗时及响应体大小有记录；点数有上限，无 N+1，没有未经验证的性能结论。
- [x] 检查两仓库任务 diff，保留既有及并行修改；同步前端接口文档；索引实施状态据实更新。

### 停止并报告

- 实时代码已改变样本语义、监控归属或权限边界，导致本文假设不成立。
- 状态码修复需要改变规则/通知判定或原 overview 行为。
- 被要求伪造已经删除的历史或隐藏真实缺口；保留期变更不能恢复不存在的数据。
- 需要扩大到探针注册/凭据生命周期、计费、全新协议检查器或定时报表订阅；本方案内的上报协议、告警与历史模型是必做，不触发停止。
- 无法运行 PostgreSQL/HTTP 集成验证或浏览器验收：记录缺口，不宣称已经通过。
- 同一验证在合理修复后仍连续失败两次，先定位基线问题，不覆盖无关用户改动。

## 13. 维护说明

- 新增协议、改变 LOCAL/PROBE 写入语义、保留期或时区策略时，必须同步重审 metricBasis、缓存版本和测试。
- AlertEvent 是告警/故障生命周期唯一来源，MonitorHistory 是数量历史来源；AlertDelivery/NotificationLog 承担投递职责，不相互替代。
- 不允许通过更新配置、暂停、删除或清理历史伪造恢复；清理策略必须保留 anchor、ongoing 事件、未完成投递及成功事实。
- 前端接口文档已同步为全量契约。
- 实现调整：数量历史、配置 revision 和抑制采用 PostgreSQL 触发器覆盖所有写入路径，不再新建逐服务调用的 monitoring-history 模块；单测及真实数据库集成测试验证该行为。
- 已执行生成、隔离库迁移、构建、业务测试与浏览器验收；未迁移开发/生产数据库，未向真实渠道发送通知。上线仍需目标环境迁移及服务发布。

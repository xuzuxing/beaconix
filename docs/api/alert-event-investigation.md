# 项目告警查询与投递追踪（C1）

更新：2026-10-30。本文描述后端接口；本仓库没有前端。示例使用默认 `/api` 前缀，实际部署跟随 GLOBAL_PREFIX。

## 权限与导航

使用访问令牌 `Authorization: Bearer <ACCESS_TOKEN>`。所有查询要求 `monitoring.read`，沿用 ProjectAccessGuard：项目 VIEWER / MEMBER / ADMIN 可读，组织 OWNER/ADMIN 与平台管理员按现有规则可读。普通组织成员必须有该项目授权。

从看板 `recentAlerts[].id`、监控 insights `events[].id` 或站内通知 `meta.alertEventId` 打开详情，携带原 `projectId`。不再要求组织用户访问平台管理端失败列表来获取 deliveryId。

| 动作 | 接口 |
| --- | --- |
| 项目事件列表 | `GET /api/projects/:projectId/monitoring/alert-events` |
| 事件详情 | `GET /api/projects/:projectId/monitoring/alert-events/:eventId` |
| 事件的投递列表 | `GET /api/projects/:projectId/monitoring/alert-events/:eventId/deliveries` |
| 某份投递的尝试记录 | `GET /api/projects/:projectId/monitoring/alert-events/:eventId/deliveries/:deliveryId/attempts` |
| 失败投递重试（既有接口） | `POST /api/projects/:projectId/monitoring/alert-deliveries/:deliveryId/retry` |

归档项目仍可读历史，禁止重试。软删除项目/组织不可读；监控已删除时保留事件快照，`monitorDeleted=true`。事件或投递不属于 URL 中的项目/事件时返回 404，不暴露其他项目是否存在该资源。

## 列表筛选与分页

所有列表返回统一外层封装：

```json
{
  "data": { "items": [], "total": 0, "page": 1, "limit": 25 },
  "meta": { "timestamp": "2026-10-30T01:00:00.000Z" }
}
```

分页 `page=1..1000000`，`limit=1..100`，默认 1 / 25。超出末页返回空 items，total 仍为筛选后的总数。每次查询的授权、items 与 total 使用同一数据库快照；不同请求之间数据可能变化，重试后应刷新详情与列表。

事件列表支持：

| 参数 | 值 / 含义 |
| --- | --- |
| monitorId | 可选 CUID，可查询已删除监控的历史；其他项目的 ID 返回空列表 |
| kind | `CONNECTIVITY / AVAILABILITY / SSL / NO_DATA` |
| status | 小写 `ongoing / resolved`；不传查询全部 |
| level | 小写 `warning / critical` |
| from / to | 可选 ISO 8601，按事件 **startedAt** 包含边界筛选；from 不得晚于 to |
| page / limit | 分页参数 |

按 `startedAt DESC, id DESC` 排序。时间范围不表示“该时间段内曾持续”：开始时间早于 from 的未恢复事件不会进入结果。需要全部当前故障时用 `status=ongoing`，不附开始时间范围。按天选择时前端应将用户本地时区的起止时间转换为带时区的 ISO 时间。周日期、序号日期和无效日历日期返回 400；未声明的查询字段按当前全局管道丢弃，不参与筛选。

```http
GET /api/projects/<PROJECT>/monitoring/alert-events?status=ongoing&kind=NO_DATA&page=1&limit=25
Authorization: Bearer <ACCESS_TOKEN>
```

## 事件详情

列表的每条 item 与详情共享以下事件字段。详情另外包含 `deliverySummary`、`canRetryDeliveries`：

```json
{
  "data": {
    "id": "event-id",
    "projectId": "project-id",
    "monitorId": "monitor-id",
    "monitorName": "Production API",
    "target": "https://api.example.com/health",
    "monitorDeleted": false,
    "kind": "NO_DATA",
    "level": "warning",
    "status": "ongoing",
    "origin": "OBSERVED",
    "suppressedReason": null,
    "reason": "NO_EFFECTIVE_OBSERVATION",
    "threshold": 600,
    "actual": 700,
    "unit": "s",
    "startedAt": "2026-10-30T00:40:00.000Z",
    "resolvedAt": null,
    "durationSeconds": null,
    "firstNotifiedAt": null,
    "updatedAt": "2026-10-30T00:50:00.000Z",
    "deliverySummary": [{ "status": "FAILED", "count": 1 }],
    "canRetryDeliveries": true
  },
  "meta": { "timestamp": "2026-10-30T01:00:00.000Z" }
}
```

`monitorName/target` 是事件保存的快照；`reason/threshold/actual/unit` 描述触发时的条件，不能当作最新检查读数。原始 message 与 latestEvidence JSON 不返回。已恢复事件的 durationSeconds 为最终持续时间；ongoing 的该字段为 null，界面可按当前时间减 startedAt 展示持续时长。

`firstNotifiedAt` 非空仅表示曾有一份渠道投递成功，不代表所有渠道成功；具体状态看 deliverySummary 和投递列表。summary 中不存在的状态按 0 处理，不依赖数组顺序。`canRetryDeliveries` 是当前项目操作权限，具体投递仍须 FAILED。

目标按现行监控投影规则处理：ADMIN 可见去除凭据、查询值及 fragment 后的 URL；MEMBER/VIEWER 的 target 为 `[REDACTED]`。NO_DATA 恢复表示有效观测恢复，服务仍可能 DOWN；不要把 NO_DATA 的 resolved 渲染为服务已正常。

## 投递与尝试记录

投递列表额外支持 `status=PENDING/QUEUED/SENDING/SUCCESS/FAILED/SKIPPED`、`phase=OPEN/RECOVERY`，默认查询全部。按 `createdAt ASC, id ASC` 排序，先呈现最早的开告警投递。

```json
{
  "data": {
    "items": [{
      "id": "delivery-id", "eventId": "event-id", "eventRevision": 1,
      "phase": "OPEN", "channelId": "channel-id", "status": "FAILED", "attempts": 3,
      "createdAt": "2026-10-30T00:40:00.000Z", "deliveredAt": null,
      "nextAttemptAt": "2026-10-30T00:41:00.000Z",
      "channel": { "id": "channel-id", "name": "值班邮件", "type": "EMAIL", "enabled": true },
      "canRetry": true
    }],
    "total": 1, "page": 1, "limit": 25
  },
  "meta": { "timestamp": "2026-10-30T01:00:00.000Z" }
}
```

channel 是当前渠道的安全摘要，不是发送时的收件人快照；渠道已删除或不可用时为 null，仍保留 channelId 和历史。接口不提供邮箱收件人、Webhook 地址或任何渠道配置。channel.enabled 不代表历史投递是否成功。

`attempts` 是当前重试周期的计数，人工重试会重置；nextAttemptAt 是允许再次尝试的时间，不能作为成功/失败记录的实际发送时间。

尝试记录接口只接受 page/limit，按 `sentAt DESC, id DESC` 排序：

```json
{
  "data": {
    "items": [{
      "id": "log-id", "deliveryId": "delivery-id", "eventId": "event-id",
      "channelId": "channel-id", "phase": "OPEN", "attempt": 3,
      "status": "FAILED", "sentAt": "2026-10-30T00:41:00.000Z"
    }],
    "total": 3, "page": 1, "limit": 25
  },
  "meta": { "timestamp": "2026-10-30T01:00:00.000Z" }
}
```

人工重试后旧日志保留，attempt 编号可能再次从 1 开始；用日志 id 标识记录、sentAt 排序，不用 attempt 作为全历史唯一键。SKIPPED 或尚未发送的投递可能没有尝试日志。日志来自已有 NotificationLog，原始 error 不返回。

## 重试交互与错误

仅显示 `canRetry=true` 的重试按钮，调用既有 POST 接口，不传请求体。仅项目 ADMIN（含组织/平台管理员的既有权限）可操作；归档项目禁止。

成功为 `data={"id":"delivery-id","status":"PENDING"}`。后台 outbox 异步领取，不等于已重新发送。随后刷新投递、summary 与尝试记录；连续点击或状态已变化返回 409，应刷新。事件过时、渠道已删除/禁用时，后续可能 SKIPPED；canRetry 不承诺最终可送达。

| HTTP | 前端处理 |
| --- | --- |
| 400 | 查询参数、分页、时间范围错误；修正筛选条件 |
| 401 | 登录失效，重新登录 |
| 403 | 缺少操作权限或项目已归档；隐藏操作并刷新 |
| 404 | 项目/事件/投递不存在或当前不可见，不跨项目尝试回退查询 |
| 409（重试） | 状态变化，不重复自动提交；刷新投递 |

本次没有 ACK、人工关闭、维护静默或清理历史；看板和 insights 原接口保持原行为。前端可逐步接入，无需等待新迁移。

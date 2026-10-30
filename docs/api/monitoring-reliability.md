# C6 + C5 前端对接

## 无数据状态

`GET /api/projects/:projectId/monitors/:monitorId/state` 新增 `noDataSince: string | null`（ISO 时间）。监控 insights 的 `latest` 同样新增 `noDataSince`，格式沿用该接口时区。

无有效观测超过 `max(3 × interval, 600)` 秒后，下一次每分钟扫描写入：

```json
{"status":"UNKNOWN","noDataSince":"2026-10-30T01:00:00.000Z","executionBlockedReason":"NO_DATA"}
```

界面应显示“暂无有效观测”，保留最近一次检查时间、延迟和历史。不要将 UNKNOWN 渲染为正常或故障。仅根据旧延迟值也不能推断当前健康。

告警事件 kind 增加 `NO_DATA`；站内通知仍使用 `MONITOR_ALERT` / `MONITOR_RECOVERED`，`meta.kind=NO_DATA`。渠道事件分别为 `NO_DATA` / `NO_DATA_RECOVERED`。恢复文案应为“观测已恢复”，服务可能仍 DOWN。新鲜有效成功或失败均结束无数据事件；旧结果、无证据和未求值结果不会结束它。

暂停、配额限制与软删除不产生新的 NO_DATA。创建、编辑、重新启用或恢复配额会重新给出阈值长度的调度宽限。

## 平台失败投递列表

`GET /api/admin/alert-deliveries`，JWT + `SUPER_ADMIN`。普通组织管理员无法访问。

| 参数 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| status | FAILED | FAILED/PENDING/QUEUED/SENDING/SUCCESS/SKIPPED |
| organizationId/projectId/monitorId/channelId | 可选 CUID | 精确过滤 |
| phase | OPEN/RECOVERY | 可选 |
| from/to | 可选 ISO 时间 | 投递创建时间，包含边界；from 不得晚于 to |
| page | 1 | 1–1,000,000 |
| limit | 25 | 1–100 |

统一响应封装：

```json
{
  "data": {
    "items": [{
      "id": "delivery-id", "eventId": "event-id", "eventRevision": 1,
      "phase": "OPEN", "channelId": "channel-id", "status": "FAILED", "attempts": 3,
      "createdAt": "2026-10-30T01:00:00.000Z", "deliveredAt": null,
      "nextAttemptAt": "2026-10-30T01:01:00.000Z",
      "event": {
        "organizationId": "org-id", "projectId": "project-id", "monitorId": "monitor-id",
        "monitorName": "Production API", "kind": "NO_DATA", "status": "ongoing", "suppressedReason": null
      }
    }],
    "total": 1, "page": 1, "limit": 25
  },
  "meta": {"timestamp": "2026-10-30T01:02:00.000Z"}
}
```

按 createdAt/id 倒序。时间范围是创建时间，非最后失败时间。接口不返回通知 payload、渠道配置或原始错误；渠道以 channelId 标识。无独立详情接口。

人工重试沿用：`POST /api/projects/:projectId/monitoring/alert-deliveries/:deliveryId/retry`，从 `event.projectId` 取项目，要求 `alert.retry` 项目权限（含平台管理员）。仅 FAILED 可重试，成功返回 `{id,status:"PENDING"}`；重复点击或状态已变化返回 409。页面刷新后更新列表；后台 outbox 后续投递，过时事件或失效渠道可能最终 SKIPPED。

## 每日汇总

北京时间每日 09:00，仍有 FAILED 积压的组织向 OWNER/ADMIN 发送站内通知和已验证邮箱邮件。类型 `ALERT_DELIVERY_FAILED_SUMMARY`，组织范围，`resourceType=Organization`。`meta` 为 `{day,timezone:"Asia/Shanghai",failedCount}`，不含跨组织详情。同组织同收件人每日一次，积压未解决则次日继续提醒，零积压不提醒。

站内通知供组织管理员获知异常；跨租户列表仅向 SUPER_ADMIN 开放。汇总描述发送时的积压数量，邮件或站内展示时数量可能已变化。

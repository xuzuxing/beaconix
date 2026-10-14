# 监控 V1.1 路线图与开发计划

> 文档类型：历史归档。原文中的“当前状态”、缺口、示例和阶段计划均属于当时的设计快照，不代表最新实现；日常使用请从 [文档索引](../README.md) 查找现行接口与运行指南。

## 系统设计中的演进摘要

### 八、演进计划

#### 8.1 P0：对齐当前实现与文档

- 保留 `Project -> Monitor`，将文档中的组织级监控接口标注为目标接口，当前开发继续使用项目级接口。
- 保留 SSL 监控字段与业务实现，并纳入 V1.1 正式能力。
- 将当前可用接口和待实现接口持续维护在 5.1.1 表格中。

#### 8.2 P1：补齐监控产品核心缺口

- 增加 `ProbeScope`、`ProbeExecution`、`ExecutionTrigger`、`ExecutionStatus`。
- 支持系统探针：`Probe.scope = SYSTEM`、`organizationId = null`、Admin 创建和启停。
- 实现执行日志写入：本地调度、手动检查、探针 heartbeat/results 都记录 execution。
- 将 `CheckLog.source` 从 String 迁移到 `CheckSource` enum。

#### 8.3 P2：补齐对外产品能力

- 实现 StatusPageModule：租户侧 CRUD 和公开 `GET /status/:slug`。
- 实现状态总览接口：组织/项目维度的 UP/DOWN/DEGRADED 统计和最近故障列表。
- 引入 Redis/BullMQ，将 NotifierModule 从同步 fan-out 迁移到异步队列、重试和死信。

#### 8.4 P3：运营与商业化

- 实现 AdminModule：租户管理、系统探针管理、指标、审计视图。
- 实现 BillingModule：套餐、支付、用量限制。
- 如果需要内置控制台，再实现 ViewModule 和 Handlebars 页面；否则保持纯后端 API。

文档结束。 这份设计现在同时覆盖目标架构与当前仓库适配差异，可直接作为后续开发依据。

## 详细开发计划

本文档用于指导后续实现 `docs/archive/monitoring-v1.1-design.md` 中的 P1、P2、P3。当前系统保持项目级监控模型：`Organization -> Project -> Monitor`。

### 总体原则

- 不把现有监控从 Project 下剥离，除非产品明确改方向。
- 所有 schema 改动必须通过 Prisma migration，并在之后执行 `pnpm prisma:generate`。
- 新接口遵循现有 Beacon 后端约定：Swagger、Guard、RBAC、AuditLog、响应包装、Service 内 Prisma 访问。
- 每个阶段都要有服务层单测；涉及公开接口或权限边界时补 e2e。

### P1：补齐监控产品核心缺口

目标：补齐系统探针、执行日志、数据语义，保证监控核心链路可审计、可运营、可扩展。

#### P1.1 Schema 与迁移

新增：

- `ProbeScope`: `SYSTEM`, `TENANT`
- `ExecutionTrigger`: `SCHEDULED`, `MANUAL`, `CALLBACK`
- `ExecutionStatus`: `SUCCESS`, `FAILED`, `TIMEOUT`, `SKIPPED`
- `Probe.scope`
- `Probe.organizationId` 改为可空，用于系统探针
- `Probe.maxTenants`
- `Probe.priority`
- `ProbeExecution`

建议同时处理：

- 将现有 Probe 全部回填为 `TENANT`。
- 将 `CheckLog.source` 从 String 迁移为 `CheckSource` enum。

验收：

- Prisma generate 通过。
- 现有 tenant probe 测试继续通过。
- 不破坏当前 heartbeat/results 流程。

#### P1.2 租户探针兼容

工作项：

- 租户侧查询统一过滤 `scope: TENANT`。
- 租户创建 probe 时强制写入 `TENANT`。
- 租户接口不能读取、绑定、删除系统探针。
- DTO 不暴露 scope/maxTenants/priority 给租户侧创建。

验收：

- tenant probe list 不返回系统探针。
- tenant probe create 不允许伪造系统探针。
- bind monitor 时只能绑定租户可见探针。

#### P1.3 ProbeExecution 写入与查询

工作项：

- heartbeat 写 execution：trigger=`CALLBACK`。
- results 上报写 execution：trigger=`CALLBACK`。
- 手动 check 写 execution：trigger=`MANUAL`。
- scheduler check 写 execution：trigger=`SCHEDULED`。
- 执行日志不得保存 probe secret、JWT、敏感 header。
- 租户侧增加 `GET /organizations/:orgId/probes/:id/executions`。

验收：

- 执行日志可按 probeId、monitorId、status、时间分页查询。
- 本地检查和探针上报都有审计记录。

#### P1.4 系统探针管理

工作项：

- 增加 AdminModule 基础，或先增加 system-probe 子模块。
- 仅 `SUPER_ADMIN` 可创建/列表/更新/启停/删除系统探针。
- 系统探针 `organizationId = null`。
- 系统探针不出现在租户 probe 列表中。

验收：

- SUPER_ADMIN 可管理系统探针。
- 普通租户完全不可见。
- 后续可接 Redis 动态分配。

### P2：补齐对外产品能力

目标：补齐客户可见的监控产品闭环，包括状态页、状态总览、异步通知。

#### P2.1 StatusPageModule

接口：

| 方法   | 路径                                     | 鉴权   | 说明       |
| ------ | ---------------------------------------- | ------ | ---------- |
| POST   | `/organizations/:orgId/status-pages`     | ADMIN  | 创建状态页 |
| GET    | `/organizations/:orgId/status-pages`     | MEMBER | 列表       |
| GET    | `/organizations/:orgId/status-pages/:id` | MEMBER | 详情       |
| PATCH  | `/organizations/:orgId/status-pages/:id` | ADMIN  | 更新       |
| DELETE | `/organizations/:orgId/status-pages/:id` | ADMIN  | 删除或禁用 |
| GET    | `/status/:slug`                          | Public | 公开状态页 |

规则：

- `visibleMonitorIds` 必须属于当前组织。
- 当前系统有 Project 维度，公开页可以跨项目展示同组织下被选中的 monitors。
- `showLatency` 控制是否展示延迟。
- `showUptime` 控制是否展示 uptime。
- 页面总体状态建议规则：任一 DOWN -> DOWN；否则任一 DEGRADED -> DEGRADED；否则全部 UP -> UP；空页面 -> UNKNOWN。

验收：

- 公开接口无需 JWT。
- 禁用页面不可公开访问。
- 不泄露未配置在 `visibleMonitorIds` 的 monitor。

#### P2.2 状态总览

建议接口：

- `GET /organizations/:orgId/monitoring/overview`
- `GET /projects/:projectId/monitoring/overview`

返回：

- monitors total/enabled/paused
- counts by `MonitorStatus`
- recent DOWN/DEGRADED monitors
- avg latency
- 24h uptime summary
- SSL expiring soon count

验收：

- 组织成员可查看。
- Project overview 只统计该项目。
- Organization overview 统计组织内所有项目的 monitors。

#### P2.3 通知队列化

工作项：

- 引入 `@nestjs/bullmq` / `bullmq`。
- NotifierService 从同步发送改为 enqueue notification jobs。
- Notification processor 负责调用 sender、写 `NotificationLog`、更新 last notified status。
- `sendTestMessage()` 保持同步，方便测试按钮即时返回。
- 增加 retry/backoff。

验收：

- 检查链路不等待 webhook/email 发送完成。
- 单渠道失败不影响其他渠道。
- 失败任务可重试并记录日志。

### P3：运营与商业化

目标：让平台具备运营管理、租户用量统计、套餐/配额约束能力。

#### P3.1 AdminModule

接口：

- `GET /admin/tenants`
- `GET /admin/tenants/:id`
- `PATCH /admin/tenants/:id/toggle`
- `GET /admin/metrics/overview`
- `GET /admin/metrics/tenants`
- `GET /admin/audit-logs`

规则：

- 仅 `SUPER_ADMIN` 可访问。
- 不复用租户侧 service 绕过隔离规则；Admin 查询要显式跨租户。

#### P3.2 用量统计与配额

统计项：

- monitor count
- enabled monitor count
- tenant probe count
- system probe usage estimate
- check volume
- notification volume
- status page count

配额建议：

- Free/Starter/Pro/Enterprise plan。
- 创建 monitor/probe/status page 时校验配额。
- 超额返回明确错误。

#### P3.3 BillingModule

待产品确认：

- 支付供应商。
- 套餐模型是否落库。
- Webhook 安全校验方式。

MVP 可先实现：

- `GET /billing/plans`
- plan config
- quota enforcement

支付 checkout/webhook 可在供应商确认后补。

#### P3.4 ViewModule 可选

建议：

- 若已有独立前端，则不在后端实现 ViewModule。
- 若需要内置轻量运营页，再基于现有 `views/monitor-test.hbs` 扩展。

### 推荐实施顺序

1. P1.1 Schema migration
2. P1.2 tenant probe compatibility
3. P1.3 ProbeExecution write/query
4. P1.4 system probe admin foundation
5. P2.1 StatusPageModule
6. P2.2 status overview
7. P2.3 notification queue
8. P3.1 AdminModule
9. P3.2 usage/quota
10. P3.3 BillingModule

### 每阶段验收命令

```bash
pnpm prisma:generate
pnpm test
pnpm type-check
pnpm lint
pnpm build
```

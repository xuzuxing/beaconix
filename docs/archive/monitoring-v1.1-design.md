# 暗哨（Beacon Watch）V1.1 系统设计

> 文档类型：历史归档。原文中的“当前状态”、缺口、示例和阶段计划均属于当时的设计快照，不代表最新实现；日常使用请从 [文档索引](../README.md) 查找现行接口与运行指南。

> 本文档分为“目标设计”和“当前仓库适配说明”。目标设计描述 Beacon Watch 的最终形态；当前仓库 `nest-beacon` 已经承载 Agile workspace 后端，因此监控能力先落在现有 `Organization -> Project -> Monitor` 模型下，而不是文档初稿里的 `Organization -> Monitor` 独立监控 SaaS 模型。后续开发应优先兼容当前实现，再按演进计划补齐 V1.1 能力。

## 0、当前仓库适配基线

### 0.1 当前系统边界

当前仓库不是纯监控产品，而是多租户 Agile workspace 后端，已有组织、项目、Sprint、任务、评论、附件、标签、通知和审计日志等模块。V1.1 监控能力作为该后端的一个功能域接入：

| 维度       | V1.1 目标设计                       | 当前仓库实现                                                    |
| ---------- | ----------------------------------- | --------------------------------------------------------------- |
| 监控归属   | Organization 直接拥有 Monitor       | Project 拥有 Monitor，Monitor 同时冗余 organizationId           |
| 路由根     | `/organizations/:orgId/monitors`    | `/projects/:projectId/monitors`                                 |
| 多租户解析 | 通过 orgId                          | 通过 projectId 由现有 Guard 解析组织                            |
| 数据隔离   | organizationId 行级隔离             | projectId + organizationId 行级隔离                             |
| 模块风格   | Service + Repository + Shared/Infra | 现有 Beacon 约定：Controller 薄、Service 直接注入 PrismaService |
| 通知       | Redis/BullMQ 异步队列               | 当前为同步 fan-out，多渠道 sender 已实现                        |
| 探针       | SYSTEM + TENANT 双层                | 当前仅 TENANT 探针，SYSTEM 探针待补                             |
| 状态页     | StatusPageModule + 公开访问         | 已有 StatusPage 表，业务接口待补                                |
| SSL 监控   | 初稿未覆盖                          | 当前已实现 HTTPS 证书过期监控                                   |

### 0.2 当前已实现能力

- Monitor CRUD、暂停/恢复、软删除/恢复，项目级路由：`/projects/:projectId/monitors`。
- 本地 HTTP/TCP 检测、定时调度、手动触发、检查历史。
- 状态机：`UNKNOWN -> UP/DEGRADED/DOWN/PAUSED`，支持失败阈值和 24h uptime/latency 摘要。
- 租户探针注册、heartbeat、结果上报、monitor 绑定/解绑、探针结果查询。
- 本地 + 租户探针双源确认：本地失败时，如果绑定探针近期成功，则本次状态保持成功。
- 多渠道通知：飞书、企业微信、钉钉、微信订阅消息、邮件。
- SSL 证书监控：`checkSsl`、`sslExpiryThreshold`、证书到期时间、剩余天数、Issuer、Subject、SSL 通知时间。

### 0.3 当前缺口

- 系统探针：缺少 `ProbeScope.SYSTEM`、`organizationId = null`、系统探针 Admin 管理、Redis 动态分配。
- 执行日志：缺少 `ProbeExecution`、`ExecutionTrigger`、`ExecutionStatus`。
- 状态页：缺少 StatusPage CRUD 和公开 `GET /status/:slug`。
- 状态总览：缺少组织/项目级聚合状态接口。
- Admin/Billing/View：运营后台、计费和 Handlebars 视图层尚未实现。
- 异步通知：尚未接入 Redis/BullMQ 队列、重试和死信处理。
- 文档中的 repository/shared/infra 分层尚未迁移，当前仍遵循本仓库既有模块约定。

## 一、系统架构

### 1.1 整体架构图

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        公网 SaaS（NestJS 11）                        │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                      业务模块层                                 │ │
│  │                                                               │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │ │
│  │  │ MonitorsMod │ │  ProbeMod   │ │   CheckerModule         │ │ │
│  │  │ 监控配置     │ │ 探针管理     │ │   ┌──────────┐          │ │ │
│  │  │ CRUD        │ │ 回调接收     │ │   │Scheduler │          │ │ │
│  │  └──────┬──────┘ └──────┬──────┘ │   │本地检测  │          │ │ │
│  │         │               │        │   │双源汇总  │          │ │ │
│  │         │               │        │   └──────────┘          │ │ │
│  │         │               │        └──────────┬──────────────┘ │ │
│  │         │               │                   │                │ │
│  │         │               │                   ▼                │ │
│  │         │               │        ┌─────────────────────────┐ │ │
│  │         │               │        │   StateModule           │ │ │
│  │         │               │        │   状态机 + 故障阈值      │ │ │
│  │         │               │        └──────────┬──────────────┘ │ │
│  │         │               │                   │                │ │
│  │         │               │                   ▼                │ │
│  │         │               │        ┌─────────────────────────┐ │ │
│  │         │               │        │   NotifierModule        │ │ │
│  │         │               │        │   队列 + 多渠道          │ │ │
│  │         │               │        └─────────────────────────┘ │ │
│  │         │               │                                    │ │
│  │  ┌──────┴───────────────┴────────────────────────────────┐  │ │
│  │  │              StatusPageModule（状态页）                │  │ │
│  │  └───────────────────────────────────────────────────────┘  │ │
│  │                                                               │ │
│  │  ┌───────────────────────────────────────────────────────┐   │ │
│  │  │              AdminModule（运营后台）                   │   │ │
│  │  │  ┌─────────────────┐  ┌──────────────────────────┐   │   │ │
│  │  │  │ SystemProbe     │  │ TenantManagement         │   │   │ │
│  │  │  │ 系统探针管理     │  │ 租户/用量管理            │   │   │ │
│  │  │  └─────────────────┘  └──────────────────────────┘   │   │ │
│  │  └───────────────────────────────────────────────────────┘   │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                      基础设施层                                 │ │
│  │  Prisma / PostgreSQL / Redis / BullMQ / Wechat / Config       │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
         ▲                          ▲                    │
         │ 探针回调                  │ 状态查询            │ 通知推送
         │                          │                    ▼
┌────────┴────────┐     ┌───────────┴──────┐   ┌─────────────────┐
│  系统探针        │     │  租户探针         │   │ 飞书/微信/邮件   │
│  （admin管理）   │     │  （租户管理）      │   └─────────────────┘
│  Redis动态分配   │     │  monitor_probes  │
└─────────────────┘     └──────────────────┘
```

### 1.2 探针分层模型

```text
┌─────────────────────────────────────────────────────────────┐
│                        探针体系                              │
├─────────────────────────┬───────────────────────────────────┤
│      系统探针            │           租户探针                 │
│      SYSTEM              │           TENANT                  │
├─────────────────────────┼───────────────────────────────────┤
│ admin 添加和管理          │ 租户自己添加和管理                  │
│ 租户完全不可见            │ 租户完全可见                       │
│ Redis 动态分配            │ monitor_probes 显式绑定            │
│ 为所有租户提供基础检测     │ 覆盖租户特定内网场景                │
│ 平台成本                  │ 租户自担                          │
└─────────────────────────┴───────────────────────────────────┘
```

### 1.3 核心链路

```text
创建监控 → 注册调度 → 本地检测 ─┐
                                ├→ 双源汇总 → 状态判断 → 触发通知 → 送达
探针回调 ───────────────────────┘
         │
         └→ 执行日志记录（probe_executions）

```

当前仓库链路（已实现）：

```text
创建项目级监控 → CheckerScheduler 每 10s 扫描到期监控 → HttpChecker/TcpChecker 本地检测 ─┐
                                                                                   ├→ StateService 状态机 → NotifierService 同步 fan-out → NotificationLog
租户探针 heartbeat 获取绑定监控 → probes/results 上报结果 → CheckerService 双源汇总 ───────┘

```

说明：

- 当前本地检测结果写入 `check_logs`；探针原始结果写入 `probe_results`。
- 当前还没有 `probe_executions`，因此探针执行审计、排查、计费所需的独立执行日志待补。
- 当前通知直接调用 sender；V1.1 目标是迁移为 Redis/BullMQ 队列异步投递。
- SSL 证书监控只适用于 HTTPS monitor；证书即将过期或已过期会作为检查失败进入状态机和通知链路。

## 二、目录结构

```text
nest-beacon/
├── .agents/                            # 项目级 Codex/Agent 技能说明
├── .github/                            # CI 工作流
├── docs/
│   └── archive/monitoring-v1.1-design.md
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── scripts/
│   └── smoke-monitoring.ts             # 监控链路 smoke 脚本
├── src/
│   ├── main.ts                         # 全局 prefix、Swagger/Scalar、全局管道/过滤器
│   ├── app.module.ts
│   ├── app.controller.ts
│   ├── app.service.ts
│   │
│   ├── common/                         # 跨模块共享能力
│   │   ├── decorators/
│   │   ├── filters/                    # GlobalExceptionFilter
│   │   ├── guards/                     # JwtAuthGuard / OrgMemberGuard / RolesGuard
│   │   ├── interceptors/
│   │   ├── interfaces/
│   │   └── utils/
│   │
│   ├── config/                         # typed config factories
│   │   ├── app.config.ts
│   │   ├── database.config.ts
│   │   ├── env.ts
│   │   ├── jwt.config.ts
│   │   ├── logger.config.ts
│   │   ├── redis.config.ts
│   │   ├── resend.config.ts
│   │   └── throttler.config.ts
│   │
│   ├── infra/                          # 基础设施模块
│   │   ├── cache/                      # MultiLevelCacheService
│   │   ├── cls/                        # requestId / CLS / transaction context
│   │   ├── database/                   # PrismaModule / PrismaService
│   │   ├── logging/                    # LoggerModule / StructuredLoggerService
│   │   └── redis/                      # RedisModule / RedisService
│   │
│   ├── generated/
│   │   └── prisma/                     # Prisma 7 generated client（提交到仓库）
│   │
│   └── modules/
│       ├── auth/                       # 注册、登录、刷新 token、OTP、邮箱验证
│       │   ├── auth.controller.ts
│       │   ├── auth.module.ts
│       │   ├── auth.service.ts
│       │   ├── dto/
│       │   └── entities/
│       │
│       ├── users/                      # 用户查询与内部用户服务
│       │   ├── users.module.ts
│       │   └── users.service.ts
│       │
│       ├── organizations/              # 组织 CRUD、onboarding bootstrap
│       │   ├── organizations.module.ts
│       │   ├── organizations.controller.ts
│       │   ├── organizations.service.ts
│       │   └── dto/
│       │
│       ├── memberships/                # 成员列表、角色调整、移除成员
│       ├── invitations/                # 邀请成员、接受/撤销邀请
│       ├── projects/                   # Agile 项目
│       ├── sprints/                    # Sprint 管理
│       ├── tasks/                      # 任务、依赖、指派、移动 Sprint
│       ├── comments/                   # 任务评论
│       ├── attachments/                # 附件上传、local/OSS 存储、元数据保存
│       ├── labels/                     # 标签与任务标签
│       ├── notifications/              # 站内通知 / SSE
│       ├── audit-logs/                 # 审计日志查询
│       ├── email/                      # Resend 邮件服务与模板
│       ├── cron/                       # 邀请过期、任务提醒、token 清理
│       │
│       ├── monitors/                   # 项目级监控配置
│       │   ├── monitors.module.ts
│       │   ├── monitors.controller.ts
│       │   ├── monitors.service.ts
│       │   ├── monitors.service.spec.ts
│       │   └── dto/
│       │       ├── create-monitor.dto.ts
│       │       └── update-monitor.dto.ts
│       │
│       ├── checker/                    # 本地检测、调度、检查历史
│       │   ├── checker.module.ts
│       │   ├── checker.controller.ts
│       │   ├── checker.scheduler.ts
│       │   ├── checker.service.ts
│       │   ├── checkers/
│       │   │   ├── check-result.ts
│       │   │   ├── http.checker.ts
│       │   │   └── tcp.checker.ts
│       │   └── dto/
│       │
│       ├── state/                      # MonitorState 状态机与状态摘要
│       │   ├── state.module.ts
│       │   ├── state.controller.ts
│       │   ├── state.service.ts
│       │   └── entities/
│       │
│       ├── probes/                     # 租户探针管理 + 探针侧 ingest API
│       │   ├── probes.module.ts
│       │   ├── probes.controller.ts
│       │   ├── probe-ingest.controller.ts
│       │   ├── probes.service.ts
│       │   ├── dto/
│       │   └── entities/
│       │
│       └── notifier/                   # 监控告警渠道和发送
│           ├── notifier.module.ts
│           ├── notifier.service.ts
│           ├── notification-channels.controller.ts
│           ├── notification-channels.service.ts
│           ├── channel-config.ts
│           ├── channel-message.ts
│           ├── http.util.ts
│           ├── senders/
│           │   ├── feishu.sender.ts
│           │   ├── wecom.sender.ts
│           │   ├── dingtalk.sender.ts
│           │   ├── wechat-subscribe.sender.ts
│           │   └── email.sender.ts
│           ├── dto/
│           └── entities/
│
├── test/                               # e2e 测试
├── views/                              # 当前仅有 monitor-test.hbs 测试页
├── prisma.config.ts
├── docker-compose.yml
├── Dockerfile
├── eslint.config.mjs
├── nest-cli.json
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.build.json
└── tsconfig.json

```

当前目录结构说明：

- 当前仓库已经引入 `src/infra`，现有基础设施集中在 `database`、`redis`、`cache`、`logging`、`cls`；`queue`、`wechat` 暂未实现，避免空模块占位。
- 当前仓库已经引入 `modules/admin/system-probes`，用于平台级系统探针管理；`billing`、`status-page`、`view` 模块仍是 V1.1 后续目标演进项。
- 当前数据库能力已迁移到 `src/infra/database/`，配置仍位于 `src/config/`。
- 当前监控归属项目，因此 `monitors` 和 `checker/state` 路由都以 `projectId` 为主要租户解析入口。
- 当前 `notifications` 与 `notifier` 分工不同：前者是站内通知，后者是监控告警渠道。

## 三、ER 关系图

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌──────────┐       ┌──────────────┐       ┌──────────────┐            │
│  │   User   │──1:N──│  Membership  │──N:1──│ Organization │            │
│  └──────────┘       └──────────────┘       └──────┬───────┘            │
│       │                                            │                    │
│       │                                            │                    │
│       │ 1:N                                        │ 1:N                │
│       ▼                                            ▼                    │
│  ┌──────────┐                              ┌──────────────┐            │
│  │  OTP /   │                              │   Monitor    │            │
│  │ Refresh  │                              └──────┬───────┘            │
│  │  Token   │                                     │                    │
│  └──────────┘                                     │ 1:1                │
│                                                   ▼                    │
│                                            ┌──────────────┐            │
│                                            │ MonitorState │            │
│                                            └──────────────┘            │
│                                                                         │
│  ┌──────────────┐       ┌────────────────┐                             │
│  │ Organization │──1:N──│     Probe      │                             │
│  └──────────────┘       │  scope: SYSTEM │                             │
│                         │       | TENANT │                             │
│                         └───────┬────────┘                             │
│                                 │                                      │
│                    ┌────────────┼────────────┐                        │
│                    │            │            │                        │
│                    ▼            ▼            ▼                        │
│            ┌──────────┐  ┌──────────┐  ┌──────────────┐              │
│            │MonitorProbe│  │ProbeResult│  │ProbeExecution│             │
│            │  (N:M)    │  │  (1:N)    │  │   (1:N)      │             │
│            └──────────┘  └──────────┘  └──────────────┘              │
│                                                                         │
│  ┌──────────────┐       ┌────────────────────┐                        │
│  │ Organization │──1:N──│NotificationChannel │                        │
│  └──────────────┘       └─────────┬──────────┘                        │
│                                   │                                   │
│                                   │ 1:N                               │
│                                   ▼                                   │
│                         ┌──────────────────┐                          │
│                         │ NotificationLog  │                          │
│                         └──────────────────┘                          │
│                                                                         │
│  ┌──────────────┐       ┌──────────────┐                              │
│  │ Organization │──1:N──│  StatusPage  │                              │
│  └──────────────┘       └──────────────┘                              │
│                                                                         │
│  ┌──────────────┐       ┌──────────────┐                              │
│  │   Monitor    │──1:N──│   CheckLog   │                              │
│  └──────────────┘       └──────────────┘                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

关系说明

| 关系                                  | 类型                     | 说明                                           |
| ------------------------------------- | ------------------------ | ---------------------------------------------- |
| User ↔ Organization                   | N:M（通过 Membership）   | 用户可属于多个组织                             |
| Organization → Monitor                | 1:N                      | 一个组织多个监控                               |
| Monitor → MonitorState                | 1:1                      | 每个监控一个状态                               |
| Monitor ↔ Probe                       | N:M（通过 MonitorProbe） | 租户探针显式绑定                               |
| Organization → Probe                  | 1:N                      | 租户探针归属组织；系统探针 organizationId=null |
| Probe → ProbeResult                   | 1:N                      | 探针检测结果                                   |
| Probe → ProbeExecution                | 1:N                      | 探针执行日志                                   |
| Monitor → CheckLog                    | 1:N                      | 本地检测历史                                   |
| Organization → NotificationChannel    | 1:N                      | 通知渠道配置                                   |
| NotificationChannel → NotificationLog | 1:N                      | 通知发送日志                                   |
| Organization → StatusPage             | 1:N                      | 状态页                                         |

## 四、完整 Prisma Schema

完整目标 Schema 与当时的适配差异见 [Schema 归档](monitoring-v1.1-schema.md)。

## 五、接口总览

### 5.1 租户侧接口

| 模块     | 方法                               | 路径                               | 说明                 |
| -------- | ---------------------------------- | ---------------------------------- | -------------------- |
| 组织     | POST                               | /organizations                     | 创建组织             |
| 组织     | GET                                | /organizations                     | 我的组织列表         |
| 组织     | GET                                | /organizations/:orgId              | 组织详情             |
| 组织     | PATCH                              | /organizations/:orgId              | 更新组织             |
| 组织     | POST                               | /organizations/:orgId/invites       | 邀请成员             |
| 组织     | GET                                | /organizations/:orgId/members       | 成员列表             |
| 监控     | POST                               | /organizations/:orgId/monitors     | 创建监控             |
| 监控     | GET                                | /organizations/:orgId/monitors      | 监控列表             |
| 监控     | GET                                | /monitors/:id                      | 监控详情             |
| 监控     | PATCH                              | /monitors/:id                      | 更新监控             |
| 监控     | PATCH                              | /monitors/:id/toggle               | 启用/禁用            |
| 监控     | DELETE                             | /monitors/:id                      | 软删除               |
| 租户探针 | POST                               | /organizations/:orgId/probes       | 创建探针             |
| 租户探针 | GET                                | /organizations/:orgId/probes        | 探针列表（仅 TENANT） |
| 租户探针 | GET                                | /probes/:id                        | 探针详情             |
| 租户探针 | PATCH                              | /probes/:id/toggle                 | 启用/停用            |
| 租户探针 | DELETE                             | /probes/:id                        | 删除                 |
| 租户探针 | GET                                | /probes/:id/executions             | 执行日志             |
| 探针回调 | POST                               | /probe/callback                    | 探针回调（探针调用） |
| 状态     | GET                                | /organizations/:orgId/status       | 状态总览             |
| 状态     | GET                                | /monitors/:id/history              | 检测历史             |
| 通知渠道 | POST                               | /organizations/:orgId/channels     | 创建渠道             |
| 通知渠道 | GET                                | /organizations/:orgId/channels      | 渠道列表             |
| 通知渠道 | PATCH                              | /channels/:id/toggle               | 启用/停用            |
| 状态页   | POST                               | /organizations/:orgId/status-pages | 创建状态页           |
| 状态页   | GET                                | /organizations/:orgId/status-pages | 列表                 |
| 状态页   | PATCH                              | /status-pages/:id                  | 更新                 |
| 状态页   | GET                                | /status/:slug                      | 公开访问（无需鉴权） |
| 计费     | POST                               | /billing/checkout                  | 创建支付订单         |
| 计费     | POST                               | /billing/webhook                   | 支付回调             |
| 计费     | GET                                | /billing/plans                     | 套餐列表             |

### 5.1.1 当前仓库已实现接口映射

| 能力              | 当前接口                                                      | 状态   | 备注                                              |
| ----------------- | ------------------------------------------------------------- | ------ | ------------------------------------------------- |
| 监控列表          | `GET /projects/:projectId/monitors`                           | 已实现 | 项目级，不是组织级                                |
| 创建监控          | `POST /projects/:projectId/monitors`                          | 已实现 | 支持 `checkSsl`、`sslExpiryThreshold`             |
| 监控详情          | `GET /projects/:projectId/monitors/:id`                       | 已实现 | 通过 projectId 做租户解析                         |
| 更新监控          | `PATCH /projects/:projectId/monitors/:id`                     | 已实现 | 目标/SSL 配置变化会重置运行态                     |
| 暂停监控          | `POST /projects/:projectId/monitors/:id/pause`                | 已实现 | 对应目标设计里的 toggle disable                   |
| 恢复监控          | `POST /projects/:projectId/monitors/:id/resume`               | 已实现 | 对应目标设计里的 toggle enable                    |
| 软删除监控        | `DELETE /projects/:projectId/monitors/:id`                    | 已实现 | 设置 `deletedAt`                                  |
| 恢复监控          | `POST /projects/:projectId/monitors/:id/restore`              | 已实现 | 目标设计未单列                                    |
| 手动检查          | `POST /projects/:projectId/monitors/:monitorId/check`         | 已实现 | MEMBER 及以上                                     |
| 检查历史          | `GET /projects/:projectId/monitors/:monitorId/checks`         | 已实现 | 目标设计为 `/monitors/:id/history`                |
| 当前状态          | `GET /projects/:projectId/monitors/:monitorId/state`          | 已实现 | 含 24h uptime/latency                             |
| 租户探针列表      | `GET /organizations/:orgId/probes`                            | 已实现 | 当前全部为租户探针                                |
| 创建租户探针      | `POST /organizations/:orgId/probes`                           | 已实现 | 返回 secret                                       |
| 更新探针          | `PATCH /organizations/:orgId/probes/:id`                      | 已实现 | 目标设计为 toggle，当前为通用 update              |
| 删除探针          | `DELETE /organizations/:orgId/probes/:id`                     | 已实现 | 硬删除探针和结果                                  |
| 轮换探针密钥      | `POST /organizations/:orgId/probes/:id/rotate-secret`         | 已实现 | 目标设计未单列                                    |
| 绑定监控          | `POST /organizations/:orgId/probes/:id/monitors`              | 已实现 | monitor 必须属于同组织                            |
| 解绑监控          | `DELETE /organizations/:orgId/probes/:id/monitors/:monitorId` | 已实现 | 目标设计未单列                                    |
| 探针结果          | `GET /organizations/:orgId/probes/:id/results`                | 已实现 | 目标设计是 executions，当前是 raw results         |
| 探针 heartbeat    | `POST /probes/heartbeat`                                      | 已实现 | 使用 `x-probe-secret`，公开路由                   |
| 探针结果上报      | `POST /probes/results`                                        | 已实现 | 使用 `x-probe-secret`，公开路由                   |
| 通知渠道列表      | `GET /organizations/:orgId/notification-channels`             | 已实现 | 目标设计路径为 `/channels`                        |
| 创建通知渠道      | `POST /organizations/:orgId/notification-channels`            | 已实现 | 支持 Feishu/WeCom/DingTalk/WeChat Subscribe/Email |
| 更新通知渠道      | `PATCH /organizations/:orgId/notification-channels/:id`       | 已实现 | 可启停                                            |
| 删除通知渠道      | `DELETE /organizations/:orgId/notification-channels/:id`      | 已实现 | 硬删除                                            |
| 测试通知渠道      | `POST /organizations/:orgId/notification-channels/:id/test`   | 已实现 | 目标设计未单列                                    |
| 通知日志          | `GET /organizations/:orgId/notification-channels/:id/logs`    | 已实现 | 按 channel 查询                                   |
| 状态页 CRUD       | `/organizations/:orgId/status-pages`                          | 待实现 | 仅 schema 已有                                    |
| 公开状态页        | `GET /status/:slug`                                           | 待实现 | 需 Public 路由                                    |
| 组织/项目状态总览 | `GET /organizations/:orgId/status`                            | 待实现 | 建议补项目级聚合                                  |
| 计费              | `/billing/*`                                                  | 待实现 | 文档目标                                          |

### 5.2 运营后台接口

| 模块     | 方法                                | 路径                    | 说明         |
| -------- | ----------------------------------- | ----------------------- | ------------ |
| 租户管理 | GET                                 | /admin/tenants          | 所有组织列表 |
| 租户管理 | GET                                 | /admin/tenants/:id       | 组织详情     |
| 租户管理 | PATCH                               | /admin/tenants/:id       | 调整套餐     |
| 租户管理 | PATCH                               | /admin/tenants/:id/toggle | 启用/停用   |
| 系统探针 | POST                                | /admin/system-probes    | 创建系统探针 |
| 系统探针 | GET                                 | /admin/system-probes     | 列表         |
| 系统探针 | PATCH                               | /admin/system-probes/:id/toggle | 启用/停用 |
| 系统探针 | DELETE                              | /admin/system-probes/:id | 删除         |
| 系统探针 | POST                                | /admin/system-probes/rebalance | 手动触发重新分配 |
| 系统探针 | GET                                 | /admin/system-probes/:id/executions | 执行日志 |
| 指标     | GET                                 | /admin/metrics/overview | 系统概览     |
| 指标     | GET                                 | /admin/metrics/tenants   | 租户用量统计 |
| 审计     | GET                                 | /admin/audit-logs       | 审计日志     |

## 六、模块依赖关系

```text
┌─────────────────────────────────────────────────────────────────┐
│                        依赖方向（上层依赖下层）                   │
└─────────────────────────────────────────────────────────────────┘

AdminModule
  ├── TenantsService ──▶ PrismaService
  ├── SystemProbeService ──▶ PrismaService + RedisService
  └── MetricsService ──▶ PrismaService

BillingModule ──▶ OrganizationsModule + WechatModule

StatusPageModule ──▶ MonitorsModule + StateModule

StatusModule ──▶ MonitorsModule + ProbeModule

NotifierModule ──▶ BullModule(Redis) + WechatModule
  └── NotifierRepository ──▶ PrismaService

StateModule ──▶ PrismaService

CheckerModule ──▶ StateModule + NotifierModule
  ├── SchedulerService ──▶ PrismaService + CheckerService
  ├── CheckerService ──▶ StateService + NotifierService
  ├── HttpChecker
  └── TcpChecker

ProbeModule ──▶ CheckerModule(CheckerService)
  ├── ProbeService ──▶ ProbeRepository + CheckerService
  └── ProbeRepository ──▶ PrismaService

MonitorsModule ──▶ CheckerModule(SchedulerService)
  ├── MonitorsService ──▶ MonitorsRepository + SchedulerService
  └── MonitorsRepository ──▶ PrismaService

OrganizationsModule ──▶ PermissionsModule
  ├── OrganizationsService ──▶ PrismaService
  ├── MembersService ──▶ PrismaService
  └── InvitesService ──▶ PrismaService

AuthModule ──▶ UsersModule + WechatModule

UsersModule ──▶ PrismaService

SharedModule
  ├── TenancyModule ──▶ PrismaService
  ├── PermissionsModule ──▶ PrismaService
  └── QuotaModule ──▶ PrismaService

InfraModule（全局）
  ├── PrismaModule
  ├── RedisModule
  ├── WechatModule
  ├── ConfigModule
  └── LoggerModule

```

### 6.1 当前仓库模块依赖适配

当前仓库没有单独的 `infra/`、`shared/` 和 repository 层，依赖关系按现有 Nest 模块实现：

```text
MonitorsModule ──▶ PrismaService

CheckerModule ──▶ StateModule + NotifierModule + PrismaService
  ├── CheckerScheduler ──▶ CheckerService
  ├── CheckerService ──▶ StateService + NotifierService + HttpChecker + TcpChecker
  ├── HttpChecker
  └── TcpChecker

ProbesModule ──▶ CheckerModule + PrismaService
  ├── ProbesService ──▶ CheckerService + PrismaService
  ├── ProbesController（租户侧管理）
  └── ProbeIngestController（探针侧 heartbeat/results）

StateModule ──▶ PrismaService

NotifierModule ──▶ EmailModule + PrismaService
  ├── NotificationChannelsService ──▶ PrismaService
  ├── NotifierService ──▶ StateService + channel senders
  └── senders ──▶ HTTP webhook / EmailService
```

NotificationsModule（产品内通知）与 NotifierModule（监控告警）是两套不同概念：

- `notifications`：用户站内通知，服务于 Agile workspace。
- `notifier`：监控告警渠道配置和告警发送。

关键依赖规则

| 规则                                     | 说明                                                |
| ---------------------------------------- | --------------------------------------------------- |
| Controller 只调用本模块 Service          | 不跨模块调用 Service                                |
| Service 只依赖本模块 Repository + Shared | 跨模块走对方 Service                                |
| Repository 只依赖 PrismaService          | 不写业务逻辑                                        |
| AdminModule 独立                         | 用 AdminRepository 跨租户查询，不依赖租户侧 Service |
| CheckerModule 是核心枢纽                 | Monitors 和 Probe 都依赖它的 Scheduler 和 Checker   |
| NotifierModule 通过队列解耦              | 检测和通知异步化                                    |

## 七、关键设计总结

| 维度         | 决策                                             | 理由                                             |
| ------------ | ------------------------------------------------ | ------------------------------------------------ |
| 架构形态     | 模块化单体                                       | 小团队交付，避免微服务复杂度                     |
| 多租户隔离   | organizationId + projectId 行级过滤              | 当前沿用 Agile workspace 的项目边界              |
| 监控归属     | Project 级监控优先                               | 贴合现有项目空间；未来如需独立监控产品再剥离     |
| 探针分层     | SYSTEM（目标）+ TENANT（已实现）                 | 先交付租户探针，系统探针后续补齐                 |
| 系统探针分配 | Redis 动态分配，不落库                           | 目标能力，当前未实现                             |
| 租户探针绑定 | monitor_probes 显式绑定                          | 已实现，租户完全掌控                             |
| 双源确认     | 本地失败 + 绑定探针近期成功则不 DOWN             | 已实现，用于过滤单点网络抖动                     |
| 探针过期降级 | 超过 2 周期未更新，排除该探针                    | 目标能力，当前仅按近期 probe result 窗口参与汇总 |
| 状态机       | UP ↔ DEGRADED ↔ DOWN                             | 已实现，DEGRADED 缓冲避免抖动误报                |
| 首次检测     | 只建基线，不通知                                 | 已实现：UNKNOWN 作为 previousStatus 时不通知     |
| 通知方式     | 当前同步 fan-out；目标 Redis 队列异步 + 失败重试 | 先可用，后增强可靠性                             |
| 执行日志     | probe_executions 独立表                          | 目标能力，当前未实现                             |
| SSL 监控     | HTTPS 证书有效期检查                             | 已实现，为 V1.1 扩展能力                         |
| 软删除       | Monitor 用 deletedAt                             | 已实现，保留历史数据                             |
| Prisma v7    | ESM + 驱动适配器 + 自定义 output                 | 必须显式配置                                     |

演进摘要与详细阶段计划见 [V1.1 路线图](monitoring-v1.1-roadmap.md)。

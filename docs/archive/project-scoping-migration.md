# Project-scoped business adjustment plan

> 文档类型：历史归档。原文中的“当前状态”、缺口、示例和阶段计划均属于当时的设计快照，不代表最新实现；日常使用请从 [文档索引](../README.md) 查找现行接口与运行指南。

生成时间：2026-10-04

## 背景

当前 Beacon 的主业务链路是：

```text
User -> Organization -> Project -> business resources
```

现有敏捷任务业务已经基本遵循这个模型，例如 tasks/sprints/comments 多数从 `projectId` 或 `taskId` 反推组织上下文。但新接入的监控业务仍然以 organization 为主入口：

```text
/organizations/:orgId/monitors
/organizations/:orgId/monitors/:monitorId/check
/organizations/:orgId/monitors/:monitorId/state
```

这会让监控配置变成“组织级业务资源”，与实际“业务基于 project 开发”的边界不一致。

## 目标

把监控业务资源下沉到 Project：

```text
/projects/:projectId/monitors
/projects/:projectId/monitors/:monitorId/check
/projects/:projectId/monitors/:monitorId/state
```

Project 继续通过现有 `OrgMemberGuard` / `RolesGuard` 解析所属 Organization，因此 RBAC 和租户隔离仍然沿用现有体系。

## 范围

本轮实施聚焦监控业务：

| 资源                  | 调整                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Monitor               | 增加 `projectId`，作为业务归属                                                                       |
| Monitor CRUD          | 从 organization route 改成 project route                                                             |
| Manual check          | 从 project route 进入，并验证 monitor 属于该 project                                                 |
| Check logs            | 从 project route 查询                                                                                |
| Monitor state         | 从 project route 查询                                                                                |
| Probe binding         | 管理接口仍挂组织级 probe 下，但绑定 monitor 时校验 monitor 属于同组织；monitor 本身已有 project 归属 |
| Notification channels | 保留组织级。它更像通知基础设施，可被同组织多个项目复用                                               |
| Probes                | 保留组织级。探针也是组织基础设施，不强制项目化                                                       |

## 不在本轮范围

- 不改 tasks/sprints/comments 等已有项目业务。
- 不把 Probe / NotificationChannel 强制下沉到 Project。
- 不新增 project-level notification routing 规则。
- 不重写 audit log org 解析逻辑；继续使用 `projectId` 反推 org。

## 数据模型调整

`Monitor` 新增：

```prisma
projectId String
project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

@@index([projectId])
@@index([projectId, enabled])
```

`Project` 新增：

```prisma
monitors Monitor[]
```

`organizationId` 暂时保留在 `Monitor` 上：

- 便于通知、探针、审计、列表查询继续使用现有组织上下文。
- 避免一次改动跨太多模块。
- 创建 monitor 时由 project 读取并写入 `organizationId`，保证二者一致。

## API 调整

### Monitor

| 旧路径                                            | 新路径                                           |
| ------------------------------------------------- | ------------------------------------------------ |
| `GET /organizations/:orgId/monitors`              | `GET /projects/:projectId/monitors`              |
| `POST /organizations/:orgId/monitors`             | `POST /projects/:projectId/monitors`             |
| `GET /organizations/:orgId/monitors/:id`          | `GET /projects/:projectId/monitors/:id`          |
| `PATCH /organizations/:orgId/monitors/:id`        | `PATCH /projects/:projectId/monitors/:id`        |
| `POST /organizations/:orgId/monitors/:id/pause`   | `POST /projects/:projectId/monitors/:id/pause`   |
| `POST /organizations/:orgId/monitors/:id/resume`  | `POST /projects/:projectId/monitors/:id/resume`  |
| `DELETE /organizations/:orgId/monitors/:id`       | `DELETE /projects/:projectId/monitors/:id`       |
| `POST /organizations/:orgId/monitors/:id/restore` | `POST /projects/:projectId/monitors/:id/restore` |

### Checks / State

| 旧路径                                                 | 新路径                                                |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `POST /organizations/:orgId/monitors/:monitorId/check` | `POST /projects/:projectId/monitors/:monitorId/check` |
| `GET /organizations/:orgId/monitors/:monitorId/checks` | `GET /projects/:projectId/monitors/:monitorId/checks` |
| `GET /organizations/:orgId/monitors/:monitorId/state`  | `GET /projects/:projectId/monitors/:monitorId/state`  |

## 实施步骤

1. 修改 Prisma schema：`Project.monitors` + `Monitor.projectId/project` + index。
2. 生成迁移并运行 `pnpm prisma:generate`。
3. 修改 `MonitorsController` 路径和参数。
4. 修改 `MonitorsService`：所有入口从 `projectId` 开始，先读取 project 获取 `organizationId`，再创建/查询 monitor。
5. 修改 `CheckerController` 和 `CheckerService`：从 `projectId` 约束 monitor。
6. 修改 `StateController` 和 `StateService`：从 `projectId` 约束 monitor。
7. 更新单元测试和冒烟脚本。
8. 运行 `pnpm test`、`pnpm type-check`、`pnpm build`。

## 风险与注意事项

- 生产已有 monitor 数据时，新增必填 `projectId` 需要数据迁移策略。本地开发迁移可以先创建字段；真实生产需要按现有 monitor 归属回填 project。
- Probe result 当前仍按 target 匹配 monitor。如果同一 project 或同组织多个 project 使用相同 target，未来建议给 `ProbeResult` 增加 `monitorId`。
- NotificationChannel 仍是组织级资源；如果未来要支持项目级渠道，需要新增 `projectId` 或中间表。

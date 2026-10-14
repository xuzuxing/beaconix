# 002：邀请项目授权与项目级权限控制设计

## 状态与结论

- 日期：2026-10-11。
- 状态：TODO，设计方案，尚未实施。
- 优先级：P1；工作量：L；实施风险：HIGH，涉及现有访问权限收紧。
- 基准：`D:/zuxcloud/nest-beacon`，提交 `04e9253`，并包含本次分析时的未提交修改。
- 依赖：无新增外部权限框架；必须兼容已经存在的项目监控与工作区通知。
- 本文只设计后端及前端接口契约，不实现前端，也不修改数据库。

**推荐采用“组织身份 + 显式项目授权”双层权限。**

组织 MEMBER/VIEWER 加入团队，不再自动获得任何项目权限。邀请时选择项目，并分别指定查看、协作或管理权限；接受邀请后，组织成员关系和项目授权一次性事务落库。组织 OWNER/ADMIN 仍管理全部项目，包括未来新增项目。

特别注意：**“某项目管理员”必须是组织 MEMBER + 项目 ADMIN，不能通过邀请组织 ADMIN 实现。** 后者是整个团队的管理员，不支持限制为单个项目。

## 1. 问题与现状依据

当前不是跨组织隔离缺失，而是同一组织内没有项目级授权边界。已有组织 RBAC 无法表达“张三只查看 A、管理 B、看不到 C”。

| 位置 | 已核对现状 | 本次影响 |
| --- | --- | --- |
| `prisma/schema.prisma:370` | Membership 仅关联用户、组织与组织角色 | 没有项目成员关系 |
| `prisma/schema.prisma:392` | Invitation 仅存组织和组织角色 | 邀请无法携带项目授权 |
| `src/common/guards/org-member.guard.ts:28` | 查询 `userId_organizationId` | 属于组织即可通过项目读接口 |
| `src/common/guards/roles.guard.ts:42` | 按组织角色比较角色等级 | 无法判断项目内角色 |
| `src/modules/projects/projects.controller.ts:50` | `findAll` 只传 `orgId` | 查询没有当前用户上下文 |
| `src/modules/projects/projects.service.ts:51` | 项目仅按组织和软删除过滤 | 返回组织的所有项目 |
| `src/modules/invitations/dto/create-invitation.dto.ts:6` | 只支持 `email`、`role` | 没有项目选择 |
| `src/modules/invitations/invitations.service.ts:245` | 接受邀请事务创建 Membership | 必须在同一事务创建项目授权 |
| `src/modules/monitoring/monitoring.service.ts:22` | 组织概览汇总组织全部监控 | 不能仅限制项目列表 |
| `src/modules/developer-api/auth/developer-auth.guard.ts:106` | PAT 检查组织成员关系和 scopes | 开发者 API 也必须执行项目权限 |
| `src/modules/notifications/notifications.service.ts:262` | 任务受众按组织成员过滤 | 已撤项目权限者仍可能成为受众 |
| `src/modules/notifications/notifications.service.ts:379` | 通知查询只按收件人过滤 | 撤权后历史通知仍可能暴露内容 |

现有代码摘录，供实施时核对：

```typescript
// src/modules/projects/projects.service.ts:51
async findAll(orgId: string) {
    const projects = await this.prisma.project.findMany({
        where: { organizationId: orgId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
    });
    return projects.map((p) => new ProjectEntity(p));
}
```

```typescript
// src/modules/invitations/invitations.service.ts，acceptById 内
await tx.membership.create({
    data: {
        userId,
        organizationId: invitation.organizationId,
        role: invitation.role,
        invitedById: invitation.sentById,
    },
});
```

另一个需要一并关闭的缺口：任务创建/修改、评论和附件写入等部分接口仅使用 OrgMemberGuard，没有最低写角色约束。因此“项目只读”必须显式禁止写入，不能沿用当前这些接口的守卫配置。

遵循现有产品决策：`docs/archive/project-scoping-migration.md` 已明确 `Project -> Monitor`，Probe 和 NotificationChannel 保留组织级基础设施，不在本次强行项目化；`docs/design/workspace-notifications.md` 的事务 outbox、去重和跨实例 SSE 保留。

## 2. 产品目标与非目标

### 目标

1. 邀请时可给同一用户分配不同项目、不同权限。
2. 未授权项目不出现在列表、概览、统计、通知和关联资源中。
3. 知道项目、任务、附件或监控 ID，也不能绕过授权。
4. 项目只读者不能创建、修改、删除业务数据或触发检查/告警。
5. 加入、修改权限、撤权、移出团队有明确且可审计的生命周期。
6. 浏览器 JWT 和开发者 PAT 共用项目权限判断。

### 非目标

- 不引入自定义角色、按钮级权限、CASL、OPA、权限策略编辑器。
- 不新增“整个团队所有项目但不是管理员”的自动继承角色。
- 不实现任务级 ACL，也不让任务创建者、负责人、关注者绕过项目权限。
- 不修改监控执行引擎、计费逻辑或探针调度算法。
- 不把公开状态页伪装成私有项目资源。
- 不在这个后端仓库实现邀请页面或团队管理页面。

## 3. 权限模型

### 3.1 组织角色

| 组织角色 | 项目范围 | 团队管理 |
| --- | --- | --- |
| OWNER | 全部现有和未来项目 | 全部权限，包括组织删除与所有权转移 |
| ADMIN | 全部现有和未来项目 | 团队配置、成员与普通邀请管理 |
| MEMBER | 仅显式授权的项目 | 无团队配置/角色管理权 |
| VIEWER | 仅显式授权的项目，且始终只读 | 无团队管理权 |

SUPER_ADMIN 保留平台级运维例外，但仍校验请求中的资源确实存在、父子归属一致、组织状态有效；不能因为旁路而跳过数据归属验证。

建议本版将“授予组织 ADMIN”收紧为 OWNER/SUPER_ADMIN 执行，包括邀请与成员晋升；组织 ADMIN 仍可管理 MEMBER/VIEWER。该规则会收紧当前 ADMIN 邀请 ADMIN 的能力，上线前需要产品确认，不能静默改变。

### 3.2 项目角色

新增独立 `ProjectRole`：`VIEWER`、`MEMBER`、`ADMIN`，等级依次为 1、2、3。

| 能力 | 项目 VIEWER | 项目 MEMBER | 项目 ADMIN | 组织 OWNER/ADMIN |
| --- | --- | --- | --- | --- |
| 查看项目、任务、评论、附件 | 是 | 是 | 是 | 是 |
| 查看监控、状态、检查记录、概览 | 是，敏感字段脱敏 | 是，敏感字段脱敏 | 是，密钥仍不明文回显 | 是 |
| 创建/修改任务、分配、移动迭代、维护依赖 | 否 | 是 | 是 | 是 |
| 评论、上传、维护任务标签 | 否 | 是 | 是 | 是 |
| 删除任务 | 否 | 是，保留现有业务规则 | 是 | 是 |
| 修改自己的评论 | 否 | 是 | 是 | 是 |
| 删除他人评论/附件 | 否 | 否 | 是 | 是 |
| 修改他人评论正文 | 否 | 否 | 否，保留“仅作者编辑”规则 | 否，保留现有规则 |
| 手动监控检查 | 否 | 是 | 是 | 是 |
| 配置监控、规则绑定、暂停/恢复、测试告警 | 否 | 否 | 是 | 是 |
| 管理迭代、项目标签、项目设置、归档 | 否 | 否 | 是 | 是 |
| 恢复软删除任务/监控 | 否 | 否 | 是 | 是 |
| 删除/恢复项目 | 否 | 否 | 否，本版保留团队级破坏性操作 | 是 |
| 分配项目访问权限、邀请新团队成员 | 否 | 否 | 否，本版不委托项目 ACL 管理 | 是 |
| 创建项目、管理探针/渠道/API Key、计费 | 否 | 否 | 否 | 是 |

项目管理员负责项目业务管理，不代表能管理团队成员或随意扩大他人的项目范围。这样可以直接满足“管理某几个项目”，而不引入授权委托与角色提权复杂度。

### 3.3 最终权限计算

对用户请求：

```text
用户有效 + 组织有效 + 实际资源归属一致
    -> SUPER_ADMIN：按平台例外执行
    -> 必须存在当前组织 Membership
    -> OWNER/ADMIN：获得所有项目业务权限
    -> MEMBER/VIEWER：必须存在当前 ProjectMembership
       -> 组织 MEMBER：使用项目角色
       -> 组织 VIEWER：最终最高只能是项目 VIEWER
    -> 角色允许该操作
    -> 同时满足归档状态、作者/上传者等原有业务规则
```

- 无项目记录 = 无权限；不是 VIEWER，也不是全项目。
- 组织 MEMBER 的权限上限不限制到项目 MEMBER，否则无法授予局部项目管理权。
- 组织 VIEWER 只允许创建 VIEWER 项目授权；遗留非法高权限记录也必须由运行时只读上限兜底。
- 将组织 MEMBER 降为 VIEWER 时，同事务把项目授权降为 VIEWER；以后晋升回来不自动恢复旧写权限。
- 组织 ADMIN 降为 MEMBER/VIEWER 时，只保留经管理员明确设置的项目授权；没有记录则无项目权限。
- 组织角色晋升 ADMIN 是全团队权限扩张，不能用来代替批量项目授权。
- 归档项目对普通业务写操作只读，角色不能绕过；必要生命周期动作使用明确的例外操作。
- 已删组织/项目拒绝普通访问；恢复接口明确允许查找对应软删除资源，但不放开其他接口。

## 4. 数据模型

### 4.1 ProjectMembership：正式项目授权

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| id | CUID 主键 | 审计和独立引用 |
| organizationId | String | 显式组织边界 |
| membershipId | String | 关联组织 Membership，而非仅 userId |
| projectId | String | 关联 Project |
| role | ProjectRole | VIEWER / MEMBER / ADMIN |
| grantedById | String? | 授权操作者；用户删除可置空，审计保留记录 |
| createdAt / updatedAt | DateTime | 授权时间 |

数据库约束：

- Membership 新增 `@@unique([id, organizationId])`。
- Project 新增 `@@unique([id, organizationId])`。
- ProjectMembership 通过 `(membershipId, organizationId)` 复合外键引用 Membership。
- ProjectMembership 通过 `(projectId, organizationId)` 复合外键引用 Project。
- 唯一约束 `(membershipId, projectId)`，同一团队成员在项目中只有一个当前角色。
- 索引 `(projectId, role)`、`(membershipId, organizationId)`。
- 移除组织 Membership 时级联删除其项目授权，重新加入组织不会复活旧授权。
- 软删除项目不物理删除授权，恢复项目后原授权有效；业务访问仍受 `deletedAt` 约束。
- 为相关模型增加反向 relation；`grantedById` 若建 User 外键则使用独立命名 relation + SetNull。
- `Project.createdById` 仅表示创建历史，不是访问授权，不作为权限旁路。

这里冗余 `organizationId` 的目的不是查询方便，而是通过复合外键拒绝“组织 A 的成员授权组织 B 的项目”。服务层也必须校验，不能只依赖 DTO。

### 4.2 InvitationProjectGrant：待接受授权

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| id | CUID 主键 | 待授予记录 |
| invitationId | String | 邀请 ID |
| organizationId | String | 组织一致性 |
| projectId | String | 被邀请项目 |
| role | ProjectRole | 接受后的项目角色 |
| createdAt | DateTime | 创建时间 |

- Invitation 新增 `@@unique([id, organizationId])`。
- 对 Invitation、Project 使用包含 organizationId 的复合外键。
- 唯一 `(invitationId, projectId)`；索引 `(projectId)`。
- 邀请删除级联删除 grants；项目物理删除对未清理 grants 使用 Restrict，避免悄悄缩小邀请内容。
- 权限在发送时固定，不随以后新建项目扩张。
- 本版不修改待接受邀请的授权内容：需要变更时撤销再重发，避免被邀请人接受与界面展示不一致。
- 保留当前邀请状态、邮箱匹配、有效期、并发领取与 outbox 行为。

### 4.3 通知的可查询授权范围

为 Notification 增加 `organizationId?`、`projectId?` 和明确的 `accessScope`：

```text
ACCOUNT       账号自身事件
INVITATION    发给指定邮箱对应用户的邀请事件
ORGANIZATION  团队级事件
PROJECT       项目私有业务事件
UNKNOWN       迁移期间尚未可靠归类的历史事件，默认拒绝显示/投递
```

- PROJECT 必须有 projectId/organizationId；数据库 CHECK 和服务验证同时约束。
- 使用独立标量保留历史范围，或不可扩权的外键策略；不要使用 SetNull 后自动视为 ACCOUNT。
- 索引建议 `(userId, accessScope, projectId, isRead)`，保留必要已有索引，最终用测试数据验证查询计划。
- NotificationEvent 和 NotificationDelivery 的 audience 携带对应范围，不能只放进任意 JSON meta。
- 授权范围来源为服务器解析的实体，不接受客户端自报。
- 无法可靠回填范围的历史项目通知不显示、不计入未读、不再投递；不能当成账号通知放行。
- 扩展迁移期间旧代码写入的通知默认 UNKNOWN；新代码每次写入必须显式指定合法范围，禁止默认 ACCOUNT 自动放行。

## 5. 邀请流程与接口契约

### 5.1 发送邀请

沿用 `POST /api/organizations/:orgId/invitations`，保留 `role` 表示组织角色，增加 `projects`：

```json
{
  "email": "colleague@example.com",
  "role": "MEMBER",
  "projects": [
    { "projectId": "project-a", "role": "VIEWER" },
    { "projectId": "project-b", "role": "ADMIN" }
  ]
}
```

结果：该用户只能查看 A、管理 B，看不到 C，也不会自动看到以后新增的 D。

约束：

- `role` 缺省仍为 MEMBER；`projects` 对 MEMBER/VIEWER 必填且至少一项，V1 不新增“仅加入组织”邀请模式。
- ADMIN 邀请明确意味着全部项目；`projects` 必须不提供，不接受伪装成部分项目限制。
- 每项嵌套 DTO 验证 projectId、ProjectRole；限制最多 100 个项目，拒绝重复项目和多余字段。
- VIEWER 组织邀请的所有项目角色必须为 VIEWER。
- 项目必须属于当前组织、未删除、ACTIVE；发送者必须当前仍有组织邀请/授权权。
- 已是组织成员继续返回 409；增加其项目权限走成员权限管理接口，不混用重新邀请。
- 邀请与 InvitationProjectGrant、站内通知、邮件意图在同一事务创建。
- 邀请邮件不携带项目配置、监控目标、token 以外的敏感资源信息；完整权限摘要在认证后的邀请详情展示。
- 旧客户端不传 projects，普通邀请返回 400，不能偷偷退回“全部项目”。需要与前端同步发版。

### 5.2 邀请详情

`pending`、`by-id`、管理端邀请列表返回 `projects: [{ projectId, projectName, role }]`；组织 ADMIN 邀请返回 `accessMode: "ALL_PROJECTS"`，普通邀请返回 `"SELECTED_PROJECTS"`。

将现有公开 token 预览收紧为仅返回组织名、邀请状态和是否需要登录，不返回项目名、项目 ID、权限清单或发送者邮箱；完整详情在登录并校验被邀请邮箱后查看。当前预览返回 InvitationEntity，实施时需要新增最小公开响应 DTO，并同步调整客户端。响应实体必须白名单映射，不能 `Object.assign` 整个含敏感 relation 的 Prisma 对象。

发送/接受接口禁止把项目配置通过 relation include 一并返回。站内通知不含邀请 token，保留现有规定。

### 5.3 接受邀请

沿用 `acceptById` 与 token 路由共用逻辑：

1. 查邀请，验证当前用户有效、邮箱已验证且匹配。
2. 锁定授权发起者当前 Membership，复查仍有发送该级别邀请的权力；离职、被降权的邀请者不能留下可继续授予的邀请。
3. 复查组织有效、所有指定项目归属正确、仍未删除且 ACTIVE。
4. 验证角色组合、项目数量和 grants 完整性；无 grants 的旧普通邀请返回 409，要求管理员重发。
5. 保留会员配额校验。继续使用条件更新领取 PENDING，处理有效期和接受/撤销竞争。
6. 创建组织 Membership，获得其 id。
7. 按邀请 grants 创建 ProjectMembership；不重新查询“组织所有项目”作为授权清单。
8. 更新邀请状态、写通知/欢迎邮件意图，一起提交。

任一项目失效返回 409，整体不创建成员、不部分授予、不接受邀请。接受和项目删除竞争时需要项目行锁，避免“先校验再删除”的竞态；接受成功后随后删除项目仍按正常软删除访问规则处理。

并发接受只成功一次。任何数据库失败应回滚状态、成员、授权及 outbox；quota 校验需要与已有并发配额机制保持一致，不能只在测试 mock 中认为安全。

管理员邀请也需要复查邀请者权限。本版建议上线时撤销全部旧 PENDING 邀请后重发，而不从历史角色推测项目范围。

## 6. 权限管理接口

以下是新增契约，不宣称已存在：

| 接口 | 权限 | 作用 |
| --- | --- | --- |
| `GET /api/organizations/:orgId/members/:userId/project-permissions` | 组织 OWNER/ADMIN；用户可查自己 | 查询显式授权及有效权限 |
| `PUT /api/organizations/:orgId/members/:userId/project-permissions` | 组织 OWNER/ADMIN | 一次替换该成员的项目授权 |
| `GET /api/projects/:projectId/members` | 项目 VIEWER+ | 查询当前可参与本项目的成员，最小字段 |
| `GET /api/organizations/:orgId/my-permissions` | 当前组织成员 | 返回组织能力及授权模式 |
| `GET /api/projects/:projectId/my-permissions` | 项目 VIEWER+ | 返回有效项目角色与能力 |

替换请求：

```json
{
  "expectedVersion": 3,
  "projects": [
    { "projectId": "project-a", "role": "VIEWER" },
    { "projectId": "project-b", "role": "MEMBER" }
  ]
}
```

- 为 Membership 增加 `projectPermissionsVersion Int @default(0)`。
- PUT 要求 expectedVersion；同事务校验并加一，冲突 409；不能后写覆盖管理员较新的操作。
- 空数组表示撤销所有显式项目权限，绝不能解释为授予全部项目。
- 对 OWNER/ADMIN 不允许通过该接口“限制项目”；返回 400 并提示需先修改组织角色。
- 目标必须仍是该组织成员；项目归属与角色组合验证同邀请。
- 角色更新、项目授权替换、离开/移除团队锁定同一 Membership 行，防止撤权后又被并发写回。
- 组织管理员降为普通成员后 version 递增；旧请求不能重新恢复旧授权。
- 响应区分 `assignedRole`、`effectiveRole`、`accessMode`，避免组织 VIEWER 有效只读与原记录含义混淆。
- 项目成员列表含有效授权成员和组织 OWNER/ADMIN；不展示其他项目成员，不暴露完整邮箱/其他授权列表。
- 组织完整成员目录仅 OWNER/ADMIN 查询；普通成员使用项目成员列表查协作者。
- 组织 ADMIN 可管理普通成员授权，不能通过此接口变更组织角色或授予组织 ADMIN。

ACL 替换记录 actorId、targetUserId、organizationId、每项目 before/after、版本和时间。当前 AuditLogInterceptor 对批量授权和复合键 before 快照不足：授权服务在事务中显式写 AuditLog，按已有 CREATE/UPDATE/DELETE action 记录；不要让这些记录仅依赖 fire-and-forget，也不要重复写同一批次。

## 7. 后端授权架构

### 7.1 统一策略服务

新增独立 `src/common/authorization/authorization.module.ts`，提供：

- `ResourceContextResolver`：显式解析组织、项目和子资源上下文。
- `ProjectAccessService`：有效角色、操作校验、可访问查询条件及通知资格。
- 类型化 `AccessPrincipal`：`USER` / `API_KEY` / `SYSTEM`；用户包含真实 userId，API key 包含组织、scopes 与 keyId；SYSTEM 仅由内部后台代码构造，所有外部请求入口拒绝声明该身份。
- 类型化 `AccessContext`：organizationId、projectId、organizationRole、projectRole、effectiveRole、principal。

模块仅依赖 Prisma 基础设施，不导入业务或通知模块。由业务模块按需 import、NotificationsModule import，避免 `Projects -> Notifications -> Projects` 循环；同一策略服务不在多个模块重复 providers 注册。

OrgMemberGuard/RolesGuard 保留组织接口语义。JwtAuthGuard 和 DeveloperAuthGuard 都加载当前有效 User，用数据库中的 globalRole 判断平台旁路，不沿用 JWT/PAT 签发时的角色；用户停用或软删除即时拒绝。共享组织解析器可减少现有重复，但不做无关全仓库重构。项目路由使用新的 `ProjectAccessGuard` 与 `@ProjectPermission(...)` 明确标注动作。

示例目标形态：

```typescript
@UseGuards(OrgMemberGuard, ProjectAccessGuard)
@ProjectPermission('project.read', { projectParam: 'projectId' })
```

这是设计 API，不是现有符号。项目管理路由不能再额外保留 `@Roles('ADMIN')` 组织门槛，否则组织 MEMBER + 项目 ADMIN 仍然无法管理项目。

不要仅依据 HTTP 动词授权：例如 POST 手动检查最低 MEMBER，而 POST 测试告警最低 ADMIN；POST token 接受邀请也不是普通项目写入。

权限键固定枚举并集中映射：`project.read`、`project.manage`、`project.delete`、`project.restore`、`task.write`、`task.restore`、`comment.write`、`attachment.write`、`monitor.check`、`monitor.manage` 等；不引入动态数据库权限字典。

### 7.2 资源解析不能仅采用参数优先级

| 路由类型 | 解析规则 |
| --- | --- |
| `organizations/:orgId/projects/:id` | 显式将 id 当项目，核对 Project.organizationId 与 orgId |
| `projects/:projectId/.../:taskId` | 核对 task.projectId 与 projectId，同时核对组织 |
| `tasks/:taskId/comments|attachments|labels` | Task -> Project -> Organization，再验证 comment/attachment/label 关系 |
| `labels/:id` | Label.projectId 决定项目权限；为空则使用组织管理权限 |
| `organizations/:orgId/rule-groups/:id` | 按 RuleGroup 实际 organizationId/projectId 决定权限 |
| `projects/:projectId/monitors/:monitorId` | 校验 monitor 确实属于 project；再校验 log/binding/delivery 所属 monitor |
| 组织级 body 含 projectId | 按 body 中的项目进行同组织校验和项目授权，不只看 URL orgId |

Resolver 使用元数据指定 resourceType/idParam，不猜测任意 `:id` 是组织还是标签。不同参数声称不同父级时失败，不能“先遇到 orgId 就放行”。

请求中保留目前审计使用的 `projectOrgId`、`taskOrgId`、`taskProjectId`，并让新审计读取标准 AccessContext；组织路由的项目详情也要填入实际 projectId。

### 7.3 Guard + 服务查询约束

- Guard 判断是否允许调用，服务查询保留明确 organizationId/projectId 条件。
- 含多项目数据的服务必须接收 principal/访问范围，不允许默认未传表示全部。
- 组织项目列表、组织监控列表/概览、分页 total、统计和关联 include 都在数据库查询前过滤。
- 关联 body ID（assignee、sprint、parentTask、label、dependencyTask、ruleGroup、channel）逐一校验归属，不因主资源通过而放行。
- 分配任务的用户必须对目标项目拥有 MEMBER+ 有效权限；@mention 候选限本项目可读成员。不要用组织成员名单作为项目协作者名单。
- 当前评论/附件删除传组织 membership.role，改为有效项目管理能力；保留仅作者编辑、上传者/管理员删除规则，先满足最低写权限。
- 默认不缓存授权；每个请求查当前关系。业务缓存仍可存在，但其键包含授权主体/版本或缓存授权前的原始数据，不能复用管理员完整响应给普通用户。
- 用户入口不能调用内部全量查询 helper；内部后台任务使用明确 system principal，不伪装成用户，不接受客户端指定 system 模式。
- 写入和 ACL 修改在事务内重新校验并锁定 Membership/授权相关行，统一顺序为 Membership -> Project -> 子资源；涉及多名成员或多个项目时，每类按 id 排序获取锁。现有 task/project 锁应排在权限锁之后，避免反向锁序；后台操作如也读取成员权限，遵循同样顺序。
- 撤权提交后的新请求立即失败；已开始的授权操作通过锁串行化。已经完成的响应、邮件或文件下载无法追回。

响应规则：未登录 401；无项目访问权/资源不属于指定父级统一 404，不暴露项目名称；能读项目但操作角色不足返回 403；输入错误 400；过期状态/并发版本/项目失效返回 409。

## 8. 必须覆盖的资源入口

| 模块/入口 | 处理 |
| --- | --- |
| Projects 列表/详情/设置 | 用户范围过滤、项目权限；创建/删除/恢复仍组织管理权 |
| Tasks/Sprints | 项目读写矩阵，恢复例外，子资源归属 |
| Comments/Attachments | 从 task 解析项目；最低写权限、作者/上传者规则 |
| Labels | 项目标签与组织标签分流；任务标签必须同项目或组织共享标签 |
| Monitors/Checker/State | 读取、手动检查、配置分别最低 VIEWER/MEMBER/ADMIN |
| Monitoring dashboard/availability/status-codes/insights | 全部校验对应项目，含历史、导出型 payload 和细节 |
| 组织 monitoring overview 与 developer org monitor list | 只聚合可访问项目；数量、比率、recentIncidents 同范围 |
| RuleGroups/RuleBindings | 组织模板与项目规则分流；补齐更新/删除服务的 org/project 条件 |
| AlertEvents retry | 项目 ADMIN，不允许 deliveryId 指向其他项目 |
| Notifications/SSE/任务提醒 | 投递前和读取时复查权限，历史通知处理 |
| Developer API | PAT 项目范围与操作能力，不能仅看 scopes |
| Probes/NotificationChannels | 保留组织管理资源，禁止通过 logs/results/include 旁路读取别项目 |
| StatusPages 管理接口 | 本版全部 OWNER/ADMIN；公共发布入口单独解释 |
| API Key 管理、组织完整成员目录 | 本版仅组织 OWNER/ADMIN |
| AuditLogs | 组织审计仍组织 ADMIN；不默认授予项目管理员组织完整日志 |

Probe/NotificationChannel 的组织完整配置、执行历史、投递日志，仅组织管理员可访问。项目 ADMIN 若需要选择共享资源，提供项目上下文的最小选项接口：

- `GET /api/projects/:projectId/probe-options`：仅合法组织探针的 id/name/在线状态，无凭证、执行目标、其他绑定项目。
- `GET /api/projects/:projectId/notification-channel-options`：仅 id/name/type，不含 webhook/secret/收件人/投递历史。
- 项目内 probe 绑定与解绑可由项目 ADMIN 在项目监控路由操作；必须验证同组织且 monitor 属于本项目，不能操作探针配置。
- 组织规则模板只提供允许复用的最小摘要；项目规则读接口过滤其他项目。修改组织模板需要组织 ADMIN，项目 ADMIN 只修改本项目规则或绑定。
- RuleGroupsService 当前 `update(id)` / `softDelete(id)` 仅按 id 写入，实施时必须改为携带已解析 org/project 条件，不能只给控制器加守卫。

### 文件与公开资源例外

- 私有任务附件不能返回永久公开 CDN/OSS URL；当前 storage providers 支持 publicBaseUrl，必须按“任务私有 / 明确公开素材”区分。
- 任务附件下载走授权后的任务 download 路由；OSS 采用私有桶与短期签名 URL。已签发 URL 在到期前仍可用，严格即时撤权需代理流式下载。
- 禁止本地静态服务器直接暴露私有上传目录；检查反向代理、CDN 和桶 ACL，不能只改 Nest Guard。
- 一般上传 `/attachments/upload` 现有“public”素材不是天然私有项目附件。如果该对象被关联到私有任务，需要私有存储迁移/所有权映射；不得继续通过通用 object 路由旁路访问。
- 本版不全面重构普通素材库；只确保项目私有附件不被其公开读取能力绕过。已有公开任务文件上线前需要运维确认迁移，不能声称旧公开链接已被 API 修复撤销。
- `/api/status/:slug` 是管理员主动发布的公共状态页，不受项目私有 ACL 控制。前端要明确公开发布；页面不能显示凭证和未发布资源，软删除组织/项目的资源不再公开输出。
- 如果“查看权限”还要包括公开状态页保密，需独立的私有状态页设计，不在本方案里假设原公共链接会自动变私有。

## 9. PAT 与组织 API Key

### PAT：用户身份

```text
PAT 有效 + 当前有效用户 + 当前组织成员
    + 当前项目授权 + 对应操作能力 + token scopes
```

- `monitors:write` 只是调用能力上限，不等于项目管理权。
- 组织 MEMBER + 项目 VIEWER 即使有 write scope 也不能配置 monitor。
- 普通用户 PAT 读取组织 monitor/overview，只返回有权项目数据。
- 项目撤权后旧 PAT 同样失效，不要求重新签发 JWT 才生效。
- 读取实际 User.globalRole/isActive/deletedAt，不能长期信任 PAT 签发时的 SUPER_ADMIN 快照。
- API key 的 createdById 仅用于审计归因，不能把虚构 request.user 当授权主体。

当前 JwtAuthGuard 允许 PAT 调用普通 JWT API，而该路径没有开发者 scope 检查。本版推荐 **PAT 仅允许 `/developer/v1`，普通 JWT API 拒绝 PAT（403）**，避免用普通路径绕过 scopes。这是明确的兼容性变化，需要通知现有脚本迁移；若不能接受该变化，必须为普通 API 增加完整 scope 映射后再上线，不能保留 scope 旁路。

### 组织 API Key：机器身份

本版保留组织级 key 的全项目范围，由组织 OWNER/ADMIN 创建并明确确认；scope 仍约束可调用操作。它不是受邀用户身份，不与创建者个人项目授权混用。

- 创建者离开组织后 key 是否继续使用，按组织服务凭证策略管理；本版保留到管理员撤销/过期，不宣称用户撤权会撤销机器凭证。
- 每次请求验证 key 有效、组织未删除、路径资源归属和 required scopes。
- 不把 key 发给局部项目成员。将来确需项目 key，再新增独立 key-project grant，不用传用户 projectIds 临时拼规则。
- 审计标明认证类型/keyId/创建者，避免与真人操作混淆。

## 10. 通知、撤权与生命周期

### 项目通知

1. 事件产生时筛选：现有参与者集合与当前项目可读成员求交；角色额外限制按事件定义执行。
2. 事务写入带 PROJECT 范围的通知与投递意图，不破坏去重。
3. SSE/邮件 worker 真正发送前复查当前项目权限；无权标为 SKIPPED，不继续重试。
4. Redis SSE 到本机用户流之前再次核对权限，处理排队/跨实例延迟。
5. 列表、详情、未读数、标记已读返回体使用同一范围规则；先过滤再分页/count。
6. 监控恢复事件虽复用首次告警受众，也必须与当前授权求交，不能仅按当前组织成员判断。
7. 任务提醒收件人和 assignee 邮件同样检查项目访问能力。

邀请、移出组织、账号安全事件按明确 scope 保持合理可见，不能用通用 `allowOutsideOrg` 绕过项目私密事件的 ACL。撤权确认可发无项目内容的账号通知；不携带无权项目名称、目标或深链。

撤权不删除任务、评论和创建历史；取消其未来参与/提醒资格。旧 assignee 可保留为历史事实，但不能再被分配新任务或收到私密提醒；管理员可另行重新分配。旧 watchers 可以清理，但不能把“尚未清理”当权限。

外部群机器人、邮件收件地址属于管理员配置的独立外发策略，不受站内用户项目授权自动回收；要说明该边界。不能声称移除站内用户就会把他从外部群移除或追回已发送邮件。

### 生命周期

- 新建项目：组织 OWNER/ADMIN 自动可管理；其他人无默认权限。
- 项目创建者以后被降为 MEMBER：只按显式 grants 判断，不按 createdById 自动保留。
- 移出/离开组织：Membership 删除级联 grants；PAT 实时查成员关系；项目通知停止。
- 重新邀请加入：生成新的 Membership，仅授予新邀请中的项目。
- 所有权转移：保持现有新 OWNER/旧 OWNER 降 ADMIN 规则，二者仍有全项目权限；以后再降普通角色时明确分配。
- 组织/项目软删除：普通读写停止；恢复后按保留的角色和 grants 生效。
- 权限异常或依赖故障：拒绝访问，不降级到“所有项目可读”。

## 11. 存量迁移与上线

这是访问控制语义变更，不是只加两张空表就能上线。

### 推荐迁移

1. 导出用户-组织角色清单、旧 pending 邀请、现有项目和公开附件暴露情况，保存安全备份。
2. 新增表、约束、通知范围和权限版本。不要自动按组织成员 × 全项目生成 grants。
3. OWNER/ADMIN 继续依赖组织角色，不必生成重复 grants；逐项核实历史 ADMIN 是否只是误当“项目管理员”邀请进来的。
4. 管理员确认普通成员应访问的项目和角色，生成显式回填清单；不从 createdById/assignedToId/历史访问日志推断授权。
5. 无清单的 MEMBER/VIEWER 默认无项目权限，上线前明确通知可能暂时失去访问。
6. 旧 PENDING 邀请统一撤销并重发，避免“未选择项目”的旧邀请继续扩权。
7. 回填能可靠识别的项目通知范围；未知历史项目通知 fail closed，停止对应旧 outbox。保留去重记录，不重新投递旧事件。
8. 私有附件公开存储和外部群受众按运维清单处理；迁移不可由本地设计分析擅自执行。

### 发布顺序

- 在隔离测试库演练“旧数据 -> 新约束 -> 授权回填 -> 新代码”。
- 数据结构可提前扩展，但旧代码仍泄露全部项目，不能把该阶段视为已修复。
- 正式切换时临时暂停业务写入和旧通知 worker，应用授权清单与旧邀请/通知处理。
- 同步上线新前端邀请契约和全部 API/worker 副本，停止旧副本继续服务。
- 验证匿名、普通成员、只读、局部管理员、组织管理员、PAT 和机器 key。
- 恢复服务，观察 403/404、异常拒绝、DB 查询与 outbox SKIPPED。

不增加可随意关闭的 `PROJECT_ACL_ENABLED=false` 旁路。回滚应保持限制访问或维护模式，保留新授权数据；不能回滚到旧代码重新开放全部项目。所有迁移使用 deploy，不使用 reset/db push 代替生产迁移。

## 12. 前端交互契约

供前端另仓库实施，当前未核对其源码：

- 邀请表单：邮箱、团队身份、项目选择及每项目 VIEWER/MEMBER/ADMIN。
- 默认团队 MEMBER；项目不默认全选，必须主动选择。
- 团队 ADMIN 与“全部现有及未来项目”绑定呈现，不能同时显示部分项目限制；需要明确确认全团队管理权。
- 全团队只读者用团队 VIEWER + 指定项目 VIEWER。
- 成员管理：组织角色与项目授权分开显示，支持替换授权、逐项目角色调整、撤销和版本冲突提示。
- 项目切换器仅显示后端可访问列表；没有项目时呈现正常空状态。
- 能力结果控制按钮显示/禁用，但后端始终重新验证，不信任前端。
- 收到权限变更或请求 403/404，重新获取权限和项目列表，移除当前无权项目缓存、详情与路由。
- 项目成员/负责人候选使用项目成员接口，不再复用完整组织成员目录。
- 不把此后端方案当作已完成前端适配。

## 13. 实施范围与顺序

### 允许修改范围

- `prisma/schema.prisma`、本次新增 `prisma/migrations/*_project_access_control/`、生成的 `src/generated/prisma/`。
- `src/common/authorization/**`（新建）、相关 guards/decorators/interfaces 及其 index。
- `src/common/interceptors/audit-log.interceptor.ts` 和 spec，仅接入标准上下文/避免授权审计重复。
- `src/modules/{invitations,memberships,projects,tasks,sprints,comments,attachments,labels,monitors,monitoring,checker,state,rules,alert-events,notifications,developer-api,probes,notifier,status-pages,audit-logs}/` 中仅授权入口、查询过滤、受众和对应测试。
- `src/modules/cron/jobs/` 中与任务提醒授权相关文件。
- `src/app.module.ts` 仅权限模块注册；相关 feature module imports。
- `test/project-access.e2e-spec.ts`、`test/project-access-postgres.integration-spec.ts`（新增）。
- 本方案、授权契约文档、必要 README/Swagger 描述与状态索引。

### 不允许修改

- 无关 checker 协议逻辑、系统探针分配算法、计费价格/支付、登录/2FA 产品流程。
- 无关依赖升级、全仓库格式化、现有用户未提交修改的回退。
- 前端仓库，除非实施者另获授权；本方案只给接口契约。
- 本地 `.env` 内容、生产权限清单、实际用户数据、真实 token/secret。

分支建议 `codex/project-access-control`，最终 PR 目标 master。当前工作区大量未提交修改；不要切分支或迁移前擅自 reset/checkout/覆盖。新执行者先记录实时 `git diff`，获得适合的执行工作区，不自动推送或创建 PR。

### 步骤 1：基线与拒绝用例

核对现状摘录，建立 O1/O2 两组织、A/B/C 三项目、不同角色及 PAT fixtures；先添加当前泄漏的特征用例，保存已有测试失败基线。

验证：`pnpm test -- src/modules/invitations/invitations.service.spec.ts src/modules/projects/projects.service.spec.ts --runInBand`，已有测试应通过；新增旧行为特征用例仅用于确认缺口，最终必须改为拒绝断言。

### 步骤 2：数据结构和策略核心

创建 ProjectRole、ProjectMembership、InvitationProjectGrant、通知范围、版本及复合约束；新增 AuthorizationModule、resolver 和纯策略测试。

验证：`pnpm exec prisma validate`、`pnpm prisma:generate`、`pnpm type-check` 均 exit 0；`pnpm test -- src/common/authorization --runInBand` 全通过。不得对真实数据库运行试验性迁移。

### 步骤 3：邀请与授权管理

修改 CreateInvitationDto、InvitationEntity、send/acceptById、成员权限控制器/服务、组织角色升降规则；保持 outbox 事务、验证邮箱与并发领取。

验证：`pnpm test -- src/modules/invitations src/modules/memberships --runInBand` 全通过，包含 grants 回滚、发送者失权、旧邀请、版本冲突用例。

### 步骤 4：所有用户资源入口

按第 8 节逐模块替换项目守卫；组织列表/聚合加入 principal 范围；修正有效项目管理权限和 parent/body ID 校验；提供最小共享资源选项。

验证：`pnpm test -- src/modules/projects src/modules/tasks src/modules/sprints src/modules/comments src/modules/attachments src/modules/labels src/modules/monitors src/modules/monitoring src/modules/rules --runInBand` 全通过；`pnpm type-check` exit 0。

新增 HTTP 路由覆盖表检查：每个项目业务 handler 有权限元数据，GET 最低 read、写入有明确 action，且项目管理接口不残留组织 ADMIN 前置门槛。不能只靠文本搜索判断无漏网路由。

### 步骤 5：开发者入口与通知

DeveloperAuthGuard 使用真实 principal、用户当前项目能力和 scopes；处理普通 JWT API 的 PAT 兼容边界；通知产生、读取、计数、SSE/邮件复查与历史数据策略落地。

验证：`pnpm test -- src/modules/developer-api src/modules/notifications src/modules/cron --runInBand` 全通过，旧 PAT 不能绕过、撤权后不读不投递项目通知。

### 步骤 6：升级演练与全链路验收

用一次性数据库验证复合外键、真实事务回滚/并发、迁移回填和 HTTP 响应；更新 Swagger 和前端接口文档。测试 fixture、凭证和 outbox 不触发真实网络邮件。

验证命令与期望：

| 命令 | 成功条件 |
| --- | --- |
| `pnpm exec prisma validate` | exit 0 |
| `pnpm prisma:generate` | 生成客户端成功，无遗漏 schema 同步 |
| `pnpm type-check` | exit 0 |
| `pnpm test -- --runInBand` | 全部单测通过 |
| `pnpm test:e2e -- --runInBand test/project-access.e2e-spec.ts` | 所有项目权限 HTTP 回归通过 |
| `pnpm exec tsx --test test/project-access-postgres.integration-spec.ts` | 一次性数据库约束/并发/升级测试通过 |
| `pnpm lint` | exit 0，检查 --fix 未修改无关文件 |
| `pnpm build` | exit 0 |

新增 PG harness 沿用 `test/notifications-postgres.integration-spec.ts` 的安全模式，使用显式 `PROJECT_ACCESS_TEST_DATABASE_URL`，仅允许 disposable 本地 `beacon_project_access_test[_suffix]`，非空数据库拒绝运行；不得 reset 开发/生产数据。HTTP suite 参考 `test/monitoring-dashboard.e2e-spec.ts` 的临时本地 Nest 服务 + fetch 模式，权限回归不能 override 真实授权守卫；单测参考 `src/modules/invitations/invitations.service.spec.ts` 的 Prisma tx mock 与事务断言。

迁移演练测试需要创建旧结构并应用增量迁移，不能只测新 schema 新库。新 harness 的上述命令目前尚不可运行，属于实施验收契约；本次设计没有运行测试或迁移。

## 14. 验收矩阵

所有用例最终必须由自动化测试覆盖：

| 场景 | 期望 |
| --- | --- |
| MEMBER，A=VIEWER，B=ADMIN，无 C 授权 | 列表只有 A/B，A 读通过写 403，B 项目管理通过，C 详情 404 |
| 邀请组织 MEMBER，A=VIEWER，B=ADMIN，接受 | 仅创建两个 ProjectMembership，组织角色仍 MEMBER |
| 新建 D 项目 | 上述用户看不到 D |
| 组织 VIEWER 携带 ADMIN grant 输入 | 400；运行时遗留高角色记录仍只读 |
| 不传 projects 或 projects=[] 的普通邀请 | 400，不生成全项目授权 |
| 组织 ADMIN 邀请附带部分项目 | 400，不能产生“受限组织管理员” |
| 普通项目授权 PUT 空数组 | 撤销全部项目，列表为空 |
| 组织管理员 | 全项目含未来项目；项目授权列表为空不影响其组织能力 |
| 多组织成员 O1/O2，混合 orgId 与 projectId | 404/输入 400，零跨组织查询/写入 |
| 路径 A + task/monitor/attachment 来自 C | 404，不能借 A 的权限读 C |
| task body 外项目 sprint/label/dependency | 拒绝，保持原有同项目业务限制 |
| 项目只读者写任务/评论/附件/标签/手动检查 | 403，业务服务不写入 |
| 项目管理员操作他人评论/附件 | 可删除，不可编辑他人评论；不能提升团队角色 |
| assignee 没有目标项目 MEMBER 权限 | 拒绝；不创建提醒和关注关系 |
| 同组织其他项目监控存在 | 组织 overview/list/count 不包含其明细和统计 |
| 普通成员访问组织探针结果、渠道日志、状态页管理 | 403，不从共享基础设施绕过项目 |
| scopes=write 但项目 VIEWER 的 PAT | 写操作 403，其他项目 404 |
| PAT 请求普通 JWT 路由 | 本版默认 403，不能绕过 scopes |
| 用户/平台角色被撤销，旧 JWT/PAT 仍在有效期 | 按当前数据库身份拒绝，无 token 旧角色旁路 |
| 组织 API key | 按组织身份/scopes 工作，不误用创建者个人项目角色 |
| 邀请发起者失权、项目删除/归档、旧 grant 缺失 | 接受失败，无部分组织成员或授权 |
| 并发接受/撤销邀请、重复接受 | 至多一次成功，状态/成员/grants/outbox 一致 |
| 不同管理员同时替换项目授权 | expectedVersion 只允许一次成功，另一请求 409 |
| 移出组织与授予项目并发 | 移除提交后无孤立 grant；复合 FK 与事务锁兜底 |
| 撤权后旧通知列表/详情/未读 | 隐藏项目通知并保持 count/分页一致 |
| 已排队邮件/SSE、告警恢复、定时任务提醒 | 权限复查失败后 SKIPPED，不泄露旧项目内容 |
| 项目/组织已删除、非法 grants | 拒绝访问；restore 仅特定角色/动作通过 |
| 私有附件永久公开 URL、通用 object 下载 | 不允许构成私有任务旁路；已签名链接失效期限有文档 |
| 公开状态页 | 只输出管理员主动发布且未删除的资源，不声称受私有 ACL 限制 |
| DB 直接写入跨组织 ProjectMembership | 复合外键失败 |
| 任一 grant 写入失败 | 邀请接受事务整体回滚，零欢迎邮件意图 |
| 旧数据升级，没有普通成员授权清单 | MEMBER/VIEWER 无项目权限，不自动全量回填 |

## 15. 完成标准与停止条件

完成标准：

- 第 14 节对应测试全部通过，第 13 节质量命令全部通过。
- 新旧数据升级演练通过，授权回填经组织管理员确认，不存在隐式全项目 fallback。
- 路由覆盖测试证明项目接口有明确 action，普通邀请携带 grants。
- Swagger 明确组织 role、项目 role、公开资源与 PAT 兼容变化。
- 当前用户只能看到其授权项目的列表、聚合、关联与通知数据。
- 权限变更留下事务内可查审计，所有副本和 worker 执行同一策略。
- 相对实施前 baseline 的新增 diff 只在约定授权范围内；没有回退用户既有修改。
- 更新 `plans/README.md` 的 002 状态，设计 TODO 与实施 DONE 不混淆。

必须停止并报告：

- 实时代码与本文摘录/路由清单已不一致，且无法解释未提交修改来源。
- 产品要求组织 ADMIN 也只能看部分项目，或要求项目管理员能邀请/授权他人：需要调整角色模型，不能临时打补丁。
- 不接受组织 VIEWER 只读上限、PAT 普通 API 收紧或存量普通成员默认拒绝策略。
- 发现未列出的业务聚合/导出/附件发布方式构成授权旁路；先补齐方案范围。
- 无安全一次性测试数据库，或迁移可能影响开发/生产数据。
- 验证持续失败、需要改监控/计费引擎等无关模块、不能满足锁序与事务一致性。

维护重点：以后新增项目资源、聚合、导出、通知、开发者端点时，必须同时补权限动作、资源解析、范围过滤和负向 HTTP 回归。新增权限不能靠复用组织 ADMIN 或对空项目范围放行来解决。

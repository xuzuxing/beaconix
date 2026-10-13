# 002：邀请项目授权与项目级权限控制设计

## 状态与结论

- 初稿日期：2026-10-11；设计修订：2026-10-12，版本 v2；实施核对更新：2026-10-13。
- 状态：IN PROGRESS，已实现数据模型、统一策略、权限接口及任务/监控/缓存/私有附件/开发者 API/通知等后端业务接入；2026-10-13 已补独立 PostgreSQL/HTTP 验收 harness。未执行业务库迁移、生产回填或前端修改；数据库验收矩阵尚未补全，真实数据库和部署发布验收尚未完成。当前核对见末尾“验收脚本与最终复测”，此前记录保留为历史快照。
- 优先级：P1；工作量：L；实施风险：HIGH，涉及现有访问权限收紧。
- 分类：security / migration / tests。
- 设计评估基准：`D:/WorkSpace/beacon`，提交 `04e9253`；实施核对提交 `7e2e733`，工作区变更未提交。
- 原稿：`C:/Users/Admin/Downloads/002-project-access-control.md`，原稿基准路径为 `D:/zuxcloud/nest-beacon`。本修订不覆盖下载目录原稿。
- 当前已有修改：`pnpm-lock.yaml` 已修改，`.github/workflows/monitor-validation.yml`、`docs/`、`plans/` 未跟踪；实施前重新记录实时状态，不把相同 HEAD 当作相同工作区的证明。
- 修订期间另观察到 `src/modules/notifier/notifications.processor.ts`、其 spec 和 `notifier.queue.ts` 并行变动；本次没有修改或回退它们，执行者以实施启动时的实时 diff 为准。
- 本计划及状态索引保存在 `advisor-plans/`。现有 `plans/002-local-monitor-delivery.md` 是监控计划，不是本方案，不能更新错编号。
- 依赖：先建立可通过的验证基线；第 13 节步骤 0 完成后，才能把后续质量门禁视为有效。无新增外部权限框架。
- 本文设计后端及前端接口契约，不实现前端，也不连接或修改真实数据库。

**推荐采用“组织身份 + 显式项目授权”双层权限。**

组织 MEMBER/VIEWER 加入团队不自动获得任何项目权限。邀请时选择项目并逐项指定权限；接受邀请后，组织成员关系、项目授权和通知意图一次性事务落库。组织 OWNER/ADMIN 管理全部现有和未来项目。

**“某项目管理员”必须是组织 MEMBER + 项目 ADMIN，不能通过邀请组织 ADMIN 实现。** 后者是整个团队的管理员，不支持限制为单个项目。

执行者必须先阅读全文，再依第 13 节顺序实施。每步执行验证命令，出现第 15 节停止条件时报告，不擅自扩大范围、推送或创建 PR。

## 1. 问题与现状依据

当前主要缺口是同一组织内没有项目级授权边界。已有组织 RBAC 无法表达“只查看 A、管理 B、看不到 C”。本结论不是宣称所有跨组织入口已经安全，父子资源归属仍需逐项验证。

| 位置 | 已核对现状 | 本次影响 |
| --- | --- | --- |
| `prisma/schema.prisma:370` | Membership 仅关联用户、组织与组织角色 | 没有项目成员关系 |
| `prisma/schema.prisma:392` | Invitation 仅存组织角色及 sentById | 邀请没有项目授权或发起者成员关系代次 |
| `src/common/guards/org-member.guard.ts:28` | 查询 userId_organizationId | 组织成员可通过项目读接口 |
| `src/common/guards/roles.guard.ts:33` | SUPER_ADMIN 可无组织成员关系旁路 | 邀请接受不能无条件要求发起者 Membership |
| `src/modules/projects/projects.service.ts:51` | 列表仅按组织及软删除过滤 | 返回全部项目 |
| `src/modules/invitations/invitations.service.ts:246` | 接受邀请已经使用事务 | 同一事务新增项目授权，不破坏 outbox |
| `src/modules/invitations/invitations.service.ts:293` | 事务回调内调用不带 tx 的配额方法 | 不能认为配额已经事务安全 |
| `src/shared/quota/quota.service.ts:52` | 根客户端计数，含 Membership.count | 不同邀请可竞争最后一个成员名额 |
| `src/shared/subscription/effective-plan.service.ts:25` | 套餐解析使用根客户端 | 成员配额事务需传递同一 tx |
| `src/modules/organizations/organizations.service.ts:202` | 转移所有权修改组织及两条 Membership | 必须参与生命周期锁序和权限版本更新 |
| `src/modules/monitoring/monitoring.service.ts:24` | 组织概览选择全部监控 | 聚合必须先缩小用户范围 |
| `src/modules/monitoring/monitoring-dashboard.service.ts:89` | 按项目缓存仪表盘数据 | 缓存命中、脱敏及 304 也要先授权 |
| `src/modules/developer-api/auth/developer-auth.guard.ts:106` | PAT 验组织关系/scopes，API Key 曾填充伪用户 | 改为真实、类型化授权主体 |
| `src/modules/notifications/notifications.service.ts:383` | 通知仅按收件人筛选 | 撤权后历史项目内容仍可见 |
| `src/modules/notifications/notification-delivery.service.ts:109` | 资格检查与网络发送分离 | 明确投递在途例外和租约边界 |
| `src/modules/notifications/notification-stream.service.ts:50` | Redis 消息直接推入本地流 | 本地 fan-out 重新验证项目访问 |
| `src/modules/attachments/storage/oss-storage.provider.ts:102` | 下载优先使用 publicBaseUrl | 私有文件不能依靠 Guard 单独保护 |

现状摘录，实施时必须重新核对：

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
// src/modules/invitations/invitations.service.ts:293
await this.quotaService.assertCanCreate(
    invitation.organizationId,
    'members',
);
```

任务、评论、附件等部分写接口仅使用 OrgMemberGuard。项目只读必须显式禁止业务写入，不能沿用当前配置。

### 已核对的设计依据与缺失引用

原稿引用的 `docs/project-scoped-business-plan.md`、`docs/workspace-notifications.md` 和 `test/notifications-postgres.integration-spec.ts` 在当前工作区不存在，不再作为执行依赖或已验证依据。

实际依据为：

- `prisma/schema.prisma`：Monitor 必须归属 Project，Probe/NotificationChannel 是组织基础设施，RuleGroup 可为组织或项目范围。
- `src/modules/notifications/notification-event.ts`、`notifications.service.ts`、`notification-delivery.service.ts`、`notification-stream.service.ts`：已有事务通知、去重、数据库 outbox 租约和跨实例 SSE。
- `test/monitor-postgres/harness.ts`、`safety.spec.ts`、`prisma.config.ts`：真实存在的隔离数据库安全模式；不能直接复用其监控库白名单。
- `test/monitoring-dashboard.e2e-spec.ts`：临时 Nest 服务、fetch、真实 HTTP guards 的结构参考；其环境变量缺失时跳过和宽松库名检查不能照搬。
- `AGENTS.md`、`package.json`、`.github/workflows/ci.yml`：pnpm、NestJS、Prisma、4 空格/单引号、Swagger、类型检查与质量命令。

源码约定为薄控制器、业务服务负责 Prisma、全局响应 `{ data, meta: { timestamp } }`。新实体使用白名单映射，枚举从 `src/generated/prisma/enums` 导入。PrismaService 当前路径为 `src/infra/database/prisma.service.ts`，不是旧描述中的 `src/database/`。

### 2026-10-12 验证记录

| 已执行命令 | 结果 |
| --- | --- |
| `pnpm test -- src/modules/invitations/invitations.service.spec.ts src/modules/projects/projects.service.spec.ts --runInBand --no-cache` | 2 个 suite、59 项测试通过 |
| `pnpm type-check` | 失败，7 处 TS2554 参数数量不匹配 |

类型错误位置为 `test/monitor-postgres/monitor.integration-spec.ts:173,491` 和 `test/monitoring-dashboard.e2e-spec.ts:238,671,884,886,1139`。它们发生在本方案实施前，不是项目 ACL 已实施后的回归，也不能为了通过门禁而删除断言或屏蔽类型检查。

本次没有运行 build、lint、全量测试、PostgreSQL 集成、HTTP 数据库测试或迁移。后续执行者必须重新验证，不能把本表当作当前永久基线。

## 2. 产品目标与非目标

### 目标

1. 一次邀请可授予不同项目、不同角色。
2. 无权项目不出现在列表、概览、统计、关联 include、通知和导出中。
3. 知道项目及其任务、文件、监控等 ID 不能绕过授权。
4. 项目 VIEWER 不得写业务数据、触发检查或告警。
5. 授权、撤权、离职、重新加入均有明确且可审计的生命周期。
6. 浏览器 JWT 与用户 PAT 使用同一策略，PAT 另外受 scopes 限制。
7. 明确撤权对数据库操作、在途邮件/SSE、已签发文件链接的不同生效边界，不承诺追回已披露内容。

### 非目标

- 不引入自定义角色、CASL、OPA、按钮级动态权限或任务级 ACL。
- 不增加非管理员自动继承全部未来项目的角色。
- 不允许项目创建者、负责人、关注者作为授权旁路。
- 不委托项目 ADMIN 管理组织成员或项目 ACL。
- 不修改监控协议、调度算法、套餐价格、支付或订阅产品规则；仅允许成员配额读取加入授权事务。
- 不把公开状态页自动改为私有页面。
- 不实现前端、普通素材库全面重构或外部群成员回收。

## 3. 权限模型

### 3.1 组织角色

| 角色 | 项目范围 | 团队管理 |
| --- | --- | --- |
| OWNER | 全部现有与未来项目 | 全部权限，包括删除组织、转移所有权 |
| ADMIN | 全部现有与未来项目 | 团队配置、普通成员及邀请管理 |
| MEMBER | 显式授权项目 | 无团队配置、组织角色管理权 |
| VIEWER | 显式授权项目，始终只读 | 无团队管理权 |

SUPER_ADMIN 保留平台运维例外，但必须使用数据库中的当前有效 User/globalRole，校验组织、资源存在性及父子归属，不能依赖旧 JWT/PAT 角色快照。

建议仅 OWNER/SUPER_ADMIN 能授予组织 ADMIN，包括邀请和晋升；ADMIN 可管理 MEMBER/VIEWER。该兼容变化仍需产品确认，不得因“更新文档”自动视为已批准。

### 3.2 项目角色

新增 ProjectRole：VIEWER(1)、MEMBER(2)、ADMIN(3)。

| 能力 | VIEWER | MEMBER | 项目 ADMIN | 组织 OWNER/ADMIN |
| --- | --- | --- | --- | --- |
| 查看项目、任务、评论、附件 | 是 | 是 | 是 | 是 |
| 查看监控、历史、状态、概览 | 脱敏 | 脱敏 | 密钥不明文回显 | 密钥不明文回显 |
| 创建/修改/分配任务、移动迭代、维护依赖 | 否 | 是 | 是 | 是 |
| 评论、上传、维护任务标签 | 否 | 是 | 是 | 是 |
| 删除任务 | 否 | 是，保留业务规则 | 是 | 是 |
| 编辑自己的评论 | 否 | 是 | 是 | 是 |
| 删除他人的评论/附件 | 否 | 否 | 是 | 是 |
| 编辑他人评论正文 | 否 | 否 | 否，仅作者可编辑 | 否，仅作者可编辑 |
| 手动监控检查 | 否 | 是 | 是 | 是 |
| 配置监控、绑定规则、暂停/恢复、测试告警 | 否 | 否 | 是 | 是 |
| 管理迭代、项目标签、项目设置、归档 | 否 | 否 | 是 | 是 |
| 恢复软删除任务/监控 | 否 | 否 | 是 | 是 |
| 删除/恢复项目 | 否 | 否 | 否 | 是 |
| 项目 ACL、邀请团队成员 | 否 | 否 | 否 | 是 |
| 创建项目、探针/渠道/API Key 管理、计费 | 否 | 否 | 否 | 是 |

关注/取消关注属于个人订阅操作，不得由 HTTP 动词推断为任务内容写入。本版建议可读成员可维护自己的关注关系；只读者仍不能修改任务。此规则需在权限动作与测试中明确，不能遗漏现有 watch/unwatch 路由。

### 3.3 最终权限计算

```text
当前有效身份 + 有效组织 + 实际资源归属一致
    -> 当前 SUPER_ADMIN：平台例外
    -> 必须存在当前组织 Membership
    -> OWNER/ADMIN：全部项目业务权限
    -> MEMBER/VIEWER：必须存在当前 ProjectMembership
       -> MEMBER 使用项目角色
       -> VIEWER 的有效角色上限为项目 VIEWER
    -> 操作能力允许
    -> 归档、软删除、作者/上传者等业务规则允许
```

- 无 grant = 无权限，不是默认 VIEWER，也不是全项目。
- 组织 MEMBER 可获得项目 ADMIN；组织 VIEWER 仅允许 VIEWER grant，遗留非法高权限记录运行时仍只读。
- MEMBER 降为 VIEWER 时，同事务降全部 grants 为 VIEWER，以后晋升不恢复旧写权限。
- ADMIN 降普通角色时只保留明确记录的 grants，无记录则无项目访问；不按创建历史推断授权。
- 所有有效权限相关组织角色变更均更新权限版本，包括晋升 ADMIN、所有权转移中的两名成员。
- 归档项目普通业务写入只读，特定生命周期例外必须有独立 action。
- 删除组织/项目后普通访问拒绝；restore 仅按特定角色/动作查询已删除资源。

## 4. 数据模型

以下均为拟新增字段，必须用 schema 校验、生成客户端及真实 PostgreSQL 约束测试证明可执行。

### 4.1 ProjectMembership

| 字段 | 约束/说明 |
| --- | --- |
| id | CUID 主键 |
| organizationId | 组织边界 |
| membershipId | 当前组织成员关系 ID，不直接关联 userId |
| projectId | 授权项目 |
| role | ProjectRole |
| grantedById | 可空授权操作者；独立命名 User relation，SetNull |
| createdAt / updatedAt | 授权时间 |

- Membership、Project 分别增加 `@@unique([id, organizationId])`。
- 两个复合外键分别引用 `(membershipId, organizationId)` 和 `(projectId, organizationId)`，拒绝跨组织 grants。
- 唯一 `(membershipId, projectId)`；索引 `(projectId, role)`、`(membershipId, organizationId)`。
- Membership 物理删除级联其 grants；重新加入产生新 Membership ID。
- 项目软删除保留 grants，恢复后按现有关系生效；普通访问必须检查 deletedAt。
- Project.createdById 仅记录历史，不能授予权限。

Membership 另加 `projectPermissionsVersion Int @default(0)`。**成员关系代次为 Membership.id，版本只在该代次内比较，二者必须联合使用。**

### 4.2 InvitationProjectGrant 与邀请发起者身份

| 字段 | 约束/说明 |
| --- | --- |
| id | CUID 主键 |
| invitationId | 邀请 ID |
| organizationId | 组织一致性 |
| projectId | 被邀请项目 |
| role | 接受后 ProjectRole |
| createdAt | 创建时间 |

- Invitation 增加 `@@unique([id, organizationId])`。
- 对 Invitation、Project 使用包含 organizationId 的复合外键。
- 唯一 `(invitationId, projectId)`；索引 projectId。
- 邀请删除级联 grants；项目物理删除对未清理邀请 grants 使用 Restrict，不能静默缩小邀请内容。
- 待接受授权不可修改，需要撤销后重发；不随新项目扩张。

Invitation 另加：

| 字段 | 约束/说明 |
| --- | --- |
| issuerType | `LEGACY / ORGANIZATION / PLATFORM`，迁移默认 LEGACY |
| issuerMembershipId | 可空、不可变的发起者成员关系代次标量 |
| issuerAuthorityVersion | 可空整数，PLATFORM 邀请保存发送时的平台身份代次 |

ORGANIZATION 邀请必须记录发送时的 Membership.id，接受时只能验证这条仍有效的关系，不能因发送者离职后重新加入而恢复旧邀请。该历史标量不使用删除后可重新解释身份的 SetNull 关系。

PLATFORM 邀请要求 issuerMembershipId 为空，以 sentById 的当前有效 SUPER_ADMIN 身份及 issuerAuthorityVersion 验证，不要求组织 Membership，也不得在平台角色被撤销后改按组织身份放行。角色变更后需要重发邀请。

User 增加 `platformAuthorityVersion Int @default(0)`。本版用本次 PostgreSQL 迁移中的 BEFORE UPDATE trigger 维护：globalRole、isActive、deletedAt 任一实际变化，版本从 OLD 值递增；无变化时保留 OLD 值，不接受应用显式重置计数。这样普通服务、后台脚本和直接 SQL 的失权/恢复都会使旧 PLATFORM 邀请永久失效，不需要改登录/2FA 产品流程。真实数据库测试证明 trigger 生效；不能只在某一控制器里加 increment 而漏掉其他变更入口。

新代码禁止写 LEGACY；所有旧 PENDING 邀请按迁移清单撤销重发。数据库 CHECK 明确允许存量 LEGACY（两个来源字段均为空）、ORGANIZATION（issuerMembershipId 非空、issuerAuthorityVersion 为空）及 PLATFORM（issuerMembershipId 为空、issuerAuthorityVersion 非空且非负）三种组合，服务只允许新建后两类；不能添加一个排斥所有历史 LEGACY 行、导致扩展迁移失败的约束。内部身份计数不新增到用户/邀请公开响应。

### 4.3 通知授权范围

Notification 新增独立标量 `organizationId?`、`projectId?`、accessScope：

```text
ACCOUNT       账号自身事件
INVITATION    与当前收件人邮箱身份匹配的邀请事件
ORGANIZATION  团队事件，按事件定义限制受众
PROJECT       项目私有业务事件
UNKNOWN       无法可靠归类的历史事件，默认拒绝
```

- PROJECT 必须有 org/project，数据库 CHECK 和服务共同约束；其他 scope 的必需字段也要集中定义。
- 范围不能因外键 SetNull 自动变成 ACCOUNT，不接受客户端自报，不仅放在任意 JSON meta。
- NotificationEvent、NotificationDelivery.audience 使用类型化相同范围；用户型项目事件不得使用通用 allowOutsideOrg。
- 默认 UNKNOWN，新代码必须显式指定合法范围；无法可靠回填的旧通知不显示、不计数、不投递。
- 索引建议 `(userId, accessScope, projectId, isRead)`，保留去重和必要旧索引，用测试数据验证查询计划。
- NotificationDelivery 增加 `dispatchAuthorizedAt DateTime?` 记录当前 leaseToken 对应尝试的授权边界；重试重新置空、重新授权，不能作为永久投递资格。

### 4.4 附件访问类别

Attachment 新增 `visibility`：PRIVATE / EXTERNAL / UNKNOWN，迁移默认 UNKNOWN。任务内第一方上传只能为 PRIVATE，外部链接显式为 EXTERNAL；没有任务实体的普通公开上传继续走独立的 public 路由。

- 新任务上传由服务器写 PRIVATE，客户端不能自行声明 PUBLIC、provider、bucket 或 object 所有权。
- UNKNOWN 在回填前拒绝下载，不因存在旧 url 视为可公开。
- EXTERNAL 只保证元数据访问受项目 ACL 控制，实际链接仍受第三方权限管理；不宣称 Beacon 可撤销外部公开 URL。
- 存储接口获得服务器解析的 PRIVATE/PUBLIC 类别和可信对象定位，PRIVATE 分支永不使用 publicBaseUrl。

## 5. 邀请流程与接口契约

### 5.1 发送邀请

沿用 `POST /api/organizations/:orgId/invitations`：

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

结果仅可查看 A、管理 B，不可看 C 或未来新增 D。

- role 默认 MEMBER；MEMBER/VIEWER 必须提供至少 1、最多 100 个项目，拒绝重复项及未知字段。
- 组织 VIEWER 只能携带项目 VIEWER。组织 ADMIN 邀请不允许 projects，明确表示全部项目。
- 项目必须同组织、未删除、ACTIVE；已有组织成员返回 409，增加授权走第 6 节接口。
- 事务内按第 7.4 节锁序复查发送者当前身份和邀请能力，固定 issuerType、issuerMembershipId、issuerAuthorityVersion。
- 当前有效 SUPER_ADMIN 使用 PLATFORM 来源并固定锁定 User 的 platformAuthorityVersion；其他有权组织成员使用 ORGANIZATION 来源，不能由客户端选择来源或代次。
- Invitation、grants、站内通知和邮件意图同事务创建。邮件不含项目配置、监控目标或多余敏感信息。
- 旧普通客户端不传 projects 返回 400，不退回全项目；前端同步发版。

### 5.2 邀请详情

认证后的 pending、by-id、管理端列表提供 `projects: [{ projectId, projectName, role }]` 和 accessMode：ALL_PROJECTS / SELECTED_PROJECTS。

公开 token 预览只返回组织名、邀请状态、是否需登录；不返回项目名、项目 ID、授权清单或发送者邮箱。完整详情需登录且校验被邀请邮箱。不能 Object.assign 整个 Prisma relation；发送/接受响应不 include 项目配置，站内通知不含邀请 token。

### 5.3 接受邀请

acceptById 和 token 路由共用逻辑：

1. 初步读取邀请定位组织/身份；该读取不构成授权通过。
2. 在同一事务中按身份行 -> Organization -> Membership -> Project -> Invitation 的锁序获取必要行，重新读取当前状态。
3. 当前被邀请用户须有效、邮箱已验证且匹配；组织未删除。
4. ORGANIZATION：发送者有效、原 issuerMembershipId 仍匹配 user/org，当前仍有授予该级别邀请的能力；PLATFORM：发送者有效、当前仍为 SUPER_ADMIN，且 issuerAuthorityVersion 等于锁定 User 的 platformAuthorityVersion。失权后再恢复仍因代次不同拒绝。LEGACY 一律 409。
5. 锁定所有指定项目并复查同组织、未删除、ACTIVE；校验 grants 数量、角色组合与完整性。任一失效整体返回 409。
6. 对 Organization 取得 FOR UPDATE 后，使用同一 tx 解析当前套餐、读取成员数、校验名额；见 5.4。
7. 条件更新 PENDING 且未过期的邀请，处理接受/撤销竞争；已是成员返回 409。
8. 创建 Membership，取得新 id，按固定 grants 创建 ProjectMembership。不得改查组织全部项目。
9. 写状态转换通知、欢迎邮件意图，整体提交。

并发接受仅一次成功；任一失败回滚状态、成员、grants、outbox。接受与删除/归档按锁串行化，接受后随后删除仍受正常访问限制。

### 5.4 成员配额并发协议

本版选择**组织行互斥 + 同事务读写**，不依赖当前不存在的“已有并发配额机制”。

- 所有同组织新增/删除 Membership 的入口先锁 Organization FOR UPDATE；不同邀请、不同发送者也竞争同一组织锁。
- QuotaService 提供成员专用事务接口，例如 `assertCanAddMember(orgId, tx)`；成员数用 `tx.membership.count`，不用 getUsage 的五类全量根客户端查询。
- EffectivePlanService 增加明确的事务查询入口，套餐和 FREE fallback 由同一 tx 读取，不改变现有价格、额度或套餐选择规则。
- 普通业务授权事务默认 ReadCommitted，邀请名额安全来自组织互斥，不是读取隔离级别的猜测。
- 并发套餐变更按当前读取到的有效套餐规则处理，不在本次重构订阅/支付事务；若产品要求套餐变更也严格串行，先扩大设计，不声称此版已经保证。
- onboarding 新建组织并插入 OWNER 属于组织创建事务，检查唯一入库路径，不生成不必要重复锁。
- 测试必须包含“不同管理员、不同邀请、不同项目、只剩一个名额”，最终恰好新增一人，失败方无 grants/outbox。只测同一邀请重复接受不够。

## 6. 权限管理接口

| 接口 | 权限 | 用途 |
| --- | --- | --- |
| GET `/api/organizations/:orgId/members/:userId/project-permissions` | OWNER/ADMIN 或本人 | 显式 grants、有效角色、成员关系代次/版本 |
| PUT 同路径 | OWNER/ADMIN | 原子替换目标成员 grants |
| GET `/api/projects/:projectId/members` | 项目可读 | 本项目有效协作者的最小字段 |
| GET `/api/organizations/:orgId/my-permissions` | 当前成员 | 组织能力、accessMode、成员关系代次/版本 |
| GET `/api/projects/:projectId/my-permissions` | 项目可读 | 有效项目角色、能力 |

替换请求：

```json
{
  "expectedMembershipId": "cmembership-current",
  "expectedVersion": 3,
  "projects": [
    { "projectId": "project-a", "role": "VIEWER" },
    { "projectId": "project-b", "role": "MEMBER" }
  ]
}
```

- GET 返回真实 membershipId、projectPermissionsVersion；PUT 必须同时提供成员关系 ID 和非负整数版本，不能缺省为当前值。
- 事务锁定后校验 org/user/id/version 全部匹配。目标不存在 404；成员关系代次或版本不符 409，零授权写入。
- 即便重新加入的新版本与旧版本相同，旧 expectedMembershipId 仍拒绝，不能把旧页面提交重定向到新 Membership。
- 同一成员代次的并发替换只能一个成功；grants 替换、版本 +1 和事务审计一起提交。
- 空数组撤销全部；对 OWNER/ADMIN 不能通过 grants 限制项目，返回 400，需先修改组织角色。
- 目标为当前成员；项目归属、ACTIVE 和角色组合验证同邀请。组织角色变化、所有权转移均使旧版本失效。
- 响应区分 assignedRole、effectiveRole、accessMode；显式记录不等于组织管理员的继承范围。
- 项目成员列表包含有效 grants 成员及组织 OWNER/ADMIN，仅 id/name/avatar 等最小字段，不暴露邮箱或其他授权。
- 完整组织成员目录仅 OWNER/ADMIN；普通成员使用项目成员候选。
- 授权替换不改变组织角色，也不让组织 ADMIN 授予组织 ADMIN。

事务审计记录 actorId、targetUserId、membershipId、organizationId、每项 before/after、版本和时间。当前 AuditLogInterceptor 的动态 before 快照不足，服务显式写 AuditLog，不仅依赖 fire-and-forget，不重复记录同一批次。

## 7. 后端授权架构

### 7.1 统一策略模块

新增 `src/common/authorization/authorization.module.ts`，仅依赖 Prisma 基础设施，导出：

- ResourceContextResolver：通过显式资源类型/参数解析真实 org/project。
- ProjectAccessService：有效角色、动作判断、查询过滤、通知资格。
- AccessPrincipal：USER / API_KEY / SYSTEM；USER 包含真实 userId，API_KEY 包含 keyId/org/scopes，SYSTEM 只能内部构造。
- AccessContext：org/project、当前组织/项目角色、effectiveRole、principal、membershipId、权限版本。
- ProjectAccessGuard 和 `@ProjectPermission(...)`：集中固定动作与元数据，不建动态权限字典。
- 事务锁/重试 helper：明确接收 tx，不允许自动退回根客户端。

业务及 NotificationsModule import 该模块，不反向 import 业务/通知，避免 Projects -> Notifications -> Projects 循环；不重复注册 providers。

OrgMemberGuard/RolesGuard 保留组织接口语义，JwtAuthGuard/DeveloperAuthGuard 验证当前有效数据库身份。项目管理路由移除额外组织 `@Roles('ADMIN')` 门槛。

```typescript
@UseGuards(OrgMemberGuard, ProjectAccessGuard)
@ProjectPermission('project.read', { projectParam: 'projectId' })
```

上述为拟定 API，不是现有符号。动作包括 project.read/manage/delete/restore、task.write/restore、task.subscribe、comment.write、attachment.write、monitor.check/manage 等。POST 手动检查为 MEMBER，POST 测试告警为 ADMIN，不能只按 HTTP 动词推断。

### 7.2 资源解析

| 入口 | 解析要求 |
| --- | --- |
| organizations/:orgId/projects/:id | id 显式为 Project，核对 organizationId |
| projects/:projectId/.../:taskId | 核对 task.projectId 与组织 |
| tasks/:taskId/comments/attachments/labels | Task -> Project -> Organization，再验证子资源 |
| labels/:id | 项目标签按项目能力，组织标签按组织管理/共享读取能力分流 |
| organizations/:orgId/rule-groups/:id | 按 RuleGroup 的实际 org/project |
| projects/:projectId/monitors/:monitorId | 校验 monitor、log、binding、delivery 的完整归属 |
| 组织路径 body 含 projectId | 验同组织与项目能力，不能只验证 URL 的 orgId |

Resolver 使用 resourceType/idParam 元数据，不猜测任意 id。父级声明不一致即拒绝；SUPER_ADMIN/API Key 也验证资源归属。

保留审计所需 projectOrgId/taskOrgId/taskProjectId，统一使用 AccessContext；组织路径的项目详情也填真实 projectId。

### 7.3 Guard 与查询

- Guard 控制可调用性；服务查询仍携带真实 org/project 条件。
- 多项目服务必须传 principal/范围，缺失不能表示全项目。后台全量调用必须是明确 SYSTEM。
- 列表、total、聚合和 include 在数据库查询前过滤；分页后过滤或全组织统计后删明细均不合格。
- assignee、sprint、parentTask、label、dependency、ruleGroup、channel 验各自归属；被分配者须有本项目 MEMBER+，mention 候选只来自可读成员。
- 评论/附件删除使用有效项目管理能力，保留作者编辑和上传者/管理员删除，先满足最低写角色。
- 外部入口拒绝自报 SYSTEM，不将 API Key 创建者冒充用户。
- 用户请求每次读当前有效关系，不缓存权限；写事务再次验证，不依赖早先 Guard 快照。

响应：401 未认证；404 无项目访问权/父级不匹配；403 可读但动作不足；400 输入错误；409 邀请状态/授权版本/目标项目状态冲突。

### 7.4 全局锁序与事务边界

本版统一顺序为：

```text
身份行（User 或 ApiKey）
    -> Organization
    -> 已存在的 Membership
    -> Project
    -> Invitation / 业务子资源 / NotificationDelivery
    -> 新增 outbox 与审计
```

每类多行按 ID 稳定排序。先收集参与者，再一次获取适当强度，不能先共享锁后随意升级、在锁了 Task 后补锁成员，或在同一事务里混用根客户端。

| 操作 | Organization | Membership | Project/子资源 |
| --- | --- | --- | --- |
| 普通用户业务写入 | FOR SHARE | actor、assignee 等需验权限的关系 FOR SHARE | 项目状态默认 FOR SHARE；现有业务需更强项目锁时首次取得该强度，实际子资源按需 FOR UPDATE |
| 项目 ACL 替换/组织角色调整 | FOR SHARE | 授权 actor 共享；目标 FOR UPDATE，同一行取较强模式 | 涉及项目共享，验证后替换 grants |
| 邀请接受/新增成员/移出或离开 | FOR UPDATE | 既有发起者/目标按需要共享或更新 | 项目共享，邀请更新 |
| 所有权转移/组织软删除 | FOR UPDATE | 所有参与者按 ID 顺序锁定，需要变更者 FOR UPDATE | 生命周期涉及资源按需 |
| 项目归档/删除/恢复 | FOR SHARE | 当前 actor 共享 | Project FOR UPDATE，再锁子资源 |
| 当前用户 SUPER_ADMIN 操作 | 按实际业务模式 | 无组织关系不制造 Membership | 仍验证真实资源与状态 |

- User/ApiKey 身份行正常读授权使用 FOR SHARE，确保权限敏感的更新/删除与授权写事务有序；平台邀请锁发送者及接受者 User。
- grants 的修改/删除必须持其 Membership FOR UPDATE；普通业务持该关系 FOR SHARE 后重读 grants，防止撤权与提交交错。不能只锁不存在的 grant 行。
- 保留 `TasksService.update` 在完成任务时的 Project FOR NO KEY UPDATE 串行化，权限锁在其之前；该路径不得先取得同一 Project FOR SHARE 再升级。其他既有业务锁同样先确定所需强度，不为套用统一 helper 删除原保护。
- owner 转移按本序重写现有组织先写、成员后写的路径，并增加双方版本，保持旧 OWNER -> ADMIN 的产品规则。
- 组织删除、成员新增/移除和项目状态变化必须重新验证事务内状态。SYSTEM 无用户身份行，但不能反向锁序。
- 新 Membership 插入属于当前事务创建，不用伪造“已经存在的目标成员锁”；组织互斥保护名额，数据库唯一约束保护重复加入。
- 数据库写提交与撤权串行化；新授权判定在撤权提交后拒绝。已经完成的读取响应无法追回；正在执行的读取不承诺全部阻塞到撤权完成。
- 无网络调用、文件上传或邮件发送放进权限锁事务。手动检查先授权并创建检查意图，提交后执行；已授权的在途执行无法取消所有外部副作用。
- 仅数据库冲突/死锁等可重试错误允许最多 3 次整个事务重试，使用稳定幂等事件键及有界退避；业务 400/403/404/409 不重试。重试用新 tx 并重读权限。不要对所有异常无差别重试。
- 新增并发测试以 barrier 协调，不用 sleep 代替锁序证明。对组织互斥热点测等待时间，不能为了性能静默移除保护。

### 7.5 缓存与条件请求

本版选定两种明确路径：

- 项目仪表盘等同项目统一数据：缓存不依赖个人角色的原始业务快照，每次命中前验当前 org/project/grants，命中后做角色相关白名单投影/脱敏。缓存不能含明文凭据。
- 组织列表/聚合等随用户范围变化的数据：先过滤再查询；若缓存最终响应，key 必须包含 principal ID、Membership.id、权限版本、当前组织/平台角色及 query。API Key 包含 keyId 和当前 scopes 指纹。

使用新 `monitoring:v2` 或明确 ACL 版本前缀，不读旧 v1 全量响应。所有副本切换时重启清空各自 L1；Redis 旧业务键只能按已核定 namespace 退役，不删除无关队列或去重数据。

检查权限必须先于 ETag/304；ETag 包含最终投影与当前授权指纹，无权不能返回 304，降权不能因旧 ETag 复用高权限正文。HTTP 私有资源不得使用共享 public 缓存。

自动化验收覆盖 L1 命中、L2 命中、旧键存在、两副本、撤权、角色降级、移出再加入、旧 ETag；正常均匀项目快照不要求每次 ACL 修改全量 purge，但权限检查/投影绝不能跳过。

## 8. 必须覆盖的资源与文件入口

| 模块 | 要求 |
| --- | --- |
| Projects | 用户列表范围、详情/设置；创建/删除/恢复仍组织管理 |
| Tasks/Sprints | 动作矩阵、restore 例外、子资源归属、个人关注 |
| Comments/Attachments | 从 Task 解析；最低写角色、作者/上传者约束 |
| Labels | 组织/项目标签分流，任务仅可同项目或合法共享标签 |
| Monitors/Checker/State | VIEWER 读、MEMBER 检查、ADMIN 配置；不改变协议引擎 |
| Monitoring/insights/历史/导出 | 全部校验项目；组织聚合限定范围 |
| RuleGroups/Bindings | 组织模板与项目规则分流；update/softDelete 携带 org/project 条件 |
| AlertEvents retry | 项目 ADMIN，delivery 所属事件/项目一致 |
| Notifications/SSE/Cron | 产生、读、count、投递授权及历史范围 |
| Developer API | PAT 项目权限与 scopes，机器身份独立 |
| Probes/NotificationChannels | 组织管理资源，结果/日志/include 不旁路 |
| StatusPages | 管理仅组织 OWNER/ADMIN，公共发布单独处理 |
| API Key/完整成员目录/AuditLogs | 本版仅组织 OWNER/ADMIN，不把组织审计给局部项目管理员 |
| Organizations 生命周期 | 组织删除、所有权转移、成员代次/版本与全局锁序 |

共享资源最小选项：

- GET `/api/projects/:projectId/probe-options`：合法组织探针的 id/name/在线状态，不含凭证、执行目标、其他项目绑定。
- GET `/api/projects/:projectId/notification-channel-options`：id/name/type，不含 webhook/secret/收件人/投递历史。
- 项目 ADMIN 仅在项目监控路由绑定/解绑探针，核对同组织；不能操作探针配置。
- 组织模板只暴露允许复用的最小摘要，项目 ADMIN 只能改本项目规则/绑定；组织模板修改仍组织管理能力。

### 私有附件契约

- 任务第一方上传 PRIVATE，返回任务授权 download 路由，不返回 provider 的永久公开 URL。
- StorageService/providers 显式接收服务器决定的访问类别。PRIVATE 分支忽略所有 publicBaseUrl，LOCAL 流式读取，OSS 私有容器短期签名 URL。
- 上传先在短事务中授权，再执行私有存储 IO，最后短事务复核权限并落库；失权后不落授权元数据，新增孤立对象走受控清理，不能跨存储 IO 持长数据库锁。
- 删除先在授权事务内删除附件元数据并写审计，保存可信对象定位，提交后尝试物理删除。撤权不撤销已提交的删除；存储失败沿现有失败日志/运维清理策略处理，不恢复已删除元数据，不宣称数据库与对象存储强一致，残留对象必须仍不可匿名读取。
- `/tasks/:taskId/attachments` 的 UPLOAD 元数据保存不能信任客户端 fileKey/provider/bucket/url。第一方上传从本服务产生的私有对象定位写入；普通公开 object 不直接关联成私有附件。
- 若需将普通公开素材加入私有任务，本版只能经服务器验证所有权后复制到私有位置；无法提供可信对象记录时拒绝，不能临时靠 key 格式声明所有权。
- 旧文件按经运维确认的映射迁移，确认 bucket ACL、反向代理、静态根和 CDN 已不再匿名暴露旧私有对象。只改 API 无法撤销旧公开地址。
- OSS 签名 TTL 默认沿现有 300 秒，记录最大撤权残留窗口；已签发 URL 至过期前可用。若要求更严格开始下载授权，改为代理下载设计；已开始流和已下载内容仍无法追回。
- UNKNOWN 默认拒绝；EXTERNAL 明确只保护元数据，敏感文件应迁移第一方私有上传。

### 公开资源例外

`/api/status/:slug` 为组织管理员主动发布的公共页面，不受私有项目 ACL 控制。只显示主动发布且 org/project 未删除的资源，不泄露凭证和未发布数据。需要私有状态页时另行设计，不宣称原公共链接自动保密。

普通公开素材仍是独立产品边界，不全面重构素材库；私有任务对象不得被 public object 路由读取。

## 9. PAT 与组织 API Key

### PAT

```text
PAT 有效 + 当前有效 User + 当前 Membership
    + 当前项目授权 + 操作能力 + token scopes
```

- write scope 不是项目 ADMIN；项目 VIEWER 携带 monitors:write 仍不能配置监控。
- PAT 组织列表/overview 同用户项目范围，撤权立即影响后续判定，不要求重签 JWT。
- 验证当前 User.isActive/deletedAt/globalRole，不信任 token 快照。
- 本版建议 PAT 仅允许 `/developer/v1`，普通 JWT API 对 PAT 返回 403；DeveloperAuthGuard 路由仍由 @Public 跳过全局 JWT，再执行真实开发者认证。
- 该兼容变化需产品确认和脚本迁移；不接受时必须先设计普通 API 完整 scope 映射，不能保留旁路。

### 组织 API Key

保留组织级全项目机器凭证，由 OWNER/ADMIN 创建并明确确认，scopes 限制操作。

- 验 key 有效、组织有效、资源归属及 scopes；AccessPrincipal 为 API_KEY。
- createdById 仅审计归因，不构造 request.user 代替机器授权。
- 创建者离职后凭证按组织策略存续至撤销/过期，不声称个人项目撤权会撤销机器凭证。
- 不向局部项目成员分发全组织 key；未来项目 key 需要独立 grants 模型。
- 审计记录认证类型、keyId、创建者归因，区分真人与机器。

## 10. 通知、投递与生命周期

### 10.1 项目事件

1. 原参与者集合与当前项目可读成员取交集，额外角色限制按事件定义。
2. 同业务事务写带 PROJECT 范围的 Notification 与 delivery 意图，保留去重。
3. worker 对当前范围重新授权，无权将自己持有的任务记 SKIPPED，不重试权限不足。
4. Redis 到本机用户流前再次核对当前权限，异步过滤保持同一用户流的消息顺序。
5. list/detail/unread/read 返回体使用统一谓词，先过滤再分页/count。
6. 监控恢复受众与当前项目授权重新取交集；任务提醒和 assignee 邮件同样执行策略。
7. 未知历史通知/旧 outbox fail closed，不改为 ACCOUNT，也不删除去重 tombstone 后重新投递。

### 10.2 在途投递边界与租约

**本版建议采用“短事务记录投递授权，已授权尝试属于在途例外”。此边界仍需产品确认，不能承诺严格的外部发送即时撤销。**

- worker 先领取现有 leaseToken，再在短事务中按第 7.4 节锁序验证身份/org/project/成员资格和邀请状态，最后锁 delivery，确认仍拥有未过期租约。
- 合法时记录 dispatchAuthorizedAt 并提交；不合法则条件更新 SKIPPED；事务内不调用邮件、Redis 或其他外部网络。
- 撤权在授权事务前提交：该尝试必须 SKIPPED，不调用发送 adapter。授权事务先提交：本次已授权尝试可在撤权后完成，属于明确在途例外。
- 下一次重试/租约接管必须重验当前权限，不复用旧 dispatchAuthorizedAt；旧授权不是永久能力。
- 网络调用前确认/续租 token；续租或归属验证失败不开始新调用。只有当前 leaseToken 可写完成/失败状态，租约变化后旧 worker 的更新应影响 0 行。
- 当前租约是 120 秒；要求外部调用有有界超时和安全余量，必要时按 token 续租。支持取消的请求使用真实取消，不以 Promise.race 冒充已经终止网络副作用。
- 每个 leaseToken 最多启动一次 adapter 调用。外部邮件使用稳定 dedupKey/提供者幂等键；跨 token 重试仍属于至少一次语义，不保证数据库与外部系统原子 exactly-once。
- 已进入外部系统的调用不能因租约丢失追回；严格零重复/零在途披露需要另行设计，不以租约或发送前复查虚假承诺。
- 本地 SSE fan-out 的最后一次当前授权检查决定该本地投递是否已在途；撤权后重新判定必须拒绝。流中已推入/已写入的字节不能追回。
- 若产品不接受这些在途例外，停止本方案实施，重新设计通知内容、投递机制或撤权确认协议。

测试必须用 barrier 暂停在授权前/授权后/adapter 调用中，验证撤权两种顺序、接管后原 worker 的条件更新、adapter 幂等及本地 SSE 过滤，不以时间猜测竞态。

### 10.3 事件范围与成员生命周期

- 邀请、移出组织、账号安全事件按明确 INVITATION/ACCOUNT 等 scope 保持合理可见，不能用 allowOutsideOrg 放行项目事件。
- 撤权确认可发无项目名、目标或深链的账号通知。
- 旧任务、评论、创建者、assignee 可保留历史；不能再分配无 MEMBER+ 权限用户或发送私密提醒。watcher 清理不是授权依据。
- 新项目仅组织管理员默认管理；普通用户无权限，createdById 不提供旁路。
- 移出/离开删除 Membership 级联 grants，重新加入产生新代次，只获得新邀请 grants。
- 所有权转移仍为新 OWNER、旧 OWNER -> ADMIN，两人版本递增，旧授权替换请求 409。
- 软删除停普通访问，恢复依保留 grants；未知或依赖故障拒绝，不降级全量开放。
- 外部机器人、群成员、渠道收件地址是独立外发策略，不宣称站内撤权可移除外部用户或追回邮件。

## 11. 存量迁移与上线

这是访问语义切换，不是只加空表。

### 迁移清单

1. 导出角色、成员代次、旧邀请、项目、通知范围及公开附件情况，保存受控安全备份。
2. 扩展 grants、邀请来源、权限版本、通知 scope、投递授权时间、附件类别与约束；不按组织成员乘全部项目自动回填。
3. OWNER/ADMIN 不生成重复 grants；核对误当“项目管理员”的历史组织 ADMIN。
4. 管理员确认普通成员项目/角色清单；不从 assignedTo/createdBy/访问日志推断授权。
5. 无清单的 MEMBER/VIEWER 默认无权限，提前通知可能失去访问。
6. 旧 PENDING 全部撤销重发，LEGACY 不接受。
7. 回填可可靠识别的通知，未知不显示、不计数、不投递，保留去重。新投递尝试不能承接旧代码尚在运行的 lease。
8. 运维处理私有附件公开路径和外部受众清单；EXTERNAL/UNKNOWN 明确归类，不伪称公网链接已被 Guard 撤销。

### 发布顺序

- 隔离库演练旧 schema/数据 -> 新迁移 -> 授权清单 -> 新代码。
- schema 可提前扩展，但旧应用仍无项目边界，不能视为修复阶段。
- 正式切换暂停写入、旧 API/worker；等待已在途投递结束或明确按 10.2 处置，不仅停止新的定时触发。
- 应用管理员确认的授权清单、邀请/通知/附件处理，同步前端契约与全部副本；新缓存 namespace，不读旧全量缓存。
- 验角色、PAT、机器 key、真实私有文件访问，确认所有旧副本退出，再恢复业务。
- 观察 403/404/409、锁等待/重试、查询计划、outbox SKIPPED 与投递在途记录。

不增加 PROJECT_ACL_ENABLED=false 旁路。回滚保持限制访问/维护模式，保留授权数据；不能退到旧代码重新开放全部项目。生产迁移只用 deploy，不用 reset/db push。

## 12. 前端交互契约

当前未核对前端源码，不代表已适配。

- 邀请：邮箱、组织身份、项目选择及逐项角色；普通成员项目不默认全选。
- 组织 ADMIN 明确“全部现有及未来项目”，不与部分项目限制同时呈现，需确认团队管理权。
- 组织 VIEWER + 指定项目 VIEWER 表示所选项目只读，不表示未来所有项目自动可读。
- 组织角色与项目 grants 分开展示，版本冲突刷新处理。
- 授权读取保留 membershipId/version，提交带 expectedMembershipId/expectedVersion；409 必须重新加载，不能只替换版本后自动重试旧 projects。
- 切换器仅显示后端可访问项目，无项目是正常空状态。
- 能力决定按钮但服务器重新授权；403/404 或已获得的权限变更事件触发权限、项目列表与详情缓存刷新。
- 协作者/负责人候选使用项目成员接口，不复用完整组织目录。
- 明确文件签名残留窗口、已在途投递边界和外部链接/公开状态页边界，不宣传“撤权追回已下载文件/邮件”。

## 13. 实施范围、顺序与命令

### 允许修改范围

- `prisma/schema.prisma`、本次 `_project_access_control` 增量迁移、`src/generated/prisma/`。
- `src/common/authorization/**`、相关 guards/decorators/interfaces/index；AuditLogInterceptor 仅标准上下文与避免重复审计。
- `src/modules/{invitations,memberships,organizations,projects,tasks,sprints,comments,attachments,labels,monitors,monitoring,checker,state,rules,alert-events,notifications,developer-api,probes,notifier,status-pages,audit-logs}/`：仅授权入口、查询、生命周期锁、版本、受众及测试。
- `src/shared/quota/quota.service.ts` 与 spec：仅成员 tx 配额；`src/shared/subscription/effective-plan.service.ts` 与对应测试：仅 tx 读取入口，不改变套餐逻辑。
- `src/modules/auth/entities/user.entity.ts` 及对应序列化测试仅隐藏新增内部身份计数；不修改登录、2FA、OAuth 流程。平台身份代次由本次迁移 trigger 维护。
- `src/modules/admin/tenants/` 仅组织删除/恢复入口接入同一生命周期锁序及授权上下文，不改变后台产品功能。
- `src/modules/cron/jobs/` 仅任务提醒资格；`src/modules/email/email.service.ts` 及测试仅投递超时/幂等适配，禁止无关模板改写。
- `src/infra/cache/`、monitoring ETag 仅授权后投影/命名空间/条件请求必要变动。
- attachment storage types/providers/测试，必要 `src/config/storage.config.ts` 及 `.env.example` 仅非敏感公开配置契约，不修改本地 `.env`。
- `src/app.module.ts` 仅权限注册、相关 feature imports。
- `test/project-access.e2e-spec.ts`、`test/project-access-postgres.integration-spec.ts`、`test/project-access/{harness.ts,safety.spec.ts,prisma.config.ts,legacy-fixtures.sql}`。
- `test/monitoring-dashboard.e2e-spec.ts`、`test/monitor-postgres/monitor.integration-spec.ts` 仅修步骤 0 已确认构造器参数基线，不删除覆盖。
- `.github/workflows/project-access-validation.yml` 如为可靠验收必需，只跑本方案测试和隔离依赖；不改用户已有监控 workflow。
- 本方案、`advisor-plans/README.md`、必要 Swagger/README/授权契约。

### 不允许修改

- 无关协议、探针算法、计费价格/支付、登录/2FA 产品流程。
- 无关依赖升级、全仓格式化、删除/回退用户既有修改。
- 未另获授权的前端仓库、实际环境配置、生产 grants 清单、真实用户/凭据。
- 旧监控 `plans/` 的编号/状态，下载目录原稿。

分支建议 `codex/project-access-control`，PR 目标 master，不自动切换、提交、推送或创建 PR。按实际基线比较新增 diff，不把用户已有修改视为本任务成果。

漂移检查先执行：

```powershell
git status --short
git diff --stat 04e9253..HEAD -- prisma src test .github/workflows/ci.yml
git diff --stat -- prisma src test
```

提交差异、未提交差异及未跟踪文件均需核对。相同 SHA 不能代替现状摘录验证。

### 步骤 0：确认产品边界并修验证基线

确认第 16 节决策项。只修第 1 节两份旧测试的 7 处构造器参数，使其匹配当前服务依赖；mock 禁止触发外部邮件。新路由/数据库实现尚未开始。

验证：`pnpm type-check` exit 0；`pnpm test -- src/modules/invitations/invitations.service.spec.ts src/modules/projects/projects.service.spec.ts --runInBand --no-cache` 全通过。不能保留原类型失败再把 ACL 质量门禁宣称绿色。

### 步骤 1：拒绝用例与 harness 安全层

建立 O1/O2、A/B/C、组织/项目角色、PAT/API Key fixtures。添加泄漏特征用例并最终改为拒绝断言，准备两类 disposable 数据库白名单及安全测试，不接触开发库。

验证：`pnpm exec tsx --test test/project-access/safety.spec.ts` exit 0，覆盖非法协议/主机/库名/query/hash、缺失 URL、非空数据库拒绝；邀请/项目单测仍通过。

### 步骤 2：数据模型和策略

新增第 4 节模型/字段、固定权限动作、Resolver、principal、tx 锁与重试 helper，保持薄控制器及既有响应格式。

验证：`pnpm exec prisma validate`、`pnpm prisma:generate`、`pnpm type-check` exit 0；`pnpm test -- src/common/authorization --runInBand` 全通过。schema 与生成客户端同步提交，实验迁移只用于经验证的一次性库。

### 步骤 3：邀请、授权与生命周期

实现固定邀请来源/grants、SUPER_ADMIN 身份代次分支、成员配额 tx、双重 optimistic precondition、角色与 owner 转移版本、移出/重加和事务审计。

验证：`pnpm test -- src/modules/invitations src/modules/memberships src/modules/organizations src/shared/quota src/shared/subscription --runInBand` 全通过；`pnpm type-check` exit 0。包含原成员关系删除重建、平台身份失权、不同邀请竞争末位、grants/outbox 回滚；真实锁行为最终由第 6 步验证。

### 步骤 4：全业务入口、缓存、文件

按第 8 节接入动作及父子归属，列表/聚合带 principal，项目管理员不残留组织 ADMIN 门槛；落实 raw cache/授权投影、ETag、PRIVATE 存储契约。

验证：`pnpm test -- src/modules/projects src/modules/tasks src/modules/sprints src/modules/comments src/modules/attachments src/modules/labels src/modules/monitors src/modules/monitoring src/modules/rules --runInBand` 全通过；`pnpm type-check` exit 0。

用 Nest 路由元数据建立覆盖表检查项目业务 handler 的动作与认证方式，明确组织/公开/内部例外。不能只靠 rg 文本搜索证明没有遗漏。

### 步骤 5：开发者入口与通知

PAT 范围/scopes、机器身份、通知 scope、列表/count、worker 授权尝试与租约、本地 SSE、定时提醒、历史回填策略。

验证：`pnpm test -- src/modules/developer-api src/modules/notifications src/modules/cron --runInBand` 全通过；`pnpm type-check` exit 0。覆盖撤权前后授权边界、租约接管、未知 scope、邀请状态和去重，不发送真实网络邮件。

### 步骤 6：真实事务、HTTP、升级验收

| 命令 | 成功条件 |
| --- | --- |
| `pnpm exec prisma validate` | exit 0 |
| `pnpm prisma:generate` | 客户端生成成功并同步 |
| `pnpm type-check` | exit 0，含旧测试基线 |
| `pnpm test -- --runInBand` | 全量单测通过 |
| `pnpm exec tsx --test test/project-access/safety.spec.ts` | 全部安全测试通过 |
| `pnpm test:project-access:postgres` | 配置有效、真实约束/并发/升级测试全部执行并通过；入口为 `test/project-access/database.integration-spec.ts` |
| `pnpm test:project-access:http` | 真实 HTTP 授权测试执行且通过，零 skipped/todo；入口为 `test/project-access/http.integration-spec.ts` |
| `pnpm lint` | exit 0，核对 --fix 无无关修改 |
| `pnpm build` | exit 0 |

### 隔离数据库与 HTTP harness 契约

- integration 新安装只接受 `PROJECT_ACCESS_TEST_DATABASE_URL`，白名单 `localhost/127.0.0.1/[::1]`、postgres/postgresql、`beacon_project_access_test[_suffix]`。
- integration 旧库升级只接受独立 `PROJECT_ACCESS_UPGRADE_TEST_DATABASE_URL`，同主机/协议限制、库名 `beacon_project_access_upgrade_test[_suffix]`。验收命令必须同时运行新安装和升级两个场景。
- HTTP 只接受独立 `PROJECT_ACCESS_HTTP_TEST_DATABASE_URL`，同主机/协议限制、库名 `beacon_project_access_http_test[_suffix]`。
- integration 启动时先检查它需要的两套库均为空，再进行任一 DDL；HTTP 启动时检查自己的库为空。每个入口拒绝自己所需 URL 缺失、query/hash、远程主机、开发/生产库或非空库；不读取 `.env` 或回退 DATABASE_URL，缺配置非零退出，不能 describe.skip。
- 完整验收预先提供三套新空 disposable 库并确认解析后的服务器/端口/库不重复，命令不创建或删除数据库。前一个 suite 已完成的库可非空，后一个 suite 不再对它做空库预检，也不能借其进行第二个场景；重跑对应 suite 必须提供新的空库。
- 安全检查在任何 DDL/fixture 前执行；拒绝危险 URL 时也不记录含凭据的完整值。错误仅说明变量名与安全条件。
- 用 `test/monitor-postgres/harness.ts` 的 URL 结构化解析、pg_class/pg_type 非空检查、临时迁移目录和明确 `--config` 模式，自建本方案白名单；不能调用旧 helper 放宽其规则。
- 用独立 `test/project-access/prisma.config.ts` 指向经检查的测试库及暂存迁移，不读取生产 env；准备旧 schema 用本次 ACL 之前的迁移，旧 fixture 用 pg 参数化 SQL，之后应用本次增量迁移。
- integration 新安装在第一套空库 deploy 完整新 schema，旧库升级在第二套空库准备旧 schema/fixtures 后应用增量迁移；两个场景不复用数据库、不做 reset。HTTP 在第三套空库自动 deploy 新 schema 后建立 fixtures，不要求手工预建业务数据。
- HTTP 使用 Test.createTestingModule 组装所需真实控制器、业务服务与 guards，显式提供 `new ConfigService({ database: { url: validatedHttpUrl }, app: { isDevelopment: false }, ...testOnlyConfig })`，同一真实 PrismaService 实例用于 fixtures 和所有请求；不 import 会读取 `.env` 的 AppModule，不让配置工厂读取生产 DATABASE_URL。
- 在任何 fixture/HTTP 请求前，用运行时 PrismaService 查询 current_database() 并与已校验 HTTP URL 的库名比对，同时断言各业务服务解析到同一 PrismaService；不符立即失败。只验证 migration datasource 不够。
- 迁移完成后初始化临时 Nest HTTP 服务，使用真实 JwtAuthGuard/OrgMemberGuard/ProjectAccessGuard/DeveloperAuthGuard，禁止 override 授权守卫；仅替换邮件、Redis 外发和非授权网络执行器。
- 固定 NODE_ENV=test、外部 sender mock；Redis fan-out 策略可用两实例 stub 测，真实跨实例测试采用隔离测试 Redis namespace，不发布到真实用户 channel。
- 并发用独立数据库连接及 barrier，覆盖最后名额、成员删除/重建、owner 转移与 ACL、项目删除/接受、发送者失权。
- 验收报告包含实际 suite/test 数及 skipped/todo=0。可以另设可跳过的日常便利命令，但第 6 步验收入口不允许跳过。
- teardown 关闭 HTTP、数据库和 worker/timer，只清理带明确 run 标记的临时文件/目录；不 drop/reset 数据库。重跑使用新 disposable 库，由操作者另行处置旧库。

本节列出验收要求，不是通过证明。新增脚本的实际实现与运行状态以末尾最新实施记录为准；提供脚本不代表第 14 节全部用例已实现或实际执行通过。

## 14. 验收矩阵

以下最终均需自动化覆盖，PG 并发不以 mock 代替：

| 场景 | 期望 |
| --- | --- |
| MEMBER，A=VIEWER，B=ADMIN，无 C | 仅 A/B，A 写 403，B 管理通过，C 404 |
| 邀请 MEMBER，A=VIEWER，B=ADMIN | 接受仅 2 grants，组织仍 MEMBER |
| 新建 D | 该用户无 D |
| 组织 VIEWER 输入 ADMIN grant | 400；遗留记录有效角色仍 VIEWER |
| 普通邀请 projects 缺失/空 | 400，不授权全部 |
| ADMIN 邀请带 projects | 400，不产生受限组织管理员 |
| PUT 空数组 | 撤销全部，不变成全项目 |
| OWNER/ADMIN 无显式 grants | 仍全项目含未来项目 |
| orgId/projectId 跨组织、路径与资源父级不一致 | 404/输入 400，零越界查询/写入 |
| task body 的 sprint/label/dependency 外项目 | 拒绝，原同项目规则保留 |
| VIEWER 写业务/检查/告警 | 403，无写入 |
| VIEWER 维护本人关注 | 按 task.subscribe 允许，不修改任务内容 |
| 项目 ADMIN 评论/附件管理 | 可删他人，不可编辑他人，不可组织提权 |
| assignee 无本项目 MEMBER+ | 拒绝，零自动 watcher/提醒 |
| 组织 monitor/overview/list/count | 无权项目不影响明细、总数、比率、incidents |
| 普通成员读共享设施完整配置/结果/日志 | 403；最小项目选项不含其他项目/secret |
| write scope + 项目 VIEWER 的 PAT | 写 403，其他项目 404 |
| PAT 普通 JWT API | 默认 403，无 scope 旁路 |
| 旧 JWT/PAT 的 User/平台权限已撤 | 按当前数据库拒绝 |
| 组织 API Key | org/scopes/归属约束，不借创建者个人 grants |
| 发起者离职/降权/项目删除或归档/缺 grants | 接受 409，无部分成员/grants/outbox |
| 发起者离职后重加为管理员 | 原 ORGANIZATION 邀请仍无效，不替换成员代次 |
| 无 Membership 的有效 SUPER_ADMIN 发邀请 | PLATFORM 分支可接受，不虚构成员 |
| PLATFORM 发起者停用/删除/失去平台角色 | 拒绝，不改按组织身份接受 |
| PLATFORM 发起者失权后恢复相同角色 | 旧 issuerAuthorityVersion 不同仍拒绝，必须重发 |
| 普通 ORM/脚本/直接 SQL 改平台角色或有效状态 | trigger 同步更新身份代次，不能直接重置计数 |
| 同一邀请接受/撤销/重复接受 | 最多一次成功，状态与 outbox 一致 |
| 不同管理员两邀请竞争最后一个名额 | 仅一名新成员，另一方无 grants/欢迎意图 |
| 同代次两 ACL 替换并发 | 一个成功，一个版本 409 |
| 离开重加后旧版本号刚好相同 | expectedMembershipId 不符 409，新 grants 不变 |
| 移出与授予并发 | 无孤立 grants，移除后新判定拒绝 |
| owner 转移与 ACL/角色更新竞争 | 锁序一致，双方版本更新，不覆盖较新权限 |
| 撤权后通知 list/detail/unread/read | 项目通知隐藏，分页/count 一致 |
| 授权边界前撤权，队列/恢复/提醒 | SKIPPED，不调用 adapter |
| 授权边界后撤权 | 本次仅按已确认在途例外完成；下一次重验并拒绝 |
| lease 过期接管、旧 worker 恢复 | 无归属不能开始新调用或写状态，外部调用按幂等处理 |
| Redis 排队通知本地 fan-out 前撤权 | 当前检查拒绝，不仅查产生时受众 |
| 两级缓存/两副本命中后撤权、降权 | 不泄露，投影使用当前权限 |
| 移出重加且版本相同、旧 cache key | 不复用旧成员代次最终响应 |
| 无权请求携带旧 ETag | 404，不 304；降权后不复用高权限正文 |
| deleted org/project、非法 grants | 拒绝，restore 仅特定动作通过 |
| PRIVATE + publicBaseUrl / 匿名对象路径 | 无永久公共链接，匿名不可读，任务路由授权 |
| 普通公开 object 保存为任务 UPLOAD | 拒绝或可信所有权验证后私有复制，不直接关联 |
| EXTERNAL/UNKNOWN 附件 | 外部边界明确；UNKNOWN 拒绝直到回填 |
| 公开状态页 | 仅发布且未删除资源，不宣称受私有 ACL 控制 |
| DB 直接跨组织写 grants | 复合外键失败 |
| 任一 grant/outbox/审计写失败 | 事务全部回滚，不开始外发 |
| 无普通成员回填清单的旧库升级 | 普通成员默认无项目，不自动全量授权 |
| 新 HTTP/PG URL 缺失/危险/非空 | 非零退出，零 skipped，危险库零 DDL |
| 新安装/旧升级/HTTP 共用库或 HTTP runtime datasource 不符 | 预检/运行时校验失败，不复用数据库或连接开发库 |

## 15. 完成标准与停止条件

### 完成标准

- 第 14 节全部测试实际执行通过，第 13 节全部命令 exit 0，验收 suite 零 skipped/todo。
- 授权回填经管理员确认，旧数据升级演练通过，缺失范围无全量 fallback。
- 路由元数据覆盖所有入口，服务查询带范围，grants/角色/代次/版本一致。
- 普通邀请固定 grants，发起者两身份分支、平台身份代次 trigger、配额互斥和 SUPER_ADMIN 不需要组织 Membership 的场景通过。
- 组织生命周期与授权写入使用统一锁序；真实并发测试无死锁循环、孤立记录或超额加入。
- 通知授权尝试、租约、在途例外、历史范围、去重和 SSE 最后判定均落实，文件匿名访问经部署配置核查。
- 缓存命中/ETag 不绕过当前授权，权限敏感最终响应不会跨代次/角色复用。
- 审计在事务内可查询，Swagger/前端契约明确组织与项目角色、双重 precondition、PAT 和公开资源边界。
- 全副本/worker 一致切换，无旧应用继续服务；rollback 不开放旧权限。
- 相对实时基线的新增 diff 仅限范围，未覆盖用户修改；更新 `advisor-plans/README.md` 的本方案状态，设计 TODO 不写为实施 DONE。

### 停止条件

- 产品决策未确认，或要求组织 ADMIN 仅限部分项目/项目 ADMIN 管邀请/ACL，需要重做模型。
- 不接受 VIEWER 上限、PAT 收紧、存量默认拒绝、旧邀请撤销或通知在途边界。
- 现状摘录与代码不符且无法通过正常漂移核对解释，或新增旁路未纳入资源表。
- 步骤 0 后类型检查仍失败，需要改协议/支付等范围外逻辑；不能删除断言/排除测试过关。
- 缺少安全 disposable 库，验收会碰开发/生产库，suite 静默跳过或尝试 reset/db push。
- 无法保证跨入口锁序、tx 传递、平台邀请验证、成员关系代次或事务审计。
- 公开私有文件地址尚未处理，或要求追回已发送/已下载内容而本方案无法提供。
- 同一验证连续两次合理修复仍失败，先报告而不是关闭安全约束。

维护重点：新增项目资源、聚合、导出、通知和开发者 API 时，同时补动作、资源解析、范围过滤、缓存投影及负向 HTTP 回归；授权不能靠组织 ADMIN 门槛或空范围全量放行替代。

## 16. 修订记录与待确认决策

### v2 修订摘要

- 校正当前仓库路径、基线和状态索引，移除缺失文件作为执行依据。
- 增加成员关系 ID + 版本的 ABA 防护，发起者成员代次、PLATFORM 独立验证及不可复活的身份代次。
- 明确组织互斥/同 tx 成员配额，补齐 organizations、shared/quota、effective-plan 的实施范围。
- 加入身份/组织/成员/项目全局锁序、当前权限复核和有界重试。
- 明确邮件/SSE 在途授权边界、租约接管和至少一次语义，不承诺外部原子发送。
- 选定缓存/ETag 策略，补私有附件类别、存储接口和外部链接例外。
- 前置记录 7 处既有类型错误；新增新安装/旧库升级/HTTP 三套独立测试库、安全 helper、运行时 datasource 校验和零跳过验收。

### 产品与发布决策

更新本方案不代表批准以下兼容/产品决定。实施步骤 0 逐项记录确认结果，不静默默认已同意：

| 决策 | 推荐本版行为 |
| --- | --- |
| 谁能授予组织 ADMIN | 仅 OWNER/当前 SUPER_ADMIN |
| 普通邀请是否可仅加入组织 | V1 不允许，必须至少一个项目 |
| 组织 VIEWER 上限 | 始终项目只读 |
| PAT 普通 API 兼容 | 仅 developer/v1，迁移旧脚本 |
| 存量普通成员与邀请 | 显式回填，缺失无权；旧 PENDING 重发 |
| 通知与检查在途副作用 | 接受已授权尝试的在途例外，不承诺追回 |
| 查看者个人关注 | 可维护自己的订阅，不写任务业务数据 |
| 外部附件、签名链接、公开状态页 | 明确例外与残留窗口，敏感文件用第一方私有上传 |

完成上述确认和基线修复后，方案可按阶段实施；阶段开发不等于分批开放未经完整保护的 API。

2026-10-12 用户在询问是否采用全部 v2 推荐规则后明确回复“实施”，随后再次要求实施。上表推荐行为现已批准，本文此前“待确认”表述属于设计评估时的状态，不再是本轮实施阻塞。前端仍不在本轮源代码修改范围。

### 2026-10-12 后端实施启动记录

- 用户要求先实施后端；当前实时提交核对为 `7e2e733`。前文 `04e9253` 与类型错误表为设计评估时的历史基线，不再代表当前工作区。
- 已重新运行 `pnpm type-check`，exit 0；此前记录的 7 处错误当前不再出现，本轮未修改对应业务或测试源码。
- 已重新运行邀请/项目服务单测，2 个 suite、59 项通过。
- 当前大量源码 git status 变动在 `git diff --ignore-space-at-eol` 下没有内容 diff；锁文件有既有内容修改，未覆盖或回退。
- 已新增 `test/project-access/database-safety.ts`、`safety.spec.ts`、`prisma.config.ts`，以及 `pnpm test:project-access:safety` script。
- 本轮只实现步骤 1 的数据库安全函数和独立配置：三类变量/库名前缀、本地地址白名单、无应用 datasource 回退、运行时数据库身份校验、全部所需空库预检、重复场景与元数据不一致拒绝、秘密不进入自定义错误。
- 安全回归使用模拟 query 客户端，不连接 PostgreSQL。迁移 staging、真实数据库连接及约束/并发/HTTP harness 尚未实现，不能把安全单测当作真实数据库验收。
- 新安全回归 115 项全部通过，零 skipped/todo；独立审阅指出的原始驱动异常传播已修正，query 失败采用固定安全提示且不保留原始 cause，并有合成凭据失败用例。
- `pnpm type-check`、`pnpm build` 和新增测试文件的无 `--fix` ESLint 检查通过；未运行全仓 lint 或全量单测，未生成 Prisma client、执行数据库迁移或外发通知。
- 上述前置层完成时第 16 节产品决策尚待确认；随后用户明确回复“实施”，本轮按全部 v2 推荐规则继续。不得据前置层记录宣称全项目 ACL、邀请 grants、私有附件或通知授权已完成；整体保持 IN PROGRESS。

### 2026-10-12 后端核心阶段记录（历史快照）

当前实现基于 `7e2e733`，未提交、未推送。实际变更如下：

- Schema 新增 ProjectRole、ProjectMembership 及组织一致性复合外键，Membership 权限版本、InvitationProjectGrant、邀请来源/代次、平台身份版本、通知范围/投递授权时间及附件类别。
- 新增 `prisma/migrations/20261012120000_project_access_control/migration.sql`，包含兼容 LEGACY 的 CHECK、跨组织约束、平台身份版本触发器和旧 PENDING 撤销；没有自动 grants/通知/附件回填，也没有执行这份迁移。
- `src/common/authorization/` 新增类型化主体、固定动作、角色计算、显式资源解析、ProjectAccessGuard、查询过滤和锁/有限重试 helper。当前 VIEWER 上限、空授权拒绝、归档只读、父子/组织归属检查均有单测。
- 新增组织本人能力、成员项目授权 GET/PUT、项目本人能力、最小协作者、probe/channel options 共七类接口。替换同时要求成员关系 ID 与版本，空数组撤权，版本/授权/完整 before 审计同事务。
- 邀请 DTO 要求普通身份有固定项目清单；发送/接受校验当前发起者权限。原组织成员代次与平台身份代次分别验证，接受时组织行互斥、同 tx 成员配额/套餐读取、grants/审计/outbox 原子提交。公共 token 预览仅查/返最小信息，认证详情白名单映射，不返回 token 或内部来源字段。
- 成员角色修改、移出/离开及所有权转移加入统一锁序和事务内复查。角色变更递增权限版本，降 VIEWER 同事务收紧 grants；owner 转移双方版本递增并写事务审计。完整组织成员目录限制 OWNER/ADMIN。
- Projects 列表按当前主体过滤，详情/设置/归档/删除/恢复有显式动作；局部项目 ADMIN 可设置/归档，删除/恢复仍要求组织管理。写事务复核授权；项目 PATCH 首次取得 UPDATE 锁，避免共享锁升级死锁。
- 普通 JWT API 拒绝 PAT，并使用当前有效 User/globalRole；组织守卫也核对当前身份及未删除组织，不信任 SUPER_ADMIN 快照。UserEntity 不向序列化响应泄露平台身份计数。
- 两次独立只读审阅发现并已修复：普通 API PAT 旁路、子资源自身组织字段未核对、被删除项目 grants 未进入替换审计、项目 PATCH 锁升级风险。

新增测试使用模拟 Prisma delegates；权限 HTTP 单测使用真实 Nest/JWT/guards/ValidationPipe，仍不是 disposable PostgreSQL 的 HTTP 验收。既有监控 HTTP mock 补齐当前 User 查询并增加停用用户拒绝断言，保留原有覆盖与真实守卫。

Prisma validate/generate 使用不读取 `.env` 的测试配置和合成的本地 URL，仅解析 schema/生成客户端，不连接服务器。当前 `src/generated/prisma` 实际被 `.gitignore` 忽略且未跟踪，与原项目描述有差异；已本地生成，没有擅自修改忽略规则或暂存文件。

**尚未完成，不能上线：**

1. Tasks/Sprints/Comments/Attachments/Labels、Monitors/Checker/Monitoring/Rules 等全部入口的动作、服务过滤、事务复核与路由覆盖清单。
2. 监控缓存 v2/投影/ETag、第一方 PRIVATE 存储与旧公开路径治理。
3. DeveloperAuthGuard、PAT 全项目范围过滤、API Key 机器主体接入及对应审计。
4. 通知 scope 生产/读取/count/worker/SSE/Cron 接入和投递授权租约边界；当前只有新增模型字段，不能认为此部分已生效。
5. 新安装/旧库升级/真实数据库 HTTP harness、PostgreSQL 约束/触发器/并发验收及回填/切换演练。三个 `PROJECT_ACCESS_*_TEST_DATABASE_URL` 均未配置，不读取或回退业务 DATABASE_URL。

本阶段测试和构建通过仅证明已实现代码的阶段质量，不能替代第 14 节验收矩阵。后续继续步骤 4/5，并补步骤 1/6 的真实 harness；整体状态继续 IN PROGRESS。

最终复测（使用已安装的本地命令入口，未升级依赖）：

| 检查 | 结果 |
| --- | --- |
| Prisma validate（独立测试配置、仅 schema 校验） | exit 0 |
| Prisma generate（独立测试配置、仅本地客户端生成） | exit 0，Prisma 7.8.0 |
| TypeScript `tsc --noEmit` | exit 0 |
| 全量 Jest `--runInBand --silent` | 116 suites、1483 tests 通过；零 skipped/todo |
| project-access 安全回归 | 115 tests 通过；零 skipped/todo |
| 全仓 ESLint 无 `--fix` 检查 | exit 0 |
| Nest build | exit 0 |
| disposable PostgreSQL 新装/升级/并发及数据库 HTTP | 未执行：缺独立测试库配置，相关 harness 尚待补齐 |

全仓检查前，格式修复只作用于本轮相关文件，没有执行全仓格式化；`pnpm-lock.yaml` 的既有内容差异仍为 43 行新增、8 行删除，未修改。验证过程中发现既有监控 HTTP mock 缺少新增身份查询依赖，已补齐 mock 和停用用户拒绝测试；没有替换真实守卫、删除断言或跳过失败用例。

### 2026-10-12 后端业务接入记录

用户要求一并实施原核心阶段留下的任务/监控、缓存、私有附件、通知和开发者 API。当前这些功能已接入后端统一权限，不能继续引用历史“仍待接入”列表描述当前代码。

- Tasks/Sprints/Comments/Labels：读写动作分离，写事务重新授权；负责人要求当前可写项目成员并纳入身份/成员锁；嵌套子任务、依赖、评论回复和标签使用计数过滤授权项目及父子归属。
- Monitors/Checker/State/Monitoring/RuleGroups/RuleBindings/AlertEvents：接入项目策略；概览先过滤当前可见项目；各行使用对应角色投影；只读角色不能触发检查/告警或管理规则；组织基础设施仍要求组织管理。
- 监控缓存：v2 脱敏快照先去凭据再写 L1/L2，缓存读取前验证当前授权，返回时按当前角色重新投影；撤权请求不因旧 ETag 返回 304，降权不复用高权限正文。
- HTTP 目标拒绝 userinfo；执行器也拒绝历史凭据 URL。目标及诊断文本中的 URL 使用 URL parser 去除用户信息、片段并隐藏所有 query 值。诊断提取支持单引号，歧义文本默认整体脱敏；不更改实际执行 URL。
- Attachments/Storage：第一方上传固定 PRIVATE；存储 IO 后再复核元数据写权限，拒绝任意公开对象直接关联任务；对象 key 防穿越并保证特殊扩展名生成/下载一致；UNKNOWN 拒绝。删除元数据及审计先提交，再清理物理对象。
- 本地私有根目录与公开目录隔离并拒绝相同/嵌套根；OSS 要求私有独立 bucket、private ACL、可信 bucket 下载且签名不超过 300 秒；私有路径不返回永久公共 URL。部署 bucket/CDN、代理与历史公开路径仍需实际核查。
- Developer API：API Key 使用真实机器主体，PAT 读取当前有效身份与 scopes 并应用项目可见范围；没有 scopes 元数据默认拒绝；旧 SUPER_ADMIN claim 不旁路；PAT 管理 probes/status-pages 仍须组织管理权限。
- 通知生产者明确范围，覆盖任务提醒、密码/两步验证、API Key/PAT、组织/成员、支付订阅及 probe 安全事件；ACCOUNT 与 ORGANIZATION 不能靠事件名混淆。行政通知按当前 OWNER/ADMIN 过滤；列表/详情/计数以及写操作重新验证，UNKNOWN 不暴露。
- worker 使用当前资格、事务授权时间、条件租约与发送前续租；SSE 在异步正文处理后立即验证租约，本地 fan-out 再验证当前资格。遵循已确认在途例外，不承诺追回已发送内容。
- 公开状态页保持公开边界，同时排除已删除组织/项目/监控并脱敏 target，不宣称公共内容受私人授权控制。

回归包括真实 Nest/JWT/ProjectAccessGuard/ValidationPipe HTTP 负向路由、嵌套父子错误、只读关注、无权旧 ETag/降权、两实例共享 Redis stub 的 L1/L2、附件隔离/撤权清理及通知租约。真实策略加模拟 delegates 的负责人测试覆盖无 grant、项目 VIEWER、组织 VIEWER 上限和停用账户。上述模拟数据库测试不等于 PostgreSQL 并发或事务回滚证明。

发布核对另见 [后端集成与发布核对](002-backend-integration.md)。全部后端业务链路接入与真实部署上线是两项不同结论；当前保持 IN PROGRESS，未连接业务数据库、未执行生产迁移/回填、未发送外部通知，也未修改前端源码。

### 2026-10-13 验收脚本与最终复测

此前列出的后端业务功能均已接入；本次继续补齐验收入口、检查新增 harness，并修复测试代码 lint 及清理错误覆盖原始失败的问题。没有回退用户修改，也没有提交或推送。

- `test/project-access/harness.ts` 实现三套显式、本地、独立 disposable 库配置检查、运行时身份/空库预检、迁移目录所有权检查、历史迁移 staging 和 Prisma 外部连接池清理。没有 `.env`/`DATABASE_URL` 回退，不创建、重置或删除数据库。
- PostgreSQL suite 在任何 DDL 前检查三套库；只迁移 fresh/upgrade。HTTP suite 再单独检查并迁移 http 库，允许前一 suite 留下 fresh/upgrade 数据。每次重跑需提供新的空库。
- 已编写数据库约束、触发器、历史升级、无自动授权、无效负责人零写入、写入与撤权的实际锁等待，以及附件审计失败回滚用例。
- 已编写真正 PrismaService 支撑的 Nest HTTP suite，使用实际控制器、守卫和业务服务；显式补齐 tsx 不生成的依赖/DTO 类型元数据，不替换守卫。外部存储和通知发送仍隔离为 stub。
- 离线测试验证上述安全拒绝、迁移文件顺序/清理、零连接 Prisma pool 和 Nest 装配；不把模拟 query 或离线 bootstrap 宣称为 PostgreSQL 验收。

| 检查 | 实际结果 |
| --- | --- |
| 全量 Jest `pnpm exec jest --runInBand --silent` | 123 suites、1662 tests 通过；零 skipped/todo |
| `pnpm test:project-access:safety` | 130 tests 通过；零 skipped/todo |
| `pnpm type-check` | exit 0 |
| 全仓 ESLint 无 `--fix` 检查 | exit 0 |
| `pnpm build` | exit 0 |
| Prisma validate/generate | 已通过，Prisma 7.8.0；独立配置，仅 schema 校验/本地生成，无数据库连接 |
| `pnpm test:project-access:postgres` | exit 1：缺显式测试库配置，在连接及迁移前拒绝；非验收通过 |
| `pnpm test:project-access:http` | exit 1：缺显式测试库配置，在连接及迁移前拒绝；非验收通过 |

三个 `PROJECT_ACCESS_*_TEST_DATABASE_URL` 均未配置，当前命令环境无 `docker`、`psql`、`pg_ctl` 或 `postgres`。因此不能实际证明新装/升级迁移、外键/触发器、锁竞争和数据库事务回滚。

**尚待编写的真实数据库用例另行列明，不能全部归因于环境：** 邀请发起者生命周期/最终成员配额竞争、成员离开重加 ABA/所有权转移竞争、并发 ACL 替换、项目删除与邀请接受竞争、通知 worker/SSE 租约及撤权竞争、DB 支撑的 dashboard/ETag。现有单元与模拟 HTTP 回归不替代这些用例。完整变量、运行顺序及覆盖边界见 [验收说明](../test/project-access/README.md)。

`package.json` 仅新增三个验收命令，既有 `pnpm-lock.yaml` 内容差异仍为 43 行新增、8 行删除。前端只同步规划文档，源码未修改。真实数据库验收、完整矩阵、生产回填、历史公开路径治理和部署切换仍是发布门禁，整体保持 IN PROGRESS，不标为 DONE 或生产可用。

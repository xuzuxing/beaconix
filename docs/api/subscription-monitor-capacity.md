# 套餐降级与监控数量限制：前端对接文档

更新日期：2026-10-29。适用范围：本次 008 后端实现。

本文按当前代码描述接口；页面布局、轮询频率和提示文案属于前端接入建议。后端已实现，目标环境需要先应用 `20261028150000_monitor_capacity_downgrade` 迁移并部署相应版本。本仓库不包含前端。

## 1. 页面要实现什么

组织实际降级且配置数量超过新套餐额度时，超额监控获得从实际降级时刻开始的 **72 小时**数量宽限。用户可以选择保留哪些监控。截止后超额监控停止执行，配置和历史仍保留；升级、删减资源或调整保留名单后重新计算可运行范围。

建议接入三处：

| 位置 | 前端职责 |
| --- | --- |
| 套餐 / 用量页 | 展示配置数量、套餐名额、宽限与限制情况，提供“选择保留监控”“续费 / 升级”入口 |
| 保留监控选择面板 | 按项目展示可选监控、当前保留名单、独立截止时间，提交完整选择 |
| 监控列表 / 详情 | 区分手动暂停、数量受限、类型 / 频率不满足套餐和等待新检查结果 |

**边界：**72 小时只用于已有监控的数量超额。高级监控类型、检查频率等继续使用原有套餐规则，不能统一承诺“所有高级能力延长三天”。宽限期间新增和恢复监控仍受当前数量、类型和频率配额限制。

## 2. 鉴权与关联接口

请求使用登录用户的访问令牌：

```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

容量查询和保留名单修改要求**组织级 OWNER / ADMIN**。项目管理员身份本身不足以管理组织保留名单。普通 MEMBER / VIEWER 不展示管理入口；在其有权查看的项目内，仍可展示监控执行受限的原因。平台 SUPER_ADMIN 按既有权限规则放行。

本接口不使用 API Key 或 PAT。切换组织时清空上个组织的草稿、容量快照和监控缓存；请求及缓存键都带 `orgId`，防止旧响应覆盖当前组织。

| 用途 | 接口 | 说明 |
| --- | --- | --- |
| 容量状态与名单 | `GET /api/organizations/:orgId/subscription/monitor-capacity` | 本文新增接口；组织管理员可读 |
| 修改保留名单 | `PATCH /api/organizations/:orgId/subscription/monitor-capacity` | 本文新增接口；组织管理员可写 |
| 当前套餐与订阅栈 | `GET /api/organizations/:orgId/subscription` | 沿用现有接口；展示实际生效套餐，不根据某一笔订单自行推断 |
| 配额、类型与最小间隔 | `GET /api/organizations/:orgId/quota` | 使用现有 `resources.monitors`、`allowedMonitorTypes`、`minInterval` 等字段 |
| 组织内可访问项目 | `GET /api/organizations/:orgId/projects` | 返回项目数组 |
| 项目监控及名称 | `GET /api/projects/:projectId/monitors` | 返回监控数组，按需加载并按 ID 合并；保留名单跨整个组织 |
| 单个监控详情 | `GET /api/projects/:projectId/monitors/:id` | 读取执行准入与状态 |

容量接口不返回监控名称、项目名、目标 URL，也没有新增普通登录用户专用的“组织全部监控”聚合接口。复用项目列表与项目监控接口补充名称，不能为了管理名单改用 developer API 凭据。

## 3. 响应与 TypeScript 类型

GET 和 PATCH 成功均返回 HTTP **200**，使用统一包裹层，无分页。注意 Axios 的 `response.data` 是整个包裹层，业务对象在 `response.data.data`；已经统一解包的请求客户端不应再重复解包。

```ts
export type CapacityStatus = 'WITHIN_LIMIT' | 'GRACE' | 'LIMITED';

export interface MonitorCapacity {
    cycleId: string | null;
    status: CapacityStatus;
    startsAt: string | null;
    graceEndsAt: string | null;
    limit: number;
    total: number;
    overLimit: boolean;
    excess: number;
    selectedMonitorIds: string[];
    retainedMonitorIds: string[];
    restrictedMonitorIds: string[];
    monitorDeadlines: Array<{
        id: string;
        quotaGraceEndsAt: string;
        enabled: boolean;
    }>;
}

export interface SelectMonitorCapacity {
    cycleId: string;
    monitorIds: string[];
}

export interface ApiEnvelope<T> {
    data: T;
    meta: { timestamp: string; requestId: string };
}
```

时间均为 ISO 8601 UTC 字符串，日期可能为 `null`；前端格式化为用户本地时间并显示时区，例如“中国标准时间 UTC+8”。不要把 UTC 字符串当作无时区本地时间解析。

| 字段 | 含义与使用方式 |
| --- | --- |
| `cycleId` | 当前开放的降级周期。无周期为 `null`，此时不能提交 PATCH；生命周期结束后不再返回旧周期 |
| `status` | 组织的数量限制状态，详见下一节；不是监控健康状态，也不是订阅状态 |
| `startsAt` | 当前周期的实际降级起点，不能用页面打开时间代替 |
| `graceEndsAt` | 当前周期截止时间。连续降级时，部分监控可能保留更早截止时间，单行展示必须使用 `monitorDeadlines` |
| `limit` | 当前有效套餐的监控名额 |
| `total` | 组织所有未软删除监控的配置数，手动暂停仍计数；项目软删除也不会自动清除其监控配置计数 |
| `overLimit` | `total > limit`，表示配置超额，不表示已经停止执行 |
| `excess` | `max(0, total - limit)`，是超额配置数，不是“已停止运行数” |
| `selectedMonitorIds` | 用户指定的优先保留 ID 及其顺序；可能未填满额度，历史选择也可能包含后来删除的 ID，不应直接当作生效名单 |
| `retainedMonitorIds` | 后端计算的当前保留名额名单，包含自动补齐部分。仅代表数量名额，不保证已启用或满足类型 / 频率要求 |
| `restrictedMonitorIds` | 已到截止时间的数量受限 ID，可能包含原本就手动暂停的监控 |
| `monitorDeadlines` | 所有被排除在保留名额外、仍未删除的监控及各自截止时间，包含尚在宽限期和已经受限的条目；`enabled` 是用户启用开关 |

无开放周期时，`startsAt` / `graceEndsAt` / `cycleId` 为 `null`，四个名单数组均为空。**空 `retainedMonitorIds` 不代表组织全部监控停止。**无周期时按普通套餐与监控执行字段展示。`WITHIN_LIMIT` 的实现含义是“无开放容量周期”；如果读到它与 `overLimit: true` 同时出现，应展示配置超额并重新查询，不能自行生成 72 小时宽限或提交空周期。

## 4. 状态和倒计时

| `status` | 含义 | 建议展示 |
| --- | --- | --- |
| `WITHIN_LIMIT` | 没有开放的数量限制周期 | 隐藏宽限倒计时和保留名单编辑入口；继续显示用量与其他执行限制 |
| `GRACE` | 存在超额配置，目前排除名单尚未到截止时间 | “监控数量超额，部分监控处于宽限期”；显示截止和处理入口 |
| `LIMITED` | 至少一部分排除监控已到截止时间 | “部分监控受套餐数量限制”；同时保留尚未截止批次的倒计时 |

`LIMITED` 不代表所有超额监控都已停止，`GRACE` 也不保证它们满足当前套餐的类型和频率要求。关闭周期在数据库记为 `RESOLVED`，该值不通过此查询接口暴露；前端不要等待 `status === 'RESOLVED'`。

倒计时建议：

1. 用 `meta.timestamp` 对齐服务端时间，按该快照到当前的本地经过时间递增，减少用户设备时钟偏差。
2. 单行按 `quotaGraceEndsAt` 计算。顶部显示最近一个未来截止时间；没有未来批次时显示“限制已生效”。
3. 到零时重新 GET，并刷新监控状态，不发 PATCH，不把期限重新设为三天。重新查询失败时显示“正在确认限制状态 / 状态更新失败”，保留最近成功快照与更新时间。
4. 页面可见时建议 30～60 秒刷新，回到页面、切换组织、保存名单、删除监控和完成支付后主动刷新；保存草稿期间刷新快照不应静默覆盖用户草稿。

建议使用下列口径，避免把暂停或名额算成实际运行数：

```ts
const restrictedIds = new Set(snapshot.restrictedMonitorIds);
const enabledRestrictedCount = snapshot.monitorDeadlines.filter(
    (m) => m.enabled && restrictedIds.has(m.id),
).length; // “已启用且数量受限”的配置数
const futureEnabledCount = snapshot.monitorDeadlines.filter(
    (m) => m.enabled && Date.parse(m.quotaGraceEndsAt) > serverNowMs,
).length; // “已启用且仍在数量宽限期”的配置数
```

`retainedMonitorIds.length`、`limit` 和上面两个数量都不是正在成功执行的检查数；实际准入继续读取监控的 `executionEligible`。

## 5. 查询示例：同时存在受限与宽限批次

```http
GET /api/organizations/cmg0000000000000000000001/subscription/monitor-capacity
Authorization: Bearer <access_token>
```

```json
{
    "data": {
        "cycleId": "cmg0000000000000000000002",
        "status": "LIMITED",
        "startsAt": "2026-10-28T00:00:00.000Z",
        "graceEndsAt": "2026-10-31T00:00:00.000Z",
        "limit": 1,
        "total": 3,
        "overLimit": true,
        "excess": 2,
        "selectedMonitorIds": ["cmg0000000000000000000003"],
        "retainedMonitorIds": ["cmg0000000000000000000003"],
        "restrictedMonitorIds": ["cmg0000000000000000000004"],
        "monitorDeadlines": [
            {
                "id": "cmg0000000000000000000004",
                "quotaGraceEndsAt": "2026-10-29T00:00:00.000Z",
                "enabled": true
            },
            {
                "id": "cmg0000000000000000000005",
                "quotaGraceEndsAt": "2026-10-31T00:00:00.000Z",
                "enabled": false
            }
        ]
    },
    "meta": {
        "timestamp": "2026-10-29T01:00:00.000Z",
        "requestId": "example-capacity-query"
    }
}
```

该例表示 1 个保留名额、1 个已启用但数量受限的监控，以及 1 个手动暂停、仍保留未来截止时间的监控。前端不能显示成“2 个监控已停止运行”，也不能只看组织的 10 月 31 日截止而遗漏更早受限批次。

## 6. 选择与提交保留名单

```http
PATCH /api/organizations/cmg0000000000000000000001/subscription/monitor-capacity
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
    "cycleId": "cmg0000000000000000000002",
    "monitorIds": ["cmg0000000000000000000005"]
}
```

请求规则：

- 两个字段均必传，ID 使用服务端返回的 CUID；`monitorIds` 必须是无重复数组，最多 10000 项，且不能超过当前 `limit`。
- 只能选择当前组织中未删除、所在项目也未删除的监控。手动暂停的监控可以被选中，但仍占名额，保存不会替用户开启它。
- 本次请求是**完整替换**优先名单，不是增量添加 / 删除。不传名称、截止时间、`enabled` 或其他字段；未知字段会被 DTO 校验拒绝。
- 未填满额度时，后端按 `createdAt ASC, id ASC` 自动补齐；`monitorIds: []` 表示恢复默认保留顺序，不是停止全部监控。
- 名单顺序是优先顺序，不是当前额度内监控的调度先后。后续额度减少时会优先保留排在前面的可用 ID。
- 保存后立即重新计算数量准入，不延长周期或单个监控的原截止时间。超过截止后换名单，可能立即解除所选监控的限制并限制被换出的监控。
- `cycleId` 防止旧周期提交到新周期，但**不是同一周期的名单版本号**。同一周期多个管理员同时保存时，没有 ETag / `If-Match` 冲突校验，后提交会覆盖先提交。

面板建议先显示 `retainedMonitorIds` 的实际保留勾选状态，并区分其中哪些是 `selectedMonitorIds` 指定的、哪些为自动补齐。保存时提交用户最终确认的完整优先名单。已删除或不再可选的历史 ID 不应直接回传；如果当前名单存在无法从项目接口解析的 ID，应显示“资源不可用”并说明原因，避免静默丢弃后自动保存。

提交后使用 **PATCH 返回的整个容量快照**更新界面，再刷新监控列表与用量。保存按钮在请求中禁用。无周期时关闭编辑面板。

数量限制已生效时建议确认文案：“保存将立即调整保留名额。被移出的监控可能停止运行；手动暂停的监控将保持暂停。”保存成功提示“保留名单已更新”，不要提示“所有所选监控已恢复运行”。

### 最小请求封装

以下示例使用原生 fetch；`accessToken` 由现有登录态管理提供。

```ts
async function capacityRequest(
    orgId: string,
    accessToken: string,
    selection?: SelectMonitorCapacity,
): Promise<ApiEnvelope<MonitorCapacity>> {
    const response = await fetch(
        `/api/organizations/${encodeURIComponent(orgId)}/subscription/monitor-capacity`,
        {
            method: selection ? 'PATCH' : 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                ...(selection ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(selection ? { body: JSON.stringify(selection) } : {}),
        },
    );
    const body: unknown = await response.json();
    if (!response.ok) {
        throw Object.assign(new Error('Capacity request failed'), {
            status: response.status,
            body,
        });
    }
    return body as ApiEnvelope<MonitorCapacity>;
}
```

生产页面还应复用现有令牌刷新、请求取消和错误展示策略。保存遇到网络超时、无法确定是否提交成功时，先重新 GET 核实结果，再让用户决定是否重新保存；不要在后台无限重发旧草稿。

## 7. 单个监控的展示与操作

监控列表 / 详情沿用这些字段：

```ts
interface MonitorExecutionView {
    id: string;
    enabled: boolean;
    status: 'UNKNOWN' | 'UP' | 'DEGRADED' | 'DOWN' | 'PAUSED';
    executionEligible: boolean;
    executionBlockedReason: string | null;
    lastCheckAt: string | null;
}
```

| 条件 / 原因 | 建议展示与动作 |
| --- | --- |
| `enabled === false` 或原因 `PAUSED` | “手动暂停”；启用操作与保留名额选择分开；续费不自动启用 |
| `MONITOR_QUOTA_EXCEEDED` | “套餐数量受限”，使用中性色，不视为服务 DOWN；禁用“立即检查”，管理员显示管理名单 / 升级入口 |
| `MONITOR_TYPE_NOT_ALLOWED` | “当前套餐不支持此监控类型”；数量宽限不豁免此限制 |
| `INTERVAL_TOO_SHORT` | “检查间隔低于当前套餐要求”；提供调整间隔或升级入口 |
| `executionEligible === true` 且 `status === 'UNKNOWN'` | “等待新的检查结果”；解除数量限制后不要从缓存直接恢复历史 UP |
| 其他非空原因 | 保留可理解的兜底提示，不能因前端枚举不认识而当作可执行 |

数量受限的启用监控显示 UNKNOWN；`lastCheckAt`、延迟和历史曲线仍可保留，应标为历史检查信息。公开状态页也会显示 UNKNOWN。前端不要通过批量设置 `enabled=false` 模拟套餐限制，否则会混淆用户暂停和系统配额限制。

即使前端禁用了按钮，后端仍会拒绝受限手动检查。现有 `POST /api/projects/:projectId/monitors/:monitorId/check` 在数量受限时返回 403，`message` 为 `MONITOR_QUOTA_EXCEEDED`，不是成功执行后返回 DOWN。

## 8. 错误处理

错误不使用成功包裹层，也不保证存在业务 `code`：

```json
{
    "statusCode": 400,
    "timestamp": "2026-10-29T01:00:00.000Z",
    "method": "PATCH",
    "message": "The downgrade cycle has changed; refresh capacity"
}
```

`message` 可能是字符串或 DTO 校验产生的字符串数组。

| HTTP 状态 | 当前场景 | 前端处理 |
| --- | --- | --- |
| 400 | ID 格式错误、重复 / 超额选择、其他组织 / 删除资源、旧周期 | 保留草稿，重新 GET；周期已消失时关闭编辑；周期变化时提示重新确认；同周期资源失效时标出不可选项，不自动覆盖服务器 |
| 401 | 登录令牌缺失、失效或账号不再有效 | 沿用登录刷新 / 重新登录逻辑 |
| 403 | 当前用户不再有组织管理员权限 | 隐藏管理入口，清除管理草稿；不能按“没有监控”展示 |
| 404 | 组织不存在或已删除 | 离开当前组织上下文并刷新组织列表 |
| 429 | 全局限流 | 暂停重复请求并退避，不重置倒计时 |
| 503 | 维护期间修改被禁止，或服务暂不可用 | 保留草稿，按 `Retry-After`（如有）提示稍后重试 |
| 5xx / 网络错误 | 查询失败或保存结果未知 | 展示失败及最近更新时间；保存后先读回确认，不显示虚假的成功 |

当前旧周期错误是 **400，不是 409**，且尚无专门的稳定错误码。上表英文错误文本只用于联调识别，前端逻辑优先依据 HTTP 状态和重新查询结果，不依赖精确英文匹配。

维护模式下 GET 容量接口可读，PATCH 对普通组织管理员仍受维护限制。不能因为查询成功就认为保存一定可用。

## 9. 续费、通知与邮件入口

支付完成页面应重新读取订阅栈、容量状态、用量和监控列表；如果支付回调尚未完成，显示“权益更新中”并有限重试，不能仅凭客户端支付成功立即清空数量限制。升级后可能只是部分监控解除限制，仍按后端返回展示。

前端通知类型枚举增加：

| 类型 | 含义 | 点击行为 |
| --- | --- | --- |
| `MONITOR_CAPACITY_GRACE_STARTED` | 数量宽限开始 | 切换至对应组织，打开容量 / 套餐管理 |
| `MONITOR_CAPACITY_GRACE_ENDING` | 某截止批次剩余不超过 24 小时 | 打开管理页面并重新 GET 当前状态 |
| `MONITOR_CAPACITY_LIMITED` | 数量限制生效 | 查看当前受限名单 |
| `MONITOR_CAPACITY_RESTORED` | 已解除一部分或全部数量限制 | 刷新当前状态；不直接把监控标为 UP |

复用现有通知列表和 SSE：`GET /api/notifications`、`GET /api/notifications/stream`。列表按既有分页契约处理，SSE 的 `event.data` 为通知对象 JSON，不套普通响应的 `data/meta` 层。流仍需访问令牌；浏览器原生 EventSource 无法直接附加 Bearer 头，沿用项目现有鉴权流客户端或使用支持请求头的实现，不把令牌拼进 URL。

容量通知的 `resourceType` 为 `MonitorCapacityCycle`，`resourceId` 是周期 ID，**不是监控 ID**。`meta.organizationId` 标识组织，`meta.cycleId` 标识周期；按组织导航后重新取快照。通知是历史事件，不作为当前限制状态来源，收到后可触发刷新，但不能据其增减本地名单。用户可能错过实时消息，重连后仍需主动 GET。

邮件由后端异步 outbox 投递：前端不调用发信接口，PATCH 也不返回邮件已投递标志。沿用到期前 7 / 3 / 1 天提醒，并增加宽限开始、各批次最后 24 小时、限制生效和解除通知；延迟扫描可能只投递当时仍有意义的阶段。恢复邮件是独立容量事件，可能与原有付款成功邮件分别收到。

邮件按钮目前指向 `app.webUrl` 并追加 `organizationId` 查询参数，没有约定 `/billing` 等固定前端路由。前端应在入口解析该组织参数，先验证当前用户对组织的访问权，再切换组织并展示管理入口。站内通知实体没有独立 `actionUrl` 字段，不要假定邮件的动作 URL 会原样出现在通知响应中。

## 10. 联调验收清单

- [ ] OWNER / ADMIN 可读写；MEMBER / VIEWER 不出现组织名单管理入口，403 有明确提示。
- [ ] 未超额、GRACE、LIMITED、无周期后的数组和 `null` 均能正确展示。
- [ ] 部分受限、部分宽限共存时，逐行截止与顶部最近截止正确，暂停监控不误计为正在运行。
- [ ] 选择少于名额会自动补齐；空选择回到默认顺序；保存使用服务端返回的生效名单。
- [ ] 已受限后换名单不新增三天宽限；保存提示反映可能立即停执行。
- [ ] 旧周期、已删除资源、重复 ID、超过名额等 400 能刷新状态并保留可确认草稿。
- [ ] 两个管理员同时修改时按后端最新结果展示，不宣称具备同周期版本冲突保护。
- [ ] 数量受限监控的立即检查被禁用；后端 403 也能正常处理；UNKNOWN 不显示成健康或故障。
- [ ] 续费后等待后端权益更新；解除限制后等待新观测；原手动暂停监控仍暂停。
- [ ] 本地时钟偏差、页面后台再返回、截止到零、请求失败时倒计时与状态不被重置。
- [ ] 通知枚举、组织导航、邮件入口、SSE 重连后刷新可用；通知到达不直接覆盖当前名单。
- [ ] 组织切换、权限变更、维护模式与保存超时不造成旧组织数据或旧草稿误提交。

## 11. 契约来源

- `src/modules/billing/subscription/monitor-capacity.controller.ts`：路由与权限。
- `src/modules/billing/subscription/monitor-capacity.service.ts`：管理事务与数量汇总。
- `src/modules/billing/subscription/dto/select-monitor-capacity.dto.ts`：请求校验。
- `src/shared/subscription/monitor-capacity.service.ts`：周期、名单、独立截止和通知。
- `src/modules/monitors/monitors.service.ts`：监控执行字段。
- `src/common/interceptors/transform.interceptor.ts`、`src/common/filters/global-exception.filter.ts`：成功 / 错误包裹。
- [响应格式与分页](response-format.md)、[工作区通知](../design/workspace-notifications.md)。

# 003：适配当前系统的探针成功率实施方案

> 状态：设计完成，尚未实施。更新日期：2026-10-12。
> 基准：`e2895cc` 加设计时的实时工作区；仓库根目录为 `D:/zuxcloud/nest-beacon`。
> 本方案是 `docs/archive/probe-success-ratio.md` 的优化版，实施时以本文件为准。
> 原提案保留供对照；不再采用其中“升级无感知”“只有 Checker 改动”和“同步本轮”的承诺。

## 1. 目标与范围

当本地检测失败、且当前监控允许使用旧 Agent 的结果时，按有效窗口内各探针
**最新有效结果的成功比例**决定是否救回。新增 `Monitor.probeSuccessRatio`，
与现有 `failureThreshold` 独立：

| 参数 | 作用 |
| --- | --- |
| `probeSuccessRatio` | 一次实际聚合时，参与计算的探针结果需要达到多少成功百分比 |
| `failureThreshold` | 状态与告警现有的连续失败/连续异常门槛，算法不变 |
| `availabilityThreshold` | 规则健康可用率阈值，算法不变 |
| `availabilityWindow` | 规则健康可用率统计样本数，算法不变 |

优先级 P1，工作量 M，风险 MED；约 1–2 个工程日，包含迁移、接口和测试，
不包含真轮次协调和生产容量调优。无计划编号依赖，但目标数据库必须已有当前迁移历史。

保持项目作用域、多租户隔离、现有动态系统探针分配，以及当前 HTTP/TCP 的兼容边界。
不新增聚合模式枚举，不把探针比例写进规则树，不升级 Agent/SCF 协议。

## 2. 固定产品语义

以下是首版的实施决策，不留给执行者自行选择：

| 项目 | 首版决策 |
| --- | --- |
| 聚合模型 | 滑动窗口快照，不是多探针共享的同步检测轮次 |
| 本地成功 | 直接成功，探针不能否决；比例仅用于失败救回 |
| 本地阻断/断言失败 | 沿用当前保护，不被旧探针救回 |
| 探针范围 | 当前有效的租户绑定探针 + 当前有效的系统分配探针 |
| 结果范围 | 当前 monitorId、target、configRevision，以及当前有效窗口 |
| 每探针票数 | 最多一票，取该探针最新有效结果 |
| 成功率分母 | 有有效结果的探针数；缺失、离线、停用、解绑、不再分配的不计入 |
| 零有效结果 | 不救回，保留本地结论；不能将空集合解释为 100% 成功 |
| 比例阈值 | 1–100 的整数百分比；不为值 1 添加隐藏 ANY 特例 |
| 比较 | `successCount * 100 >= probeSuccessRatio * totalCount`；不先四舍五入 |
| 回调 | 保留两层去重、原始结果入库及 appliedAt 处理，不增加延迟重算任务 |
| 状态计数 | 保留现有每次被接受的结果折叠，不承诺每个 interval 只累计一次 |
| SSL | SSL 总体结论与服务连通性结论保持独立 |

`100` 表示所有**参与计算的有效结果**成功，不表示所有绑定探针已上报或已通过。
例如绑定 5 个探针、只有 3 个有有效结果，3 个成功时是 3/3=100%。
无需为了计算分母再查询绑定探针总数；首版不引入覆盖率或最少样本数配置。

默认值 1 的准确含义是“成功比例至少 1%”。100 个有效结果中 1 个成功满足阈值；
101 个有效结果中 1 个成功不满足。需要严格 ANY 的用户不应依赖值 1 的数学近似。

## 3. 当前系统与需要保留的约束

### 3.1 实际执行链路

```text
本地执行 / 探针回调携带最近本地原始结论
  -> CheckerService.evaluateResult
     -> 执行保护、SSL 保护、有效探针结果、比例判定
  -> CheckerService.evaluateRuleTree
     -> 保留 statusCode、bodyContains、latency、证书等上下文
  -> StateService.record
     -> 行锁、配置版本校验、观察结果幂等、回调去重
     -> success 驱动 failCount
     -> serviceVerdict 驱动 connectivityFailCount
     -> AlertEventsService.record
        -> CONNECTIVITY / AVAILABILITY / SSL
        -> 事务内告警及投递 outbox
```

不得恢复已经被替代的 `evaluateAvailabilityAlert` 调用，也不得绕过 outbox 直接通知。
聚合成功不保证高级规则不命中；保留规则引擎内部算法，但允许比例变化影响 success 输入。

### 3.2 关键实时代码

`src/modules/checker/checker.service.ts` 的执行保护：

```typescript
if (
    !this.acceptsLegacyProbe(monitor) ||
    localResult.evaluated === false ||
    localResult.failureKind === 'ASSERTION'
) {
    return { result: localResult, rescuedByProbe: false };
}
```

该兼容方法当前要求 HTTP/TCP、空 config，并检查旧版本/SSL 的兼容条件。
保留原函数和调用，不为应用协议、带配置 HTTP、DNS/PING 放宽范围。

同文件当前查询同时过滤 `monitorId`、`target`、`configRevision`。
租户探针还检查 organizationId、TENANT、ONLINE、enabled 和绑定；
系统探针检查分配 ID、SYSTEM、ONLINE、enabled。不能只用目标字符串识别监控。

`execute` 当前有以下回退，所以成功救回必须显式设置 serviceVerdict：

```typescript
serviceVerdict: result.serviceVerdict ?? localResult.serviceVerdict,
localServiceVerdict: localResult.serviceVerdict,
```

`src/modules/monitors/monitors.service.ts` 的定义变化列表目前包含
`failureThreshold`，不包含新字段；列表控制 revision 增加及原有状态重置。
`prisma/migrations/20261011100000_merge_monitor_revision_tracking/migration.sql`
中的 `beacon_monitor_config()` 另负责 configRevision 增加，不能只更新应用列表。

代码遵循 pnpm、4 空格、单引号、尾逗号；控制器薄、PrismaService 注入服务。
DTO 的 `failureThreshold` 是 Swagger/数值范围风格参考；新字段须明确拒绝 null。
不增加 Repository 层，不调整 guards、审计、配额或模块依赖。

## 4. 数据模型与迁移

### 4.1 Schema

在 `prisma/schema.prisma` 的 Monitor、`failureThreshold` 邻近位置加入：

```prisma
failureThreshold  Int @default(3)
probeSuccessRatio Int @default(1)
```

不修改 ProbeResult、MonitorState、CheckLog 的模型，不引入 roundId。

### 4.2 新迁移

使用当前时间戳创建 `<timestamp>_add_probe_success_ratio`，仅在新增迁移中执行：

1. `monitors` 增加 NOT NULL INTEGER `"probeSuccessRatio"`，DEFAULT 1。
2. 增加名为 `monitors_probeSuccessRatio_check` 的 CHECK：
   `"probeSuccessRatio" BETWEEN 1 AND 100`。Schema 不表达该 CHECK 时保留在 SQL 中。
3. 读取部署链路中最新的 `beacon_monitor_config()`，完整保留现有 OLD/NEW 字段列表，
   在两个 tuple 的相同位置加入 `"probeSuccessRatio"`；继续只增加 configRevision，
   不在触发器中重复增加应用 revision。
4. 不执行主动 UPDATE，不重算历史日志，不为了升级重置全体监控状态。

新增列给既有行提供默认值，不应因“添加配置列”主动推进每行的配置版本。
真正修改阈值时才由触发器推进 configRevision。
不得修改或重命名已存在的历史迁移。

实施后 `pnpm prisma:generate`，由工具生成 `src/generated/prisma/`，不得手写客户端。
模拟数据库返回值不会自动获得默认值，相关 monitor 测试夹具必须补上新字段。

## 5. API 与配置生命周期

### 5.1 Create/Update DTO

在两个 DTO 中加入可省略但不可为 null 的新字段。目标形态：

```typescript
@ApiPropertyOptional({
    example: 60,
    minimum: 1,
    maximum: 100,
    default: 1,
    description:
        'Minimum success percentage of latest valid probe results used to rescue a compatible local failure',
})
@ValidateIf((_, value: unknown) => value !== undefined)
@IsInt()
@Min(1)
@Max(100)
probeSuccessRatio?: number;
```

Create 的 default 表示数据库默认值；Update 可以省略 default 元信息，省略字段表示不修改。
不要使用跳过 null 的 `@IsOptional()` 作为唯一可选条件，不给 DTO 设置运行时默认值。
沿用生产 ValidationPipe 的隐式转换；JSON 数值和可转换的整数数值字符串有效，
非数值字符串、空字符串、null、非整数、0、101 均应拒绝。
HTTP 测试涉及此字段的转换选项须与生产一致，不修改生产全局 ValidationPipe。

服务目前通过 monitorData spread 传入 Prisma，可以复用。
不为单个新字段重写 create/update 的通用持久化流程。

### 5.2 返回和文档

`src/modules/monitors/entities/monitor.entity.ts` 加必填 `probeSuccessRatio: number`，
带 ApiProperty、范围、默认值和“窗口内失败救回”描述。
`toEntity` 已有 `...rest`，无需新增一套投影；测试验证列表、详情、创建、更新都返回值。
开发者 API 复用同样 DTO/服务/Entity，不新增另一种字段语义或聚合模式。

不向 Agent 心跳监控清单新增该字段：这是服务端聚合策略，Agent 无需知道阈值。

### 5.3 修改阈值

将 `probeSuccessRatio` 加入 MonitorsService 的 definitionChanged 比较列表：

- 改成不同值：沿用当前 revision +1、运行状态重置及重新调度机会。
- configRevision：由迁移后的数据库触发器 +1，应用不得再额外增加。
- 旧 revision/configRevision 的本地在途执行不生效；旧 Agent 结果被拒绝或不参与聚合。
- 修改后需要新版本的本地基线和探针证据，不用旧比例策略的历史成功立即救回。
- 修改同值、仅改名称、未提供该字段：不因新字段引入额外版本推进或状态清空。
- 暂停监控修改阈值保持 PAUSED；启用监控沿用现有 UNKNOWN 重置。

运行状态重置仅通过现有 service 路径进行。数据库触发器不负责代替 API 做状态重置；
不得把直接 SQL 更新阈值当作一个完整的管理操作。
正在进行的告警及通知继续沿用现有配置变化处理，不新增主动关闭事件或补发逻辑。

## 6. Checker 聚合实现

### 6.1 `fetchLatestProbeResults`

将现有两组结果查询提取为 CheckerService 的私有方法：

```typescript
type ProbeVerdictSample = Pick<
    ProbeResultModel,
    'id' | 'probeId' | 'success' | 'checkedAt' | 'receivedAt'
>;
```

类型从现有 `../../generated/prisma/models` 导入。
方法返回 `Promise<ProbeVerdictSample[]>`，只 select 上述字段，不伪装为完整模型。
不新增独立可注入聚合服务，不使用每探针一次的 findFirst。

每次调用只计算一次 `since = new Date(Date.now() - probeResultWindowMs(monitor.interval))`。
保持当前 checkedAt 下限语义及入站时钟偏差容忍；本次不新加 checkedAt 上限或改变时间可信模型。
这里的“快照”指一次求值使用的窗口样本，不承诺两条查询具有同一数据库 MVCC 快照。

租户查询保留以下 where：

```typescript
{
    monitorId: monitor.id,
    target: monitor.target,
    configRevision: monitor.configRevision,
    checkedAt: { gte: since },
    probe: {
        organizationId: monitor.organizationId,
        scope: 'TENANT',
        enabled: true,
        status: 'ONLINE',
        monitors: { some: { monitorId: monitor.id } },
    },
}
```

取得 `systemProbeScheduler.getAssignedProbes(monitor.id)` 后，去重分配 ID。
空数组时跳过系统结果查询；否则 where 为：

```typescript
{
    monitorId: monitor.id,
    target: monitor.target,
    configRevision: monitor.configRevision,
    checkedAt: { gte: since },
    probeId: { in: systemProbeIds },
    probe: {
        scope: 'SYSTEM',
        enabled: true,
        status: 'ONLINE',
    },
}
```

排序统一为 `checkedAt DESC, receivedAt DESC, id DESC`。
合并两组结果后，用 Map 按 probeId 去重，保留排序 tuple 最大的样本。
不要直接对“租户数组 + 系统数组”执行首次出现去重而假设合并数组全局有序；
可用一次扫描比较 tuple，避免额外全量排序。id 同时间戳下只是确定性 tie-break，
不宣称 id 更大代表观测更晚。

Checker 采样方法自身最多直接发起两次 ProbeResult.findMany，
并调用一次 getAssignedProbes；采样方法不新增 probe.findMany。
分配缓存命中时沿用一次分配表读取；缓存失效时，既有调度器可能触发 rebalance，
查询探针/监控并重建分配表。这部分既有成本不包含在上述直接结果查询预算内，
不得为满足“固定查询数”修改调度器；性能观察应分别记录命中与重建路径。
不做任意 `take: N` 截断，否则高频探针可能挤掉其他探针。
窗口原始样本量仍影响成本；首版不以“只留下 N 个样本”宣称数据库已优化完成。

保留现有错误处理：数据库或分配表读取失败不能假装成“没有探针结果”，
不增加 catch 后返回 [] 的隐性成功路径。

### 6.2 `evaluateResult`

保持当前条件顺序：

1. 本地 success=true：原样返回，rescuedByProbe=false。
2. acceptsLegacyProbe=false、evaluated=false、ASSERTION：原样返回。
3. 保留当前 certificatePolicyFailure 的计算与提前返回条件：
   有 SSL 证据且本地服务已成功或有 ssl 详情时，不让探针覆盖证书结论。
4. 调用 fetchLatestProbeResults；totalCount=0 时原样返回。
5. 统计成功数，按整数交叉乘法比较，不改参数默认或偷偷兼容 undefined。
6. 达标时，根据是否独立证书失败分别走以下两个分支。
7. 不达标时保留完整 localResult，只补聚合错误字符串。

达标且存在独立证书失败时，沿用当前分支：

```typescript
return {
    result: { ...localResult, serviceVerdict: 'SUCCESS' },
    rescuedByProbe: false,
};
```

达标且允许正常救回时：

```typescript
return {
    result: {
        ...localResult,
        success: true,
        error: null,
        failureKind: null,
        serviceVerdict: 'SUCCESS',
    },
    rescuedByProbe: true,
};
```

`localSuccess`、`localServiceVerdict` 仍由 execute 保存原始本地证据。
不使用 probe latency 替换本地 latency；不抹掉 statusCode、bodyContains、
ssl/sslVerdict、checkedAt、meta 或其他 CheckResult 字段。
不达标时不根据缺失探针或部分成功把 serviceVerdict=NO_EVIDENCE 擅自改成 FAILURE。

`buildAggregatedError` 接受 localResult、successCount、totalCount、threshold，
输出示例：

```text
Request timed out; probe success ratio 2/5 below 60%
```

successCount=0 也用同一格式，更新原有 `all N ... failed` 的断言。
比例诊断不写入带协议联合类型的 CheckResult.meta。
首版不新增公开 CheckExecution/CheckLog 聚合字段；结构化诊断可另行扩展。

## 7. 回调、计数与告警边界

保持 CheckerService.ingestProbeReportForMonitor 的近期回调过滤、
StateService.record 的事务内去重及 ProbesService.applyStoredResult 的 appliedAt 行为。
reportId/observationId 是幂等身份，configRevision 是配置版本，都不能当作共享 roundId。

明确接受以下场景作为首版的既有异步边界：

```text
interval=60s，去重窗口15s，threshold=100，窗口起初无探针结果，本地失败
T+0s   A成功到达：1/1达标，可能救回
T+2s   B失败到达：原始结果保存，回调被去重，暂时不重新应用结论
随后实际发生的合格本地检查/未被去重回调：看到A成功+B失败，1/2不达标
```

反向到达可能先形成失败，后来的成功暂时不应用。
不能承诺到达去重截止时间便自动重算；也不能从 appliedAt 推断该结果单独推进过状态。
若后续求值时 A/B 中某个结果已过期，分母按当时有效结果重新计算。

failureThreshold 继续作用于实际被接受的状态/告警样本：
本地与回调在一个 interval 内都被接受时，可能分别影响计数。
只保留既有去重，不能描述成严格“每轮一次”。

告警保留：

- CONNECTIVITY：serviceVerdict 与 connectivityFailCount/failureThreshold。
- AVAILABILITY：availabilityEnabled、规则健康比例、availabilityThreshold、
  availabilityWindow 和连续 ruleMatched 次数。
- SSL：独立证书 verdict，不被比例成功抹掉。
- 初始 UNKNOWN 的基线抑制、事件恢复、投递 outbox 及通知接收人策略。

后续要消除到达顺序影响时，单独设计轮次/截止时间/覆盖率/最终状态推进。
不能仅删除去重或在每条 probe 回调上累计 failCount。

## 8. 兼容性与上线

### 8.1 有意变化

旧行为是窗口内存在任意成功记录即救回。
新行为是每探针最新有效结果参与比例判定，旧成功会被该探针较新的失败覆盖。
即使默认值为 1，也不严格兼容；必须在发布说明中明确。
旧 CheckLog 和告警不按新策略回算，可用率历史不能因策略切换被重写。

### 8.2 发布顺序

1. 在专用测试库验证升级、新列默认值、CHECK 和触发器。
2. 生产按既有部署流程先部署新迁移，再部署包含生成客户端的新应用。
3. 协调检查 worker 的滚动升级，避免旧/新聚合策略长期同时处理同一监控；
   所有运行实例升级完成之前不要对外开放阈值配置。
4. 观察采样变化引起的状态变化、告警、检查处理耗时和数据库查询量。

阈值变化会使旧 Agent 缓冲结果的 configRevision 过期，Agent 通过既有心跳获取新版本，
无需新增心跳字段或升级包。无需把已存在的系统探针调度算法纳入本次重构。

回滚应用时保留新增列、CHECK 和触发器，不通过删除列、reset 或修改已应用迁移回滚。
旧应用不会遵守非默认比例策略；因此应用回滚是监控判定策略降级，需要运维明确批准，
不能将“数据库向后兼容”当作“业务判定无损回滚”。
真实需要撤销触发器逻辑时另写前向修复迁移，不编辑历史文件。

## 9. 文件边界

唯一允许的业务改动：

| 文件 | 改动 |
| --- | --- |
| `prisma/schema.prisma` | Monitor 增加字段 |
| `prisma/migrations/<timestamp>_add_probe_success_ratio/migration.sql` | 新列、范围约束、最新触发器函数更新 |
| `src/generated/prisma/` | prisma:generate 的相关自动输出 |
| `src/modules/monitors/dto/create-monitor.dto.ts` | 新字段及校验 |
| `src/modules/monitors/dto/update-monitor.dto.ts` | 新字段及校验 |
| `src/modules/monitors/entities/monitor.entity.ts` | 返回类型和 Swagger |
| `src/modules/monitors/monitors.service.ts` | definitionChanged 列表 |
| `src/modules/checker/checker.service.ts` | 私有采样方法、比例判断、聚合错误 |
| `src/modules/checker/checker.service.spec.ts` | 比例、采样、保护和回调回归测试 |
| `src/modules/monitors/monitors.service.spec.ts` | 配置更新/状态重置 |
| `src/modules/monitors/monitors.http.spec.ts` | API 默认、校验、返回、Swagger 验收 |
| `src/modules/state/state.service.spec.ts` | 成功判定/双计数回归 |
| `src/modules/alert-events/alert-events.service.spec.ts` | 独立告警回归 |
| `test/monitor-postgres/harness.ts` | 将新迁移延后到新增升级验收阶段 |
| `test/monitor-postgres/monitor.integration-spec.ts` | 升级、触发器、隔离和真实状态验证 |
| `test/monitor-postgres/README.md` | 新验收阶段与用例说明 |
| `src/**/*.spec.ts` 的其他 monitor 夹具 | 仅补模型新默认值，不顺便重写测试 |
| `plans/003-probe-success-ratio.md`、`plans/README.md` | 实施结果与状态 |

只读回归文件、不修改其业务逻辑：
`src/modules/state/state.service.ts`、`src/modules/alert-events/alert-events.service.ts`、
`src/modules/probes/probes.service.ts`、`src/modules/admin/system-probes/`、
`src/modules/rules/`、`src/modules/notifier/`、`probes/agent/`。
不调整前端、权限设计、生产 ValidationPipe、通知结构、配额、依赖或其他计划。

若无法在以上业务边界内实现，应停止并报告，不通过“顺手修复”扩大范围。

## 10. 执行步骤与验证

执行者先完整阅读本方案，保留工作区既有修改。需要隔离实施时使用 `codex/` 分支，
基于当前确认的代码，不自动覆盖工作区或把其他未提交修改带入提交。
不要自行推送、发 PR、提交代码或执行生产迁移。

### 步骤 0：基线与漂移检查

```powershell
git status --short
git diff --stat e2895cc..HEAD -- prisma src/modules/checker src/modules/monitors src/modules/state src/modules/probes src/modules/alert-events test/monitor-postgres
pnpm type-check
pnpm test -- --runInBand --watch=false src/modules/checker/checker.service.spec.ts src/modules/monitors/monitors.service.spec.ts src/modules/monitors/monitors.http.spec.ts src/modules/state/state.service.spec.ts src/modules/probes/probes.service.spec.ts src/modules/alert-events/alert-events.service.spec.ts
```

预期：类型与相关基线测试通过。Git 检查不包含未提交内容，需要同时读取实时文件；
若第 3 节约束已变化，先更新方案，不机械应用旧代码片段。

### 步骤 1：迁移和模型

创建 schema 改动和新迁移；检查数据库 URL 确实指向允许使用的隔离开发库，
仅在明确授权的开发库运行开发迁移创建流程：

```powershell
pnpm prisma:migrate dev --create-only --name add_probe_success_ratio
pnpm prisma:generate
pnpm type-check
```

`--create-only` 不等于完全不访问数据库；不能在未确认的应用/生产库运行它。
没有授权的开发库时可以人工创建新增迁移 SQL，并以第 4 节和专用测试库验证，
不要因此跳过数据库验收或直接连接默认 DATABASE_URL。
生成的 migration.sql 还需手工补 CHECK 和触发器函数，生成目录名固定后同步测试分期。
补相关 monitor 夹具默认值，使生成类型与现有测试一致；不掩盖真实字段缺失。

预期：生成与 type-check 退出 0；旧迁移无改动，新迁移包含 3 项必要 SQL。

### 步骤 2：API 与版本

完成两个 DTO、Entity、definitionChanged，以及 service/HTTP 测试。

```powershell
pnpm test -- --runInBand --watch=false src/modules/monitors/monitors.service.spec.ts src/modules/monitors/monitors.http.spec.ts
pnpm type-check
```

预期：默认/显式值、校验、返回和应用 revision 测试通过，省略阈值不重置既有值。
数据库 configRevision 的真实验证留到步骤 4，不用 Jest 伪造触发器通过。

### 步骤 3：比例聚合与兼容保护

按第 6 节修改 Checker，仅替换采样和成功门槛，保持原有条件顺序。
同步更新测试 mocks：query 选择少量字段，样本必须有 probeId 和两个时间字段；
旧“只有 success”样本不能继续作为有效最新结果测试数据。

```powershell
pnpm test -- --runInBand --watch=false src/modules/checker/checker.service.spec.ts src/modules/state/state.service.spec.ts src/modules/probes/probes.service.spec.ts src/modules/alert-events/alert-events.service.spec.ts
pnpm type-check
```

预期：第 11 节聚合/保护/异步边界用例通过，成功救回不会保留失败的 serviceVerdict。
模拟 `HTTP 500` 的比例测试要注意真实 HTTP Checker 会把状态断言归类为 ASSERTION：
比例主路径用 TRANSPORT/TIMEOUT 本地失败；断言用例单独验证“不救回”。

### 步骤 4：真实升级与配置版本

当前 harness 的 `stageMigrations` 会把未排除的新迁移提前放进首阶段；
直接增加测试而不修改分期，不能证明旧数据库升级。
按下面的三阶段顺序扩展，保留已有安全门禁：

1. 新迁移放入单独的 feature migration 列表，并从 stageMigrations 初始复制中排除；
   既有 localMigrations 和 compatibilityMigrations 顺序保持。
2. 先完成当前历史基线、legacy-fixtures、既有本地协议迁移和既有保留字段检查。
3. **在创建 PrismaService 之前**，拍摄当前 SQL 快照，再追加新比例迁移并 deploy。
   可新增 `addProbeSuccessRatioMigration` 小函数，复用当前目录复制及安全边界。
4. 比较升级前后：仅新增 probeSuccessRatio=1，既有字段、configRevision、
   state/checkLog/plan/subscription 数据不变化；重复 deploy 不重放迁移。
5. 此后才初始化当前生成客户端，验证真实默认值、1/100 接受、0/101 拒绝、
   阈值变化推进 configRevision、同值修改不推进。
6. 用真实 StateService 验证旧 revision/configRevision 的结果拒绝应用；
   再用真实 Checker 查询和 StateService，mock 网络/规则/配额/分配依赖，
   验证相同 target 的不同 monitor/configRevision 不串样本，成功救回重置双计数。

不要修改旧的本地协议默认值断言来掩盖错误迁移阶段；
新字段默认值必须在独立的“当前系统升级到比例版本”阶段被验证。

```powershell
pnpm test:monitor:safety
pnpm test:monitor:postgres
```

预期：安全测试与新旧集成用例全部通过。后者只在已设置
`MONITOR_TEST_DATABASE_URL` 的空白、一次性、本地 `beacon_monitor_test*` 库执行；
沿用 harness 的名称/host 校验、不读 .env、不回退 DATABASE_URL、
不 reset/db push/DROP、不复用已有应用数据。
没有可用专用库时标记“数据库验收未完成”，不能将方案或功能状态改成 DONE。

### 步骤 5：全量质量和发布说明

```powershell
pnpm prisma:generate
pnpm type-check
pnpm test -- --runInBand --watch=false
pnpm lint
pnpm build
git diff --check
git status --short
```

预期：全部退出 0；所有测试通过，仅允许文件有本次改动。
lint 使用 --fix，执行后检查 diff，不将其他工作区改动回退或纳入本次交付。
不因为生成字段引发全项目格式化；提交范围按本方案精确核对。
在本方案记录实际新测试数、专用库验收结果和已接受的快照边界，
再更新计划索引状态。未部署时明确注明“本地验收，待部署”。

## 11. 测试清单

| 层级/文件 | 必须覆盖 |
| --- | --- |
| Checker 单测 | 3 个样本：3/3@100 达标，2/3@100 不达标；5 个样本：3/5@60 达标，2/5@60 不达标 |
| Checker 单测 | 阈值 1 的 1/100 与 1/101 边界；零样本、全失败、本地成功不查探针 |
| Checker 单测 | 同 probeId 多条只一票；新失败覆盖旧成功；checkedAt 同值按 receivedAt、id 决定 |
| Checker 单测 | 租户/系统结果合并，空系统分配不查询，停用/离线/解绑/不同租户条件保留 |
| Checker SQL 集成 | 相同 target 不同 monitor；不同 configRevision；过期样本；关联探针不再有效时排除 |
| Checker 单测 | HTTP/TCP 兼容范围；ASSERTION、evaluated=false、配置化 HTTP、应用协议不被救回 |
| Checker/State | 救回后的 success=true、serviceVerdict=SUCCESS、failureKind=null；localServiceVerdict 保留 |
| Checker/规则 | statusCode、bodyContains、latency、meta、checkedAt 保留，规则依据聚合后的完整上下文 |
| Checker/SSL | ssl 对象证书失败原样返回；无 ssl 对象的 INVALID 不改整体 success，只允许独立服务判定 |
| State/告警 | 成功后 failCount/connectivityFailCount 重置；失败按现有计数；CONNECTIVITY、AVAILABILITY、SSL 独立 |
| 回调回归 | A 成功先到/B 失败先到两种顺序，第二回调被去重；随后实际求值看到全部仍有效结果 |
| 回调回归 | report 重试幂等、appliedAt、local 基线、local 与 callback 交错；不推进 lastLocalCheckAt |
| DTO/HTTP | 省略、1、60、100、可转换整数字符串；拒绝 null/空字符串/非数值/小数/0/101 |
| DTO/HTTP | create/list/detail/update 返回字段；OpenAPI optional 输入、必填输出、范围与默认描述 |
| Service | 改值 revision+状态重置；同值/省略/仅名称不重置；暂停修改仍 PAUSED |
| PostgreSQL | 现有行默认1且旧字段不变；CHECK；数据库触发器改值+1、同值不增；在途旧结果拒绝 |
| 全量回归 | 配额、通知、状态页、监控概览和开发者 API 的现有测试继续通过 |

测试按现有 checker.service.spec.ts、monitors.service.spec.ts、monitors.http.spec.ts 的
factory/mock 风格编写；真实约束与归属筛选用独立 PostgreSQL 验收，不靠返回任意数组的
Jest mock 证明数据库隔离。保持基线测试，新增测试不能仅检查私有方法调用。

## 12. 完成条件与停止条件

完成必须同时满足：

- Schema、迁移 SQL、自动生成类型、API 字段、更新版本链路都已实现。
- 两组有效结果查询及稳定最新结果去重通过单测和真实数据库隔离测试。
- 新增比例功能、既有执行保护、SSL 双判定和规则上下文测试通过。
- 类型检查、全量单测、lint、build、diff 检查全部通过。
- 专用 PostgreSQL 的真实升级、范围 CHECK 和触发器测试通过，不接受“只有空库已建好”。
- 新策略行为变化与回调异步限制已被如实记录；不存在升级无感知/同步本轮承诺。
- 本次改动没有跨越第 9 节边界，既有用户修改保留，计划索引状态准确。

出现以下情况停止并报告：

- 聚合接口、配置版本触发器、状态回调去重已与基准不一致。
- 需要修改 StateService/告警/Agent 业务逻辑才能满足用户实际产品要求。
- 产品要求“所有绑定探针通过”“每轮一次计数”或“默认完全恢复旧行为”，
  这些不是本方案快照比例版本的承诺，需要先重新设计。
- 迁移需要重置/删除应用数据，或目标数据库不能确认是可用的隔离开发/测试环境。
- 校验失败两次后仍不能在既定边界内解释并修正；不要静默跳过失败用例。
- 批量窗口查询在目标规模下不可接受，需要原生 latest-per-probe SQL 或新索引；
  先补容量/查询计划证据，不以任意 take 或 catch-empty 临时掩盖问题。

后续维护重点：增加协议或 Agent 能力时重新评估 acceptsLegacyProbe；
改变探针回调调度时重新评估采样时间和去重；增加聚合元数据时不要破坏协议 meta 类型；
任何新配置字段都需要同步考虑应用 revision 和数据库 configRevision。

## 13. 本次方案验证记录

本节仅记录设计文档验证，不代表功能实施完成：

- 重新核对 `e2895cc` 与实时 Checker、DTO/Service、配置版本触发器及测试迁移分期。
- 独立上下文复核未发现实施阻塞；已澄清直接查询预算不包含调度器缓存重建成本。
- 已检查 Markdown 代码围栏、空白、计划索引链接和所有引用的 pnpm 脚本名称。
- `git diff --check` 通过；工作区存在既有 CRLF 警告与未提交修改，未回退。
- 本次未执行新迁移、生成客户端、运行业务测试或修改业务代码。
- 初次评估的 112 项测试和类型检查通过仅是当时系统基线，不能作为新功能验收。

# 探针成功率方案可行性评估

评估日期：2026-10-12。基准：`04e9253` 加当前未提交修改。
原方案：`docs/archive/probe-success-ratio.md`。本次没有修改业务代码、原方案或数据库。

## 结论

**设计方向可行，但当前文档不适合直接实施。**

把探针聚合策略与连续失败阈值分开是合理的。现有 `evaluateResult` 已是聚合入口，
无需将成功率逻辑塞进规则组。修正结果筛选、执行保护和结果字段后，可以实现一个
“本地失败时，以有效探针最新结果成功率决定是否救回”的小范围版本。

但该版本不等于全局多点共识，也不是严格同步的检测轮次。原方案的“升级无感知”
和“其他文件不动”均不成立。若要求所有探针属于同一逻辑轮次，且每轮只推进一次
失败计数，需要另行设计轮次协调，不能承诺 StateService 完全不动。

## 当前系统对照

| 项目 | 当前实现 | 原方案 | 评估 |
| --- | --- | --- | --- |
| 聚合入口 | CheckerService.evaluateResult | 相同 | 可复用 |
| 本地成功 | 直接返回成功，不查询探针 | 相同 | 阈值只是失败救回策略，不是全局共识 |
| 支持范围 | 兼容旧探针语义的 HTTP/TCP；阻断结果和断言失败不得救回 | 替换代码没有这些保护 | 必须保留 |
| 结果归属 | monitorId、target、configRevision、有效探针条件 | 只按 probeId、target、时间查询 | 有串监控和旧配置误用风险 |
| 聚合样本 | 时间窗口内所有记录，任意成功救回 | 每个探针只取最新一条 | 分母更合理，但默认行为改变 |
| 时间窗口 | 2 个 interval，最短 2 分钟、最长 15 分钟 | 保留窗口，称为本轮 | 应改称有效窗口快照 |
| 状态 | success 驱动 failCount；serviceVerdict 另驱动 connectivityFailCount | 只关注 success | 必须保持双判定字段一致 |
| 告警 | AlertEventsService.record；连通性、可用率、SSL 分开 | evaluateAvailabilityAlert + failCount | 文档已落后于当前实现 |
| 参数修改 | revision + 状态重置；数据库触发器维护 configRevision | 没有配置生命周期说明 | 需同时接入两条链路 |
| 回调 | 5–30 秒去重，首个回调之后可能不再重算 | 未说明 | 百分比可能短暂受结果到达顺序影响 |

## 必须修正的问题

### 1. 保留监控归属和配置版本过滤

原方案第 70–76 行的查询只有 `probeId`、`target`、`checkedAt`。
当前查询明确包含 `monitorId` 和 `configRevision`：

- `src/modules/checker/checker.service.ts:610`
- `src/modules/checker/checker.service.ts:633`
- `src/modules/probes/probes.service.ts:695`：上报结果已持久化这些归属字段。

同一探针可能服务多个相同 target 的监控，系统探针还可能跨组织服务。
目标字符串不能代替监控身份。旧配置下的成功结果也不能用于救回新配置失败。
此外，Redis 分配 ID 不等于探针当前仍启用且 ONLINE；系统探针查询必须保留
`scope: SYSTEM`、`enabled: true`、`status: ONLINE`。

建议复用现有两组过滤，再按 probeId 取最新一条，而不是重新构造更弱的查询。
工作量 S；修复风险 LOW；结论置信度 HIGH。

### 2. 不能删除现有执行和 SSL 保护

当前 `src/modules/checker/checker.service.ts:584` 禁止救回不兼容的监控、
`evaluated: false` 和 `failureKind: ASSERTION`。方案重写后只留下
`localResult.ssl !== undefined`。

结果可能将未执行、配置失败或本地 HTTP 断言失败错误改成成功。
独立 SSL 判定也不总有 ssl 对象：TLS 无效时，HTTP Checker 可以返回
`sslVerdict: INVALID` 而没有 ssl 证书详情
（`src/modules/checker/checkers/http.checker.ts:253`）。

当前还有“保持 SSL 失败，仅更新服务连通性成功”的分支
（`src/modules/checker/checker.service.ts:656`）。
该分支应在成功率达标时继续保留，不能改成总体 success=true。
工作量 S；修复风险 MED；结论置信度 HIGH。

### 3. 成功返回值丢失字段，会使状态和告警矛盾

原方案第 120–125 行只构造 success、latency、error、checkedAt。
当前成功分支保留完整结果并设置 `serviceVerdict: SUCCESS`、
`failureKind: null`（`src/modules/checker/checker.service.ts:663`）。

`execute` 会在缺少最终 serviceVerdict 时回退到本地失败的 serviceVerdict
（`src/modules/checker/checker.service.ts:456`）。
因此原方案可能导致 success=true、failCount=0，却继续累加 connectivityFailCount，
并仍产生或保持 CONNECTIVITY 告警
（`src/modules/state/state.service.ts:239`；
`src/modules/alert-events/alert-events.service.ts:70`）。

statusCode、bodyContains、meta 等字段丢失还会改变规则输入：
`src/modules/checker/checker.service.ts:704`。
规则引擎源码不修改，并不意味着行为未受影响。

建议在现有结果上仅覆盖聚合结论，保留规则上下文和诊断字段。
工作量 S；修复风险 MED；结论置信度 HIGH。

### 4. 配置入口、响应契约和双版本机制缺失

必须补充：

- CreateMonitorDto、UpdateMonitorDto：整数和 1–100 范围校验，明确 null 的处理。
- MonitorEntity：字段类型、Swagger 描述和默认值。
- MonitorsService 的 definitionChanged 字段列表：纳入 probeSuccessRatio，
  触发现有 revision 增加和运行状态重置。
- 新迁移：更新 `beacon_monitor_config()`，将该字段加入 OLD/NEW 比较，
  沿用当前 configRevision 的配置变更语义，不修改历史迁移。
- 生成客户端和相关测试夹具。

依据：
`src/modules/monitors/dto/create-monitor.dto.ts:95`、
`src/modules/monitors/dto/update-monitor.dto.ts:83`、
`src/modules/monitors/entities/monitor.entity.ts:57`、
`src/modules/monitors/monitors.service.ts:192`、
`prisma/migrations/20261011100000_merge_monitor_revision_tracking/migration.sql:4`。

当前生产 ValidationPipe 实际设置为 whitelist=true、
forbidNonWhitelisted=false（`src/main.ts:46`），没有 DTO 定义的字段会被静默剔除，
不是通过接口自动落库。现有服务使用数据 spread，可以沿用，不需另写一套持久化。
响应也使用 spread，字段可能自动出现在 JSON 中，但类型和 Swagger 仍需补齐。

应用 revision 与数据库 configRevision 是两条不同的机制，不能只改其中一个。
工作量 M；修复风险 MED；结论置信度 HIGH。

### 5. 默认值 1 不保证升级无感知

当前代码查询窗口内所有结果，再做 `some(success)`。
假设同一探针 60 秒前成功、10 秒前失败，两条都在窗口内：

| 策略 | 判定 |
| --- | --- |
| 当前任意历史记录成功 | 救回本地失败 |
| 原方案每探针最新一条，阈值 1 | 不救回 |

这是独立于阈值的采样策略变化。方案可以选择更及时的最新结果语义，
但必须说明这是有意的行为调整，不能宣称严格向后兼容。

还有数学边界：超过 100 个有效结果时，1 个成功不足 1%，不再代表任一成功。
除非明确限制参与探针数，或单独规定值 1 为 ANY 兼容语义，否则不能作无条件承诺。
后者也只能处理数量边界，不能恢复历史窗口的旧行为。

工作量 S（明确产品语义及回归测试）；风险 MED；结论置信度 HIGH。

### 6. “本轮”与回调去重不匹配

Agent 各自调度，schema 没有共享 roundId；reportId 是上报幂等身份，
configRevision 是配置版本，都不是多个探针共享的轮次。
参见 `probes/agent/src/schedule.js:95` 和 `prisma/schema.prisma:1087`。

当 interval=60 秒时，回调去重窗口是 15 秒：
`src/modules/checker/checker.service.ts:218`。
StateService 事务内还有第二道相同语义的去重：
`src/modules/state/state.service.ts:211`。

例如两个探针、阈值 100、本地失败、窗口内还没有其他结果：
第一个探针成功，忽略缺失结果后比率是 1/1=100%，会救回；
第二个探针 2 秒后失败，原始结果入库，但聚合回调被去重跳过，
不会立即纠正已经生效的结论。反向到达也可能暂时保持失败。
`src/modules/probes/probes.service.ts:792` 还会把这条结果标记为已处理，
不能依靠待处理扫描自动在去重窗口后重算。

该去重机制原本已经存在，不是新增方案引入的缺陷。
但是严格百分比、尤其 100% 的产品承诺会放大它的影响。
本地检查和探针回调也不是一个共同的状态推进事件；
如果两者都得到失败判定，现有计数不等同于“每个 interval 只加一次”。

需要在两个版本之间明确选择：

- 窗口快照版：保留现有去重，接受结果延迟与到达顺序影响，并准确写入设计。
- 真轮次版：设计 roundId、截止时间、结果完整度、收敛时机和每轮一次状态推进。
  或使用延迟合并任务，但必须明确其与本地检查的计数关系，不能仅删除去重。

工作量 M–L；修复风险 HIGH；结论置信度 HIGH。

### 7. 告警描述需要更新，原有阈值本身无需重构

当前不存在原方案描述的 evaluateAvailabilityAlert 入口。
实际由 `AlertEventsService.record` 处理：

- CONNECTIVITY：serviceVerdict + connectivityFailCount 与 failureThreshold。
- AVAILABILITY：开启 availabilityEnabled 后，最近窗口内 ruleMatched 计算健康比例，
  低于 availabilityThreshold 且连续命中次数达到 failureThreshold 才触发。
- SSL：独立 SSL verdict。

依据：`src/modules/alert-events/alert-events.service.ts:70`、`:116`、`:169`。
因此“failCount >= failureThreshold 就告警”不能完整描述当前告警机制；
聚合 success=true 也不保证绑定的高级规则不命中。
正确保留字段后，可以不修改告警算法，但必须做回归验收。
工作量 S；风险 LOW；结论置信度 HIGH。

## 查询方案

原方案把每次失败聚合的数据库查询增加到 1 次查探针 + N 次 findFirst，
另有 Redis 分配读取；当前主要是租户、系统两次批量结果查询。
Promise.all 并不会降低数据库查询次数，回调高频时还会放大连接池压力。

首版建议保留现有 findMany，按时间降序，使用 Map 按 probeId 保留第一条；
同时间结果应有稳定的次级排序。这样得到每探针一票，不引入 N 次查询。
其代价是仍读取窗口内多条记录，应以实际检查量评估，不能无限扩展。

规模增大后再评估 PostgreSQL DISTINCT ON 或窗口函数，并按真实查询做 EXPLAIN，
决定是否补 monitorId/probeId/configRevision/checkedAt 的复合索引。
本次没有数据库执行计划，不能声称当前查询已经满足生产性能目标。

阈值比较可以用 `successCount * 100 >= probeSuccessRatio * totalCount`，
先单独处理 totalCount=0；不需要把比率四舍五入后再比较。

## 建议实施边界

保留以下已明确的产品行为：

- 本地成功优先，探针不能否决本地成功。
- 仅支持当前能够解释旧 Agent 结果的 HTTP/TCP 配置。
- 只计算当前有效、已绑定或已分配的探针；每个探针最多贡献一条最新有效结果。
- 忽略缺失结果是可选的明确产品策略，不等于所有绑定探针都健康。
- 总样本为零时不救回本地失败；100 表示所有“参与计算的有效结果”成功。
- failureThreshold、StateService 状态机、告警算法和规则树内部逻辑继续沿用。
- SSL 总体结论与服务连通性结论继续分离。

阈值信息和成功/有效/预期/缺失数量可作为聚合诊断信息保留，避免只能从错误字符串
推断当时如何判定。此项可作为后续可观测性改进，不必阻塞窗口快照版。

粗略工作量：修正后的窗口快照版 M，约 1–2 个工程日，含迁移、API 和回归测试；
真轮次协调版 L，应单独设计，粗估 3–5 个工程日起，取决于调度协议改动。
这是基于当前代码的估算，不是交付承诺。

## 验收建议

1. 1、60、100 阈值；恰好达到阈值；零结果；无成功结果。
2. 同一探针多次上报只算一次，最新失败覆盖旧成功。
3. 相同 target 的不同监控、组织，以及不同 configRevision 不相互污染。
4. 系统探针停用、离线、失去分配后不参与；租户解绑后不参与。
5. ASSERTION、evaluated=false、新协议、带配置 HTTP 不被旧探针救回。
6. SSL 无效/过期保持原行为；成功救回时 serviceVerdict 和 connectivityFailCount 正确。
7. statusCode、bodyContains、meta 等规则上下文和诊断信息不丢失。
8. ratio-only PATCH 正确推进 revision/configRevision，并按现有策略重置状态；
   同值 PATCH 不产生无意义版本变化；修改期间在途检查被丢弃。
9. 两种回调到达顺序、同窗口多回调、本地与回调交错，符合选定的快照或轮次语义。
10. DTO 边界、默认值、null、JSON 返回、Swagger 和开发者 API 的复用契约。

实施后按仓库要求运行 Prisma generate、type-check、lint、build，
并补上述单测及独立测试库的版本触发器/升级集成测试。
使用 pnpm 工作流，不新增 npm/npx 的直接操作步骤。

## 本次验证与限制

- `pnpm test -- --runInBand --watch=false src/modules/checker/checker.service.spec.ts src/modules/state/state.service.spec.ts src/modules/probes/probes.service.spec.ts src/modules/alert-events/alert-events.service.spec.ts`：4 套件、112 项通过。
- `pnpm type-check`：通过。
- 测试验证的是当前系统基线，不是尚未实施的新阈值功能。
- 未运行迁移、生成客户端、格式化、构建、全量测试或真实 PostgreSQL/Redis 集成测试。
- 未审查其他业务模块、部署环境或生产数据分布。

## 已核查但不作为缺陷

- 本地成功绕过成功率，是原方案明确选择，属于产品边界。
- 缺失结果不计分母，也是明确选择；应说明其后果，而非强行改成缺失算失败。
- 保留本地 latency 是既有行为，不作为本次阻塞问题。
- rule 树内部无需加入探针聚合模式，但必须保留其输入字段。
- 现有回调去重是既有行为，按新方案语义适配风险评估，不归因于尚未实现的功能。

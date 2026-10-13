# 监控多协议扩展：开发范围

> 2026-10-10 执行范围更新：用户已授权按文档开发，并明确 SCF 不处理、探针相关先不做，只记录。
> 本次执行 M0/M1 的本地部分：HTTP/TCP 策略注册、HTTP 有界读取、DNS/PING、配置版本与 revision、
> 本地历史元数据及套餐类型限制。下文原对齐稿中的探针/Agent/SCF 项全部延期，不属于本次验收。
> 探针协议、身份、能力协商、凭据接口、安全修复、Agent 和 SCF 脚本均不开发。
> M2-M5 保留路线图，不在本次范围。详细交付和延期清单见 `002-local-monitor-delivery.md`。
> 后续范围更新：用户要求“继续完善”后，单独开发 M2-A HTTP 断言，见 `003-http-assertions-delivery.md`；其余 M2-M5 和探针/SCF 边界不变。

## 1. 文档状态

| 项目 | 内容 |
| --- | --- |
| 状态 | 已授权本地 M0/M1；探针与 SCF 延期 |
| 原始方案 | `docs/monitor-plan.md`，本次保留原文 |
| 对照基线 | `b5c8273`，2026-10-10 的当前工作区 |
| 本次目标 | 实施本地 M0/M1，保留原对齐稿作为后续路线图 |
| 总体工作量 / 风险 | L / HIGH，涉及本地检测、分布式探针、数据迁移和套餐权益 |
| 后续动作 | 确认范围和阻断性决策后，再分别生成各阶段的可执行计划 |

当前工作区已有 `pnpm-lock.yaml`、`scripts/probe-agent.js`、`scripts/probe-agent-scf.js` 的未提交修改，以及未跟踪的 `docs/`、`scripts/probe.json`。本稿描述的是当前工作区，不只是 HEAD。后续开发必须保留并核对这些修改，不能覆盖；不要读取、提交或复制实际探针凭据。

后续执行前先检查：

```powershell
git diff --stat b5c8273..HEAD -- prisma src/modules/checker src/modules/monitors src/modules/probes src/modules/admin/system-probes src/shared scripts
git status --short
```

如果相关实现发生变化，应先更新本稿。文档中的阶段均为建议范围，不应在用户确认前直接执行。

## 2. 目标与不变项

目标是在现有监控系统上增加协议能力，而不是替换监控系统或新建调度平台。

- 保留 NestJS 11、Prisma 7、PostgreSQL、Redis/BullMQ 和 pnpm。
- 保留组织隔离、项目归属、`cuid()` 主键、软删除、现有 RBAC 和开发者 API。
- 保留 BullMQ 扫描与检测队列、任务去重、现有状态机及通知渠道。
- 优先复用现有服务和模块，不为扩展协议重写调度器、计费系统或通知平台。
- 沿用薄 Controller、Service 承载业务逻辑、Swagger、DTO 校验和邻接 Jest 测试的约定。
- 修改范围可以涉及调度资格、聚合策略、结果落库和通知输入，不能承诺这些层完全不变。
- 本仓库交付后端 API 和探针 Agent；不包含独立产品前端。已有 HBS 测试页面可随接口做必要联调更新。

## 3. 当前项目事实

| 能力 | 当前状态 | 主要位置 |
| --- | --- | --- |
| HTTP / TCP | 本地 Checker 和独立 JS Agent 均已实现 | `src/modules/checker/checkers/`、`scripts/probe-agent.js` |
| HTTPS 证书 | 已采集证书信息并判断到期阈值，属于 HTTP 附加能力 | `http.checker.ts`、`Monitor.checkSsl` |
| 关键词规则 | 已有 `bodyContains`，输入是响应体前 512 个字符，不等于完整响应断言 | `src/modules/rules/types.ts`、`http.checker.ts` |
| 检测调度 | BullMQ 每 10 秒扫描，检测 Worker 当前并发为 5，按 monitor 去重 | `src/modules/checker/checker.queue.ts` |
| 探针任务 | 心跳下发固定 HTTP/TCP 参数，尚无能力协商或协议配置 | `src/modules/probes/probes.service.ts` |
| 远程结果 | 主要按 target 去重和匹配，尚无 monitor/config revision 身份 | `probes.service.ts`、`ProbeResult` |
| 结果聚合 | 本地失败可由新鲜探针成功救回，SSL 失败有特殊例外 | `CheckerService.evaluateResult` |
| 套餐 | 已有有效套餐解析、数量/间隔/功能限制，尚无类型白名单 | `src/shared/quota/`、`src/shared/subscription/` |

当前结果契约来自 `src/modules/checker/checkers/check-result.ts:9`，后续只能兼容扩展，不能用原方案中的简化接口替换：

```typescript
export interface CheckResult {
    success: boolean;
    latency: number;
    error: string | null;
    checkedAt: Date;
    ssl?: SslCertificateInfo | null;
    statusCode?: number | null;
    bodyContains?: string | null;
}
```

现有 DTO 风格来自 `src/modules/monitors/dto/create-monitor.dto.ts`：

```typescript
@ApiProperty({ enum: MonitorType, example: MonitorType.HTTP })
@IsEnum(MonitorType)
type: MonitorType;
```

JSON 配置也必须具有等价的运行时校验和 Swagger 描述，不能只定义 TypeScript 类型或使用 `any`。

## 4. 相对原方案的调整

| 原方案内容 | 对齐后的建议 |
| --- | --- |
| 仅新增 Checker 和 Registry | 同步梳理 DTO、配置校验、Agent、任务下发、结果身份、聚合、历史和套餐 |
| `Monitor` 示例使用 UUID，省略项目归属 | 保持现有 `cuid()`、`organizationId`、`projectId` 和关系不变 |
| 所有协议枚举一次加入 | 按阶段添加；只有实现、权限和执行条件都满足的类型才允许创建 |
| SSL / 关键词 / JSON 同时列为扩展类型 | 作为 HTTP 检测能力，不默认新增独立 MonitorType |
| HTTP `expectedStatus` 移入 config | 首期保留顶层字段；不接受 config 中的重复字段，避免双重事实源 |
| `config: any` / `meta: any` | 按类型校验配置，限制元数据结构、大小和敏感字段 |
| 结果仅包含 success/error/latency/meta | 保留现有结果字段，再增加必要的元数据、失败分类和版本身份 |
| 创建时校验套餐类型 | 覆盖类型变更、启用、恢复及运行时权益策略，补齐迁移和降级行为 |
| 所有探针都能执行新协议 | 依据 Agent 版本、能力、网络位置和授权选择执行器 |
| V1.0 预计 2-3 天 | 不作为承诺；范围确认后按安全、双链路兼容、迁移和测试重新估算 |
| 前端维护独立配置映射 | 后端提供类型与配置元数据，产品前端独立交付，避免规则重复维护 |

## 5. 开发阶段

各阶段按依赖推进，后续阶段不是首期交付承诺。

| 阶段 | 建议开发内容 | 完成边界 |
| --- | --- | --- |
| M0：前置修复 | SCF 调度实例错误及单次执行行为；探针上报嵌套校验；探针密钥读接口收敛；HTTP 有界响应读取；现有行为回归测试 | 为扩展建立安全、可验证的基线 |
| M1：首期基础协议 | HTTP/TCP 策略适配、Registry、类型配置契约、DNS、PING；探针协议升级、结果身份、能力匹配；必要历史字段及套餐类型限制 | HTTP/TCP 兼容；DNS 可端到端运行；PING 在通过验证的执行环境运行 |
| M2：应用接入准备 | HTTP 关键词完整断言和 JSON 字段断言；私网探针独立执行；监控凭据存储与最小化下发；PostgreSQL、Redis | 不依赖中心服务直接访问租户私网，结果和凭据链路可验收 |
| M3：其他数据库 | MySQL、MongoDB | 固定健康操作、身份验证、TLS、超时、清理和历史可追溯 |
| M4：专项协议 | gRPC、WebSocket、Docker，分别立项验收 | gRPC 健康状态、WebSocket 心跳、Docker 宿主授权边界各自明确 |
| M5：按需扩展 | MQTT、Kafka、SMTP；如有独立 TLS 目标需求，再评估独立 TLS/SSL 监控 | 有明确使用场景后开发，不在首期预装所有依赖 |

M0 的问题位置：

- `scripts/probe-agent-scf.js:45` 传入 `createSchedule` 函数，而 `scripts/probe-agent.js:997` 使用调度实例的 `.sync()`；修正后仍需验证单次执行与启动抖动。
- `src/modules/probes/dto/report-probe-results.dto.ts:59` 缺少数组项嵌套验证，`success` 缺少布尔验证。
- `src/modules/probes/probes.controller.ts:50` 的成员读接口通过 `probes.service.ts:802` 返回共享密钥；应分离普通读响应和受控注册/轮换响应，评估已暴露密钥的轮换。
- `src/modules/checker/checkers/http.checker.ts:133` 先读取完整响应再截断，不能视为限制读取量。

M0 不包含全面重写身份认证、全量安全审计或清理其他模块技术债。

## 6. 首期 M1 功能范围

### 6.1 HTTP / TCP 兼容重构

- 统一策略接口和注册表，依赖通过 Nest provider 注入；避免运行时扫描加载任意代码。
- 保留 HTTP 状态码、TCP 连接、HTTPS 证书和现有规则告警行为。
- `CheckerService` 仍负责编排，不把状态机、通知、Prisma 落库复制到每个 Checker。
- 不改变既有合法 HTTP/TCP 请求的默认值；安全收敛造成的行为变化必须单独说明。
- 首期不迁移顶层 `expectedStatus`、`checkSsl`、`sslExpiryThreshold` 到 config。

### 6.2 DNS

- 新增 DNS 类型，target 表示查询域名；config 表示记录类型及预期结果。
- 建议首期支持 A、AAAA、CNAME；MX/TXT/NS/SRV 留待明确需求后扩展。
- 无预期值时检查是否成功解析；配置预期值时必须明确集合比较规则，不能依赖响应顺序。
- 建议首期采用规范化后的无序精确集合比较，不同时开放多种模糊匹配方式。
- 保存实际解析结果；只有实际取得 TTL 时才返回，不承诺每类记录都有 TTL。
- 必须有整次查询期限、取消/清理和确定的错误分类。

### 6.3 PING

- 新增 PING 类型，target 表示主机名或 IP；不允许用户提交命令、参数片段或脚本。
- 建议采用固定次数的短时检查；首期建议 3 次，有响应即连通，延迟取成功样本平均值，丢包率作为诊断元数据。
- PING 的默认判定属于待确认建议，不自动增加丢包率阈值告警或新的状态机规则。
- 检测必须在整次 timeout 内结束并回收子进程/socket；采用参数化调用，不拼接 shell。
- 生产镜像和实际执行平台必须验证命令/权限；Windows 开发环境与 Linux 部署分别测试。
- M1 仍要求本地执行器支持 PING；若中心环境不支持而仅远程探针支持，应报告阻断，由用户决定提前引入 M2 的 probe-only 能力或调整首期范围。
- 无 PING 能力的执行器不接收该任务；没有可用执行器时报告执行受阻，不能伪造目标 DOWN。
- 若部署环境无法满足条件，先报告阻断并确认改期，不能用 TCP 冒充 PING 或擅自开启特权容器。

### 6.4 配置和结果契约

- 建议新增 `Monitor.config`、配置格式版本和单调递增的检测定义 revision。
- 格式版本描述如何解释 config；revision 标识本次任务依据的监控定义，两者不可混用。
- config 根据 type 校验；创建时应用默认值，更新时先合并完整定义再校验。
- 建议 PATCH 对 config 整体替换，不做隐式深度合并；未传 config 则保留，切换 type 必须提交符合新类型的完整配置。
- target 是连接/查询目标的唯一来源；不再让 config.host/config.port 与 target 并行定义同一地址。
- 影响检测语义的字段变化后增加 revision，使旧任务和缓冲结果不能修改新定义的状态。
- 区分传输失败、断言失败、超时、配置错误和执行能力不足；只把真正的目标检测结论折叠进故障状态。
- 元数据必须经过限长、类型校验和脱敏，贯通本地/远程结果、持久化、历史响应与 Swagger。
- 不保存完整 HTTP 响应体、完整连接串或原始认证材料。

### 6.5 探针和聚合

- 心跳上报 Agent 版本和支持的监控类型；服务端下发带协议版本、monitorId、revision 和配置的任务。
- 结果携带 monitorId、revision 和稳定 observationId；验证组织、绑定或系统分配关系。
- 同一 target 的不同 monitor/config 不得去重成同一条结果；重试不能重复推进状态。
- 新 Agent 的 HTTP/TCP 也使用新身份协议，避免继续污染新增类型的聚合查询。
- 建议旧 Agent 仅保留无歧义 HTTP/TCP 兼容通道；无法证明归属或配置等价的旧结果不参与救回和状态变更，返回升级提示。
- 分配时同时检查类型能力、执行环境和网络授权；不能仅看探针 ONLINE。
- 首期保留中心本地检测加探针辅助的模式；不在 M1 承诺完整的私网 probe-only 执行。
- 聚合只接受同 monitor、同 revision、同检查语义的有效结果，不能把普通连通结果作为 DNS 断言成功。
- 复用既有窗口和去重基础，但不能仅按 target 或 success 决定是否覆盖失败。
- 心跳调度不得被慢检测长期阻塞；SCF 的截止时间、冷/暖启动和单次任务期限需独立测试。

### 6.6 套餐、权限和网络边界

- 建议新增 `Plan.allowedMonitorTypes`，允许创建的类型还须满足实现和可用执行能力条件。
- 建议首期 FREE 为 HTTP/TCP/PING，PRO/TEAM 为 HTTP/TCP/PING/DNS；这是沿用原方案方向的建议，不是已批准定价策略。
- 为已有套餐显式回填，不通过同一列默认值把付费套餐全部降为 FREE 权益。
- 补齐 FREE fallback、套餐响应、配额响应和迁移测试。
- 检查创建、修改 type、从 disabled 改为 enabled、resume、restore；始终允许用户停用和删除。
- 建议订阅降级后停止不再有权限的执行，保留配置和历史；与用户主动暂停意图区分，不删除监控。
- 权益受限原因需要从 API 可见，不能伪装成目标故障；调度、已排队任务、手动检查和探针回调共用同一资格判定。
- 建议公共执行器仅允许获授权的公网目标，并限制地址、端口及重定向；私网需求在 M2 通过指定租户探针支持。
- 不能直接批量停用现有私网 HTTP/TCP 监控；先生成不含凭据的影响清单，再由用户确认迁移策略。

## 7. 本轮明确不做

- 不一次性交付所有数据库、中间件和容器协议。
- 不新增独立 SSL、KEYWORD、JSON 类型；M1 保留已有 SSL/关键词能力，完整断言放在 M2。
- 不开放任意 SQL、任意 gRPC 方法、用户命令、任意脚本或动态插件。
- 不把中心服务所在主机的 Docker socket 默认暴露给租户监控。
- 不让所有 Agent 持有中心服务的主解密密钥；M1 不下发数据库凭据。
- 不新增完整产品前端、独立 Worker 部署平台、通用密钥管理平台或订阅缓存系统。
- 不改造任务管理、附件、微信支付等不相关模块。
- 不把原方案的天数估算当作承诺，也不承诺扩展协议后核心编排永远无需变化。

## 8. 需用户确认的产品决策

下列内容均为建议，未确认的决策是相关阶段的开发阻断项：

| 编号 | 决策 | 建议默认 | 影响 |
| --- | --- | --- | --- |
| D1 | 首期协议和 HTTP 新断言 | M1 为 HTTP/TCP/DNS/PING；完整关键词/JSON 断言在 M2 | 决定首期范围和规则改动量 |
| D2 | PING 判定及发布条件 | 3 次有响应即连通；丢包率仅诊断；M1 要求本地执行器也通过验证 | 决定验收规则；部署不支持时须重新确认 |
| D3 | 首期套餐类型分配 | FREE：HTTP/TCP/PING；PRO/TEAM：再加 DNS | 需确认是否希望 FREE 也支持 DNS |
| D4 | 降级和到期行为 | 停止无权益执行，保留定义与历史，区别于手动暂停 | 影响已有用户，必须批准后实施 |
| D5 | 执行与网络范围 | M1 公共执行器；M2 指定私网租户探针与凭据能力 | 需确认现有私网监控的迁移安排 |
| D6 | 配置更新方式 | PATCH 的 config 整体替换，保留顶层 HTTP 字段 | 决定客户端兼容和 revision 规则 |

确认 D1-D6 不等于授权同时实施 M0-M5。每个阶段仍需明确启动范围；M2 及以后的详细配置、凭据方案和协议参数另行确认。

## 9. 开发影响范围

本稿只写入 `plans/`。下表是后续开发的候选范围，不是当前修改授权：

| 范围 | 预期工作 |
| --- | --- |
| `prisma/schema.prisma`、`prisma/migrations/`、`prisma/seed.ts`、`src/generated/prisma/` | 分阶段增加枚举、配置/结果字段、权益字段，迁移、回填并生成客户端 |
| `src/modules/checker/` | 策略/注册表、结果分类、聚合身份、执行资格及回归测试 |
| `src/modules/monitors/` | 创建/更新配置校验、revision、响应实体和安全输出 |
| `src/modules/probes/`、`src/modules/admin/system-probes/` | 协议版本、能力与网络匹配、任务下发、授权和结果入库 |
| `scripts/probe-agent.js`、`scripts/probe-agent-scf.js` | 与现有本地修改协作，增加协议、生命周期和兼容测试 |
| `src/modules/state/`、`src/modules/rules/` | 必要的元数据存储/读取与规则上下文；不重写规则引擎 |
| `src/shared/quota/`、`src/shared/subscription/`、`src/modules/billing/` | 类型权益、fallback、资格判定和已确认的到期策略 |
| `src/common/interceptors/audit-log.interceptor.ts` | 必要的递归脱敏及测试；不得记录新凭据 |
| `src/modules/developer-api/`、`src/modules/status-pages/`、`src/modules/monitoring/`、`src/modules/notifier/` | 验证已有入口复用校验；安全展示目标、状态、历史和执行受限原因，禁止泄露 config/凭据 |
| `src/config/`、`.env.example`、`Dockerfile`、`README.md`、`package.json`、`pnpm-lock.yaml`、`views/*monitor*.hbs` | 经确认的运行参数、PING 环境、依赖、部署/升级说明及必要测试页面联调 |

不得修改实际 `.env`、`scripts/probe.json` 或其他凭据文件。需要超出表中范围时先说明原因，不能顺带重构。

## 10. 验收与测试

### 10.1 首期验收项

- [ ] 旧 HTTP/TCP 创建、修改、检查、告警、历史和开发者 API 合法调用兼容。
- [ ] DNS 的解析成功、无结果、错误域名、超时及预期集合不匹配可端到端复现。
- [ ] PING 在指定部署环境中通过成功、失败、超时和清理验证；不支持的执行器不会产生假故障。
- [ ] 同 target 不同 monitor/type/config 的结果互不影响。
- [ ] 旧 revision、重复 observation、越权或已撤销分配的结果不能推进状态。
- [ ] DNS 断言失败不能由普通连通成功覆盖；历史可解释最终判定来源。
- [ ] 配置错误、能力不足和套餐受限可识别，不冒充目标 DOWN。
- [ ] 套餐类型覆盖新建、类型切换、启用、恢复、降级及已排队/手动/远程执行。
- [ ] 普通读接口、审计、日志、公开状态页和诊断元数据中不出现凭据。
- [ ] SCF 冷/暖启动、单次执行、启动抖动和失败重试有离线测试。
- [ ] 迁移在有既有 HTTP/TCP、多个套餐和历史数据的测试数据库上通过，不删除用户数据。
- [ ] 响应读取和元数据有大小上限；整次超时后没有残留连接、timer 或子进程。
- [ ] 在确认的监控数量、间隔和慢目标比例下记录队列等待、心跳延迟和检测完成率；容量目标须在阶段实施计划中量化。

### 10.2 测试结构

- 沿用 `src/modules/checker/checkers/http.checker.spec.ts`、`tcp.checker.spec.ts` 的邻接测试，增加 DNS/PING 的成功、语义失败、超时和清理用例。
- 扩展 `checker.service.spec.ts`、`state.service.spec.ts`，覆盖新身份聚合、元数据和不应进入故障状态的执行结果。
- 扩展 `monitors.service.spec.ts`，覆盖完整配置校验、类型切换、config 替换和 revision 变化。
- 扩展 `probes.service.spec.ts`、`system-probe-scheduler.spec.ts`，覆盖授权、同目标不同任务、能力变化、旧 Agent 和幂等重试。
- 探针 DTO 测试必须经过真实 ValidationPipe；仅直接调用 Service 不能证明输入验证有效。
- Agent/SCF 测试使用假的网络、驱动、命令执行器和时钟，不连接真实租户目标。
- HTTP 请求链路用 Supertest 验证 DTO、角色、组织归属、响应和错误契约；具体 E2E 文件和环境在阶段计划中确定。
- 扩展 quota/effective-plan/expiry 测试，固定时间并覆盖 FREE 缺失、精确到期边界和权益限制。

### 10.3 验证命令

后续实施者每阶段必须记录命令、退出码和测试数量。文档确认阶段不执行迁移、生成、自动修复或构建。

| 场景 | 命令 | 成功标准 |
| --- | --- | --- |
| Schema 检查 | `pnpm exec prisma validate` | 退出 0 |
| Schema 变化后生成 | `pnpm prisma:generate` | 退出 0，生成客户端与 schema 一致 |
| 开发迁移 | `pnpm exec prisma migrate dev --name <本阶段名称>` | 仅在授权的测试数据库退出 0，检查迁移 SQL |
| 迁移发布验证 | `pnpm prisma:migrate:deploy` | 仅在授权的测试数据库退出 0，既有数据兼容 |
| 类型检查 | `pnpm type-check` | 退出 0，无类型错误 |
| 当前相关回归 | `pnpm test --runInBand --testPathPatterns='modules/(checker\|monitors\|state\|rules\|probes\|admin/system-probes)\|shared/(quota\|subscription)'` | 全部通过 |
| 全部单测 | `pnpm test --runInBand` | 全部通过 |
| Agent/SCF 新测试 | 沿用或新增被 `pnpm test` 发现的离线测试入口，并纳入上项 | 通过且不依赖真实凭据/网络 |
| E2E | `pnpm test:e2e --runInBand` | 新建的阶段相关 E2E 通过，测试数据库隔离 |
| CI lint | `pnpm lint` | 实施工作区退出 0；此命令含 `--fix`，之后检查 diff |
| 构建 | `pnpm build` | 退出 0 |
| 变更边界 | `git status --short`、`git diff --check` | 原有用户修改保留，无越界变更和新增空白错误 |

2026-10-10 已有只读回归基线：`pnpm type-check` 通过；上述“当前相关回归”17 个套件、153 个用例通过。这不证明云平台权限、真实协议兼容、生产迁移或容量已经验收，也不替代后续阶段验证。

## 11. 阶段实施与停止条件

确认后依次进行：

1. 固化 D1-D6 及首期部署目标；形成分阶段计划，每项列出精确文件、默认参数、测试和退出码标准。
2. 实施 M0 并建立安全/SCF/响应读取回归，验证无未说明的旧接口破坏。
3. 将 HTTP/TCP 适配到 Registry，保持已确认的兼容行为，先通过既有相关回归。
4. 实施配置版本、revision、任务身份与 Agent 能力协议，再开放 DNS/PING，不能先下发给旧 Agent。
5. 补齐已确认的套餐权益和网络规则，完成迁移、混合版本升级和端到端验收。
6. 只有 M1 验收通过且 M2 获得单独授权后，才开始私网独立执行、凭据和应用协议。

遇到以下情况应停止相关阶段并反馈：

- 用户未确认该阶段或相关 D 决策。
- 当前工作区与基线不符，尤其是已有 Agent 修改无法安全合并。
- 实际部署环境不支持 PING，或必须扩大容器/宿主权限。
- 网络安全收敛影响现有私网目标，但用户尚未批准迁移策略。
- 必须破坏既有 API、改变状态机语义或读取真实凭据才能继续。
- 发现需要开放任意 SQL、命令、宿主 Docker 控制或共享中心主密钥。
- 无法建立安全的测试数据库、协议 mock 或可复现验收环境。
- 验证失败两次且原因尚未查明，或必须越出已确认范围。

## 12. 维护与交付

- 监控类型、套餐类型权限、Agent 能力、Swagger 和元数据必须保持一致；添加新类型不等于立即开放创建。
- 每次影响检测语义的配置变化都应检查 revision 和旧结果处理，尤其是缓冲重试和混合版本升级。
- 迁移、schema 和生成客户端一起交付；使用测试数据库验证，禁止用生产全量 seed 代替定向回填。
- 后续分支按 `codex/monitor-<阶段>` 命名，从确认后的 master 基线开始；不要在本次文档对齐阶段创建分支、提交、推送或 PR。
- 原始方案中的协议路线图完整保留；本稿调整的是分类、交付顺序与安全边界，不代表取消后续类型。

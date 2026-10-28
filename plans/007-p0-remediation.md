# 007：P0 缺口修复方案

> 状态：方案定稿，进入实施。日期：2026-10-28。
> 上游：[006 下一阶段开发计划](./006-next-phase-plan.md) 的「P0 — 阻断上线」8 项。
> 基线：`master` `c7980a4` + 工作树未提交改动（`Dockerfile`/`.dockerignore`/`package.json`/`pnpm-lock.yaml`/`alipay-payment.service(.spec).ts`/`.pipewright.yml`/`scripts/notify.json`）与本方案无关，不动。

## 0. 分组与顺序

| 组 | 项 | 风险 | 依赖 |
|---|---|---|---|
| 一、隔离与暴露面 | A1 审计日志越权、A7 SSRF、A8 `/metrics` | 跨租户泄露 | 无 |
| 二、支付可信 | A2 金额核对、A3 订单状态准入、A4 `FAILED` 落库 | 资损/账实不符 | 同文件，一次改完 |
| 三、配额与后台一致性 | A6 配额并发、A5 `mark-paid` 结算 | 付费墙可绕过 | A5 复用 A2 组的结算函数 |

实施顺序：A1 → A2/A3/A4 → A7 → A8 → A6 → A5。每步后 `pnpm type-check`，最后统一跑相关 spec 与 lint。

---

## 1. A1 审计日志跨租户越权

**病根**：`src/modules/audit-logs/audit-logs.service.ts:50-53` 用 `organizationId: organizationId ?? orgId` 拼 where，而 `QueryAuditLogsDto.organizationId`（`dto/query-audit-logs.dto.ts:24`）由客户端控制。org-A 的 ADMIN 传 `?organizationId=<org-B>` 即可读 B 的审计日志。附带问题：`audit-logs.controller.ts:22-24` 重复 `@UseGuards(RolesGuard)`。

**改法**：

- 删除 DTO 的 `organizationId` 字段（全局 `ValidationPipe` 是 `whitelist` + **非** `forbidNonWhitelisted`，见 `main.ts:52-53`：客户端再传会被静默剥离，而不是 400）。
- service 的 where 恒为 `organizationId: orgId`（路径参数），`organizationId` 不再参与。
- 控制器去掉重复的 `@UseGuards(RolesGuard)`。
- `SUPER_ADMIN` 的跨租户过滤能力搬到 `/api/admin/audit-logs` 的独立 `QueryAdminAuditLogsDto`（继承租户版并加回 `organizationId`），两边的契约互不影响。

**契约变化**：`GET /api/organizations/:orgId/audit-logs` 不再接受 `organizationId` query，传了被静默剥离，结果恒为路径 `orgId`。跨租户查询本无合法场景，属收紧而非破坏；跨租户能力保留在 admin 面。

**验收**：

1. `audit-logs.service.spec.ts`：`findAll('orgA', { organizationId: 'orgB' } as any)` 断言 `prisma.auditLog.findMany` 收到的 `where.organizationId === 'orgA'`。
2. DTO 单测：按生产 pipe 配置（`whitelist` + 非 `forbidNonWhitelisted`）断言 `organizationId` 被剥离；`is-cuid.decorator.spec.ts` 的 CUID 覆盖从 `QueryAuditLogsDto` 迁移到 `QueryAdminAuditLogsDto`（否则该 spec 的 16 条用例会因字段消失而失败）。

---

## 2. A2/A3/A4 支付回调可信化

**病根**：`src/modules/billing/payment/payment.service.ts:120-189` 的回调链路只判 `callback.trade_state === 'SUCCESS'`，随后 `updateMany` 无条件置 `SUCCESS` 并 `settlePaidOrder`。三处后果：

- 不比对实付金额（支付宝 `total_amount` 已在 `alipay-payment.service.ts:148` 解析出来却丢弃；微信金额在 `WechatPayTransaction.amount.total`）；
- 不校验 `order.status`，本地 `CANCELLED` 的订单可被迟到回调改回 `PAID` 并激活订阅；
- `PaymentStatus.FAILED` 全仓无写入点，支付失败在库内永远是 `PENDING`。

**改法**（新增纯函数 + 收敛回调主流程）：

1. 新增 `src/modules/billing/payment/callback-amount.ts`：
   - `fenFromYuan(value: string | undefined): number | null`（两位小数字符串 → 分，`Math.round(Number * 100)`，非数字/负值返回 null）；
   - `resolvePaidAmountFen(channel, callback): number | null`：`WECHAT` 取 `callback.amount.total`（已是分），`ALIPAY` 走 `fenFromYuan(callback.total_amount)`；`WECHAT_VIRTUAL` 不走本路径（由虚拟支付服务自行核对，见 `wechat-virtual-payment.service.ts:424-431`）。
2. `handleCallback` 在 `payment` 命中后按顺序判定，任一失败都写 `PaymentStatus.FAILED` + `rawCallback` + `logger.error` 并返回 `{code:'FAIL'}`：
   - **订单状态准入**：`payment.order.status` 必须为 `PENDING` 或 `PAID`；`CANCELLED`/`REFUNDED`/其它 → 拒绝（A3）；
   - **金额核对**：`resolvePaidAmountFen(...) !== payment.amount` → 拒绝；金额字段缺失同样拒绝（验签通过的回调必然带金额，缺失即报文异常）（A2）。
3. 非 `SUCCESS` 的 `trade_state`：维持直接返回 FAIL，但**仅当** `payment` 能定位且 `trade_state === 'PAYERROR'` 时落 `FAILED`（`NOTPAY`/`USERPAYING` 是中间态，不能标失败）（A4）。
4. 成功的写入路径保持现状（`updateMany where status != SUCCESS` 的幂等 + 同事务 `settlePaidOrder`）。

**契约变化**：回调行为收紧。金额不符、订单已取消、报文缺金额三种情况从"照常发货"变为"拒绝并留痕"。`mock` 模式的回调样本（`payment.service.spec.ts`、`alipay-payment.service.spec.ts`）需要补金额字段，否则会按新规则被拒——这是预期行为，测试数据同步修正。

**验收**：

- 微信：金额一致 → 激活；`amount.total` 少 1 分 → 不激活、`payment.status = FAILED`、返回 FAIL。
- 支付宝：`total_amount='19.99'` 对 `payment.amount=1999` → 激活；`'19.98'` → 拒绝。
- 已 `CANCELLED` 的订单收到成功回调 → 订单仍 `CANCELLED`、无订阅变更、`payment.status = FAILED`。
- `trade_state='PAYERROR'` → `payment.status = FAILED`；`'USERPAYING'` → 仍 `PENDING`。
- 重复投递的成功回调 → 幂等（既有一致性用例保持通过）。

---

## 3. A7 SSRF：平台侧本地检查统一内网阻断

**病根**：`BlockList` 只定义在 `src/modules/checker/checkers/ping.checker.ts:13-37` 且未导出；`http.checker.ts`、`tcp.checker.ts` 对目标零地址校验。租户可创建指向 `127.0.0.1`、`10/8`、`169.254.169.254` 的 HTTP 监控，让平台代为探测内网。

**语义决策**（关键）：**只阻断平台侧本地执行（Local check），不阻断探针执行**。探针跑在用户自己的网络里，监控内网是它存在的意义；平台侧执行器跑在服务端，必须阻断。

**改法**：

1. 新建 `src/modules/checker/checkers/network-guard.ts`，把 `ping.checker.ts` 的 `BlockList` 移入并导出：`isPublicAddress(address)`、`isPrivateOrReservedAddress(address)`、`resolvePublicHost(host, {allowPrivate})`（`dns.promises.lookup` 取全部地址，任一非公网即拒；返回 pin 住的地址供连接，防 DNS rebinding）。`ping.checker` 改为 import，行为不变。
2. 新增配置 `src/config/monitoring.config.ts`（若已存在则扩展）：`allowPrivateTargets`（`MONITOR_ALLOW_PRIVATE_TARGETS`，默认 `false`）。用途仅限私有化部署/测试，SaaS 下保持 false。
3. `HttpChecker.check()`：解析 URL host → `resolvePublicHost` → 用 pin 住的 IP 建连（`undici` 的 `dispatcher`/agent `lookup` 或现有请求方式）、保留原 `Host` 头与 SNI；重定向不自动跟随（现有实现若跟随，改为 `redirect: 'manual'` 并逐跳复检）。
4. `TcpChecker.check()`：目标为 IP 直接校验，为域名则 `resolvePublicHost` 后连 pin 住的地址。
5. `DnsChecker` **不改**：它只查询记录、不连接目标，返回内网 A 记录不构成访问面（在代码注释里说明该判断，避免后人误加限制）。
6. `MonitorsService.validateTarget()`（`monitors.service.ts:897-982`）在保存时做同样的公网校验，让用户在建监控阶段就拿到明确报错，而不是每次检查都失败。

**契约变化**：默认配置下，指向私网/保留地址的 HTTP/TCP 监控保存即被拒（`400`，提示走探针）。私有化部署可用 `MONITOR_ALLOW_PRIVATE_TARGETS=true` 恢复。

**验收**：

- `network-guard.spec.ts`：`127.0.0.1`、`10.1.2.3`、`169.254.169.254`、`::1`、`fd00::1` 判私网；`1.1.1.1`、`2001:4860::8888` 判公网；域名解析到私网 IP 时拒绝。
- `http.checker.spec`：目标为 `http://127.0.0.1:PORT` → 检查结果失败且 `kind` 为地址拒绝（不是超时）；`allowPrivateTargets=true` 时放行（现有用 localhost 的 http checker 测试用该开关跑）。
- `monitors.service` 保存校验：`target='http://10.0.0.1'` → 400。

---

## 4. A8 `/metrics` 暴露面（已回滚为网络层隔离）

**病根**：`src/infra/observability/metrics/metrics.module.ts:38-40` 把 `MetricsMiddleware` 挂到 `metrics` 路由，无应用层鉴权；`app.module.ts:134` 还为它排除了静态文件兜底。端点暴露的内容：全量 `path` 维度的流量与错误率、登录尝试结果与失败原因、队列积压、outbox/存储/通知成败，以及 `collectDefaultMetrics` 的进程指标。**不含租户维度**（没有 `org_id` 标签），泄露的是平台运行画像而非客户数据。

**曾尝试的方案（已撤销）**：应用层准入 —— 配 `METRICS_TOKEN` 时要求 Bearer，未配时仅放行私网来源（`request.ip`）。

**为什么撤销**：部署形态是 **LB → nginx → 应用**，而 `main.ts` 没有设置 `trust proxy`（`docs/Dockerfile.nginx:121` 却会写 `X-Forwarded-For`）。于是 `request.ip` 恒为上游代理地址、私网判定恒真 —— 这层准入在真实部署下不生效，属于「看着修了、实际没修」。转而解析 `X-Forwarded-For` 又依赖正确的 hop 数，配错就等于放行伪造来源。

**最终决定**：`/metrics` 不做应用层鉴权，访问控制放在网络层（LB / nginx 白名单，或不把该路径暴露到公网）。代码侧只保留一条边界注释（`metrics.middleware.ts`），并在 README 的 Security 表登记该约束。

**遗留代价**：网络层配置一旦失误，攻击者可拿到路由清单与错误率用于侦察。这是刻意用「简单且与部署一致」换来的取舍，不是遗漏。

**验收**：`/metrics` 行为与改动前一致（无鉴权）；README 有明确要求；随回滚删除无用代码（`isPrivateOrReservedAddress` 与新增的 middleware spec 一并移除）。

---

## 5. A6 配额并发保护

**病根**：`QuotaService.assertCanCreate`（`quota.service.ts:116-133`）在事务外读取用量，调用方（`monitors.service.ts:105`/`:729`、`probes.service.ts:138`、`notification-channels.service.ts:20`、`api-credentials.service.ts:49`）随后各自开事务创建。并发 N 个请求都能通过断言，突破上限。对照已有正确范式：`assertCanAddMember(orgId, tx)` + `FOR UPDATE`（`invitations.service.ts:428,526`）。

**改法**：

1. `QuotaService` 新增事务版断言：`assertCanCreateInTransaction(orgId, resource, tx)`，内部先 `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`（与 `assertCanAddMember` 同一手法），再用 `tx` 计数与判定；`assertCanCreate` 保留为薄封装（内部开事务调用事务版），供无需外层事务的调用方使用。
2. 调用点改造：
   - `MonitorsService.create/restore`：把 `assertCanCreate('monitors')`、`assertIntervalAllowed`、`assertMonitorTypeAllowed`、`assertProbesAssignable` 移入既有 `access.withProject(...)` 回调（该回调已在事务内且 `lockOrganization` 已持 org 行锁，见 `project-access.service.ts:60-79`），用回调收到的 `tx`。套餐相关的纯读断言（间隔/类型）留在事务内一并复用同一份 plan，避免重复查询。
   - `ProbesService.create`：先 `prisma.$transaction` 锁 org → 断言 → 创建 + 通知，合并成一个事务。
   - `NotificationChannelsService.create`：同上。
   - `ApiCredentialsService.createApiKey`：断言移入已有 `$transaction`，用 tx 版。
3. `QuotaService.getPlan(orgId)` 增加可选 `tx` 参数，事务内读 plan 走 `getEffectivePlanInTransaction`，避免事务内外读两份口径。

**契约变化**：无 API 变化。并发下超额请求返回既有 `403 QUOTA_EXCEEDED`。

**验收**：`quota.service.spec.ts` 增加事务版用例（断言先 `FOR UPDATE` 再计数）；各调用点 spec 断言事务内调用（mock `tx`）。真实并发验证留待 e2e（需独立库，不在本轮）。

---

## 6. A5 `mark-paid` 与订阅一致性

**病根**：`src/modules/admin/orders/admin-orders.service.ts:104-113` 的 `markPaid` 只把订单置 `PAID`，注释明写"不激活或续费订阅"。结果是后台标记线下收款后，用户没有权益，且后台无补建工具。

**改法**：

- `markPaid` 改为单事务：`tx.order.updateMany({ where: { id, status: PENDING }, data: { status: PAID, paidAt } })` 条件更新（并发/重复点击幂等，`count === 0` 时按现状返回既有非法迁移错误）→ 调 `settlePaidOrder(tx, { order, paymentId: 'manual:' + order.id, notifications })`。`paymentId` 只用于通知 `eventKey` 去重，不写 `Payment` 表（线下收款没有渠道流水）。
- `settlePaidOrder` 现在只从 `Order` 读字段（`payment-settlement.ts:12-25` 的 `OrderForSettlement`），无需改签名即可复用；`paymentId` 传字符串前缀只为幂等键唯一。
- 保留 `refund`（PAID → REFUNDED）现状，不改动渠道调用语义。

**契约变化**：`POST /api/admin/orders/:id/mark-paid` 语义由"只改订单状态"变为"记账并结算订阅"。这是修复方向：手工收款必须给到权益。文档（`docs/design/billing.md`）同步说明。

**验收**：`admin-orders.service.spec.ts` 增加：mark-paid 后 `order.status = PAID`、`order.serviceStartsAt/EndsAt` 有值、订阅已激活、`PAYMENT_SUCCEEDED` 通知发出；重复调用返回非法迁移错误且不重复结算。

---

## 7. 明确不做（本轮）

- A9 文档真相修复（`plans/002/004/005` 状态、`alipay` 提案）留到下一批，避免与代码改动混在同一 PR 的可读性损失。
- 支付查单补偿、渠道关单、`PaymentAttempt` 普及（迭代 B）。
- 告警事件 ACK/静默/Webhook（迭代 C）。
- DNS 检查器地址限制（见 A7 说明）。
- 多阶段退款、`Subscription.autoRenew` 落地（迭代 D）。

## 8. 回滚

每项独立可回滚：A1 恢复 DTO 字段与 where 表达式；A2-A4 移除金额/状态判定与 `FAILED` 写入；A7 将配置默认改为 `true` 即回到旧行为（无需回滚代码）；A8 `metrics.allowPrivateOnly=false` 且不配 token 即公开；A6 调用点保持事务外断言即可（新增事务版方法惰性无害）；A5 恢复旧 `transition` 调用。

# 退款接入开发方案（微信 / 支付宝 / 微信虚拟支付）

把「退款」做成独立于支付渠道的能力：用户/运营发起 → 政策试算（全额 / 按天折算）→ 调用渠道退款 → 渠道回调或轮询确认 → 落账 → 回收订阅权益。

> 状态：**P0 / P1 / P2 已实施**。P0：数据模型、政策折算、渠道退款、RefundService、后台接口、微信退款回调、兜底轮询、配置项；P1：用户端自助接口、归属校验、自助开关与审批分流；P2：虚拟支付退款统一入口、被动退款留痕、对账报表。现行行为以源码与 Swagger 为准。
> 分期：P0 全额退款闭环 → P1 用户自助 + 按天折算 → P2 多次部分退款 + 对账。
> 实施调整：P2 **未放开**「每单限一次」（部分退款后订单仍置 `REFUNDED`）；改为虚拟支付统一入口 + 对账报表。

## 1. 目标与范围

### 本期做（P0 → P2）

| 阶段 | 内容 |
| --- | --- |
| P0 | `Order` 服务期快照、`Refund` 表、微信 V3 + 支付宝**全额退款**（后台发起）、订阅回收、微信退款回调、定时兜底查询、退款通知 |
| P1 | 用户端自助申请、7 天冷静期、**按天折算**试算与执行、可配置退款策略、自动/人工审批分流 |
| P2 | 同一订单多次部分退款、虚拟支付退款统一入口、支付宝退款轮询对账、发票红冲联动（人工）、退款报表 |

### 本期不做

- 已开票发票的红冲（财务人工处理，代码只留备注与订单标记）。
- 分账 / 服务商模式退款（当前是直连商户模式）。
- 汇率与外币退款（`Order.currency` 目前恒为 CNY）。
- 退款争议/黑名单风控（P2 之后再评估）。

## 2. 现状与差距

| 环节 | 现状 | 差距 |
| --- | --- | --- |
| 微信 V3 退款 API | `WechatPayClient.createRefund / queryRefund` 已实现（分、`out_refund_no` 幂等） | 没有业务调用方 |
| 微信退款回调 | ❌ | 只有交易回调 `POST /payment/wechat/callback` |
| 支付宝退款 | ❌ | `AlipayClient` 只封了支付；需加 `alipay.trade.refund` / `...refund.query` |
| 微信虚拟支付退款 | `WechatVirtualPayClient.refundOrder` 已实现；`xpay_refund_notify` 只落账、**刻意不回收订阅** | 未与统一退款记录打通 |
| 后台退款 | `AdminOrdersService.refund()` 只把订单改成 `REFUNDED`，注释明确「不调渠道」 | 换成本方案的执行入口 |
| 退款记录 | ❌ 无表、无累计金额 | 无法支持部分退款与对账 |
| 服务期快照 | ❌ 续费订单不写 `Subscription.orderId` | 算不出「这笔订单覆盖哪段时间」，折算与回收都无从下手 |
| 订阅回收 | ❌ | 但 `EffectivePlanService` 按 ACTIVE+未过期算权益，回收后天然降权；`restorePausedSubscription` 可复用 |
| 通知类型 | 只有 `PAYMENT_SUCCEEDED` | 需加 `PAYMENT_REFUNDED`（Postgres 枚举加值要单独迁移） |

## 3. 关键设计决策

### 3.1 退款政策（默认值全部可配）

| 规则 | 条件 | 退款额 | 订阅处理 |
| --- | --- | --- | --- |
| R1 未生效 | `now < serviceStartsAt`（压栈/排队订单） | 全额 | 该订阅段 `CANCELLED`，不影响当前生效段 |
| R2 冷静期 | 服务已开始且 `usedDays <= coolingOffDays`（默认 7） | 全额 | 段终止，`expiresAt = now` |
| R3 按天折算 | `usedDays > 冷静期` 且 `remainingDays > 0` | `round(金额 × 剩余天数 / 总天数)` | 段截断到 `now`；续费订单回退剩余天数 |
| R4 已过期 | `remainingDays == 0` | 0（拒绝申请） | 不动 |
| R5 已退过 | 部分退款后再申请 | ≤ `amount - refundedAmount` | 按新的剩余天数再截断 |

- 冷静期按「**服务开始日**」起算，不是付款日：排队订单（`startsAt` 在未来）自然落入 R1 全额退。
- 手续费与最低退款额默认关闭（`feeRate = 0`、`minAmount = 0`），需要时再开。
- `billing.refund.prorate = false` 时退化成「只退冷静期内」，超过一律不退（更省事、投诉风险更高）。

### 3.2 按天折算：整数分，不用浮点

```ts
const DAY_MS = 24 * 60 * 60 * 1000;

/** 已使用天数：当天算 1 天，避免「用 1 小时退全款」和「6 天 23 小时算 7 天」 */
const usedDays = Math.min(
    order.durationDays,
    Math.max(1, Math.ceil((now - serviceStartsAt) / DAY_MS)),
);
const remainingDays = Math.max(0, order.durationDays - usedDays);

/** 先算总额再扣费，避免日单价取整误差累积 */
const gross = Math.round((order.amount * remainingDays) / order.durationDays);
const fee = Math.floor(gross * feeRate);
const refundable = Math.min(
    gross - fee,
    order.amount - order.refundedAmount,
);
```

示例：299.00 元 / 30 天，用了 10 天 → `round(29900 × 20 / 30) = 19933 分 = 199.33 元`。
金额全程整数分；只有调用支付宝时才用 `yuanFromFen()`（`AlipayPaymentService` 里已有，直接复用）。

### 3.3 服务期快照（P0 的前置）

结算时（`payment-settlement.ts` 的 `settlePaidOrder`）把「这笔订单买到的时间段」写进订单：

- 新建订阅段：`serviceStartsAt = startsAt`、`serviceEndsAt = expiresAt`
- 续费（同档位延长）：`serviceStartsAt = 原 expiresAt`、`serviceEndsAt = 原 expiresAt + durationDays`

没有这两个字段，续费订单就查不到自己的时间段（`Subscription.orderId` 只在新建段时写入）。

### 3.4 订阅回收（两条路径）

| 订单与订阅的关系 | 判定 | 处理 |
| --- | --- | --- |
| 建段订单 | `subscription.orderId === order.id` | R1/R2 → `status = CANCELLED`、`expiresAt = min(expiresAt, now)`；R3 → `expiresAt = now` |
| 续费订单 | `subscription.orderId !== order.id` 且同 planId | `expiresAt = max(now, expiresAt - remainingDays)` |
| 找不到订阅 | 历史数据/人工补录 | 只落账 + 通知运营，不改权益 |

回收后若没有生效订阅，必须调用 `EffectivePlanService` 的恢复逻辑，把之前被压住（`PAUSED`）的低档订阅放出来——否则「退了高档订阅」会让用户直接掉到无权益。

### 3.5 退款记录独立成表

`Payment.orderId` 是唯一键（一单一条支付记录），所以「一次订单多次部分退款」只能靠 `Refund` 表累积。同一订单在途（`PENDING/APPROVED/PROCESSING`）记录最多一条，避免并发重复退款。

### 3.6 渠道能力差异

| 维度 | 微信 Pay V3 | 支付宝 | 微信虚拟支付 |
| --- | --- | --- | --- |
| 幂等键 | `out_refund_no` | `out_request_no` | `MchOrderNo` |
| 金额单位 | 分 | **元**（两位小数字符串） | 分 |
| 结果通知 | 退款回调 + 查询 | **仅同步响应**（无回调）+ 查询 | 推送 + 查询 |
| 需要付款人 | 否 | 否 | **需要 openid** |
| iOS 退款 | — | — | 由 Apple 发起，只能被动落账 |

结论：统一抽象 `PaymentProvider.refund()`，但**支付宝必须靠轮询兜底**，虚拟支付 iOS 场景保持「只落账不回收」。

## 4. 数据模型变更

```prisma
enum RefundType {
  FULL       // 冷静期/未生效：全额
  PRORATED   // 按天折算
  MANUAL     // 人工指定金额
}

enum RefundStatus {
  PENDING      // 已申请，待执行/审批
  PROCESSING   // 已提交渠道，等待终态
  SUCCESS
  FAILED
  CLOSED       // 被拒/人工关闭
}

model Refund {
  id              String         @id @default(cuid())
  refundNo        String         @unique   // out_refund_no / out_request_no
  orderId         String
  organizationId  String
  channel         PaymentChannel
  type            RefundType
  status          RefundStatus   @default(PENDING)

  /// 申请金额（分）与渠道实际退款额；部分退款时两者可能不同
  amount          Int
  settledAmount   Int?
  /// 政策快照：客服解释「为什么退这么多」时不必重算
  policyCode      String?        // COOLING_OFF / NOT_STARTED / PRORATED / MANUAL
  usedDays        Int?
  remainingDays   Int?

  reason          String?
  requestedBy     String?
  approvedBy      String?
  channelRefundId String?
  failureReason   String?
  rawResponse     Json?
  refundedAt      DateTime?

  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt

  order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([orderId])
  @@index([status, updatedAt])
  @@index([organizationId])
  @@map("refunds")
}
```

订单 / 支付补字段：

```prisma
model Order {
  /// 本单覆盖的服务期快照（结算时写入）；历史订单为空
  serviceStartsAt DateTime?
  serviceEndsAt   DateTime?
  /// 累计已退金额（分），用于「累计不得超过订单金额」
  refundedAmount  Int       @default(0)
  refunds         Refund[]
}

model Payment {
  refundedAmount Int @default(0)
}
```

迁移拆分（Postgres 对 `ADD VALUE` 有事务限制，枚举单独一个迁移）：

1. `add_refund_tables`：`Refund` 表 + `RefundType`/`RefundStatus` + `Order`/`Payment` 新列
2. `add_payment_refunded_notification`：`NotificationType` 加 `PAYMENT_REFUNDED`

存量数据回填（可选）：用 `paidAt` 推算 `serviceStartsAt = paidAt`、`serviceEndsAt = paidAt + durationDays` 的 `refundedAmount` 与快照，仅为了让老订单也能走 P1 折算。

## 5. 代码结构

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/modules/billing/refund/refund.controller.ts` | 用户端：试算 / 申请 / 查询 |
| `src/modules/billing/refund/refund.service.ts` | 建单、状态机、幂等、落账、订阅回收调用 |
| `src/modules/billing/refund/refund-policy.ts` | 纯函数：政策判定 + 折算（无 IO，单测主战场） |
| `src/modules/billing/refund/refund.module.ts` | 装配 |
| `src/modules/billing/refund/dto/*` | `CreateRefundDto` / `QueryRefundDto` / `RefundQuoteDto` |
| `src/modules/billing/refund/entities/*` | `RefundEntity` / `RefundQuoteEntity` |
| `src/modules/admin/refunds/admin-refunds.{controller,service}.ts` | 后台列表、发起、重试（`SuperAdminGuard`，仿 `admin/orders`） |
| `src/modules/cron/jobs/refund-reconcile.service.ts` | 兜底轮询渠道终态 |
| `src/infra/alipay/`（扩） | `AlipayClient.refund()` / `queryRefund()` |
| 对应 `*.spec.ts` | 见 §8 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `prisma/schema.prisma` | §4 全部 |
| `src/modules/billing/payment/payment-provider.interface.ts` | `PaymentProvider` 加 `refund()`；`RefundInput/RefundResult` |
| `src/modules/billing/payment/wechat-payment.service.ts` | 实现 `refund()`（`createRefund` + 状态映射） |
| `src/modules/billing/payment/alipay-payment.service.ts` | 实现 `refund()`（`alipay.trade.refund`，金额转元） |
| `src/modules/billing/payment/wechat-virtual-payment.service.ts` | 实现 `refund()`（`refundOrder`）；退款推送里同步更新 `Refund` 记录 |
| `src/modules/billing/payment/payment.service.ts` | `assertChannelSwitchable` 拦住 REFUNDED / 在途退款；`handleCallback` 对 `REFUNDED` 短路 |
| `src/modules/billing/payment/payment.controller.ts` | 新增 `POST /payment/wechat/refund-callback` |
| `src/modules/billing/payment/payment-settlement.ts` | 结算时写 `serviceStartsAt/serviceEndsAt` |
| `src/modules/billing/billing.module.ts` | 引入 `RefundModule`；导出 `RefundService` 供 admin 使用 |
| `src/modules/admin/admin.module.ts` | 注册 `AdminRefundsController/Service` |
| `src/modules/cron/cron.module.ts` + `jobs/index.ts` | 注册 `RefundReconcileService` |
| `src/modules/settings/settings.defaults.ts` | 新增 `billing` 分组 7 项（见 §6.3） |
| `src/infra/wechat/pay/wechat-pay.client.ts` | 新增 `parseRefundNotification()`（复用验签/解密，仅 endpoint 名不同） |

## 6. 接口契约

### 6.1 用户端（P1）

```text
GET  /api/orders/:id/refund-quote
resp: {
  eligible: true,
  policyCode: "PRORATED",
  usedDays: 10,
  remainingDays: 20,
  amount: 19933,          # 分
  refundedAmount: 0,
  subscriptionEffect: "EXPIRES_NOW"   # NONE / EXPIRES_NOW / CANCELLED / SHRINKS
}

POST /api/orders/:id/refunds
body: { reason?: string }
resp: { id, refundNo, status: "PENDING", amount, policyCode }

GET  /api/orders/:id/refunds
resp: RefundEntity[]
```

### 6.2 后台（P0 起）

```text
GET  /api/admin/refunds?status=&channel=&orderId=&page=&limit=
POST /api/admin/refunds        # { orderId, type?: "FULL"|"PRORATED"|"MANUAL", amount?, reason? }
POST /api/admin/refunds/:id/retry
POST /api/admin/refunds/:id/close     # 人工关闭（被拒/无法退回原路）
POST /api/payment/wechat/refund-callback   # 渠道回调，@Public + @SkipTransform
```

- P0 的「审批」收敛为**单个后台动作**（有 `SUPER_ADMIN` 权限即可发起），`approvedBy` 记录操作人；P1 再拆成「用户申请 → 运营审批」两级，审批阈值由 `billing.refund.autoApproveLimit` 决定。
- 渠道退款金额 > 0 且 ≤ 可退上限时才允许提交；`MANUAL` 必须显式传 `amount`。
- 回调应答：微信退款回调同样回裸 JSON `{ code: "SUCCESS" }`，非 2xx 会重试。

### 6.3 配置项（`billing` 分组）

| key | 默认 | 说明 |
| --- | --- | --- |
| `billing.refund.enabled` | `false` | 总开关；关闭时所有退款接口直接拒绝（上线灰度的第一道闸） |
| `billing.refund.coolingOffDays` | `7` | 冷静期天数，服务开始日起算 |
| `billing.refund.prorate` | `true` | 冷静期后是否按天折算；false = 超过不退 |
| `billing.refund.feeRate` | `0` | 手续费率（0–0.3），从折算额里扣 |
| `billing.refund.minAmount` | `0` | 最小退款额（分），低于则拒绝 |
| `billing.refund.userSelfService` | `false` | P1 用户自助入口开关 |
| `billing.refund.autoApproveLimit` | `0` | P1 自动通过阈值（分），0 = 全部人工 |

三段式 key（`billing.refund.*`）会让设置页自动归到 `billing` tab 的 `refund` 小节，不需要显式声明 `section`。

## 7. 实施步骤

### 步骤 1（P0）：数据模型与快照

1. schema 加 `Refund`、两个枚举、`Order.serviceStartsAt/serviceEndsAt/refundedAmount`、`Payment.refundedAmount`。
2. `pnpm prisma:migrate`（Prisma 7 需 `npx prisma migrate dev --create-only --name add_refund_tables`，检查 SQL 后 deploy）→ `pnpm prisma:generate`。
3. `payment-settlement.ts` 写入服务期快照（新建段 / 续费两条分支都要写）。
4. 验收：`pnpm type-check` 通过；结算单测补「续费订单也写快照」。

### 步骤 2（P0）：政策与折算纯函数

1. `refund-policy.ts`：`quoteRefund(order, now, config)` 返回 `{ policyCode, usedDays, remainingDays, amount, subscriptionEffect }`。
2. 不做任何 IO、不读 DB，配置从参数传入 → 单测覆盖全部边界（见 §8）。
3. 验收：`pnpm test -- refund-policy` 全绿。

### 步骤 3（P0）：渠道 `refund()` 抽象

1. `PaymentProvider` 加 `refund()`；三个实现分别接 `createRefund` / `alipay.trade.refund` / `refundOrder`。
2. 微信回调：`WechatPayClient.parseRefundNotification()`（复用 `buildResponseSignMessage` + `decryptResource`，endpoint 名换成 `POST /v3/refund/domestic/notifications`）。
3. 支付宝金额用 `yuanFromFen()`；`out_request_no` 用 `refundNo` 保证幂等。
4. 验收：三个 provider 的 mock 模式都能返回 `SUCCESS`，不发网络请求。

### 步骤 4（P0）：退款服务与订阅回收

1. `RefundService.create()`：校验订单可退 → 试算 → 建 `PENDING` 记录（同单在途唯一）→ 提交渠道 → 状态推进。
2. `RefundService.settle()`：`SUCCESS` 时在**同一事务**里：`Order.refundedAmount += amount`、订单/支付置 `REFUNDED`、写 `refundedAt`、按 §3.4 回收订阅、恢复 `PAUSED` 低档订阅、发 `PAYMENT_REFUNDED` 通知。
3. 幂等：渠道回调重复到达时 `updateMany where status != SUCCESS` 条件更新；`refundNo` 唯一约束兜底。
4. 验收：并发回调只结算一次（对照 `payment.service.spec.ts` 的并发用例）。

### 步骤 5（P0）：后台入口、回调、兜底

1. `AdminRefundsController`（`SuperAdminGuard`）+ 发起/重试/关闭。
2. `POST /payment/wechat/refund-callback`（`@Public` + `@SkipTransform`，裸 JSON 应答）。
3. `RefundReconcileService`：每 5 分钟扫 `PROCESSING` 超 10 分钟的记录，`queryRefund` / `alipay.trade.fastpay.refund.query` 同步终态；超过 24 小时仍 `PROCESSING` 的告警。
4. 验收：手工把记录改成 `PROCESSING` 后跑一次任务，能推进到终态。

### 步骤 6（P1）：用户自助与折算放开

1. 三个用户端接口 + `billing.refund.userSelfService` 开关。
2. 折算分支接上 `feeRate` / `minAmount` / `prorate` 配置。
3. `autoApproveLimit`：小额自动执行，超过则停在 `PENDING` 等后台审批。
4. 验收：299 元 / 30 天 / 用 10 天，试算返回 199.33 元；接口与折算结果一致。

### 步骤 7（P2）：多次部分退款与对账

1. 放开同单多次（累计 ≤ 订单金额），`Payment.refundedAmount` 同步。
2. 虚拟支付退款并入统一入口，iOS 场景标记 `MANUAL` 且不回收订阅。
3. 退款日/月报表（按渠道、政策、失败原因聚合）。
4. 验收：同一订单两次部分退款都成功，第三次超额的请求被拒。

## 8. 测试计划

单测（重点，按文件）：

- `refund-policy.spec.ts`：R1–R5 命中；`usedDays` 边界（0 分钟 → 1 天、23h59m → 1 天、整 24h → 1 天、24h01m → 2 天，即按经过时长 `ceil` 而不是日历天）；整除/四舍五入（29900×20/30 = 19933）；`feeRate` 与 `minAmount`；已部分退款后的上限；`prorate=false`。
- `refund.service.spec.ts`：同单在途唯一；`SUCCESS` 幂等（重复回调不再加钱）；`FAILED` 可重试；金额超上限拒绝；`REFUNDED` 订单拒绝再次支付。
- 订阅回收：建段订单 → `CANCELLED`/`expiresAt=now`；续费订单 → `expiresAt` 回退 `remainingDays`；`PAUSED` 低档订阅被恢复；已过期订单不动。
- 渠道：三个 provider 的 `refund()`（mock 分支、状态映射、金额单位：微信分 / 支付宝元）。
- 回调：`wechat refund-callback` 验签失败拒绝、重复回调幂等、金额与 `Refund.amount` 不符拒绝。
- 回归：`payment.service.spec.ts` 补「`Payment.status = REFUNDED` 时 `handleCallback` 不再结算」；`payment-settlement.spec` 补快照写入。

e2e（可选，`test/`）：mock 模式下「下单 → 支付 → 退款 → 订阅终止」全链路。

## 9. 上线与回滚

顺序：

1. 迁移（新表 + 可空列，对现网零影响）。
2. 代码上线，`billing.refund.enabled = false`（默认）→ 接口全部拒绝，等于没开。
3. 打开开关，先做 1 笔小额**全额**退款（微信），核对：渠道退款到账、订单/支付 `REFUNDED`、订阅终止、通知送达。
4. 再验支付宝（沙箱）与一笔按天折算。
5. P1 才打开 `userSelfService`，先设 `autoApproveLimit = 0`（全人工）。

回滚：

- 立即止血：`billing.refund.enabled = false`（30 秒缓存后生效，无需重启）。
- 已提交渠道的退款无法撤回，但 `Refund` 记录与订阅状态保持一致，属于「退就退干净」；不会再自动发起新的退款。
- 代码回滚安全：新表/新列无人使用不影响老逻辑；`NotificationType.PAYMENT_REFUNDED` 已存在的值不会被删除。

## 10. 风险与坑

1. **续费订单没有 `orderId` 关联**：靠 `serviceStartsAt/serviceEndsAt` 快照判定；漏写快照会导致退错天数，是 P0 第一步就要解决的。
2. **`handleCallback` 重放**：退款成功后订单已 `REFUNDED`，若原支付回调重试，现有逻辑会把 `Payment` 再置 `SUCCESS` 并重复开通订阅 → 必须在 `handleCallback` 里对 `REFUNDED` 短路。
3. **再次支付**：`assertChannelSwitchable` 目前只拦 `SUCCESS`；退款后必须拦住（含在途退款记录）。
4. **金额单位**：微信分、支付宝元。支付宝侧复用 `yuanFromFen()`，禁止 `(fen/100).toString()`。
5. **部分退款累计**：`Order.refundedAmount` 与 `Payment.refundedAmount` 都要累加，且以 `updateMany` 条件更新防并发超退。
6. **订阅回收必须恢复低档**：被退款的高档订阅终止后，要调用恢复逻辑放开 `PAUSED` 订阅，否则用户直接失去全部权益。
7. **微信余额不足**：退款会 `FAILED`，必须落 `failureReason` 并允许重试；运营需要能看到失败队列。
8. **支付宝无回调**：只能靠同步响应 + 轮询；`PROCESSING` 状态不能一直挂着，超时要有告警。
9. **虚拟支付 iOS**：退款由 Apple 发起，只落账不回收（保持现状），回收走人工；Android/国内走 `refundOrder`。
10. **时间边界**：`usedDays` 用 `ceil` 且最小 1 天；`remainingDays = 0` 时直接拒绝申请，避免 0 元退款单。
11. **发票**：已开票需红冲，代码只标记 `Order.refundedAmount` 与通知，不做自动红冲。
12. **审计**：退款是资金操作，`@AuditLog({ entity: 'Refund' })` 必须加，且 `reason`/`approvedBy` 落库用于对账。

## 11. 待确认问题

1. **冷静期起算点**：按「服务开始日」还是「付款日」？本方案取服务开始日（排队订单自动全额退）。
2. **手续费与最低额**：默认 `0`（不退手续费、不设下限）。是否需要「跨渠道手续费由用户承担」？
3. **部分退款次数**：P0/P1 每单限一次（全额或折算一次），P2 才允许多次；是否接受？
4. **退款与发票**：红冲走人工还是接第三方发票平台？
5. **通知文案**：`PAYMENT_REFUNDED` 是否需要单独的邮件模板（现有 `payment-succeeded` 模板可复用变量）。

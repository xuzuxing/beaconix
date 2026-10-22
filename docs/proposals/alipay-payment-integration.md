# 支付宝支付接入开发方案

把支付宝接入计费流程，作为 `PaymentChannel` 的第二个渠道。配置项（`alipay.*` 9 项）已经就位，但计费流程尚未读取它们，本次要把「配置 → 下单 → 回调 → 开通订阅」全部打通。

> 状态：提案（`proposals/`），未实施。现行行为以源码与 Swagger 为准。

## 1. 目标与范围

### 本期做

- `PaymentChannel` 增加 `ALIPAY`（含数据库迁移）。
- 新增 `infra/alipay`：运行时配置（settings 优先、env 兜底）、RSA2 签名/验签、下单客户端。
- 新增 `AlipayPaymentService` 实现 `PaymentProvider`，注册进 `PaymentProviderFactory`。
- 新增支付宝异步回调入口 `POST /payment/alipay/callback`。
- `POST /orders/:id/pay` 支持 `channel=ALIPAY`，返回可跳转的收银台 URL。
- `alipay.mock=true`（默认）时不调用真实接口，保证无凭证也能跑通流程。

### 本期不做

- 退款（`PaymentStatus.REFUNDED` 目前也无任何渠道在用）、对账、发票、分账。
- 支付宝登录（`alipay.user.info`）与用户绑定 —— 与支付无关，另立提案。
- App 支付（`alipay.trade.app.pay`）—— 需要移动端配合，见 §3 的支付方式决策。
- 证书模式（`sign_type=RSA2` 的公钥模式已够用；证书模式需要额外证书管理）。

## 2. 现状与差距

| 环节 | 现状 | 差距 |
| --- | --- | --- |
| 渠道枚举 | `PaymentChannel` 只有 `WECHAT`（`prisma/schema.prisma:966`） | 需要加 `ALIPAY` + 迁移 |
| 支付工厂 | `PaymentProviderFactory` 支持注册多渠道，`register()` 现成 | 无需改动，仅注册新 provider |
| provider 契约 | `PaymentProvider`：`createPayment` / `verifyCallback`（`payment-provider.interface.ts`） | `payerId` 是必填，支付宝不需要；`PayParams` 是自由对象，可放 `payUrl` |
| 下单 | `PaymentService.createPayment` 按 `dto.channel` 路由，写 `Payment.prepayId` | `extractPrepayId` 只认 `package` / `prepayId`，支付宝无此概念 |
| 回调 | `PaymentService.handleCallback(channel, …)` 已渠道无关，含幂等与订阅开通 | `trade_state !== 'SUCCESS'` 是硬编码，支付宝返回的是 `TRADE_SUCCESS` |
| 回调入口 | 只有 `POST /payment/wechat/callback` | 需要支付宝专用入口（响应体是纯文本 `success`） |
| 配置 | `alipay.*` 9 项已入库，但**无任何消费方** | 需要 `AlipayRuntimeConfigService` |
| 金额 | `Order.amount` 单位为**分**（`Int`），微信 `amount.total` 也是分 | 支付宝单位是**元**（两位小数字符串） |
| rawBody | `main.ts:22` 已开 `rawBody: true`（为微信 V3 签名） | 支付宝回调是 form-urlencoded，验签方式不同（见 §7） |

## 3. 关键设计决策

### 3.1 支付方式：先做 PC + 手机网页（推荐）

| 产品码 | 场景 | 返回值 |
| --- | --- | --- |
| `alipay.trade.page.pay` | PC 浏览器收银台 | 可 GET 跳转的 URL |
| `alipay.trade.wap.pay` | 手机浏览器 | 可 GET 跳转的 URL |
| `alipay.trade.app.pay` | App SDK | `orderString` 给客户端 |

**建议本期只做前两个**：它们都能用「拼好参数的 GET URL」实现，前端 `location.href` 跳转即可，不需要表单自提交，也不需要移动端改造。`PayParams` 返回 `{ payUrl, outTradeNo, method }`。

具体用哪个产品码由调用方决定：加一个 `payMethod` 入参（默认按 UA/端类型），或先固定 `page.pay`。**这一项需要产品确认**（见 §12）。

### 3.2 是否引入 `alipay-sdk`

**建议不引入，自实现 RSA2 签名/验签**，理由：

- 现有微信支付就是自实现（`infra/wechat/pay/wechat-pay-signature.util.ts`），风格一致；
- 支付宝的公钥模式签名逻辑很短（参数排序拼接 + `SHA256withRSA`），约 80 行；
- 少一个依赖，也便于与微信共用 `node:crypto` 的 PEM 加载与错误处理约定。

如果后续要支持证书模式（`ALIPAY_SIGN_TYPE` 之外的场景），再评估引入 SDK。

### 3.3 回调验签的数据来源

支付宝的验签对象是**参数字典序拼接的字符串**（不含 `sign`、`sign_type`），**不依赖原始字节顺序** —— 这点与微信（签原始报文）不同。因此：

- 不强制使用 `rawBody`，但**仍建议**在 provider 里用 `new URLSearchParams(rawBody)` 解析，避免中间件对 body 的二次改写；
- 空值参数要剔除，否则验签必失败。

## 4. 数据模型变更

只加一个枚举值，不加字段。

```sql
-- prisma/migrations/<timestamp>_add_alipay_payment_channel/migration.sql
ALTER TYPE "PaymentChannel" ADD VALUE 'ALIPAY';
```

生成方式：

```bash
cd D:/zuxcloud/nest-beacon
# 先改 schema.prisma 的 enum PaymentChannel，再加 ALIPAY
pnpm prisma:migrate --create-only --name add_alipay_payment_channel
# 检查生成的 SQL 只有上面这一行，再应用
pnpm prisma:migrate
pnpm prisma:generate   # 重新生成 src/generated/prisma
```

注意事项：

- **单独一个迁移**只放枚举值，不要和其他 DDL 混在一个事务里（Postgres 对 `ADD VALUE` 有事务限制）。
- `PaymentChannel` 只会新增枚举值，**不能回滚删除**（Postgres 不支持），回滚靠「关闭 mock 开关」而不是删枚举。

## 5. 代码结构

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/infra/alipay/alipay.module.ts` | `@Global()` 模块，导出 client 与运行时配置 |
| `src/infra/alipay/alipay-runtime-config.service.ts` | 读 9 个 `alipay.*` settings key，DB 优先、留空回退 env、再回退内置默认 |
| `src/infra/alipay/alipay-signature.util.ts` | 参数排序拼接、RSA2 签名、验签、PEM 加载 |
| `src/infra/alipay/alipay.client.ts` | 组装下单参数、拼收银台 URL、解析同步/异步结果 |
| `src/infra/alipay/alipay.types.ts` | 下单入参、回调结果、错误类型 |
| `src/modules/billing/payment/alipay-payment.service.ts` | `PaymentProvider` 实现（含 mock 分支） |
| 对应 `*.spec.ts` | 见 §9 |
| `prisma/migrations/<ts>_add_alipay_payment_channel/` | 枚举迁移 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `prisma/schema.prisma` | `enum PaymentChannel { WECHAT ALIPAY }` |
| `src/modules/billing/payment/payment-provider.interface.ts` | `payerId` 改可选；`PaymentProviderCreateInput` 增加可选 `payMethod` / `clientIp` |
| `src/modules/billing/payment/payment-provider.factory.ts` | 构造器注入 `AlipayPaymentService` 并 `register` |
| `src/modules/billing/payment/dto/create-payment.dto.ts` | `openid` 改可选（改按渠道校验），新增 `payMethod?` |
| `src/modules/billing/payment/wechat-payment.service.ts` | 显式校验 `openid` 必填（原本由 DTO 保证） |
| `src/modules/billing/payment/payment.service.ts` | `extractPrepayId` 兜底 `payUrl`；新增 `handleAlipayCallback` |
| `src/modules/billing/payment/payment.controller.ts` | 新增 `POST /payment/alipay/callback` |
| `src/modules/billing/billing.module.ts` | providers 增加 `AlipayPaymentService`，imports 增加 `AlipayModule` |
| `src/app.module.ts` | 注册 `AlipayModule`（若为 @Global 也必须 import 一次） |
| `.env.example` | 新增 9 个 `ALIPAY_*` 变量 |

## 6. 实施步骤

每一步都能独立跑通测试，建议按序提交。

### 步骤 1：枚举与迁移

1. `prisma/schema.prisma` 加 `ALIPAY`。
2. `pnpm prisma:migrate --create-only` → 检查 SQL → `pnpm prisma:migrate` → `pnpm prisma:generate`。
3. 验收：`pnpm type-check` 通过；`PaymentChannel.ALIPAY` 可在 TS 中引用。

### 步骤 2：`infra/alipay` 基础设施

`alipay-runtime-config.service.ts`（对照 `src/infra/wechat/wechat-runtime-config.service.ts`）：

```ts
export interface AlipayConfig {
    appId: string;
    privateKey: string;
    publicKey: string;
    gateway: string;
    signType: 'RSA2' | 'RSA';
    sandbox: boolean;
    notifyUrl: string;
    returnUrl: string;
    mock: boolean;
}

@Injectable()
export class AlipayRuntimeConfigService {
    constructor(
        private readonly settings: SettingsService,
        private readonly configService: ConfigService,
    ) {}

    /**
     * DB 覆盖优先 → env 兜底 → 内置默认。
     * 与微信一致，用 `getOverriddenValue` 判断「管理页是否改过」，
     * 避免内置默认值反过来盖掉 .env 的既有配置。
     */
    async config(): Promise<AlipayConfig> { /* 9 个 key 逐个合并 */ }
}
```

`alipay-signature.util.ts` 的关键函数：

```ts
/** 参数按 key 字典序拼接成 a=1&b=2，剔除空值与 sign/sign_type */
export function buildSignContent(params: Record<string, string | undefined>): string;

/** RSA2 = SHA256withRSA；RSA = SHA1withRSA（兼容旧应用） */
export function signContent(content: string, privateKeyPem: string, signType: 'RSA2' | 'RSA'): string;

export function verifyContent(content: string, signature: string, publicKeyPem: string, signType: 'RSA2' | 'RSA'): boolean;

/** 支持 PEM 全文或文件路径，与微信的 resolvePem 行为一致 */
export function resolvePem(value: string, label: string): string;
```

### 步骤 3：provider + 注册

```ts
@Injectable()
export class AlipayPaymentService implements PaymentProvider {
    readonly channel = PaymentChannel.ALIPAY;

    async createPayment(input: PaymentProviderCreateInput): Promise<PaymentProviderPayParams> {
        const config = await this.runtimeConfig.config();
        if (config.mock) return this.mockPayParams(input);

        // 金额：Order.amount 是「分」，支付宝要「元」的两位小数字符串
        const totalAmount = (input.totalFee / 100).toFixed(2);
        const payUrl = await this.client.buildCashierUrl({
            outTradeNo: input.outTradeNo,
            totalAmount,
            subject: input.body,
            method: input.payMethod ?? 'alipay.trade.page.pay',
        });

        return { payUrl, outTradeNo: input.outTradeNo };
    }

    async verifyCallback(rawBody: string, signature: string): Promise<PaymentProviderCallbackResult> {
        const config = await this.runtimeConfig.config();
        const params = Object.fromEntries(new URLSearchParams(rawBody));

        if (!config.mock) {
            const { sign, sign_type: signType, ...rest } = params;
            const ok = verifyContent(
                buildSignContent(rest),
                sign ?? signature,
                config.publicKey,
                (signType as 'RSA2' | 'RSA') ?? config.signType,
            );
            if (!ok) throw new WechatApiError(...); // 换成支付宝自己的错误类型
        }

        return {
            out_trade_no: params['out_trade_no'],
            transaction_id: params['trade_no'],
            // 关键映射：支付宝的 TRADE_SUCCESS / TRADE_FINISHED 都算成功
            trade_state: ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(params['trade_status'])
                ? 'SUCCESS'
                : params['trade_status'],
        };
    }
}
```

最后把 provider 注册进工厂：`PaymentProviderFactory` 的构造器注入 `AlipayPaymentService`，`billing.module.ts` 的 `providers` 与 `app.module.ts` 的 `imports` 同步加上。

### 步骤 4：下单与回调接口

`PaymentService` 三处改动（第一项**已实施**）：

```ts
    // 已实施：Order→Payment 是 1:1（Payment.orderId 唯一），换渠道会覆盖记录。
    // 已成功的记录绝不允许覆盖，否则原渠道的回调按 channel 查不到它。
    private async assertChannelSwitchable(
        orderId: string,
        channel: PaymentChannel,
    ): Promise<void> { /* 见源码 */ }

    // 待实施：支付宝没有 prepay_id，用收银台 URL 兜底，便于排查
    private extractPrepayId(params: PaymentProviderPayParams): string {
        const value = params['package'] ?? params['prepayId'] ?? params['payUrl'] ?? '';
        return typeof value === 'string' ? value : JSON.stringify(value);
    }

    /** 支付宝回调：与微信一样走渠道无关的 handleCallback */
    async handleAlipayCallback(rawBody: string): Promise<PaymentCallbackResponse> {
        return this.handleCallback(PaymentChannel.ALIPAY, rawBody, '');
    }
```

`PaymentController` 新增（注意响应必须是**纯文本 `success`**，不带 JSON 引号）：

```ts
    @Post('payment/alipay/callback')
    @Public()
    @SkipTransform()
    @ApiOperation({ summary: 'Alipay async notification (idempotent)' })
    async alipayCallback(
        @Req() request: RawBodyRequest<Request>,
        @Body() body: Record<string, string>,
        @Res({ passthrough: true }) response: Response,
    ) {
        const rawBody = request.rawBody?.toString('utf8') ?? new URLSearchParams(body).toString();
        const result = await this.paymentService.handleAlipayCallback(rawBody);

        response.status(HttpStatus.OK).type('text/plain');
        return result.code === 'SUCCESS' ? 'success' : 'failure';
    }
```

DTO 放宽：

```ts
    // 支付宝不需要 openid，改为按渠道在 provider 内校验
    @ApiPropertyOptional({ example: 'o_xxx', description: '微信 openid；支付宝渠道忽略' })
    @IsOptional()
    @IsString()
    openid?: string;
```

同时给 `wechat-payment.service.ts` 补一条显式校验（原来是 DTO 挡着的）：

```ts
        if (!input.payerId) {
            throw new BadRequestException('openid is required for WeChat Pay');
        }
```

### 步骤 5：配置与环境变量

`.env.example` 追加（与 9 个 settings key 一一对应）：

```bash
# Alipay (admin settings 里的 alipay.* 优先，留空回退这里)
ALIPAY_APPID=
ALIPAY_PRIVATE_KEY=
ALIPAY_PUBLIC_KEY=
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
ALIPAY_SIGN_TYPE=RSA2
ALIPAY_SANDBOX=false
ALIPAY_NOTIFY_URL=
ALIPAY_RETURN_URL=
ALIPAY_MOCK=true
```

沙箱网关（`alipay.sandbox=true` 时由客户端内部切换，不需要改 `gateway`）：
`https://openapi-sandbox.dl.alipaydev.com/gateway.do`

## 7. 签名与验签：与微信的差异

| 维度 | 微信 Pay V3 | 支付宝 |
| --- | --- | --- |
| 签名对象 | 请求方法 + URL + 时间戳 + 随机串 + 报文**原始字节** | 参数按 key 字典序拼接的字符串（**不含** `sign`、`sign_type`，空值剔除） |
| 签名位置 | `Authorization` 头 | 参数里的 `sign` 字段 |
| 算法 | RSA-SHA256 | RSA2（SHA256withRSA）/ RSA（SHA1withRSA） |
| 回调格式 | JSON（resource 加密） | `application/x-www-form-urlencoded` |
| 回调应答 | 裸 JSON `{ code: "SUCCESS" }` | **纯文本 `success`** |
| 金额单位 | 分（整数） | 元（字符串，两位小数） |
| 交易号 | `transaction_id` | `trade_no` |
| 状态字段 | `trade_state === 'SUCCESS'` | `trade_status ∈ {TRADE_SUCCESS, TRADE_FINISHED}` |

## 8. 接口契约

```text
POST /api/orders/:id/pay
body: { channel: "ALIPAY", payMethod?: "alipay.trade.page.pay" | "alipay.trade.wap.pay" }
resp: { payUrl: "https://openapi.alipay.com/gateway.do?app_id=...&sign=...", outTradeNo: "BW..." }

POST /api/payment/alipay/callback        # 支付宝服务器调用，无需鉴权
resp: text/plain  success | failure
```

前端跳转：`window.location.href = payUrl`。支付完成后支付宝把浏览器跳回 `alipay.returnUrl`（同步通知，不可作为到账依据），到账以异步 `notify_url` 为准。

## 9. 测试计划

单测（`src/infra/alipay/*.spec.ts`、`src/modules/billing/payment/alipay-payment.service.spec.ts`）：

- 签名：生成的 `sign` 能用对应公钥验签；改一个参数后验签失败。
- 拼接：参数按字典序、空值被剔除、`sign` / `sign_type` 不参与。
- `RSA2` / `RSA` 两种算法都覆盖（用 `crypto.generateKeyPairSync` 造密钥对，参考 `wechat-pay-signature.util.spec.ts`）。
- provider：`mock=true` 返回模拟参数且不发起请求；`mock=false` 拼出含 `sign` 的 URL。
- 回调映射：`TRADE_SUCCESS` / `TRADE_FINISHED` → `SUCCESS`，`WAIT_BUYER_PAY` → 非 SUCCESS。
- 金额：`999` 分 → `'9.99'`；`100` 分 → `'1.00'`（注意补零）。
- 运行时配置：DB 覆盖优先、留空回退 env、env 缺失回退默认（对照 `wechat-runtime-config.service.spec.ts` 的 9 个用例）。

回归：`payment.service.spec.ts` 的幂等与订阅开通逻辑通过 `handleCallback` 复用，需补一条 `channel=ALIPAY` 的用例。

## 10. 上线与回滚

顺序：

1. 先上迁移（只加枚举值，对现有数据无影响）。
2. 上代码，此时 `alipay.mock` 仍为 `true` → 生产不会真调支付宝。
3. 后台填 `alipay.*` 凭证，在沙箱（`alipay.sandbox=true`）跑通一笔。
4. 关闭沙箱、把 `alipay.mock` 置 `false`，跑通一笔真实小额订单后放量。

回滚：

- 立即止血：把 `alipay.mock` 改回 `true`（30 秒缓存后生效，无需重启）。
- 代码回滚不受枚举值影响（`ALIPAY` 值存在但无人使用是安全的）；**不要**尝试删枚举值。

## 11. 风险与坑

1. **`trade_state` 硬编码**：`payment.service.ts:104` 判断 `!== 'SUCCESS'`。若不映射，支付宝的回调会被判为失败而反复重试 —— provider 必须把 `TRADE_SUCCESS` 归一成 `SUCCESS`。
2. **金额精度**：`Order.amount` 是分，支付宝要元。务必 `(amount / 100).toFixed(2)`，不要用除法后直接 `toString()`。
3. **`transactionId` 唯一索引**：用 `trade_no` 填充；空串要先 `trim() || null`（既有逻辑已处理，复用即可）。
4. **回调应答格式**：应答 `success` 才算成功，返回 JSON 或带引号支付宝都会重试。
5. **验签剔除空值**：`URLSearchParams` 解析后可能有空串参数，拼接前必须剔除，否则验签必失败。
6. **`updateMany` 并发保护**：既有幂等靠 `status != SUCCESS` 的条件更新，支付宝并发回调同样受益，不要改成先查后写。
7. **`Payment.prepayId` 语义**：支付宝没有 prepay_id，这里存收银台 URL（可追溯即可），字段不改名以免迁移。
8. **同步通知不可信**：`return_url` 只是浏览器跳转，可在地址栏伪造；到账只认异步通知。
9. **换渠道的残留风险（已部分缓解）**：`Payment.orderId` 唯一意味着「同一订单换渠道发起」会覆盖记录。已加 `assertChannelSwitchable`：记录为 `SUCCESS` 时拒绝换渠道/重复发起。但 `PENDING` 时仍允许覆盖 —— 若旧渠道的异步回调迟到（用户其实已付款），回调会因 `channel` 不匹配而查不到记录，只能靠日志排查。彻底解决需要改基数为 `@@unique([orderId, channel])`，见 §12。

## 12. 待确认问题

1. **支付方式范围**：本期只做 `page.pay`（PC）+ `wap.pay`（手机浏览器），还是也要 App 支付？后者需要移动端接入 SDK。
2. **是否引入 `alipay-sdk`**：本方案按「自实现 RSA2」编写；若团队倾向用官方 SDK，§5 的 `infra/alipay` 会简化为薄封装。
3. **退款**：本期不做。若要一起做，需要新增 `POST /orders/:id/refund` 与 `alipay.trade.refund`，并处理 `PaymentStatus.REFUNDED` 与订阅回收。
4. **多应用/多商户**：当前 `alipay.*` 是全局单份配置，与微信一致。若将来要按租户区分收款账户，需要把配置下沉到租户维度（改动较大）。
5. **`Order → Payment` 基数**：现在保持 1:1（`Payment.orderId` 唯一），并用 `assertChannelSwitchable` 拦住「已支付后换渠道」。如果后续仍担心 `PENDING` 阶段的迟到回调，就改成 `@@unique([orderId, channel])`（每渠道一条），涉及一次迁移 + `payment.service.ts` 的 upsert 键调整 + 回调查询改为按渠道精确命中。

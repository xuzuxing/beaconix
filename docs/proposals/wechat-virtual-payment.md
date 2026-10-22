# 小程序虚拟支付接入方案（uni-app / 微信小程序）

更新：2026-10-21。**后端已实现**（nest-beacon：`PaymentChannel.WECHAT_VIRTUAL`、`PaymentAttempt`、发货推送 + 兜底查单 + 退款，CI 五道门通过），前端尚未接入，本文是给小程序端的对接方案与待改清单。

依据：

- 后端源码：`src/infra/wechat/virtual-pay/*`、`src/modules/billing/payment/{wechat-virtual-payment.service,payment.controller,dto/create-payment.dto}.ts`、`src/modules/billing/order/order.controller.ts`、`src/modules/auth/wechat/wechat-auth.controller.ts`
- 前端现状：`src/api/billing.ts`（`billingApi.payOrder` 目前只按 JSAPI 参数建模）、`src/api/core/instance.ts`（alova 实例 + `unwrapApiData`）
- 官方文档：[虚拟支付：个人](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person.html)、[wx.requestVirtualPayment](https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html)

## 1. 结论

小程序内售卖订阅/功能解锁属于虚拟商品，**只能走虚拟支付**（`wx.requestVirtualPayment`），不能用 `uni.requestPayment` / JSAPI，也不能引导用户到公众号或 H5 支付。

分工：

| 环节 | 谁做 |
| --- | --- |
| 下单签名（`signData` / `paySig` / `signature`） | 后端（`POST /api/orders/:id/pay`，`channel = WECHAT_VIRTUAL`） |
| 拉起支付 | 小程序（`wx.requestVirtualPayment`） |
| 发货判定（验签 + 查单 + 幂等 + 激活订阅） | 后端（平台推送 + 5 分钟兜底查单，前端不参与） |
| 权益展示 / 订单状态刷新 | 小程序（轮询 `GET /api/orders/:id`） |

三条必须记住的约束：

1. **前端 `success` 回调不能作为发货依据** —— 微信官方明确它可能丢失（用户异常退出）。一律以后端订单 `status === 'PAID'` 为准。
2. **`code` 每次都要现取**：`wx.login()` 的 code 只能用一次，且服务端要靠它换 `session_key` 算用户态签名；`-15007` 就是 session_key 过期。
3. **不做自动续费**：会员订阅能力要求企业主体、小程序发布 ≥ 90 天、近 30 天 DAU ≥ 1000、邮件申请开通，且仅安卓/鸿蒙可用（第二笔起费率 10%）。当前方案是「时长卡直购」，到期用户手动续买。

## 2. 前置条件

### 2.1 MP 后台（mp.weixin.qq.com）

- 【虚拟支付】已开通，记下 **OfferID** 与 **现网 AppKey**（基本配置页）
- 【道具管理】建好并**发布到现网**（发布后约 10 分钟生效）。本项目 6 个道具：

  | 道具 ID | 名称 | 单价（分） | 档位 |
  | --- | --- | --- | --- |
  | `beacon_pro_month` | 专业版月卡 | 2900 | PRO / MONTHLY |
  | `beacon_pro_quarter` | 专业版季卡 | 7900 | PRO / QUARTERLY |
  | `beacon_pro_year` | 专业版年卡 | 29000 | PRO / YEARLY |
  | `beacon_team_month` | 团队版月卡 | 9900 | TEAM / MONTHLY |
  | `beacon_team_quarter` | 团队版季卡 | 26900 | TEAM / QUARTERLY |
  | `beacon_team_year` | 团队版年卡 | 99000 | TEAM / YEARLY |

  道具图在 nest-beacon 的 `public/wechat-goods/`（200×200 PNG，可用 `pnpm assets:wechat-goods` 重新生成），上传到公网可访问地址后填 `item_url`。

- 【开发管理 → 消息推送】URL 填 `https://<后端域名>/api/payment/wechat-virtual/notify`，**数据格式选 JSON**（本项目推送解析与应答都以 JSON 为主，XML 仅作兜底），同时把 Token / EncodingAESKey 告知后端配置
- iOS 支付还需在【账号设置 → 基本信息】配置**小程序简称**（Apple 要求展示 display name）
- 个人主体月支付限额 **10 万元**

### 2.2 后端配置

管理端【系统设置 → wechat】填：`offerId`、`appKey`、`env=0`、`pushToken`、`pushAesKey`，并**关闭 `mock`**。管理端套餐编辑里给每个档位填 `wechatProductId`（与上表一致，价格必须等于档位价，否则下单报 `-15013`）。

### 2.3 前端

- `manifest.json` 的 appid 必须是已开通虚拟支付的那个小程序
- 基础库 ≥ **2.19.2**；iOS 端要求微信客户端 ≥ **8.0.68**
- 建单接口要求 **ADMIN / OWNER** 角色（普通成员调用会 403），前端需按角色隐藏/提示

## 3. 端到端流程

```
小程序                          Beacon 后端                        微信
  │ wx.login() → code              │                                  │
  │ POST /organizations/:orgId/orders                                 │
  │───────────────────────────────>│ 建单（PENDING，30 分钟过期）      │
  │<────────────── order.id ───────│                                  │
  │ wx.login() → 新 code            │                                  │
  │ POST /orders/:id/pay           │                                  │
  │  { channel: WECHAT_VIRTUAL, code }                                │
  │───────────────────────────────>│ code2Session 取 session_key      │
  │                                │ 生成 outTradeNo + signData        │
  │                                │ paySig(appKey) / signature(sk)    │
  │<──────────── payData ──────────│ 落库 PaymentAttempt(PENDING)      │
  │ wx.requestVirtualPayment({signData, mode, paySig, signature})     │
  │──────────────────────────────────────────────────────────────────>│
  │                                │<──── 发货推送（后端自动处理）─────│
  │ 轮询 GET /orders/:id           │ 查单反查 → 幂等结算 → 激活订阅     │
  │───────────────────────────────>│                                  │
  │<───────── status: PAID ────────│                                  │
```

支付成功后前端只做两件事：把订单展示成「已支付」、刷新订阅/额度缓存。

## 4. 接口清单

所有路径带全局前缀 `/api`；除标注 `PUBLIC` 外都需要 `Authorization: Bearer <accessToken>`。响应统一被 `TransformInterceptor` 包成 `{ data, meta }`（用 `unwrapApiData` 解包，与现有 `src/api/billing.ts` 一致），下文示例省略 `meta`。

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/api/auth/wechat/miniprogram/login` | PUBLIC（5 次/分钟） | `code` 换 token，新用户自动建账号 + 初始组织 |
| `GET` | `/api/organizations` | 登录 | 取当前用户的 `orgId` |
| `GET` | `/api/plans` | PUBLIC | 套餐目录，`terms` 只含启用档 |
| `POST` | `/api/organizations/:orgId/orders` | **ADMIN** | 建单，body `{ planId, cycle }` |
| `POST` | `/api/orders/:id/pay` | 登录 | 取 payData（本次新增 `channel` / `code`） |
| `GET` | `/api/orders/:id` | 登录 | 轮询订单状态 |
| `POST` | `/api/orders/:id/cancel` | 登录 | 取消 PENDING 订单 |

### 4.1 小程序登录

```http
POST /api/auth/wechat/miniprogram/login
{ "code": "wx.login 的 code", "nickname": "可选", "avatarUrl": "可选" }
```

```json
{
  "data": {
    "accessToken": "eyJhbGciOi...",
    "refreshToken": "a1b2c3...",
    "user": { "id": "clxuser", "name": "微信用户_abcd", "globalRole": "USER" },
    "isNewUser": false
  }
}
```

### 4.2 建单

```http
POST /api/organizations/clxorg0001/orders
Authorization: Bearer <accessToken>
{ "planId": "clxplan0001", "cycle": "MONTHLY" }
```

```json
{
  "data": {
    "id": "clxorder0001",
    "orderNo": "BWMB3KXABC123",
    "organizationId": "clxorg0001",
    "planId": "clxplan0001",
    "amount": 2900,
    "currency": "CNY",
    "durationDays": 30,
    "cycle": "MONTHLY",
    "termId": "clxplanterm0001",
    "status": "PENDING",
    "expiresAt": "2026-10-21T12:30:00.000Z"
  }
}
```

`amount` 单位是**分**；金额与天数由后端按档位快照，客户端不能传价格。

### 4.3 取支付参数（本次新增）

```http
POST /api/orders/clxorder0001/pay
Authorization: Bearer <accessToken>
{ "channel": "WECHAT_VIRTUAL", "code": "wx.login 的新 code" }
```

```json
{
  "data": {
    "channel": "WECHAT_VIRTUAL",
    "outTradeNo": "V1A2B3C4D5E6F7G8",
    "mode": "short_series_goods",
    "signData": "{\"offerId\":\"1450000000\",\"buyQuantity\":1,\"env\":0,\"currencyType\":\"CNY\",\"productId\":\"beacon_pro_month\",\"goodsPrice\":2900,\"outTradeNo\":\"V1A2B3C4D5E6F7G8\",\"attach\":\"BWMB3KXABC123\"}",
    "paySig": "…64 位 hex…",
    "signature": "…64 位 hex…"
  }
}
```

调用要点：

- `signData` 是**字符串**，原样传给微信。`JSON.parse` 后再 `JSON.stringify` 会改变键顺序，签名立刻失效（`-15005` / `-15006`）。
- `code` 必须当场 `wx.login()` 取，不要复用登录时的 code。
- `openid` 由后端从「当前用户绑定的微信身份」反查，前端不用传。
- 常见业务错误（后端响应里带 `code`）：

  | code | 含义 | 前端处理 |
  | --- | --- | --- |
  | `MINIPROGRAM_CODE_REQUIRED` | 没传 code | 重新 `wx.login()` |
  | `MINIPROGRAM_NOT_BOUND` | 该账号没绑微信小程序身份 | 引导先走小程序登录 |
  | `MINIPROGRAM_OPENID_MISMATCH` | code 属于另一个微信用户 | 重新登录 |
  | `VIRTUAL_PRODUCT_NOT_MAPPED` | 该档位没映射道具 ID | 提示「该套餐暂不可购买」，报运营 |
  | `VIRTUAL_PRODUCT_PRICE_MISMATCH` | 档位价与订单金额不一致 | 同上，报运营 |
  | `Order already paid` / `Order has expired` | 已支付 / 已过期 | 刷新订单状态 |

## 5. 拉起支付

### 5.1 封装（新增 `src/composables/useVirtualPayment.ts`）

```ts
/* eslint-disable ts/no-namespace */
// #ifdef MP-WEIXIN
/** 微信客户端未内置该 API 的类型，这里补一份最小声明 */
declare namespace WechatMiniprogram {
  interface RequestVirtualPaymentOption {
    /** 服务端签好的 JSON 字符串，原样传 */
    signData: string
    /** 固定 short_series_goods（道具直购） */
    mode: string
    paySig: string
    signature: string
    success?: (res: { errMsg?: string }) => void
    fail?: (err: { errMsg?: string, errCode?: number }) => void
  }
}
// #endif

export interface VirtualPayParams {
  channel: 'WECHAT_VIRTUAL'
  outTradeNo: string
  mode: string
  signData: string
  paySig: string
  signature: string
}

function compareVersion(a: string, b: string) {
  const av = a.split('.').map(Number)
  const bv = b.split('.').map(Number)
  const len = Math.max(av.length, bv.length)
  for (let i = 0; i < len; i += 1) {
    const x = av[i] ?? 0
    const y = bv[i] ?? 0
    if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}

/** 基础库 / 微信版本是否支持虚拟支付 */
export function canUseVirtualPayment() {
  // #ifdef MP-WEIXIN
  const sdk = wx.getSystemInfoSync()
  if (!wx.canIUse('requestVirtualPayment')) {
    return { ok: false as const, reason: '当前微信版本过低，请升级微信后重试' }
  }
  // iOS 端要求微信 ≥ 8.0.68
  if (sdk.platform === 'ios' && compareVersion(sdk.version ?? '0', '8.0.68') < 0) {
    return { ok: false as const, reason: 'iOS 需微信 8.0.68 及以上版本，请升级微信' }
  }
  return { ok: true as const, reason: '' }
  // #endif
  // #ifndef MP-WEIXIN
  return { ok: false as const, reason: '虚拟支付仅支持微信小程序' }
  // #endif
}

/**
 * 拉起虚拟支付。
 *
 * `resolve` 只代表「微信侧支付流程走完了」，**不代表已发货**；
 * 发货以后端订单状态为准，调用方必须继续轮询。
 */
export function requestVirtualPayment(payData: VirtualPayParams) {
  return new Promise<void>((resolve, reject) => {
    // #ifdef MP-WEIXIN
    wx.requestVirtualPayment({
      signData: payData.signData,
      mode: payData.mode,
      paySig: payData.paySig,
      signature: payData.signature,
      success: () => resolve(),
      fail: err => reject(err),
    })
    // #endif
    // #ifndef MP-WEIXIN
    reject(new Error('虚拟支付仅支持微信小程序'))
    // #endif
  })
}
```

### 5.2 微信侧错误码对照

| errCode | 含义 | 前端处理 |
| --- | --- | --- |
| `1001` | 参数错误 | 检查 `payData` 是否原样传入（最常见：`signData` 被二次序列化） |
| `-1` | 支付失败 | 提示重试，订单保持 PENDING |
| `-2` | 用户取消 | 静默处理，订单保留可再次支付 |
| `-4` | 风控拦截 | 提示稍后再试 |
| `-15002` | `outTradeNo` 重复使用 | 重新走「建单 → 取 payData」（后端每次生成新单号） |
| `-15005` / `-15006` | 用户态签名 / 支付签名错误 | 后端配置或时钟问题，直接报障，不要重试 |
| `-15007` | `session_key` 过期 | 重新 `wx.login()` 拿新 code，再次调 `pay` 接口 |
| `-15010` | 道具未发布 | 后台发布道具并等约 10 分钟 |
| `-15011` | `env` 填了沙箱 | 后端 `env` 必须是 `0` |
| `-15013` | 道具价格与 `goodsPrice` 不一致 | 运营同步 MP 后台道具价与档位价 |
| `-15014` | 道具发布未生效 | 等约 10 分钟再试 |
| `-15017` / `-15019` | 商户受限 | 提示联系客服，运营去商户平台处理 |

## 6. 页面级完整流程

```ts
async function buy(planId: string, cycle: PlanCycle) {
  // 1. 前置：角色 + 版本
  if (!isAdminOrOwner()) {
    uni.showToast({ title: '仅管理员可购买，请联系组织管理员', icon: 'none' })
    return
  }
  const support = canUseVirtualPayment()
  if (!support.ok) {
    uni.showModal({ title: '无法支付', content: support.reason, showCancel: false })
    return
  }

  // 2. 建单（后端每次都给新 outTradeNo，旧单 30 分钟后自动过期）
  const order = await billingApi.createOrder(orgId, { planId, cycle })

  // 3. 每次支付前重新取 code
  const code = await wxLoginCode()

  // 4. 取签名参数
  const payData = await billingApi.payOrderVirtual(order.id, {
    channel: 'WECHAT_VIRTUAL',
    code,
  })

  // 5. 拉起支付（-2 取消静默，-15007 回第 3 步重试一次）
  try {
    await requestVirtualPayment(payData)
  }
  catch (error) {
    handleVirtualPayError(error) // 见 §5.2
    return
  }

  // 6. 轮询确认（关键：不信 success 回调）
  uni.showLoading({ title: '确认支付结果…', mask: true })
  const paid = await waitForOrderPaid(order.id)
  uni.hideLoading()

  if (paid) {
    uni.showToast({ title: '购买成功', icon: 'success' })
    await refreshSubscription() // 订阅 / 额度 / 套餐缓存
  }
  else {
    uni.showModal({
      title: '支付结果确认中',
      content: '支付可能仍在处理中，请稍后在订单页查看，无需重复支付。',
      showCancel: false,
    })
  }
}

/** 轮询订单：5 次 × 1.5s，之后交给订单页（后端有 5 分钟兜底查单） */
async function waitForOrderPaid(orderId: string) {
  for (let i = 0; i < 5; i += 1) {
    await sleep(1500)
    const order = await billingApi.getOrder(orderId)
    if (order.status === 'PAID') {
      return true
    }
    if (order.status === 'CANCELLED') {
      return false
    }
  }
  return false
}
```

`wxLoginCode()` 用 Promise 包一层 `wx.login`（`code` 5 分钟内有效、只能用一次）。

## 7. 前端待改清单

| 文件 | 改动 |
| --- | --- |
| `src/api/billing.ts` | 新增 `VirtualPayParams` 类型；`CreatePaymentDto` 加 `channel?: 'WECHAT' \| 'WECHAT_VIRTUAL'` 与 `code?: string`；新增 `billingApi.payOrderVirtual(orderId, { code })`（返回 `VirtualPayParams`），保留现有 `payOrder` 给 H5/PC 的 JSAPI 用；`billingErrorText` 补 §4.3 的业务错误码 |
| `src/api/auth.ts` | 若还没有小程序登录封装，新增 `miniprogramLogin({ code, nickname?, avatarUrl? })` |
| `src/composables/useVirtualPayment.ts` | 新增（§5.1） |
| 购买页（`src/pages/**`） | `#ifdef MP-WEIXIN` 下切到虚拟支付；按钮文案区分「立即购买 / 继续支付」 |
| 订单页 | 展示 `PENDING`（可继续支付 / 取消）与 `PAID`；`expiresAt` 到期提示重新下单 |
| `src/store/**` | 支付成功后失效订阅 / 额度缓存 |

## 8. 联调与验收

1. **必须真机**：微信开发者工具不支持虚拟支付，只会报错；用「真机调试」或体验版。
2. 道具已发布并且**过了 10 分钟**；管理端 `mock` 已关。
3. 小额真单跑通：支付 → 后端日志出现发货推送 → 订单 `PAID` → 订阅生效 → MP 后台【交易订单】金额一致。
4. 兜底验证：支付成功后立刻杀掉小程序再进，订单仍应是 `PAID`（后端 5 分钟兜底查单生效）。
5. 异常路径：用户取消（订单仍 PENDING）、重复点击支付（只激活一次）、过期订单（提示重新下单）。
6. iOS 单独验一遍：微信 ≥ 8.0.68 且小程序简称已配置。

## 9. 常见坑

- **`signData` 二次序列化**：`JSON.stringify(JSON.parse(signData))` 键顺序一乱，签名就废了（`-15005`/`-15006`）。
- **复用了旧的 `code`**：code 一次性、5 分钟过期；每次支付都要新 `wx.login()`。
- **在 `success` 回调里解锁权益**：会丢单。只认后端订单状态。
- **`uni.requestPayment`**：不支持虚拟支付，必须 `wx.requestVirtualPayment`。
- **金额单位**：后端与微信都是「分」，前端展示要 `/100`。
- **开发者工具**：预览/模拟器里调不起来，别在工具里判断「接口坏了」。
- **推送数据格式**：MP 后台【消息推送 → 数据格式】必须选 **JSON**。后端以 JSON 解析并回 `{"ErrCode":0,"ErrMsg":"success"}`；若后台仍是 XML，后端会自动降级按 XML 处理并回 XML（不会丢单，但与项目其他接口风格不一致）。
- **重复建单**：用户反复点会生成多个 PENDING 订单（后端每次都给新 `outTradeNo`，不影响一致性），前端可禁用按钮 + 复用未过期订单。

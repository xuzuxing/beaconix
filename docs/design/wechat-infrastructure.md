# 微信基础设施模块（infra/wechat）规划文档

> 文档类型：设计记录。保留原方案、代码示例和阶段决策；当前行为以源码与 Swagger 为准。

## 1. 背景与目标

仓库里已有三处微信相关实现，但彼此独立、重复造轮子：

| 位置                                                      | 能力                     | 现状问题                                                                  |
| --------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `src/modules/notifier/senders/wechat-subscribe.sender.ts` | 小程序订阅消息           | `access_token` 用进程内 `Map` 缓存：多实例不一致、重启丢失；HTTP 调用自建 |
| `src/modules/notifier/senders/wecom.sender.ts`            | 企业微信群机器人 webhook | 仅 webhook，没有企微应用 API 能力                                         |
| `src/modules/billing/payment/wechat-payment.service.ts`   | 微信支付                 | 纯 mock，真实 API 未实现                                                  |
| `src/modules/notifier/channel-config.ts`                  | 渠道配置解析             | `appId/appSecret` 明文存在通知渠道 JSON 里                                |

**目标**：在 `src/infra/wechat/` 建立统一微信能力底座，按产品划分为四个子包
（支付 / 小程序 / 公众号 / 企业微信），把 `access_token` 管理、签名验签、HTTP 调用、
错误归一化、日志脱敏收敛到一处；业务模块（`billing`、`notifier`）改为复用底层 client。

**边界**：`infra/wechat` 只封装「微信 API 怎么调」，不承载业务编排
（谁发给谁、模板字段映射、订单生命周期、告警文案仍然留在 `modules/` 层）。

## 2. 模块定位

```
modules/billing   ──┐
modules/notifier  ──┼──▶ infra/wechat（SDK 底座）
后续 auth/小程序登录 ─┘        ├── pay            微信支付 V3
                              ├── miniprogram    小程序
                              ├── official-account 公众号/服务号
                              └── work           企业微信
```

与现有 `src/infra/*` 保持一致：`@Global()` 模块 + 单例 service，配置走
`src/config/*.config.ts`（`registerAs`），HTTP 用原生 `fetch`（仓库没有 axios）。

## 3. 目录结构

```
src/infra/wechat/
  wechat.module.ts                @Global() 模块，聚合导出各子包 service
  wechat.types.ts                 公共类型与错误类
  index.ts                        统一出口
  clients/
    wechat-http.client.ts         原生 fetch 封装：超时、重试、JSON、脱敏日志
    wechat-token.service.ts       access_token 统一管理（公众号/小程序/企微）
    wechat-signature.util.ts      SHA1 签名、AES-256-CBC、SHA256-RSA 工具函数
  pay/                            子包 1：微信支付 V3
    wechat-pay.client.ts
    wechat-pay.types.ts
    wechat-pay-signature.util.ts
    wechat-pay-callback.service.ts
    index.ts
  miniprogram/                    子包 2：小程序
    miniprogram.client.ts
    miniprogram.types.ts
    index.ts
  official-account/               子包 3：公众号/服务号
    official-account.client.ts
    official-account.types.ts
    official-account-crypto.util.ts
    index.ts
  work/                           子包 4：企业微信
    work.client.ts
    work.types.ts
    index.ts
```

每个子包只依赖 `clients/` 公共底座，子包之间不互相依赖。

## 4. 公共底座设计

### 4.1 `WechatHttpClient`

- 三个默认 baseURL：
    - 公众号/小程序：`https://api.weixin.qq.com`
    - 支付 V3：`https://api.mch.weixin.qq.com`
    - 企业微信：`https://qyapi.weixin.qq.com`
- 能力：`getJson` / `postJson` / `request`，`AbortSignal.timeout` 超时，网络错误有限重试
  （仅幂等 GET 与明确的 5xx/网络抖动，最多 2 次，指数退避）。
- 错误归一化：统一抛 `WechatApiError`，字段 `{ provider, endpoint, httpStatus, errcode, errmsg }`，
  便于上层判断（如 40001/42001 刷新 token、45009 限流退避）。
- 日志脱敏：`appSecret`、`access_token`、`apiv3_key`、私钥永不进日志；
  token 只打印前 8 位；沿用 `.env.example` 的 `LOGGER_SENSITIVE_FIELDS` 作为兜底。

### 4.2 `WechatTokenService`

- 统一管理三类 token，key 约定：
    - `wechat:token:mp:<appId>`（公众号/小程序 `client_credential`）
    - `wechat:token:work:<corpId>:<agentId?>`（企微）
- 缓存：复用 `MultiLevelCacheService`（L1 `node-cache` + L2 Redis），
  提前 300 秒过期（沿用现有 sender 的经验），避免多实例重复拉取。
- 单飞（single-flight）：进程内用 `Map<string, Promise<string>>` 合并并发请求；
  跨实例靠 L2 缓存。
- 失效重取：调用方捕获 40001/42001 后调 `invalidate()` 并重试一次。

### 4.3 `wechat-signature.util.ts`

- 公众号服务器配置：`checkSignature(token, timestamp, nonce, signature)`（SHA1 字典序拼接）。
- 公众号消息加解密：`EncodingAESKey` → AES-256-CBC，PKCS#7 padding，去掉 16 字节随机前缀和 `appId` 后缀。
- 仅供 `official-account/` 与后续回调使用；支付 V3 的 RSA 签名单独放 `pay/` 里。

## 5. 子包设计

### 5.1 `pay/` — 微信支付 V3

| 能力           | 方法                                                                |
| -------------- | ------------------------------------------------------------------- |
| 下单（JSAPI）  | `createJsapiOrder(input)` → 返回 `prepay_id` 与前端支付参数         |
| 下单（Native） | `createNativeOrder(input)` → 返回 `code_url`                        |
| 查单 / 关单    | `queryOrder(outTradeNo)` / `closeOrder(outTradeNo)`                 |
| 退款 / 查退款  | `createRefund(input)` / `queryRefund(outRefundNo)`                  |
| 回调处理       | `parseCallback(headers, rawBody)`：验签 + AES-256-GCM 解密 + 归一化 |
| 平台证书       | `refreshPlatformCertificates()`（定时任务触发）                     |

- 认证材料：`mchId`、`appId`、`serialNo`、商户私钥（PEM）、`apiV3Key`。
- 回调安全：必须验 `Wechatpay-Signature` / `Wechatpay-Timestamp` / `Wechatpay-Nonce`，
  时间戳偏差超 5 分钟拒绝；处理逻辑要求幂等（`out_trade_no` 唯一约束）。

### 5.2 `miniprogram/` — 小程序

| 能力            | 方法                                                                          |
| --------------- | ----------------------------------------------------------------------------- |
| 登录换取 openid | `code2Session(code)` → `{ openid, unionid, sessionKey }`                      |
| 订阅消息        | `sendSubscribeMessage({ templateId, openIds, page, data, miniprogramState })` |
| 获取手机号      | `getPhoneNumber(code)`（可选）                                                |

订阅消息的模板字段映射、`thing` 字段 20 字符截断、失败汇总仍留在
`notifier/senders/wechat-subscribe.sender.ts`（业务语义不下沉）。

### 5.3 `official-account/` — 公众号/服务号（已实现）

| 能力       | 方法                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 网页授权   | `buildOAuthUrl({ redirectUri, scope, state })` / `exchangeCodeForToken({ code })` / `refreshOAuthToken({ refreshToken })` / `getUserInfo({ accessToken, openid })`               |
| 模板消息   | `sendTemplateMessage({ openId, templateId, data, url, miniprogram })`                                                                                                            |
| 客服消息   | `sendCustomTextMessage({ openId, content })`                                                                                                                                     |
| 服务器回调 | `verifyServerSignature(...)`（GET 接入校验）、`parseServerMessage({ encrypted, msgSignature, timestamp, nonce })`（验签 + 解密）、`buildEncryptedReply(message)`（安全模式应答） |

实现说明：

- 签名/加解密**复用** `clients/wechat-signature.util.ts`，没有单独建
  `official-account-crypto.util.ts`；为此在该 util 里补了 4 段式
  `buildMsgSignature` / `checkMsgSignature`（`msg_signature` 是
  `sha1(sort([token, timestamp, nonce, encrypt]))`，与 GET 接入的 3 段式签名不同）。
- 网页授权 token 与 `client_credential` 全局 token 是**两套**：前者由调用方保存，
  后者走 `WechatTokenService`（只有模板消息/客服消息需要）。
- `appId/appSecret/token/aesKey` 默认取 `WECHAT_OA_*` 配置，方法级可覆盖（多公众号）。
- 当前没有业务模块依赖它，属于纯 infra 能力，等接入网页授权或公众号通知时直接用。

### 5.4 `work/` — 企业微信（已实现）

| 能力       | 方法                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| 应用 token | 复用 `WechatTokenService.getWorkAccessToken()`（`corpId + corpSecret`）                                     |
| 应用消息   | `sendAppMessage({ content, toUser/toParty/toTag, agentId?, safe? })`，支持 `text` / `markdown` / `textcard` |
| 通讯录     | `getDepartmentList()` / `getUser({ userId })` / `listUsersByDepartment({ departmentId, fetchChild })`       |

实现说明：

- 发送目标支持字符串或数组，数组会按企微规范用 `|` 拼接；`@all` 直接透传。
- `agentId` 默认取 `WECHAT_WORK_AGENTID`，方法级可覆盖；非正整数直接报配置错误。
- 返回体归一化：`msgid` → `msgId`，`invaliduser/invalidparty/invalidtag` 拆成数组，
  便于上层判断「哪些人没收到」。
- 所有请求带 `platform: 'work'`，错误信息标记为 `[work]` 而不是默认的 `[mp]`。

现有 `WecomSender` 是**群机器人 webhook**（`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=`），
不需要 token，因此**不迁入 infra**，保持现状；`work/` 面向企微应用/通讯录场景。

> `WecomAppSender`（把应用消息接成通知渠道）本轮**未做**：它需要给
> `NotificationChannelType` 新增枚举值（`WECOM_APP`），属于 Prisma schema 变更 +
> migration + 渠道配置校验的联动改动，等确认要上线这个渠道再做。

## 6. 配置设计

新增 `src/config/wechat.config.ts`（`registerAs('wechat')`），并在 `src/config/index.ts`
与 `app.module.ts` 的 `load` 数组注册。配置采用「默认实例 + 可选多实例」：

```ts
export interface WechatConfig {
    pay: {
        mchId: string;
        appId: string;
        serialNo: string;
        privateKey: string;      // PEM 内容或文件路径
        apiV3Key: string;
        mock: boolean;           // 兼容现有 WECHAT_PAY_MOCK
    };
    miniprogram: { appId: string; appSecret: string };
    officialAccount: { appId: string; appSecret: string; token: string; aesKey: string };
    work: { corpId: string; corpSecret: string; agentId: string };
}
```

环境变量（同步补充到 `.env.example`）：

| 子包      | 变量                                                                                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 支付      | `WECHAT_PAY_MCHID`、`WECHAT_PAY_APPID`、`WECHAT_PAY_SERIAL_NO`、`WECHAT_PAY_PRIVATE_KEY`、`WECHAT_PAY_APIV3_KEY`、`WECHAT_PAY_NOTIFY_URL`、`WECHAT_PAY_PUBLIC_KEY`、`WECHAT_PAY_PUBLIC_KEY_ID`、`WECHAT_PAY_MOCK` |
| 小程序    | `WECHAT_MINI_APPID`、`WECHAT_MINI_APPSECRET`                                                                                                                                                                      |
| 公众号    | `WECHAT_OA_APPID`、`WECHAT_OA_APPSECRET`、`WECHAT_OA_TOKEN`、`WECHAT_OA_AES_KEY`                                                                                                                                  |
| 企微      | `WECHAT_WORK_CORPID`、`WECHAT_WORK_CORPSECRET`、`WECHAT_WORK_AGENTID`                                                                                                                                             |
| 通用 HTTP | `WECHAT_HTTP_TIMEOUT_MS`（默认 8000）、`WECHAT_HTTP_MAX_RETRIES`（默认 2）                                                                                                                                        |

校验策略：用 `optionalEnv` 默认空串，**只有真正调用某个子包时才校验必填项**，
避免未使用微信功能的环境启动失败。

多应用场景（多个小程序/公众号）：子包方法都接受显式 `appId/appSecret` 参数，
不传则取配置默认实例；通知渠道自带的 `appId/appSecret` 继续生效（兼容现状）。

## 7. 与现有模块的集成改造点

### 7.1 `billing`（已实现）

- `WechatPaymentService` 注入 `WechatPayClient`：
    - `createPayment()` → `payClient.createJsapiTransaction()` + `buildJsapiPayParams()`
    - `verifyCallback()` → `payClient.parseNotification()`（验签 + 解密）
    - `WECHAT_PAY_MOCK !== 'false'` 时走 mock 分支，本地开发不受影响。
- `PaymentProvider.verifyCallback(rawBody, signature, headers?)` 增加**可选** `headers` 参数，
  用于取 WeChat Pay V3 的 `Wechatpay-Timestamp` / `-Nonce` / `-Serial`；现有实现与测试不受影响。
- 回调链路修正：`main.ts` 开启 `rawBody: true`，`PaymentController` 用
  `req.rawBody` 代替 `JSON.stringify(body)`——验签必须覆盖微信签名的原始字节。

### 7.2 `notifier`（已实现）

- `WechatSubscribeSender`：
    - 删除进程内 `Map` token 缓存与 `40001/42001` 处理，改用 `MiniprogramClient`；
    - `MiniprogramClient` 内部走 `WechatTokenService`（共享缓存 + 单飞），
      并在 token 失效时 `invalidate` 后自动重试一次；
    - 业务语义仍留在 sender：模板字段映射、20 字符截断、多人发送、失败汇总。
- `WecomSender`：保持 webhook 实现不变。
- 可选新增 `WecomAppSender`（走 `WorkClient.sendAppMessage`），沿用 `NotificationChannelSender` 接口。

### 7.3 安全整改（可选项）

`NotificationChannel.config` 里的 `appSecret` 目前明文入库。建议后续：
优先使用全局 `WECHAT_MINI_*` 配置，渠道 config 只存 `openIds/templateId`；
或对敏感字段做加密存储。

## 8. 分阶段实施

| 阶段      | 内容                                                                                   | 交付物                       |
| --------- | -------------------------------------------------------------------------------------- | ---------------------------- |
| P0 底座   | 模块骨架、`WechatHttpClient`、`WechatTokenService`、签名工具、`wechat.config.ts`、单测 | 可运行但未接业务             |
| P1 支付   | `pay/` 子包 + `billing` 接入 + mock 保留                                               | 真实微信支付可下单/回调      |
| P2 小程序 | `miniprogram/` 子包 + `notifier` 接入                                                  | 订阅消息统一走 infra token   |
| P3 公众号 | `official-account/` 子包                                                               | 网页授权、模板消息、回调验签 |
| P4 企微   | `work/` 子包（可选 `WecomAppSender`）                                                  | 企微应用消息/通讯录          |

## 9. 测试计划

- 单测：
    - `WechatTokenService`：缓存命中、提前过期、单飞合并、40001 失效重取；
    - `wechat-signature.util`：`checkSignature` 固定向量；
    - `WechatHttpClient`：超时、错误归一化、重试边界、日志脱敏；
    - `pay`：RSA 签名固定向量、回调验签/解密（用官方示例报文）；
- 集成：本地 mock 微信 API（http server）跑通下单、订阅消息、企微应用消息；
- 手工：真机小程序订阅消息、微信支付沙箱或 1 分钱真实单。

## 10. 风险与限制

| 风险                      | 影响                  | 缓解                                                 |
| ------------------------- | --------------------- | ---------------------------------------------------- |
| 缺少真实商户号/小程序账号 | P1/P2 无法端到端联调  | mock client + 本地 mock server 先行，保留 mock 开关  |
| 支付平台证书轮换          | 验签失败              | `refreshPlatformCertificates()` + 定时任务；失败告警 |
| access_token 调用频率限制 | 触发限流              | 多级缓存 + 单飞 + 提前刷新                           |
| 多实例 L1 不一致          | 各实例 token 短暂不同 | token 有效期 2h，提前 300s 刷新，可接受              |
| 渠道 config 明文密钥      | 泄露风险              | 优先用全局配置，后续加密存储                         |
| Node/SCF 环境差异         | 私钥文件读取失败      | 支持 PEM 内容直接配置，不强制文件路径                |

## 11. 验收标准

1. `pnpm type-check`、`pnpm lint`、`pnpm test` 全绿。
2. `infra/wechat` 各子包可独立注入使用，模块为 `@Global()`，业务模块无需重复 import。
3. `WechatTokenService` 的 token 在多实例间共享（Redis 可查 `wechat:token:*`）。
4. `billing` 的 `WECHAT_PAY_MOCK=true` 行为与现状一致；`false` 时走真实 V3 API。
5. `notifier` 的微信订阅消息发送路径不再持有自建 token 缓存。
6. 日志中不出现 `appSecret`、`access_token` 全量、`apiV3Key`、私钥内容。

## 12. 实施进度

### P0 底座（已完成）

| 文件                                                | 说明                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/infra/wechat/wechat.types.ts`                  | `WechatApiError`（`isTokenExpired` / `isRateLimited`）、`WechatConfigurationError`                              |
| `src/infra/wechat/clients/wechat-http.client.ts`    | fetch 封装：baseURL/绝对 URL、超时、GET 重试、微信错误归一化、`redactUrl`/`redactSecrets`                       |
| `src/infra/wechat/clients/wechat-token.service.ts`  | `getAccessToken`（小程序/公众号）、`getWorkAccessToken`（企微）、`invalidate`；多级缓存 + 单飞 + 提前 300s 刷新 |
| `src/infra/wechat/clients/wechat-signature.util.ts` | `checkSignature`、`decryptMessage` / `encryptMessage`（PKCS#7 + AES-256-CBC）                                   |
| `src/infra/wechat/wechat.module.ts`                 | `@Global()`，导出 `WechatHttpClient` 与 `WechatTokenService`                                                    |
| `src/config/wechat.config.ts`                       | `registerAs('wechat')`，已注册进 `app.module.ts` 与 `.env.example`                                              |

单测 24 个用例：签名固定向量、AES 往返与 appId 校验、token 缓存/提前刷新/单飞/失效、HTTP 错误归一化与重试边界、脱敏。

### P1 微信支付（已完成）

| 文件                                                     | 说明                                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/infra/wechat/pay/wechat-pay-signature.util.ts`      | 请求/应答签名串、`signMessage` / `verifyMessage`（SHA256withRSA）、`buildAuthorizationHeader`、`decryptResource`（AES-256-GCM）、`resolvePem` |
| `src/infra/wechat/pay/wechat-pay-certificate.service.ts` | 验签公钥解析：优先 `WECHAT_PAY_PUBLIC_KEY`，否则下载平台证书并解密缓存（12h + 单飞）                                                          |
| `src/infra/wechat/pay/wechat-pay.client.ts`              | JSAPI 下单、`buildJsapiPayParams`、查单/关单、退款/查退款、`parseNotification`（验签 + 解密）                                                 |
| `src/modules/billing/payment/wechat-payment.service.ts`  | mock 分支保留；真实分支委托 `WechatPayClient`                                                                                                 |
| `src/modules/billing/payment/payment.controller.ts`      | 取 `req.rawBody` 与 4 个 `wechatpay-*` header                                                                                                 |
| `src/main.ts`                                            | `NestFactory.create(..., { rawBody: true })`                                                                                                  |

单测 20 个用例：签名串格式、签名/验签往返与篡改、Authorization 头格式、AEAD 解密与 AAD/长度/算法校验、下单请求签名与 body、`wx.requestPayment` 参数验签、回调验签解密、缺 header / 篡改 / 过期时间戳、缺凭证与缺 notifyUrl、billing mock 与 live 两个分支。

### P2 小程序（已完成）

| 文件                                                      | 说明                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/infra/wechat/miniprogram/miniprogram.client.ts`      | `code2Session`、`sendSubscribeMessage`（单条）、`sendSubscribeMessageToMany`（收集逐个失败）、`getPhoneNumber`；token 失效自动失效重取并重试一次 |
| `src/infra/wechat/miniprogram/miniprogram.types.ts`       | 登录/订阅消息/手机号类型                                                                                                                         |
| `src/modules/notifier/senders/wechat-subscribe.sender.ts` | 改用 `MiniprogramClient`，删除自建 `Map` token 缓存与 40001/42001 处理                                                                           |

单测 15 个用例：code2Session 映射与缺字段、订阅消息 URL/body/默认值、token 过期重试与不重试其他错误、多人失败汇总、手机号解析；sender 侧覆盖默认字段映射、`fields` 覆盖、20 字符截断、失败抛错。

### P3 公众号（已完成）

| 文件                                                           | 说明                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/infra/wechat/official-account/official-account.client.ts` | OAuth2（授权 URL / code 换 token / refresh / 用户信息）、模板消息、客服文本消息、回调验签+解密、安全模式应答 |
| `src/infra/wechat/official-account/official-account.types.ts`  | 网页授权 / 模板消息 / 回调类型                                                                               |
| `src/infra/wechat/clients/wechat-signature.util.ts`            | 补 4 段式 `buildMsgSignature` / `checkMsgSignature`                                                          |
| `src/infra/wechat/clients/wechat-token.service.ts`             | 抽出共享 `withAccessToken()`，公众号与小程序共用同一套失效重试语义                                           |

单测 22 个用例：OAuth URL 编码与 `#wechat_redirect`、code 换 token 映射、refresh、用户信息、
模板消息体与 msgid、客服消息、token 失效重试、GET 接入签名校验、安全模式验签+解密
（含篡改拒绝）、应答加密与签名往返、`msg_signature` 固定向量。

### P4 企业微信（已完成）

| 文件                                               | 说明                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `src/infra/wechat/work/work.client.ts`             | 应用消息（text / markdown / textcard）、部门列表、成员详情、部门成员 |
| `src/infra/wechat/work/work.types.ts`              | 应用消息与通讯录类型                                                 |
| `src/infra/wechat/clients/wechat-token.service.ts` | `withAccessToken()` 泛化为 `mp` / `work` 两种 token 命名空间         |

单测 13 个用例：text / markdown / textcard 消息体与目标拼接、`agentId` 默认与覆盖、
缺 `agentId`/凭证报错、work token 失效重试、部门列表（含 `id` 过滤）、成员详情映射、
部门成员列表（`fetch_child`）。

### 已知遗留

- **回调应答签名**：微信要求回调响应也带 `Wechatpay-Signature`（用商户私钥签 `timestamp\nnonce\nbody\n`）。
  当前只做「校验微信的签名」，未给应答加签，微信侧会把应答视为失败并重试。
  需要真实商户凭证验证后再补（要改 `PaymentController` 设置响应头）。
- **平台证书定时刷新**：已提供 `WechatPayClient.refreshPlatformCertificates()`，尚未挂定时任务。
- **渠道密钥仍走渠道配置**：`WechatSubscribeSender` 的 `appId/appSecret` 仍来自
  `NotificationChannel.config`（明文入库），尚未切到全局 `WECHAT_MINI_*` 配置。
- **企业微信应用渠道未接**：`WorkClient` 已就绪，但 `WecomAppSender` 需要先给
  `NotificationChannelType` 加 `WECOM_APP` 枚举值（Prisma schema + migration +
  渠道配置校验联动）。

### 待办

- 无（P0–P4 全部完成）；下一步建议优先处理上面的「回调应答签名」遗留。

# Scripts

一次性/运维脚本，全部用 `tsx` 直接跑 TypeScript 源码（不经过 `nest build`）。

| 命令 | 作用 |
| --- | --- |
| `pnpm admin:create` | 引导首个 `SUPER_ADMIN` 账号及其初始组织/项目 |
| `pnpm assets:wechat-goods` | 生成小程序虚拟支付的道具清单 |
| `pnpm mock:pay <channel>` | 本地伪造支付渠道回调/推送，把「支付 → 结算 → 订阅」链路跑通 |
| `pnpm test:resend` / `pnpm test:smtp` | 验证邮件通道配置 |

## mock:pay

只在渠道 **mock 模式**下可用（`ALIPAY_MOCK` / `WECHAT_MOCK` / 虚拟支付 mock 打开）。
真实模式下支付宝验签、微信解密都会拒绝伪造报文。

```bash
pnpm mock:pay alipay                 # 支付宝异步通知
pnpm mock:pay wechat                 # 微信支付 V3 交易回调（JSAPI）
pnpm mock:pay wechat-virtual         # 小程序虚拟支付：发货推送
pnpm mock:pay wechat-virtual-refund  # 小程序虚拟支付：退款推送
pnpm mock:pay wechat-refund          # 微信支付 V3：退款结果通知
```

不带定位参数时会自动从数据库取「最近一条待支付记录」，金额也从库里读
（虚拟支付推送的 `ActualPrice` 必须与下单金额一致，手抄极易出错）。
`--dry-run` 只打印报文，`--help` 查看全部参数与各通道前置条件。

回调成功与否不看 HTTP 状态码，看**响应体**：支付宝是纯文本 `success` /
`failure`，微信 V3 是 `{ "code": "SUCCESS" }`，虚拟支付是 `{ "ErrCode": 0 }`。

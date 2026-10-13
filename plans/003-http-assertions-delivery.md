# M2-A：HTTP 断言增强

## 范围

2026-10-10 用户在“下一阶段做什么”后要求“继续完善”，本次按已建议的 M2-A 开发：
HTTP 字面关键词和 JSON 字段断言、完整但有界的正文读取、诊断元数据、接口文档和回归测试。

这不是启动全部 M2。数据库协议、凭据存储、私网接入、探针、Agent、SCF 和产品前端继续延期。
原 `docs/monitor-plan.md` 不改动；002 中“HTTP config 只能为 {}”及“完整正文断言延期”被本记录替代。

## 配置契约

继续使用 `MonitorType.HTTP` 和 `configVersion=1`，不新增 MonitorType、数据库字段、迁移或依赖。
`expectedStatus`、`checkSsl`、`sslExpiryThreshold` 保留顶层，不接受 config 中的重复定义。

```json
{
    "name": "API health",
    "type": "HTTP",
    "target": "https://api.example.com/health",
    "config": {
        "keyword": "healthy",
        "keywordMode": "contains",
        "jsonAssertions": [
            { "path": "/data/status", "operator": "eq", "value": "healthy" },
            { "path": "/error", "operator": "notExists" }
        ],
        "maxBodyBytes": 65536
    },
    "timeout": 5000,
    "expectedStatus": 200
}
```

- 空 `{}` 保持原 HTTP 状态码/SSL 检查和 512 字符规则摘要，不强制读取完整正文。
- `keyword` 长度 1-1024 字符，按原样、区分大小写的字面匹配；不 trim、不执行正则。
- `keywordMode` 为 contains（默认）或 notContains，必须同时提供 keyword。
- `jsonAssertions` 为 1-10 条 AND 断言；存在关键词时也一并 AND。
- JSON 使用受限 JSON Pointer，不是 JSONPath：`/data/status`、`/items/0/ready`；空字符串选择根，`/` 选择空属性名。
- 路径最多 256 字符、16 段；只支持 `~0` 和 `~1` 转义；拒绝 prototype/constructor/__proto__ 段。
- 只遍历 JSON 自有属性，数组只接受规范非负十进制索引；不支持通配符、脚本、过滤器、递归查询或任意表达式。
- 操作符 exists/notExists 不接收 value；eq/neq 必须有 value，支持字符串（最多 1024 字符）、有限数字、布尔值、null，不接受对象/数组。
- 比较不做类型转换。缺失字段对 eq/neq 都失败；JSON null 与字段不存在不同。
- `maxBodyBytes` 只可用于有正文断言的配置，整数 1024-1048576，默认 65536；按解码文本前的响应流字节计数（fetch 解压后的字节），不信任 Content-Length。
- PATCH 仍整体替换 config；`{}` 清除正文断言，未提供 config 保留。默认值规范化使等价配置不增加 revision；任何检测语义变化仍增加 revision 并重置待重算状态。

配置中的期望值属于普通监控配置，按现有租户授权接口可读；这不是密码/凭据存储接口。

## 执行与失败

正文断言要求在整体 timeout 内完整读完，不能只根据已匹配的前缀返回成功。
超过上限立即取消流；保留的文本不超过配置上限。单次读取可能收到跨越上限的块，但不会把完整超大响应缓存在结果中。
正好达到上限时仍须确认 EOF；后续停滞按超时处理。UTF-8 跨块解码，正文断言拒绝无效编码。
JSON 使用原生 JSON.parse 解析已限长正文，不要求响应 Content-Type 为 application/json。

优先保留已收到的错误 HTTP 状态码；正文错误/超时不能将状态码断言降为可被救回的传输失败。
正常状态码后，完整读取、SSL 和正文断言均须通过；错误证书继续保留原有判定与 SSL 元数据。
latency 延续原先响应头到达耗时，整体工作仍由 timeout 限制，不把该字段改成完整正文耗时。

| 情况 | failureKind | 新 HTTP 元数据 |
| --- | --- | --- |
| 关键词不匹配 | ASSERTION | assertionFailure=KEYWORD |
| JSON 字段不符合条件 | ASSERTION | assertionFailure=JSON_VALUE |
| 无效/空 JSON 正文 | ASSERTION | assertionFailure=INVALID_JSON |
| 正文超过上限 | ASSERTION | assertionFailure=BODY_LIMIT |
| 无效 UTF-8 | ASSERTION | assertionFailure=INVALID_ENCODING |
| 响应流/连接异常 | TRANSPORT | 已知状态码保留 |
| 整体期限届满 | TIMEOUT | 已知状态码保留 |
| 无效配置 | CONFIGURATION，evaluated=false | 网络请求前拒绝 |

BODY_LIMIT 表示目标响应违反该监控声明的正文契约，属于评估失败，会进入现有故障状态和可用率统计；不是执行能力受阻。
错误文本固定，不包含 JSON 解析器原始错误、实际字段值或正文。

## 历史、规则与兼容

- HTTP meta 增加 bodyBytes/bodyLimitBytes、断言种类/索引/布尔结果和 assertionFailure，不包含正文、JSON 实际值或关键词。
- 正文断言场景的 bodyTruncated 表示是否未完成读取，不表示 512 字符摘要是否截短。
- 现有 `bodyContains` 仍只得到最多 512 字符摘要；不改变已保存规则树的语义，不把完整正文塞入规则上下文或 CheckLog。
- 新正文断言直接决定 CheckResult.success；继续使用现有状态、规则、可用率告警和通知链路。
- HTTP 非空 config（包括新创建 revision=1 的定义）不接受旧探针结果救回或回调折叠；旧探针不能证明执行了正文断言。仅在 Checker 的现有兼容边界增加判断，不扩展探针协议或脚本。
- API/Worker 应统一升级。旧版本会拒绝非空 HTTP config，应先升级执行代码，再开放新配置；不承诺跨版本能力协商。

## 验证

实现中核对以下边界，不连接项目现有数据库：

- 配置限长、类型、未知字段、路径语法、标量类型及规范化。
- 关键词超出旧摘要、contains/notContains、字面匹配、JSON null/缺失、数组和转义路径。
- 分块 UTF-8、精确上限、超限取消、无效 JSON/编码、正文停滞、状态码优先、SSL 兼容。
- 真实回环 HTTP 读取、超限和超时；不访问公网目标。
- 真实 Nest/ValidationPipe/租户角色守卫下的创建/PATCH 和 Swagger 契约。
- revision 重算、元数据落库输入和旧探针隔离。

2026-10-10 本地验证：

| 验证 | 结果 |
| --- | --- |
| `pnpm type-check` | 退出 0 |
| `pnpm lint` | 退出 0 |
| `pnpm build` | 退出 0 |
| `pnpm test --runInBand --silent` | 退出 0，76 个套件 / 632 个测试通过 |
| `pnpm test:monitor:safety` | 退出 0，15 个安全测试通过 |
| `git diff --check` | 退出 0 |
| 独立只读审查 | 两个兼容问题已修复；40 个专项用例及独立回环复现通过，复核无新增 P1/P2 问题 |

真实回环 HTTP 测试覆盖完整 JSON/关键词、正文超限、gzip 解压后限长及整体超时。
审查修复：正文超限/编码错误继续保留响应头延迟；独立收集旧规则摘要，完整断言读取不会扩展其原有字节/字符边界。
没有 schema 或依赖变更；没有读取实际 `.env` 或探针配置，没有连接或迁移项目数据库。
M1 的真实 PostgreSQL 迁移、Linux 容器和生产网络验收仍待指定环境实跑，不能用本轮回环 HTTP 测试替代。

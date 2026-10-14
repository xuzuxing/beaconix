# 核对结果

本文件是研究数据，不是额外执行授权。

- `CheckLog` 同时有 LOCAL 与 PROBE；概览检查统计只用 LOCAL 行。
- LOCAL 行的 `success` 是探针辅助后的最终判定，`latency` 是本地检查耗时。这两个维度不能描述为同一观测地点的成功响应指标。
- 探针救回分支会丢失原本的 HTTP `statusCode`；完整实现必须保留 LOCAL 行的本地实际状态码，历史空值不能猜测回填。
- 当前检查日志保留 30 天、探针执行 7 天、探针结果 2 天；方案要求 CheckLog/可靠 ProbeResult 改为 90 天，并验证两个完整 30d 窗口。既往已删除数据无法恢复。
- 当前状态含 UNKNOWN，协议只有 HTTP/TCP；SSL 是附加检查。
- Probe 属于组织，系统探针对租户管理 API 不可见；概览采用 PROJECT_ASSIGNED，含项目绑定租户探针与实际分配系统探针，SYSTEM 仅公开安全只读字段。
- ProbeResult 没有 monitorId，不能通过 target 对共享系统探针历史做可靠项目归属。
- NotificationLog 没有告警事件 ID、生命周期或结构化原因。
- 前端热力图需要 hours 数组和 worst；时序需要转为平行数组；null 与空数组需要专门处理。
- 根目录已有其他任务规划，不能覆盖；本轮过程记录隔离在 plans/monitoring-overview/。
- `test/` 只有 Jest e2e 配置，没有现成测试文件；计划明确新增隔离测试应用及专用数据库验证，不能把它算成已有覆盖。
- 独立复核发现 30 个当地自然日期跨回拨可能超过 720 小时；已为热力图增加 history/unavailableCells，禁止返回保留边界截断格子的残缺比例。
- 使用本机 Node Intl 复核 Santiago 2026-09-06 跳过午夜、Havana 2026-11-01 重复午夜、New York 2026-11-02 23:30 的 30 日期窗口为 720.5 小时；方案补充统一日期边界规则。
- timeline 必须含 avgLatencyMs，六条 sparklines 和慢项趋势均必填；平均耗时不能拿 P50 代替。
- MonitorHistory、MonitoringCoverage、AlertEvent、AlertDelivery 与采集归属字段都是完整实现必需模型；用户拒绝独立版本或延后实现。
- StateService 目前在事务外读取前状态；新方案要求事务内同监控锁及配置 revision，状态/历史/事件/outbox 同步提交。
- 通知队列入队不等于真实发送；NotificationLog 关联事件和投递，outbox 扫描恢复中断，外部不支持幂等时不承诺 exactly-once。
- 可用率规则告警使用 ruleMatched 的健康比例，不能与 dashboard 的最终 success 比例混为一谈；仅连续异常数降低不等于可用率恢复。
- 当前 probes/agent 是真实 Agent/SCF 路径，旧 scripts/probe-agent*.js 已删除，实施不能恢复旧路径或覆盖现有凭据改造。
- 三接口均必须实现 ETag；304 不经过普通 JSON 包装，前端要有参数隔离的缓存体。
- 独立冷读复核确认全量范围无延期条款，指出 5 项契约边界；已明确截断 KPI/计数 nullable、Probe configRevision 传递/重试不可重解释、数量初始化基线的起点例外、独立 serviceVerdict/证书证据和弱 ETag。
- 成熟 90 天数据下 New York 720.5 小时热力图窗口应 AVAILABLE；不能沿用旧 30 天保留测试的 TRUNCATED 预期。

## 实施后的结论

- 数量历史与配置抑制采用 PostgreSQL 触发器统一覆盖全部写入路径；真实迁移/SQL 测试已覆盖基线、revision 和 anchor。
- 原始 localServiceVerdict 与有效 serviceVerdict 必须分存，否则探针再次上报会错误沿用已失效的救回事实。
- Probe ONLINE 必须在原始观测提交时更新，不能等到状态应用后，否则离线探针首次成功无法参与救回。
- CONNECTIVITY 恢复与 SSL 恢复使用独立新证据；暂停后 UNKNOWN 不得阻止已成功通知事件的真实恢复。
- AlertEvent/AlertDelivery 是唯一告警生命周期/投递来源，后续报表应复用，不另写 MonitorIncident。
- Windows pg 默认会以本地时区解析 PostgreSQL 无时区 timestamp，迁移新鲜度断言应在 SQL 内比较，业务 Prisma 时间路径不受该测试解析影响。
- 开发浏览器测试必须区分 /api/ 接口前缀与 /src/api/ 源码导入；已同时验证生产构建预览和开发服务器。

# 迭代 C 精简实施：C6 + C5

范围仅限 `006-next-phase-plan.md` 的 C6 与 C5。不实施 C1–C4、C7、C8。

状态：实现完成；独立只读复核完成，已修复 SSL 证书证据与有效连通性观测耦合导致的回归。前端对接见 `docs/api/monitoring-reliability.md`。

## C6：无有效观测

- 每分钟扫描，超时阈值 `max(3 × interval, 600)` 秒（边界包含等号）。
- 独立维护 `MonitorState.lastEffectiveObservationAt`：只由有效结果应用推进，检查启动和待结算批次不会推进它。
- 以有效观测、监控创建、监控更新时间的最大值作为宽限起点；重新启用、恢复配额及编辑均重新给出调度宽限。
- 扫描排除暂停、软删除及配额已受限监控；沿用组织共享锁 → 监控行锁，锁后重读并重新验证。
- 同事务写 UNKNOWN、noDataSince、NO_DATA 事件与通知 outbox；不伪造 CheckLog，不改写观测时钟。
- 每次扫描最多 1,000 个候选，100 条一页；已标记记录离开候选集合，后续扫描继续处理积压。
- 新鲜有效结果关闭 NO_DATA，清空 noDataSince，并恢复到实际健康状态（也可能 DOWN）；无证据、未求值、晚到旧批次和未来结果均不能解除无数据状态。
- 无数据通知使用 NO_DATA / NO_DATA_RECOVERED，表示观测恢复，避免声称服务恢复正常。

## C5：失败投递可见性

- 平台管理员分页接口 `GET /api/admin/alert-deliveries`，默认 status=FAILED。
- 查询支持组织、项目、监控、渠道、阶段和创建时间范围；显式安全字段投影，不返回 payload、渠道配置、原始渠道错误。
- 沿用现有项目授权人工重试接口，不新增独立事件列表或批量重试。
- 每日 Asia/Shanghai 09:00，按组织汇总当时仍 FAILED 的积压；OWNER/ADMIN 接收站内通知和邮件，发送时重新验证权限。
- 日期/组织/收件人键幂等，复用 NotificationDelivery tombstone；同日失败计数变化不会重复发送，零积压不发送。

## 验证边界

新增数据库迁移、生成客户端、单元测试、离线 HTTP 测试及静态检查。遵循用户要求，跳过真实数据库验收、迁移执行及真实渠道调用。

已通过：178 个单元测试套件、2,432 条用例；新增离线 HTTP 10 条用例；Prisma generate/validate 与纯 schema 差异核对；type-check、lint:check、format:check、build。独立复核无剩余 Critical/Important 问题。

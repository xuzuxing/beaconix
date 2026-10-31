# 012：项目告警查询与投递追踪

> 基线：`72c2f21`，2026-10-30。用户已授权按 C1 最小方案开发及后续提交、推送；本轮不执行实际环境操作。
> 状态：开发、回归及独立复核完成。

## 目标

项目用户从看板、监控详情或通知中的事件 ID 打开告警，查清触发原因、恢复时间、渠道投递与尝试记录；有权限的管理员可直接用已有接口重试失败投递。

## 范围与契约

- 新增项目事件列表、详情、事件投递列表、投递尝试记录四个 GET 路由，前缀 `projects/:projectId/monitoring/alert-events`。
- 列表按 monitorId/kind/status/level/startedAt 时间范围筛选，统一 items/total/page/limit；所有子列表也分页，limit 最大 100。
- 真实 ProjectAccessGuard + ProjectAccessService，读取要求 monitoring.read，事务内重新鉴权；项目与组织双重约束，子资源验证所属事件。
- 复用既有 POST `projects/:projectId/monitoring/alert-deliveries/:deliveryId/retry`，不创建第二套重试逻辑；读接口返回当前权限和 FAILED 状态对应的能力提示。
- 保留软删监控的事件快照，归档项目历史只读；删除项目/组织不可见。
- 显式字段投影、现行角色投影，不返回原始 evidence、诊断 message、payload、provider error、lease、渠道配置和收件人。
- 时间使用 UTC ISO；默认查询全部生命周期，不将过去开始的 ongoing 事件强行纳入 startedAt 日期范围。
- 无 schema/迁移改动；不含 ACK、静默、Webhook、数据清理，也不改支付。

## 实现位置

- `src/modules/alert-events/alert-event-queries.controller.ts`：薄 controller，Swagger 与项目读取权限。
- `src/modules/alert-events/alert-event-queries.service.ts`：事务快照、授权及查询投影；与事件写入状态机分离。
- `src/modules/alert-events/dto/query-alert-events.dto.ts`、`entities/alert-event.entity.ts`：参数和 Swagger 响应模型。
- `alert-events.module.ts` 注册；现有 retry controller/service 不改。
- `test/fixtures/alert-event-queries.fixture.ts`：仅替代持久层，HTTP 使用真实身份/项目 ACL/业务 service。
- `test/alert-event-queries.e2e-spec.ts`：查询→投递→人工重试→历史保留；加入 `test:business:offline`，由现有 CI 执行。
- `src/modules/alert-events/alert-event-queries.service.spec.ts`：直接服务调用、事务内鉴权、SQL 查询约束及白名单投影。
- 前端文档：`docs/api/alert-event-investigation.md`。

## 验证与完成标准

```powershell
pnpm type-check
pnpm format:check
pnpm lint:check
pnpm exec jest --runInBand
pnpm test:business:offline
pnpm build
git diff --check
```

- 授权、跨组织/跨项目/跨事件、过滤、分页、已删除监控、已删除渠道、归档项目、字段脱敏、保留重试历史均有针对性断言。
- 单次读的鉴权、结果及总数使用 RepeatableRead；跨请求的分页不承诺冻结快照，操作后刷新。
- 不以夹具证明真实 PostgreSQL 锁；本轮新增只读查询，无需渠道、Redis 或部署环境。
- 独立只读复核重要问题修复后记录最终结果。

## 2026-10-30 完成记录

- `pnpm type-check`、`pnpm format:check`、`pnpm lint:check`、`pnpm build`、`git diff --check` 均通过。
- 全量单测 183 套件 / 2,464 条通过，包含本轮新增 7 条服务边界用例。
- 固定离线入口 7 文件 / 49 条 Jest 用例通过，另含原有 6 条原生健康 HTTP 子用例；本轮事件追踪 HTTP 23 条，包含实际生成 Swagger 的四路由模型检查。
- 独立复核未发现授权/投影阻断；发现的 ISO 周日期/序号日期解析与全局验证配置差异均修复并回归通过。HTTP 使用当前生产管道的未知参数剥离行为，原有回归夹具默认不变。
- 日志位于本机 `.tmp/c1-unit-final.log`、`.tmp/c1-business-final.log`；本轮没有操作数据库、Redis、外部渠道或实际部署环境。

## 后续边界

事件 reason/actual/threshold 是触发时证据，不代表最新观测；canRetry 只表示权限与当前状态，不保证已删除渠道仍可送达。通知接收人快照与安全化 provider 诊断若有需要，另行定义存储/隐私契约。

若未来增加 ACK/静默，独立设计生命周期，不将 ACK 当恢复；若加入历史清理，应同时维护分页、历史标记与重试边界。

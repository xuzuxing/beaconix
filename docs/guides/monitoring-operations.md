# 监控概览实施与运行

更新：2026-10-10。完整契约见 [监控概览 API 契约](../../plans/001-monitoring-overview-api.md)；
前端接口文档已同步，原 overview 保持兼容。

## 部署

本轮只对独立数据库 `beacon_dashboard_test`（专用容器 55439）执行迁移。
未迁移开发或生产数据库。部署新服务前，针对目标环境显式执行：

```bash
pnpm exec prisma migrate deploy
pnpm exec prisma generate
pnpm type-check
pnpm build
```

本次新增四个迁移：monitoring_dashboard、monitoring_integrity、observation_evidence、
local_service_evidence。旧检查只回填可证明的归属，不猜测历史协议/已丢失的状态码或原始服务证据。
数量/探针/事件水位从迁移时间开始；现有检查保留范围采用保守水位。
上线后历史不足正常显示 TRUNCATED，不应人为调早水位。

## 数据一致性

状态记录事务锁定 monitor，校验配置版本，幂等写入观测、状态、事件与投递。
配置/规则变化使旧观测失效。乱序观测保留历史但不倒退当前状态。
PostgreSQL 触发器负责所有写入路径的配置 revision、状态/数量历史及抑制同步，
包括 onboarding、嵌套 Prisma 写入与后台路径。这取代了方案中逐服务调用历史写入的实现方式。
未来批量维护须保留这些触发器，不能用绕过触发器的导入声称已记录历史。

check_logs.localServiceVerdict 保存原始本地服务证据，serviceVerdict 保存探针辅助后的结论。
Probe 回调不使用旧证书快照打开或恢复 SSL 事件。新的探针成功可独立恢复连接事件，
但不能把 SSL 策略失败改成成功。

## Probe 上报协议

心跳任务含 id/type/target/configRevision。Agent 与 SCF 上报：

```json
{
  "results": [{
    "monitorId": "assigned-monitor-id",
    "reportId": "unique-observation-id",
    "configRevision": 3,
    "target": "https://example.com/health",
    "checkedAt": "2026-10-10T13:00:00.000Z",
    "success": false,
    "latency": 250,
    "statusCode": 503,
    "error": "Unexpected status 503 (expected 200)"
  }]
}
```

- checkedAt 在接收时间前 15 分钟至后 1 分钟内；target、monitorId、配置必须匹配授权任务。
- TENANT 必须同组织且实际绑定；SYSTEM 必须实际分配。projectId/orgId 从服务端确定。
- 相同 probe/reportId 的相同内容返回既有结果，即使随后配置改变；不同内容为 409。
- 旧版缺 monitorId 只在授权任务 target 唯一、具 checkedAt 且能证明配置未变时兼容；否则要求升级。
- 先事务提交原始观测和探针 ONLINE，再应用状态；每分钟 pending sweep 恢复中断。
- Agent 失败重试保留原 reportId、时间和 payload；过旧、解绑、配置变更的缓冲被丢弃。
- SCF 使用 `probes/agent/functions/scf.js` 共用执行路径。旧 `scripts/probe-agent*.js` 不再使用。

## 告警运行

alert-outbox-sweep 每分钟扫描 SQL PENDING/过期租约并投递 BullMQ。
最多三次真实发送尝试，5 秒起指数退避；FAILED 不无限重发。
`POST /api/projects/:projectId/monitoring/alert-deliveries/:deliveryId/retry` 需要组织 ADMIN+，
仅重试该项目 FAILED 投递。恢复通知只跟随同渠道真实成功的 opening；
opening 尚在发送时保留恢复意图等待，不把入队当成功。
删除渠道仍保留过去的成功事实与事件 firstNotifiedAt。

Email 传递 deliveryId 幂等键。其他渠道若不支持外部幂等，发送成功后、写库前崩溃仍可能重复，
因此不承诺端到端 exactly-once。测试使用模拟外部发送，不向真实收件人发送。

## 验证与性能

隔离集成测试：

```powershell
$env:MONITORING_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55439/beacon_dashboard_test'
pnpm test:e2e -- --runInBand --detectOpenHandles
```

只有显式专用测试库才运行；测试仅清理自身组织/项目数据。未运行 reset 或全库清表。
数据库计划与测量保存在 [性能记录](../../plans/monitoring-overview/artifacts/performance.json)。
6 万行样本下已有精确分位数 EXPLAIN (ANALYZE, BUFFERS) 与 HTTP 冷/热请求、响应体大小记录；
热缓存为隔离测试的内存缓存，不能据此推断生产 Redis/多实例性能。
最终验证清单见 [实施与验收进度](../../plans/monitoring-overview/progress.md)。

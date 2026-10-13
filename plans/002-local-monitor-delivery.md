# 本地监控交付与延期记录

> 后续 HTTP 关键词/JSON 断言已单独推进，见 `003-http-assertions-delivery.md`。本页保留此前 M0/M1 的交付记录，HTTP 空 config 限制及完整断言延期状态以 003 为准。

## 授权边界

2026-10-10 用户要求按监控计划开发，SCF 不处理，探针相关暂不开发，只记录。
原始 `docs/monitor-plan.md` 保留；001 中与本记录冲突的旧建议以本记录为准。

本次交付 HTTP/TCP/DNS/PING 的本地检测。无新增数据库协议、完整 HTTP 关键词/JSON 断言或产品前端。

## 本地实现

- Nest provider 策略和 `CheckerRegistry`，保留 HTTP/TCP 原有 `check` 调用接口。
- DNS 支持 A/AAAA/CNAME。默认 A，无 expectedValues 时非空解析即成功；有预期时使用去重、排序、大小写/尾点/IPv6 规范化后的精确集合比较。
- DNS 历史保存最多 32 个实际值。A/AAAA 保存对应 TTL，CNAME 不编造 TTL。
- PING 固定最多三次单包调用，任一次响应即成功，延迟为成功样本平均 RTT，丢包率仅供诊断。
- PING 仅执行参数化系统命令，整体 timeout 包含域名解析与所有子进程。每次调用限制输出并隐藏 Windows 窗口。
- 新 PING 只允许公共单播 IP；域名解析后验证并固定 IP，拒绝私网、环回、链路本地、元数据地址和保留网段。HTTP/TCP 现有私网行为不在本轮批量改变。
- `configVersion=1`，HTTP/TCP/PING 的 config 只能为 `{}`；DNS 仅接受 recordType/expectedValues，不接收任意 host、命令或凭据。
- PATCH config 整体替换，未传保留；切换 type 必须显式传 config。HTTP expectedStatus/checkSsl/sslExpiryThreshold 仍在顶层。
- 定义或启用生命周期变化递增 revision，清理需要重算的运行状态。元信息改名不递增。
- 状态写入在事务内锁定 Monitor 行，校验 revision、暂停/删除和时间顺序；过时结果不落库、不推进状态、不通知。
- 旧远程回调按服务端接收时间折叠，本地顺序仅比较 lastLocalCheckAt；历史探针未来时间戳不会冻结本地状态。
- 可用率告警认领同时校验 revision 和观测时间；新通知任务携带 monitorRevision，发送前复核，迟到确认不覆盖新定义状态。
- 告警有持久化 pending ID：通知入队失败或认领后进程重启会在后续检测重试，成功入队才清除。采用至少一次语义，入队后确认前崩溃可能重复投递；不宣称跨 PostgreSQL/Redis 的恰好一次事务。
- CheckLog 增加 revision/evaluated/failureKind/meta。执行能力/配置/策略受阻不增加故障次数、不参与可用率统计，保留最近真实目标状态。
- 套餐 allowedMonitorTypes：FREE 为 HTTP/TCP/PING，PRO/TEAM 加 DNS。创建、切换、启用、恢复、扫描、排队后执行、手动检测和结果写入前复查权限。
- 降级不删除配置/历史、不修改用户 enabled 意图。监控 API 返回 executionEligible 和 executionBlockedReason；用户仍可暂停/删除。
- HTTP 只消费有界前缀，最多保留 2048 字节中的前 512 字符，取消余下响应流；原有 bodyContains 仍只是前缀规则，完整正文断言延期。
- HTTP 已收到的错误状态码不会因后续正文流错误/超时降为可被探针救回的传输失败。

## API 示例

入口保持不变：`POST /api/projects/:projectId/monitors`。

```json
{
    "name": "Public DNS",
    "type": "DNS",
    "target": "example.com",
    "config": { "recordType": "A" },
    "interval": 60,
    "timeout": 5000
}
```

DNS 需套餐显式允许。PING 使用 `"type": "PING"`、公共 IP/主机名 target 和 `"config": {}`。
创建响应和后续列表返回 configVersion、revision、executionEligible、executionBlockedReason。
`GET /api/projects/:projectId/monitors/:monitorId/checks` 返回本地 meta 和 evaluated；受阻记录仍可诊断，但不参与故障计数或任何可用率统计。

## 旧探针边界

探针功能未扩展。仅有以下必要的本地接入隔离：

1. 系统任务分配和旧心跳输出过滤 DNS/PING，避免旧 Agent 收到未知协议。这不是能力协商或探针新协议。
2. Checker 不用旧探针成功覆盖 DNS/PING、HTTP 断言/SSL 失败或 revision > 1 的定义；旧 target-only 报告不能证明新定义身份。
3. 未修改 `scripts/probe-agent.js`、`scripts/probe-agent-scf.js`，保留用户已有改动。

因此修改定义后的 HTTP/TCP 不再使用旧探针救回，直到后续实现 monitorId/revision 身份协议。本轮仍可正常本地检测。
探针自身调度/套餐降级处理仍延期，不能据此宣称已完成分布式权限闭环。

## 探针与 SCF 待办

- [ ] Agent 版本、协议版本、支持类型及网络能力协商。
- [ ] 任务携带 monitorId/configVersion/revision/config，结果携带稳定 observationId。
- [ ] 同 target 多定义隔离、幂等重试、组织/绑定/系统分配权限与 revision 校验。
- [ ] DNS/PING 的远程执行、元数据校验及混合 Agent 版本发布。
- [ ] 探针报告 DTO 嵌套验证与 success 布尔验证。
- [ ] 普通读接口移除共享密钥；受控注册/轮换及已暴露密钥处置。
- [ ] 探针执行侧套餐生命周期权限复查。
- [ ] 私网指定租户探针独立执行和加密监控凭据（M2）。
- [ ] SCF 调度实例修复、冷/暖启动、单次执行期限、抖动、重试与离线测试。用户明确本轮不处理。

## 迁移与部署

1. 先备份，在隔离 PostgreSQL 上验证既有 HTTP/TCP、多个套餐和历史数据。
2. 提供两条按顺序执行的迁移：先新增 enum/本地字段；提交后再引用新 enum 添加套餐默认值和 PRO/TEAM 定向回填。
3. 未知自定义套餐保留基础类型，DNS 需管理员明确授权。迁移不修改现有套餐价格/数量/间隔，不运行全量 seed 代替回填。
4. 执行 `pnpm exec prisma migrate deploy`，再执行 `pnpm prisma:generate` 和构建；不使用 db push 绕过迁移。
5. 实际仓库 `.gitignore` 忽略 `src/generated/prisma`，生成结果已本地更新；沿用现有 CI/Docker 生成方式，不强行加入大量生成文件。
6. runner 镜像安装 iputils。不要自动授予 privileged；实际 Linux 部署需验证系统 ping 和 ICMP 权限，缺失时会显示 CAPABILITY 受阻。
7. Windows 与 Linux 参数调用均有离线测试；Linux 容器真实权限、生产网络防火墙和 ICMP 验收需在指定部署环境完成。
8. HTTP/TCP 的全面公网限制、DNS 重绑定和逐跳重定向防护需先盘点现有私网监控，再独立确认迁移策略；本轮不得宣称完成全面 SSRF 治理。

## 验证记录

开发过程第一轮：`pnpm type-check` 通过；本地相关 13 个套件、142 个测试通过。

| 验证 | 结果 |
| --- | --- |
| `pnpm prisma:generate` | 退出 0，生成 Prisma Client 7.8.0 |
| `pnpm exec prisma validate` | 退出 0 |
| `pnpm type-check` | 退出 0 |
| `pnpm test --runInBand --silent` | 退出 0，73 个套件 / 535 个测试通过 |
| `pnpm build` | 退出 0 |
| `pnpm lint` | 退出 0 |
| Windows PingRunner 回环实测 | 退出码 0，有 RTT/TTL，未被超时终止 |
| `git diff --check` | 退出 0 |

新增真实 HTTP 集成用例使用 Nest、Supertest、ValidationPipe、响应/异常契约和真实租户角色守卫，持久层隔离 mock。
独立审查指出的未来时间戳、统计入口、告警 revision 与 HTTP 状态码丢失问题已修复并补测试。
告警认领后未入队导致永久去重的问题通过持久化 pending ID 修复，失败/重启重试用例通过；独立复核通过。

未连接或迁移实际数据库，不读取真实探针配置或凭据。
本机无 Docker 可执行文件，未运行 Linux 镜像或数据库迁移回放。
完整 PostgreSQL 集成、生产网络及 Linux 权限验收仍是发布前步骤，不能用上述离线/HTTP 测试替代。

## 继续开发：部署验收入口

2026-10-10 增加 [隔离 PostgreSQL 验收说明](../test/monitor-postgres/README.md)：

- `pnpm test:monitor:safety`：测试库 URL 白名单与拒绝场景，不连接数据库。
- `pnpm test:monitor:postgres`：显式指定空的一次性本地 PostgreSQL，先部署旧迁移和样本，再升级；验证数据保留、套餐回填、真实行锁/并发、受阻统计与告警 pending 确认。
- `.github/workflows/monitor-validation.yml`：独立 PostgreSQL 16 service 验收，再构建生产 runner，禁用外网、不授予 privileged，执行实际 PingRunner 回环冒烟。

不加载 `.env`，不使用应用 `DATABASE_URL` 作为测试源，不自动重置或删除数据库，不修改探针/Agent/SCF。
本地 15 个安全用例、缺少专用 URL 时提前拒绝、独立 Prisma 配置校验、类型检查、lint、构建、差异格式检查和原有 73 个套件 / 535 个测试通过。
独立审查发现的统计快照缓存导致锁轮询不稳定的问题已修正；真实 PostgreSQL/Linux 验收尚待 CI 或指定环境实跑。

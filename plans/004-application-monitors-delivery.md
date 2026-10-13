# 应用层全协议交付

## 授权与范围

2026-10-10 用户明确要求应用层全部实现，不再拆分首批。
本阶段包含 MYSQL、POSTGRESQL、REDIS、MONGODB、DOCKER、GRPC、WEBSOCKET。
不包含 MQTT/Kafka/SMTP，不开发探针、Agent、SCF 或前端。
原始 `docs/monitor-plan.md` 保持不变。

## 协议与配置

通过现有监控创建、列表、更新、手动检测、调度、检查历史、状态机和通知接口使用。
应用层默认整体超时为 10000ms，可显式设置 100-60000ms。
所有类型复用 configVersion=1、revision 并发保护、套餐执行资格、可用率统计。
配置 PATCH 仍为完整替换，不合并嵌套字段；省略 config 保留原配置。

| 类型 | target | config | 健康条件 |
| --- | --- | --- | --- |
| MYSQL | `db.example.com:3306` | `username`、`database` 必填，`password` 可选，`tls` 默认 true，`tlsCa` 可选 | 连接后固定执行 `SELECT 1 AS beacon_health`，结果为 1 |
| POSTGRESQL | `db.example.com:5432` | 同 MySQL | 同 MySQL |
| REDIS | `cache.example.com:6379` | 可选 username/password、db(0-15，默认0)、tls(默认true)、tlsCa | 有凭据时显式 AUTH，SELECT 成功后 PING 返回 PONG |
| MONGODB | `db.example.com:27017` | 可选成对 username/password、database/authSource(默认admin)、tls(默认true)、tlsCa | 单节点直连执行 `{ping:1}`，返回 ok=1 |
| DOCKER | HTTPS daemon origin，如 `https://docker.example.com:2376`；或固定逻辑目标 `unix:///var/run/docker.sock` | 必填 containerId；远程可选 token、tlsCa、成对 tlsCert/tlsKey | 只读 inspect，running 且未 paused；有 HEALTHCHECK 时要求 healthy |
| GRPC | `grpc.example.com:50051` | service(默认空)、tls(默认true)、tlsCa、token | 标准 `/grpc.health.v1.Health/Check` 返回 SERVING=1 |
| WEBSOCKET | `wss://ws.example.com/health` | 可选 token、tlsCa | 建立连接后发送随机协议 ping，收到相同 payload 的 pong |

数据库和 gRPC target 使用显式端口；支持域名和 IP，IPv6 用方括号。
例外：当前 mysql2 对自定义固定 socket 的 IP-SAN 校验不正确，
因此 **MySQL TLS 必须使用 DNS 主机名**，接口明确拒绝 TLS IP 目标；
显式 `tls:false` 时可使用 IP，不会自动关闭证书校验。
数据库自定义 query 仅允许字面量 `SELECT 1`，并规范化为固定健康查询。
不允许任意 SQL、MongoDB URI、Redis 重连配置、TLS 文件路径、
自定义 gRPC 方法、任意 Docker API 路径或用户指定宿主机 socket。

TLS 使用系统信任链或内联 PEM tlsCa，始终验证证书。
token 仅允许通过 TLS gRPC、wss 或 HTTPS Docker 发送。
应用层 URL 禁止 userinfo、query 和 fragment，凭据放在 config；
WebSocket 可设置 pathname，不跟随重定向，不启用压缩，消息上限 64KiB。
Docker 只读取 `/containers/{id}/json?size=false`，响应上限 1MiB，
不跟随重定向，不暴露 Env、挂载、完整 inspect 响应或健康检查输出。

## 凭据边界

- 独立 `MONITOR_SECRET_KEY`：32 字节规范 base64，API 和 worker 使用相同值。
- AES-256-GCM、随机 12 字节 IV，AAD 绑定 organizationId/type/target。
- password/token/tlsKey 从 config 拆出，仅密文保存在 Monitor.credentialsEnc；
  内部检查执行时解密，数据库、响应、检查日志、通知、审计、请求日志不保存明文。
- API 返回不含上述字段或 credentialsEnc 的 config，以及 hasCredentials。
  密文错误、密钥缺失或配置不兼容阻断执行，不把目标判成 DOWN。
- 保存凭据但未配置密钥时返回 503；未使用凭据的基础监控不受影响。
- 省略 PATCH config 保留凭据；替换 config 必须重新提供需要保留的凭据，
  不接受掩码占位符恢复秘密；省略的凭据会清除。
- 修改带凭据监控的 target 必须显式重新提交完整 config，
  不能将不可见凭据自动发送到新目标。
- 凭据改变增加 revision 并重置状态；等价替换不因随机 IV 增加 revision。
- PostgreSQL 使用显式密码回调，禁止回退到 PGPASSWORD 或 `.pgpass`。
- 本阶段没有自动密钥轮换接口。更换密钥前必须保留旧密钥并完成受控重加密；
  直接替换环境变量会使旧密文无法解密，不能丢弃旧密钥后再尝试修复。

示例：

```json
{
  "name": "PostgreSQL production",
  "type": "POSTGRESQL",
  "target": "db.example.com:5432",
  "config": {
    "username": "monitor",
    "password": "<write-only>",
    "database": "app",
    "tls": true
  }
}
```

## 网络与资源边界

所有新增网络协议仅连接公网地址。解析 A/AAAA 后校验全部答案并固定连接 IP，
TLS 保留原主机名身份；混合私网/公网答案也拒绝，防止 DNS 重绑定。
数据库不允许 SRV、集群自动发现或拓扑跳转；MongoDB directConnection，
Redis 不配置 Sentinel/Cluster，不自动重连；gRPC 禁止环境 HTTP 代理和重试。
内网监控依赖未来的探针范围，不在本阶段放开服务端私网访问。
原有 HTTP/TCP 的历史网络行为不在本阶段重构。

统一整体期限覆盖解析、连接、认证、命令和资源清理。
超时销毁 socket、取消 gRPC call、终止 WebSocket，不输出驱动原始错误。
MongoDB 官方驱动 close 可能执行额外 endSessions，且不接受同一 abort signal；
本实现将其完整生命周期隔离在 worker_threads 中，超时强制终止线程。
正常 MongoDB 检查等待驱动关闭和线程退出后才成功。

Docker 本地目标是逻辑别名。只有部署者同时配置
`MONITOR_DOCKER_SOCKET_PATH` 和 `MONITOR_DOCKER_SOCKET_ORGANIZATION_IDS`，
且组织处于允许列表，才可读取该固定 socket。
允许的组织可以查询该 daemon 的容器状态；建议使用只允许 inspect 路由的
只读 Docker API 代理，禁止把非受信组织加入允许列表。
默认关闭；缺少授权返回未评估 POLICY，不产生目标故障。

## 迁移与部署

1. 配置独立加密密钥；备份数据库及密钥。
2. 部署前在隔离数据库验证迁移。
3. 应用 `20261010000300_application_monitor_types`，
   再应用 `20261010000400_application_monitor_plans`。
   enum 新值必须先提交，才能用于套餐数组。
4. 004 新增可空 credentialsEnc；历史监控默认 NULL，保留原配置和历史数据。
5. FREE 保持 HTTP/TCP/PING；PRO、TEAM 在原允许类型上追加全部应用层类型。
   seed 同步使用全部已实现枚举。
6. API/worker 同步升级，重新生成 Prisma Client。
   回滚应用代码前暂停新增类型；不能回滚到不认识新 enum/密文的旧 worker。

没有连接或迁移开发者当前数据库，没有运行完整 seed。
未修改探针/SCF 脚本；新增类型被现有 HTTP/TCP 限定的旧探针链路隔离。

## 验证

本地测试覆盖配置白名单、默认值、目标格式、凭据加密/篡改/上下文绑定、
API 写入与脱敏、凭据修改 revision、隐式转发凭据拦截、
私网及混合 DNS 阻断、整体期限和连接销毁、各驱动固定命令。

真实本地协议测试覆盖 WebSocket ping/pong/超时/重定向、
gRPC 标准 health 协议及非 SERVING/挂起、
临时 socket/Windows named pipe 上的 Docker API/权限/状态/响应上限，
以及 pg 清文密码请求不能获取进程密码。
真实 MongoDB worker + 测试 driver double 验证 connect/close 挂起强制终止。
真实 ioredis + 回环协议 fixture 验证 AUTH 不被忽略，以及半关闭对端下立即销毁 socket。

CI 新增四个真实数据库的隔离服务验收及迁移重放。
当前 Windows 主机没有可用数据库容器环境，**这些容器验收和实际迁移尚未实跑**。
真实 TLS/SNI 和部署环境验收仍需执行，不能把本地模拟测试当成生产验收。

### 最终本地结果

2026-10-10：

- Prisma Client 生成通过。
- `pnpm type-check`、`pnpm lint`、`pnpm build` 通过。
- 完整 Jest：85 个套件，755 项测试全部通过。
- `pnpm test:monitor:safety`：15 项全部通过。
- `git diff --check` 通过。
- 独立审查发现的凭据转发、pg 进程密码回退、Redis AUTH/SELECT 误判及断连延迟、
  MongoDB 清理超时均已处理并补回归；最终复核无剩余 P1/P2。
  MySQL TLS IP 目标限制为显式记录的兼容边界。
- 未提交或推送代码，未连接、迁移或 seed 当前应用数据库；
  用户原有探针/SCF 脚本修改保持原样。

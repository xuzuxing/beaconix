# 本地监控部署验收

本入口仅验证本地 M0/M1，不启动应用、调度器、Redis、探针或 SCF，不访问公网监控目标。
默认单测不连接数据库，真实 PostgreSQL 验收必须单独执行。

## 安全约束

- 只读取显式的 `MONITOR_TEST_DATABASE_URL`，不加载 `.env`，不回退到应用的 `DATABASE_URL`。
- 仅允许 localhost、127.0.0.1 或 ::1，数据库名必须是 `beacon_monitor_test` 或 `beacon_monitor_test_<后缀>`。
- URL 不接受查询参数或 fragment，不能通过连接参数覆盖主机或 schema。
- 连接后先检查非系统数据库对象；有表、视图、序列或自定义类型时拒绝执行。
- 使用真正的 `prisma migrate deploy`，不执行 db push、reset、全量 seed 或 DROP。
- 测试数据留在专用数据库中；再次验收须自行准备新的空测试库。只自动清理生成的临时迁移目录。
- 这些校验不等同于沙箱。仍须使用专门的测试 PostgreSQL 实例，不能使用生产数据库或生产凭据。

## 覆盖范围

1. 在空库部署新增本地监控迁移之前的完整迁移历史。
2. 插入既有 HTTP/TCP、暂停/软删状态、历史记录、FREE/PRO/TEAM/CUSTOM 套餐及订阅样本。
3. 分两条迁移升级，核对所有既有字段不变、新字段默认值、PRO/TEAM DNS 回填和自定义套餐默认权限。
4. 重复部署，确认已应用迁移不重放，并确认非空库防护拒绝复用该库。
5. 通过真实 Prisma Client 验证 DNS/PING 枚举、JSON 元数据及新建套餐默认值。
6. 并发结果折叠不丢失失败计数；观察 PostgreSQL 锁等待，确认定义修改提交后旧 revision 结果被拒绝。
7. 暂停、软删、过期 revision 和乱序结果拒绝落库；执行能力受阻不改变真实状态或参与可用率/延迟聚合。
8. 告警 pending ID 在重新实例化服务后仍可重试，错误 token/revision 的确认不能清除 pending。

本入口不代替生产容量、真实网络、备份恢复、所有 API 的数据库端到端验收，也不新增任何数据库监控协议。

## 本地执行

先运行无需数据库的安全测试：

```powershell
pnpm test:monitor:safety
```

已有 Docker 时，可启动独立、无数据卷的 PostgreSQL 16 测试容器。不要复用项目 `docker-compose.yml` 的已有数据库：

```powershell
docker run --rm --detach --name beacon-monitor-acceptance --publish 127.0.0.1:55432:5432 --env POSTGRES_USER=monitor_test --env POSTGRES_PASSWORD=monitor_test --env POSTGRES_DB=beacon_monitor_test_local postgres:16-alpine
docker exec beacon-monitor-acceptance pg_isready -U monitor_test -d beacon_monitor_test_local
```

等待 `pg_isready` 成功后，在项目根目录执行：

```powershell
$env:MONITOR_TEST_DATABASE_URL = 'postgresql://monitor_test:monitor_test@127.0.0.1:55432/beacon_monitor_test_local'
pnpm prisma:generate
pnpm test:monitor:postgres
```

以上账号只用于新建的一次性本地实例。测试无论成功或失败都可能已写入测试数据，不会自动删除或重置数据库。
完成后 `docker stop beacon-monitor-acceptance` 将移除这个无持久卷的专用容器。不要对项目数据库执行清理。

Linux shell 使用同一专用 URL：

```bash
MONITOR_TEST_DATABASE_URL='postgresql://monitor_test:monitor_test@127.0.0.1:55432/beacon_monitor_test_local' pnpm test:monitor:postgres
```

## CI 与 ICMP

`.github/workflows/monitor-validation.yml` 在 PR、master 推送或手动触发时：

- 创建空的 PostgreSQL 16 service，执行安全测试和上述真实数据库用例。
- 构建项目生产 runner 镜像，以默认 Docker 权限、`--network none` 和覆盖入口点的方式调用编译后的 PingRunner。
- 只检测 127.0.0.1 回环，不执行镜像默认的迁移/应用启动命令，不授予 privileged。

回环仅确认镜像包含 iputils、参数/输出兼容且该容器具备基本 ICMP 权限；不能证明生产网络、IPv6、公网连通性或部署平台权限正常。

2026-10-10 本机没有 PostgreSQL/Docker 可执行文件，也没有可用 WSL 发行版。已验证安全测试和缺少专用 URL 时提前拒绝；
真实 PostgreSQL 回放与 Linux runner 验收已提供可执行入口，但尚未在本机或远程 CI 实跑，不能记为通过。

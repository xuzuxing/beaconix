
作为一个监控系统，不应该只能监控http、tcp而已，其他的应该得支持
你说得对，只有 HTTP/TCP 确实太单薄了。参考 Peekaping（你之前调研过的开源项目），它支持 19 种监控类型。你的系统应该分层设计，而不是每种类型写一套代码。

一、监控类型分层
按协议和复杂度，分成三个层级：

基础层（V1.0 必做）

类型	说明	实现方式
HTTP(S)	状态码、响应体关键词、JSON 字段校验	fetch
TCP	端口连通性	net.Socket
Ping	ICMP 连通性和延迟	系统 ping 命令或 raw socket
DNS	域名解析、解析结果校验	dns.resolve
应用层（V1.1）

类型	说明
MySQL	连接测试 + SELECT 1
PostgreSQL	连接测试 + SELECT 1
Redis	PING 命令
MongoDB	ping 命令
Docker	容器状态查询
gRPC	health check 协议
WebSocket	连接建立 + 心跳
扩展层（V2.0）

类型	说明
MQTT	连接 + 主题订阅
Kafka	broker 连通性
SMTP	邮件服务器连通性
SSL 证书	到期时间（你之前已规划为 HTTP 附加选项）
关键词监控	HTTP 响应体包含/不包含指定关键词
JSON 查询	响应 JSON 中指定路径的值校验
二、架构调整：Checker 策略模式
现在的 HttpChecker 和 TcpChecker 是硬编码的。要支持多种类型，应该用策略模式：

text
src/modules/checker/
├── checker.service.ts              # 统一入口，根据 type 分发
├── scheduler.service.ts
├── checkers/
│   ├── checker.interface.ts        # 策略接口
│   ├── http.checker.ts
│   ├── tcp.checker.ts
│   ├── ping.checker.ts
│   ├── dns.checker.ts
│   ├── mysql.checker.ts
│   ├── redis.checker.ts
│   ├── postgres.checker.ts
│   ├── mongodb.checker.ts
│   ├── docker.checker.ts
│   ├── grpc.checker.ts
│   └── websocket.checker.ts
└── checker.registry.ts             # 策略注册表
策略接口：

typescript
export interface CheckerStrategy {
  readonly type: MonitorType;
  check(monitor: Monitor, config: any): Promise<CheckResult>;
}

export interface CheckResult {
  success: boolean;
  error?: string;
  latency: number;
  meta?: Record<string, any>;  // 各类型特有的附加信息
}
注册表：

typescript
@Injectable()
export class CheckerRegistry {
  private strategies = new Map<MonitorType, CheckerStrategy>();

  constructor(
    http: HttpChecker,
    tcp: TcpChecker,
    ping: PingChecker,
    dns: DnsChecker,
    mysql: MysqlChecker,
    redis: RedisChecker,
    // ...
  ) {
    this.register(http);
    this.register(tcp);
    this.register(ping);
    this.register(dns);
    this.register(mysql);
    this.register(redis);
  }

  private register(strategy: CheckerStrategy) {
    this.strategies.set(strategy.type, strategy);
  }

  get(type: MonitorType): CheckerStrategy {
    const s = this.strategies.get(type);
    if (!s) throw new Error(`不支持的监控类型: ${type}`);
    return s;
  }
}
CheckerService 改为通用：

typescript
async executeCheck(monitorId: string) {
  const monitor = await this.prisma.monitor.findUnique({ where: { id: monitorId } });
  if (!monitor || !monitor.enabled || monitor.deletedAt) return;

  const strategy = this.registry.get(monitor.type);
  const result = await strategy.check(monitor, monitor.config);

  // 记录日志、交给状态机
  await this.processResult(monitor, result);
}
三、Schema 调整
Monitor 表需要支持类型特有的配置。用 config JSON 字段存：

prisma
model Monitor {
  id               String      @id @default(uuid())
  organizationId   String
  name             String
  type             MonitorType      // 扩展枚举
  target           String           // 通用目标地址
  config           Json        @default("{}")  // 类型特有的配置

  interval         Int         @default(60)
  timeout          Int         @default(5000)
  failureThreshold Int         @default(3)
  enabled          Boolean     @default(true)

  // ... 原有字段
}

enum MonitorType {
  HTTP
  TCP
  PING
  DNS
  MYSQL
  POSTGRESQL
  REDIS
  MONGODB
  DOCKER
  GRPC
  WEBSOCKET
  // V2.0 扩展
  MQTT
  KAFKA
  SMTP
  SSL
}
config 示例：

json
// MySQL
{
  "host": "10.0.1.30",
  "port": 3306,
  "database": "mydb",
  "username": "monitor",
  "password": "***",
  "query": "SELECT 1"
}

// HTTP 关键词监控
{
  "expectedStatus": 200,
  "keyword": "healthy",
  "keywordMode": "contains",
  "jsonPath": "$.status",
  "jsonExpected": "ok"
}

// DNS
{
  "recordType": "A",
  "expectedValues": ["1.2.3.4"]
}

// gRPC
{
  "host": "10.0.1.40",
  "port": 50051,
  "service": "health.Health",
  "method": "Check"
}
为什么用 JSON 而不是独立表：每种类型的配置字段不同，用 JSON 最灵活，避免为每种类型建表。查询时不需要按 config 过滤，所以不用索引。

四、各类型实现要点
类型	依赖	核心逻辑
Ping	ping npm 包 或系统命令	发送 ICMP，测延迟
DNS	Node 内置 dns.promises	解析域名，校验结果
MySQL	mysql2	创建连接，执行 SELECT 1，关闭
PostgreSQL	pg	同上
Redis	ioredis	连接后 PING
MongoDB	mongodb	连接后 db.admin().ping()
Docker	dockerode	通过 Docker socket 查容器状态
gRPC	@grpc/grpc-js	调用 health check
WebSocket	ws	建立连接，等待 open 事件
MQTT	mqtt	连接 broker，订阅主题
Kafka	kafkajs	连接 broker，获取 metadata
SMTP	nodemailer	创建 transport，验证连接
关键设计：

所有 checker 必须实现超时，不能让某个类型的连接挂死

连接必须及时关闭，避免连接泄漏

密码等敏感字段加密存储，不能用明文

每个 checker 有独立的超时默认值（如 MySQL 连接超时默认 10s，HTTP 默认 5s）

五、配额和类型的关系
不同套餐支持不同数量的监控类型。比如：

套餐	支持的监控类型
FREE	HTTP, TCP, Ping
PRO	基础层 + 应用层
TEAM	全部
在 Plan 表加一个字段：

prisma
model Plan {
  // ...
  allowedMonitorTypes MonitorType[] @default([HTTP, TCP, PING])
}
创建监控时校验：

typescript
async assertMonitorTypeAllowed(orgId: string, type: MonitorType) {
  const plan = await this.effectivePlan.getEffectivePlan(orgId);
  if (!plan.allowedMonitorTypes.includes(type)) {
    throw new ForbiddenException({
      code: 'MONITOR_TYPE_NOT_ALLOWED',
      type,
      message: `当前套餐不支持 ${type} 监控，请升级套餐`,
    });
  }
}
六、前端展示
监控列表需要根据类型展示不同的图标和状态：

类型	图标	详情展示
HTTP	🌐	状态码、延迟、证书信息
TCP	🔌	端口、连接延迟
Ping	📡	延迟、丢包率
DNS	🌍	解析结果、TTL
MySQL	🐬	连接延迟、查询耗时
Redis	🔴	PING 延迟
Docker	🐳	容器状态、运行时长
创建监控时，根据选中的类型动态渲染配置表单。前端维护一个类型-配置字段的映射表。

七、实施优先级
阶段	类型	工作量
V1.0	HTTP, TCP, Ping, DNS	基础层，2-3 天
V1.1	MySQL, PostgreSQL, Redis, MongoDB	应用层，3-4 天
V1.2	Docker, gRPC, WebSocket	扩展层，3-4 天
V2.0	MQTT, Kafka, SMTP, SSL 关键词/JSON 校验	按需
建议：V1.0 先把 HTTP、TCP、Ping、DNS 做完，用策略模式把架构搭好。后续加新类型只需要写一个 Checker 类 + 注册到 Registry，不改核心逻辑。

八、总结
核心改动：

MonitorType 枚举扩展，Monitor 加 config JSON 字段

Checker 改为策略模式 + 注册表

每种类型一个独立 Checker 类，实现统一接口

配额增加 allowedMonitorTypes 限制

前端动态渲染配置表单

关键原则：架构上支持无限扩展，但实现上按优先级分批做。策略模式让加新类型变成「写一个类 + 注册一行」，不改动调度、状态机、通知任何现有逻辑。
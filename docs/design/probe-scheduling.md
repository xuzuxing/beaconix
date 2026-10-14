# 探针 + 动态调度业务详解

> 文档类型：调度设计记录。保留原始算法与生命周期示例；示例中优先级、负载均衡、绑定数量和回调形式存在简化，实际行为以 `src/modules/admin/system-probes/system-probe-scheduler.ts` 为准。当前上报协议见 [监控运行指南](../guides/monitoring-operations.md)。

## 一、核心规则

一句话定义：监控未绑定租户探针时，系统自动动态调度系统探针；已绑定租户探针时，只用租户自己的探针。

具体规则：

| 场景                   | 使用的探针                      | 来源                   |
| ---------------------- | ------------------------------- | ---------------------- |
| 监控绑定 0 个租户探针  | 系统探针（动态分配）            | Redis 分配表           |
| 监控绑定 1 个租户探针  | 租户探针 + 系统探针（补充双源） | monitor_probes + Redis |
| 监控绑定 ≥2 个租户探针 | 仅租户探针                      | monitor_probes         |
| 没有可用系统探针       | 仅本地检测                      | 降级                   |

判定逻辑：租户探针是「优先选项」，系统探针是「兜底选项」。租户绑定了足够多的探针，系统就不再介入。

## 二、数据结构

### 2.1 Probe 表的关键字段

```prisma
model Probe {
  id             String        @id @default(uuid())
  scope          ProbeScope    // SYSTEM | TENANT
  organizationId String?       // SYSTEM 为 null，TENANT 必填
  name           String
  provider       ProbeProvider
  region         String
  callbackUrl    String
  secret         String        @unique
  enabled        Boolean       @default(true)
  lastHeartbeat  DateTime?
  status         ProbeStatus   @default(OFFLINE)

  // 系统探针专属
  maxTenants Int? @default(0)  // 最多服务多少监控，null=不限
  priority   Int  @default(0)  // 调度优先级，数字越大越优先

  // ...
}
```

关键点：

scope 区分系统/租户探针

organizationId 系统探针为 null

maxTenants 和 priority 只对系统探针生效

### 2.2 Redis 分配表

系统探针的分配关系不落库，存在 Redis：

```text
Key: sys_probe:assignments
Value: {
  "probe_001": ["mon_001", "mon_002", "mon_003"],
  "probe_002": ["mon_004", "mon_005"]
}
TTL: 3600 秒（1 小时）
```

为什么存 Redis 不落库：

租户不需要知道系统探针的存在，落库容易被查询泄露

分配关系是动态的，随探针增减、监控增减实时调整

Redis 读取快，Checker 每次汇总都能快速拿到

## 三、动态调度算法

### 3.1 触发时机

rebalance() 在以下情况被调用：

| 触发事件          | 说明                       |
| ----------------- | -------------------------- |
| 系统探针新增/删除 | admin 操作后重新分配       |
| 系统探针启用/停用 | 探针状态变化               |
| 监控新增/删除     | 监控数量变化               |
| 定时任务          | 每小时自动 rebalance 一次  |
| 手动触发          | admin 后台点击「重新分配」 |

### 3.2 分配算法

```typescript
async rebalance() {
  // 1. 获取所有启用的系统探针
  const probes = await this.prisma.probe.findMany({
    where: { scope: 'SYSTEM', enabled: true },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  });

  if (probes.length === 0) {
    await this.redis.del('sys_probe:assignments');
    return;
  }

  // 2. 获取所有需要系统探针的监控
  const monitors = await this.prisma.monitor.findMany({
    where: { enabled: true, deletedAt: null },
    include: { probes: true },  // 租户绑定的探针
  });

  // 3. 过滤：租户已绑定 ≥2 个探针的，不需要系统探针
  const needSystemProbe = monitors.filter(m => m.probes.length < 2);

  // 4. 初始化分配表
  const assignments: Record<string, string[]> = {};
  const probeLoad: Record<string, number> = {};
  probes.forEach(p => {
    assignments[p.id] = [];
    probeLoad[p.id] = 0;
  });

  // 5. 按优先级轮询分配
  for (const monitor of needSystemProbe) {
    // 选择负载最低且未超限的探针
    const available = probes.filter(p =>
      !p.maxTenants || probeLoad[p.id] < p.maxTenants
    );
    if (available.length === 0) continue;

    const selected = available.reduce((min, p) =>
      probeLoad[p.id] < probeLoad[min.id] ? p : min
    );

    assignments[selected.id].push(monitor.id);
    probeLoad[selected.id]++;
  }

  // 6. 存入 Redis
  await this.redis.setex('sys_probe:assignments', 3600, JSON.stringify(assignments));

  this.logger.log(
    `系统探针分配完成: ${probes.length} 个探针，` +
    `${Object.values(assignments).flat().length} 个监控`
  );
}
```

算法特点：

优先级优先：priority 高的探针优先分配

负载均衡：每个探针分配到的监控数尽量平均

上限约束：不超过 maxTenants

跳过已满足的：租户绑定 ≥2 个探针的监控不再分配系统探针

### 3.3 分配示例

假设：

系统探针 A（priority=10，maxTenants=3）

系统探针 B（priority=5，maxTenants=5）

系统探针 C（priority=1，maxTenants=null）

需要系统探针的监控：mon_1 ~ mon_8

分配过程：

```text
mon_1 → A（A负载1，最高优先级）
mon_2 → A（A负载2）
mon_3 → A（A负载3，达到maxTenants=3）
mon_4 → B（A已满，B最高可用优先级）
mon_5 → B（B负载2）
mon_6 → B（B负载3）
mon_7 → B（B负载4）
mon_8 → B（B负载5，达到maxTenants=5）

C 没有分配到任何监控
```

结果：

```json
{
  "probe_A": ["mon_1", "mon_2", "mon_3"],
  "probe_B": ["mon_4", "mon_5", "mon_6", "mon_7", "mon_8"],
  "probe_C": []
}
```

## 四、Checker 汇总逻辑

Checker 汇总时，需要同时考虑租户探针和系统探针。

```typescript
async aggregateByTarget(target: string) {
  const monitor = await this.prisma.monitor.findFirst({
    where: { target, deletedAt: null },
    include: { probes: true },  // 租户绑定的探针
  });
  if (!monitor) return;

  // 1. 本地检测结果
  const localLog = await this.prisma.checkLog.findFirst({
    where: { monitorId: monitor.id, source: 'LOCAL' },
    orderBy: { checkedAt: 'desc' },
  });

  // 2. 租户探针结果
  const tenantProbeIds = monitor.probes.map(mp => mp.probeId);
  const tenantResults = await this.getValidProbeResults(target, tenantProbeIds);

  // 3. 系统探针结果（动态获取分配关系）
  const systemProbeIds = await this.systemProbeScheduler.getAssignedProbes(monitor.id);
  const systemResults = await this.getValidProbeResults(target, systemProbeIds);

  // 4. 合并所有探针结果
  const allProbeResults = [...tenantResults, ...systemResults];

  // 5. 双源判定
  const finalSuccess = this.evaluate(localLog, allProbeResults);

  await this.processResult(monitor, {
    success: finalSuccess,
    error: this.buildError(localLog, allProbeResults),
    latency: localLog?.latency || 0,
  });
}

private async getValidProbeResults(target: string, probeIds: string[]) {
  if (probeIds.length === 0) return [];
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
  return this.prisma.probeResult.findMany({
    where: {
      target,
      probeId: { in: probeIds },
      checkedAt: { gte: twoMinAgo },
    },
    orderBy: { checkedAt: 'desc' },
  });
}

private evaluate(local: any, probes: any[]): boolean {
  if (!local && probes.length === 0) return false;
  if (local?.success) return true;
  if (probes.some(p => p.success)) return true;
  return false;
}
```

关键点：

租户探针结果和系统探针结果合并后统一判定

任意一个探针成功 → UP

所有探针 + 本地都失败 → DOWN

租户探针和系统探针在判定逻辑中没有区别

## 五、获取系统探针分配

```typescript
// src/modules/admin/system-probe/system-probe-scheduler.ts
async getAssignedProbes(monitorId: string): Promise<string[]> {
  const raw = await this.redis.get('sys_probe:assignments');
  if (!raw) return [];

  const assignments = JSON.parse(raw) as Record<string, string[]>;
  return Object.entries(assignments)
    .filter(([_, monitorIds]) => monitorIds.includes(monitorId))
    .map(([probeId]) => probeId);
}
```

性能优化：可以缓存分配表到内存，避免每次汇总都查 Redis。但 V1.0 直接用 Redis 即可，读取延迟 <1ms。

## 六、探针回调处理

系统探针和租户探针共用同一个回调接口，通过 secret 区分。

```typescript
async handleCallback(dto: ProbeCallbackDto) {
  const probe = await this.prisma.probe.findUnique({
    where: { secret: dto.secret },
  });
  if (!probe || !probe.enabled) {
    throw new UnauthorizedException('探针未授权或已停用');
  }

  // 更新心跳
  await this.prisma.probe.update({
    where: { id: probe.id },
    data: { lastHeartbeat: new Date(), status: 'ONLINE' },
  });

  // 记录执行日志
  await this.prisma.probeExecution.create({
    data: {
      probeId: probe.id,
      target: dto.target,
      trigger: 'SCHEDULED',
      status: dto.success ? 'SUCCESS' : dto.error?.includes('超时') ? 'TIMEOUT' : 'FAILED',
      success: dto.success,
      latency: dto.latency,
      error: dto.error,
    },
  });

  // 存储检测结果
  await this.prisma.probeResult.create({
    data: {
      probeId: probe.id,
      target: dto.target,
      success: dto.success,
      error: dto.error,
      latency: dto.latency,
    },
  });

  // 触发双源汇总
  await this.checker.aggregateByTarget(dto.target);

  return { code: 0 };
}
```

关键点：

探针端不需要知道自己是系统探针还是租户探针

探针只负责「探测 + 回调」

probe.scope 在服务端用于区分管理权限，不影响回调逻辑

## 七、系统探针的生命周期

### 7.1 创建

```text
Admin 在后台创建系统探针
  → 生成 secret（sys_ 前缀）
  → 写入 probes 表（scope=SYSTEM, organizationId=null）
  → 调用 rebalance() 重新分配
```

### 7.2 部署

```text
Admin 在腾讯云 SCF 创建函数
  → 配置定时触发器
  → 入参填入 secret + callbackUrl + 目标列表
  → 探针开始回调
```

### 7.3 停用

```text
Admin 点击停用
  → probes.enabled = false
  → 调用 rebalance()
  → 该探针的监控重新分配给其他探针
```

### 7.4 删除

```text
Admin 删除
  → 级联删除 probe_results、probe_executions
  → 调用 rebalance()
  → 该探针的监控重新分配
```

## 八、租户探针的生命周期

### 8.1 创建

```text
租户创建探针
  → 生成 secret（tnt_ 前缀）
  → 写入 probes 表（scope=TENANT, organizationId=org_xxx）
  → 不触发 rebalance（不影响系统探针）
```

### 8.2 绑定监控

```text
租户创建监控时选择探针
  → 写入 monitor_probes 表
  → 如果绑定 ≥2 个探针，下次 rebalance 时跳过系统探针
```

### 8.3 停用/删除

```text
租户停用探针
  → probes.enabled = false
  → 该探针的结果不再参与汇总
  → 如果监控因此变成 <2 个探针，下次 rebalance 时重新分配系统探针
```

## 九、定时刷新分配表

分配表有 1 小时 TTL，需要定期刷新：

```typescript
// src/modules/admin/system-probe/system-probe-scheduler.ts
@Injectable()
export class SystemProbeScheduler implements OnModuleInit {
  @Cron(CronExpression.EVERY_HOUR)
  async refreshAssignments() {
    await this.rebalance();
  }

  async onModuleInit() {
    // 启动时立即分配一次
    await this.rebalance();
  }
}
```

为什么需要定期刷新：

监控可能被新增/删除，分配表需要更新

探针可能上下线，需要重新分配

TTL 到期后 Redis key 消失，需要重新写入

## 十、边界情况处理

| 场景                   | 处理                                                  |
| ---------------------- | ----------------------------------------------------- |
| 系统探针全部离线       | rebalance() 跳过离线探针，只分配给在线探针            |
| 系统探针全部停用       | Redis 分配表清空，监控降级为仅本地检测                |
| 租户绑定探针但探针离线 | 汇总时跳过离线探针，回退到系统探针或本地              |
| 监控 target 变更       | 重新触发 rebalance（target 变更可能影响分配）         |
| 探针回调结果过期       | 超过 2 分钟的结果不参与汇总                           |
| Redis 不可用           | getAssignedProbes() 返回空数组，降级为租户探针 + 本地 |

## 十一、完整数据流

```text
┌─────────────────────────────────────────────────────────────────┐
│                        Admin 侧                                 │
│                                                                 │
│  创建系统探针 → probes 表（scope=SYSTEM）                        │
│       ↓                                                         │
│  调用 rebalance()                                               │
│       ↓                                                         │
│  读取所有系统探针 + 所有监控                                     │
│       ↓                                                         │
│  按 priority + maxTenants 分配                                  │
│       ↓                                                         │
│  写入 Redis: sys_probe:assignments                              │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Checker 侧                                │
│                                                                 │
│  定时触发 executeCheck()                                        │
│       ↓                                                         │
│  本地检测 → check_logs                                          │
│       ↓                                                         │
│  探针回调 → probe_results                                       │
│       ↓                                                         │
│  aggregateByTarget()                                            │
│       ├── 读取租户探针（monitor_probes）                         │
│       ├── 读取系统探针（Redis 分配表）                           │
│       ├── 合并结果                                              │
│       └── 双源判定                                              │
│       ↓                                                         │
│  State.process() → 状态变更判断                                 │
│       ↓                                                         │
│  Notifier.notify() → 队列 → 飞书/微信                           │
└─────────────────────────────────────────────────────────────────┘
```

## 十二、关键设计决策

| 决策             | 选择                         | 理由                 |
| ---------------- | ---------------------------- | -------------------- |
| 系统探针分配存储 | Redis（不落库）              | 租户不可见，动态调整 |
| 分配算法         | 优先级 + 负载均衡            | 充分利用探针资源     |
| 租户探针绑定     | monitor_probes 表            | 租户可见、可管理     |
| 回调接口         | 统一入口，secret 区分        | 简化探针端实现       |
| 定期刷新         | 每小时 rebalance             | 动态适应监控变化     |
| 降级策略         | 无探针时仅本地检测           | 保证系统可用性       |
| 判定规则         | 本地 + 所有探针都失败才 DOWN | 过滤单点网络抖动     |

总结：系统探针是平台的「隐形基础设施」，通过 Redis 动态分配，租户完全无感知；租户探针是租户的「私有资产」，通过 monitor_probes 显式绑定。核心规则是：租户绑定 ≥2 个探针时系统不介入，否则动态调度系统探针兜底。两者在 Checker 汇总时合并结果，但管理边界和执行日志完全隔离。

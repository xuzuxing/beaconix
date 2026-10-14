# 暗哨（Beacon Watch）开发设计文档

> 文档类型：历史归档。原文中的“当前状态”、缺口、示例和阶段计划均属于当时的设计快照，不代表最新实现；日常使用请从 [文档索引](../README.md) 查找现行接口与运行指南。

## 文档信息

| 项目     | 内容                                                |
| -------- | --------------------------------------------------- |
| 项目名称 | 暗哨 Beacon Watch                                   |
| 文档版本 | V1.0                                                |
| 技术栈   | NestJS 11 + Prisma v7 + PostgreSQL + Redis + BullMQ |
| 文档目的 | 指导开发团队完成监控核心链路的实现                  |
| 目标读者 | 后端开发、架构师、测试工程师                        |

## 一、系统概述

### 1.1 产品定位

暗哨是一个部署在公网、守望内网服务的轻量级监控告警平台。核心能力是：通过内网 Agent 或云探针检测服务可用性，状态异常时通过多渠道即时告警。

### 1.2 核心链路

```text
创建监控 → 注册调度 → 执行检测 → 双源汇总 → 状态判断 → 触发通知 → 送达渠道
```

### 1.3 模块总览

| 模块           | 职责         | 核心输出                 |
| -------------- | ------------ | ------------------------ |
| MonitorsModule | 定义监控什么 | 监控配置                 |
| ProbeModule    | 定义谁来探   | 探针结果、心跳、校验应答 |
| CheckerModule  | 执行怎么探   | 聚合后的检测结论         |
| StateModule    | 判断是否异常 | 状态变更事件             |
| NotifierModule | 负责通知谁   | 通知送达记录             |

## 二、技术架构

### 2.1 整体架构图

```text
┌─────────────────────────────────────────────────────────────────┐
│                    NestJS 主服务（公网 SaaS）                     │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ MonitorsMod  │  │ ProbeModule  │  │ CheckerModule        │  │
│  │ 监控配置      │  │ 探针管理      │  │ ┌──────────┐         │  │
│  │ CRUD         │  │ 回调接收      │  │ │Scheduler │         │  │
│  └──────┬───────┘  └──────┬───────┘  │ │本地检测  │         │  │
│         │                 │          │ │双源汇总  │         │  │
│         │                 │          │ └──────────┘         │  │
│         │                 │          └──────────┬───────────┘  │
│         │                 │                     │              │
│         │                 │                     ▼              │
│         │                 │          ┌──────────────────────┐  │
│         │                 │          │ StateModule          │  │
│         │                 │          │ 状态机 + 故障阈值     │  │
│         │                 │          └──────────┬───────────┘  │
│         │                 │                     │              │
│         │                 │                     ▼              │
│         │                 │          ┌──────────────────────┐  │
│         │                 │          │ NotifierModule       │  │
│         │                 │          │ 队列 + 多渠道         │  │
│         │                 │          └──────────────────────┘  │
│         │                 │                                    │
│  ┌──────┴─────────────────┴────────────────────────────────┐  │
│  │ Infra: Prisma / Redis / Wechat / Config / Logger        │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         ▲                                    │
         │ 探针回调                            │ 通知推送
         │                                    ▼
┌────────┴────────┐                  ┌─────────────────┐
│ 腾讯云 SCF 探针  │                  │ 飞书/微信/邮件   │
│ 阿里云 FC 探针   │                  └─────────────────┘
└─────────────────┘
```

### 2.2 技术选型

| 层级        | 技术           | 版本   | 选型理由                  |
| ----------- | -------------- | ------ | ------------------------- |
| 框架        | NestJS         | 11     | 模块化 + DI，适合长期维护 |
| ORM         | Prisma         | v7     | 类型安全，ESM 原生支持    |
| 数据库      | PostgreSQL     | 16     | 并发写入强，支持 RLS      |
| 缓存/队列   | Redis + BullMQ | 7      | 异步通知，失败重试        |
| 运行时      | Node.js        | 20.19+ | Prisma v7 最低要求        |
| HTTP 客户端 | 原生 fetch     | —      | 无需额外依赖              |

### 2.3 关键设计决策

| 决策       | 选择                      | 理由                         |
| ---------- | ------------------------- | ---------------------------- |
| 架构形态   | 模块化单体                | 小团队交付，避免微服务复杂度 |
| 多租户隔离 | organizationId 行级       | V1.0 简单可靠                |
| 检测架构   | 本地 + 云探针双源确认     | 过滤单点网络抖动             |
| 状态存储   | MonitorState 独立表       | 避免频繁更新主表             |
| 通知方式   | Redis 队列异步            | 不阻塞检测主流程             |
| 软删除     | Monitor 用 deletedAt      | 保留历史数据                 |
| 探针通信   | 纯出站心跳 + 挑战应答校验 | 探针无需公网入站端口         |
| 校验安全   | HKDF-SHA256 + AES-256-GCM | 挑战一次性、TTL 防重放       |

## 三、数据模型

### 3.1 核心表关系

```text
Organization (组织/租户)
    │
    ├── Monitor (监控目标)
    │       ├── MonitorState (状态，1:1)
    │       └── MonitorProbe (探针绑定，N:M)
    │               │
    │               └── Probe (探针)
    │                       └── ProbeResult (探针检测结果)
    │
    ├── CheckLog (本地检测历史)
    ├── NotificationChannel (通知渠道配置)
    │       └── NotificationLog (通知日志)
    └── StatusPage (状态页)
```

### 3.2 枚举定义

| 枚举                    | 值                                               | 用途         |
| ----------------------- | ------------------------------------------------ | ------------ |
| MonitorType             | HTTP, TCP                                        | 监控类型     |
| MonitorStatus           | UNKNOWN, UP, DEGRADED, DOWN, PAUSED              | 状态机       |
| ProbeProvider           | TENCENT, ALIYUN, CUSTOM                          | 探针云厂商   |
| ProbeStatus             | ONLINE, OFFLINE                                  | 探针在线状态 |
| CheckSource             | LOCAL, PROBE                                     | 检测来源     |
| NotificationChannelType | FEISHU, WECOM, DINGTALK, WECHAT_SUBSCRIBE, EMAIL | 通知渠道     |
| NotificationStatus      | SUCCESS, FAILED                                  | 通知结果     |

### 3.3 关键字段说明

Monitor 表

| 字段             | 说明                          |
| ---------------- | ----------------------------- |
| interval         | 检测间隔（秒），范围 10–3600  |
| timeout          | 超时（毫秒），范围 1000–30000 |
| expectedStatus   | HTTP 期望状态码               |
| failureThreshold | 连续失败 N 次才告警           |
| deletedAt        | 软删除标记                    |

MonitorState 表

| 字段               | 说明                       |
| ------------------ | -------------------------- |
| status             | 当前状态                   |
| failCount          | 连续失败计数               |
| lastNotifiedStatus | 上次已通知的状态，用于去重 |
| lastCheckAt        | 最后检测时间               |
| lastError          | 最后错误信息               |
| lastLatency        | 最后延迟                   |

Probe 表

| 字段          | 说明                             |
| ------------- | -------------------------------- |
| secret        | 探针鉴权密钥，唯一               |
| lastHeartbeat | 最后心跳时间                     |
| status        | 动态计算：2 分钟无心跳 → OFFLINE |

## 四、模块详细设计

### 4.1 MonitorsModule

职责：管理监控配置，触发调度注册。

核心接口

```text
POST   /projects/:projectId/monitors       创建监控
GET    /projects/:projectId/monitors       列表
GET    /projects/:projectId/monitors/:id   详情
PATCH  /projects/:projectId/monitors/:id   更新
POST   /projects/:projectId/monitors/:id/pause   暂停
POST   /projects/:projectId/monitors/:id/resume  恢复
DELETE /projects/:projectId/monitors/:id   软删除
```

核心业务逻辑

创建监控时：

校验 target 格式（HTTP 必须以 http:// 或 https:// 开头；TCP 必须为 host:port）

写入 monitors 表 + 初始化 monitor_states（status=UNKNOWN）

调用 SchedulerService.registerMonitor() 注册定时器

立即执行一次检测，建立基线

更新监控时：

target/type 变更 → 重置状态（failCount=0，status=UNKNOWN）

先注销旧调度，再注册新调度

删除监控时：

软删除（设置 deletedAt）

注销调度器

关键代码

```typescript
async create(organizationId: string, dto: CreateMonitorDto) {
  this.validateTarget(dto);
  const monitor = await this.repo.create(organizationId, dto);
  if (monitor.enabled) {
    this.scheduler.registerMonitor(monitor);
  }
  return monitor;
}
```

### 4.2 ProbeModule

职责：管理探针注册、心跳、结果接收与手动校验。

核心接口（后台）

```text
POST   /organizations/:orgId/probes                创建租户探针
GET    /organizations/:orgId/probes                探针列表
GET    /organizations/:orgId/probes/:id            探针详情
PATCH  /organizations/:orgId/probes/:id            更新探针
POST   /organizations/:orgId/probes/:id/rotate-secret  轮换密钥
POST   /organizations/:orgId/probes/:id/validate   手动触发校验挑战
POST   /organizations/:orgId/probes/:id/monitors   绑定监控
DELETE /organizations/:orgId/probes/:id/monitors/:monitorId  解绑监控
DELETE /organizations/:orgId/probes/:id            删除探针

系统探针（SUPER_ADMIN）：

text
POST   /admin/system-probes              创建系统探针
GET    /admin/system-probes              系统探针列表
PATCH  /admin/system-probes/:id          更新系统探针
PATCH  /admin/system-probes/:id/toggle   启用/停用
POST   /admin/system-probes/:id/validate 手动触发校验挑战
DELETE /admin/system-probes/:id          删除系统探针

探针 Agent 接口（`x-probe-secret` 认证）

text
POST   /probes/heartbeat                          心跳：上报在线，返回分配的监控
POST   /probes/results                            批量上报检测结果
POST   /probes/validation/pull                    拉取待处理校验挑战
POST   /probes/validation/:validationId/answer    提交校验应答

```

核心业务逻辑

创建探针时：

- 生成唯一 `secret`：租户探针 `tnt_` 前缀、系统探针 `sys_` 前缀，各加 32 字节随机 hex。
- 返回探针 `id + secret`，由用户配置到探针脚本/SCF 环境变量。

心跳时：

- 验证 `x-probe-secret`，检查 `enabled`。
- 更新 `lastHeartbeat=now`、`status=ONLINE`，写入 `ProbeExecution`。
- 返回分配给该探针的监控列表（`id/name/type/target/interval/timeout/expectedStatus`）与 `serverTime`。

结果上报时：

- 验证 `x-probe-secret`。
- 批量写入 `probe_results` 表。
- 按 `target` 触发 `CheckerService` 双源汇总。

手动校验（挑战-应答）：

- 后台触发后生成校验挑战存 Redis（`probe:validation:<probeId>`，TTL 120s）。
- 挑战明文 `{ nonce, issuedAt }`，用 `HKDF-SHA256(secret) + AES-256-GCM` 加密。
- 探针 Agent 拉取挑战 → 解密 → 回传 `{ nonce, answeredAt }` 密文。
- 后端验签 `nonce`（`timingSafeEqual`）后删除挑战、标记探针 `ONLINE`，
  并写入 `ProbeExecution(trigger=MANUAL, target=validation, status=SUCCESS)`。

探针状态判断

```typescript
private calcStatus(lastHeartbeat: Date | null): string {
  if (!lastHeartbeat) return 'OFFLINE';
  const twoMin = 2 * 60 * 1000;
  return Date.now() - lastHeartbeat.getTime() < twoMin ? 'ONLINE' : 'OFFLINE';
}
```

探针与监控绑定

通过 monitor_probes 多对多表管理

创建监控时可选 probeIds，更新时全量替换

### 4.3 CheckerModule

职责：执行本地检测，汇总探针结果，输出最终结论。

核心组件

| 组件             | 职责                                   |
| ---------------- | -------------------------------------- |
| SchedulerService | 定时调度，应用启动时加载所有启用的监控 |
| CheckerService   | 执行检测 + 双源汇总                    |
| HttpChecker      | HTTP 检测                              |
| TcpChecker       | TCP 检测                               |

SchedulerService 启动流程

```typescript
async onModuleInit() {
  const monitors = await this.prisma.monitor.findMany({
    where: { enabled: true, deletedAt: null },
  });
  for (const m of monitors) {
    this.registerMonitor(m);
  }
}
```

本地检测流程

```typescript
async executeCheck(monitorId: string) {
  const monitor = await this.prisma.monitor.findUnique({ where: { id: monitorId } });
  if (!monitor || !monitor.enabled || monitor.deletedAt) return;

  const result = await this.runCheck(monitor);

  // 记录日志
  await this.prisma.checkLog.create({
    data: { monitorId, success: result.success, latency: result.latency, error: result.error, source: 'LOCAL' },
  });

  // 交给状态机
  await this.processResult(monitor, result);
}
```

双源汇总流程

```typescript
async aggregateByTarget(target: string) {
  const monitor = await this.prisma.monitor.findFirst({
    where: { target, deletedAt: null },
  });
  if (!monitor) return;

  // 本地最新结果
  const localLog = await this.prisma.checkLog.findFirst({
    where: { monitorId: monitor.id, source: 'LOCAL' },
    orderBy: { checkedAt: 'desc' },
  });

  // 有效探针结果（2 分钟内）
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
  const probeResults = await this.prisma.probeResult.findMany({
    where: { target, checkedAt: { gte: twoMinAgo } },
    orderBy: { checkedAt: 'desc' },
  });

  const finalSuccess = this.evaluate(localLog, probeResults);
  await this.processResult(monitor, {
    success: finalSuccess,
    error: this.buildError(localLog, probeResults),
    latency: localLog?.latency || 0,
  });
}
```

双源判定规则

| 场景                   | 判定             | 理由             |
| ---------------------- | ---------------- | ---------------- |
| 本地成功               | UP               | 直接确认         |
| 本地失败，任意探针成功 | UP               | 过滤本地网络抖动 |
| 本地失败，所有探针失败 | DOWN             | 双源确认         |
| 无有效探针             | 仅以本地结果为准 | 探针不可用降级   |
| 探针结果过期（>2分钟） | 排除该探针       | 避免探针故障误报 |

HTTP 检测实现

```typescript
async check(target: string, timeout: number, expectedStatus: number): Promise<CheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(target, { signal: controller.signal, redirect: 'follow' });
    const latency = Date.now() - start;
    if (res.status !== expectedStatus) {
      return { success: false, error: `状态码 ${res.status}，期望 ${expectedStatus}`, latency };
    }
    return { success: true, latency };
  } catch (err: any) {
    const latency = Date.now() - start;
    const reason = err.name === 'AbortError' ? `超时 (${timeout}ms)` : err.message;
    return { success: false, error: reason, latency };
  } finally {
    clearTimeout(timer);
  }
}
```

TCP 检测实现

```typescript
check(target: string, timeout: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const [host, portStr] = target.split(':');
    const port = parseInt(portStr, 10);
    const socket = new net.Socket();
    let settled = false;

    const done = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);
    socket.on('connect', () => done({ success: true, latency: Date.now() - start }));
    socket.on('timeout', () => done({ success: false, error: `连接超时 (${timeout}ms)`, latency: Date.now() - start }));
    socket.on('error', (err) => done({ success: false, error: err.message, latency: Date.now() - start }));
    socket.connect(port, host);
  });
}
```

### 4.4 StateModule

职责：根据检测结果判断状态，决定是否触发通知。

状态定义

| 状态     | 含义             | 是否告警 |
| -------- | ---------------- | -------- |
| UNKNOWN  | 初始状态         | 否       |
| UP       | 正常             | 否       |
| DEGRADED | 有失败但未达阈值 | 否       |
| DOWN     | 连续失败达到阈值 | 是       |
| PAUSED   | 手动暂停         | 否       |

状态转换规则

```text
成功 → 重置失败计数 → UP
失败 → failCount + 1
  ├─ failCount < threshold → DEGRADED（若当前是 UP）
  └─ failCount >= threshold → DOWN
```

通知触发规则

| 当前状态 | 上次通知状态 | 动作               |
| -------- | ------------ | ------------------ |
| UP       | UP           | 无                 |
| DEGRADED | UP           | 无（中间态不告警） |
| DOWN     | UP/DEGRADED  | 发送告警           |
| UP       | DOWN         | 发送恢复           |
| 首次     | null         | 只建基线，不通知   |

核心实现

```typescript
async process(monitorId, failureThreshold, result) {
  const state = await this.prisma.monitorState.findUnique({ where: { monitorId } });
  const newStatus = this.transition(state.status, state.failCount, result, failureThreshold);
  const failCount = result.success ? 0 : state.failCount + 1;

  await this.prisma.monitorState.update({
    where: { monitorId },
    data: { status: newStatus, failCount, lastCheckAt: new Date(), lastError: result.success ? null : result.error, lastLatency: result.latency },
  });

  const shouldNotify = this.shouldNotify(state.lastNotifiedStatus, newStatus);
  if (shouldNotify) {
    await this.prisma.monitorState.update({
      where: { monitorId },
      data: { lastNotifiedStatus: newStatus },
    });
  }
  return { shouldNotify, newStatus };
}

private shouldNotify(lastNotified, newStatus): boolean {
  if (lastNotified === null) return false;  // 首次检测
  if (lastNotified === newStatus) return false;  // 状态未变更
  if (newStatus === 'DOWN') return true;  // 告警
  if (newStatus === 'UP' && lastNotified === 'DOWN') return true;  // 恢复
  return false;
}
```

关键设计

DEGRADED 是缓冲态：UP → DEGRADED 不通知，只有 DEGRADED → DOWN 才告警。单次抖动不会误报。

首次检测只建基线：lastNotifiedStatus 初始为 null，避免系统启动时误报。

### 4.5 NotifierModule

职责：把状态变更事件推送到用户配置的渠道。

核心组件

| 组件                  | 职责                   |
| --------------------- | ---------------------- |
| NotifierService       | 通知分发入口，写入队列 |
| NotificationProcessor | 队列消费者，执行推送   |
| FeishuChannel         | 飞书 Webhook 通道      |
| NotifierRepository    | 渠道查询、日志记录     |

通知流程

```text
State 触发通知 → NotifierService.notify() → 写入 Redis 队列
                                              ↓
                                    NotificationProcessor.process()
                                              ↓
                                    并发推送到所有配置渠道
                                              ↓
                                    记录通知日志（成功/失败）
                                              ↓
                                    失败 → 自动重试（最多 3 次）
```

核心实现

```typescript
async notify(organizationId, monitorId, monitorName, target, status, error?) {
  const channels = await this.repo.findEnabledChannels(organizationId);
  if (channels.length === 0) return;

  await this.queue.add('send', {
    monitorId, monitorName, target, status, error,
    time: new Date().toISOString(),
    channels: channels.map(c => ({ id: c.id, type: c.type, config: c.config })),
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  });
}
```

队列消费者

```typescript
@Processor('notification')
async process(job: Job) {
  const { monitorId, monitorName, target, status, error, time, channels } = job.data;

  for (const channel of channels) {
    try {
      if (channel.type === 'FEISHU') {
        await this.feishu.send(channel.config.webhook, { monitorName, target, status, error, time });
      }
      await this.repo.log({ monitorId, channelId: channel.id, status: 'SUCCESS' });
    } catch (err) {
      await this.repo.log({ monitorId, channelId: channel.id, status: 'FAILED', error: err.message });
    }
  }
}
```

飞书卡片格式

```json
{
  "msg_type": "interactive",
  "card": {
    "header": {
      "title": { "content": "❌ 服务异常", "tag": "plain_text" },
      "template": "red"
    },
    "elements": [
      { "tag": "div", "text": { "tag": "lark_md", "content": "**服务**：订单API" } },
      { "tag": "div", "text": { "tag": "lark_md", "content": "**地址**：https://internal/health" } },
      { "tag": "div", "text": { "tag": "lark_md", "content": "**原因**：状态码 500" } },
      { "tag": "div", "text": { "tag": "lark_md", "content": "**时间**：2026-10-04 10:30:00" } }
    ]
  }
}
```

关键设计

通知失败不阻塞检测：Promise.allSettled 并发推送，一个渠道失败不影响其他渠道。

队列解耦：检测和通知异步化，检测频率高时不会因为通知慢而堆积。

失败重试：BullMQ 指数退避，最多 3 次。

### 4.6 探针 Agent CLI（probes/agent/）

职责：部署在服务器/云厂商上的探针执行程序，纯出站，不监听任何端口。

入口清单

| 文件                             | 运行方式         | 用途                                         |
| -------------------------------- | ---------------- | -------------------------------------------- |
| probes/agent/bin/beacon-probe.js | CLI（常驻/单次） | 心跳 → 执行监控 → 上报结果；支持校验挑战应答 |
| probes/agent/functions/scf.js    | 腾讯云 SCF 入口  | 云函数每次触发执行一轮                       |

命令

```text
beacon-probe login                       # OAuth2 设备码注册
beacon-probe enroll --enroll-token <t>   # 用 Web 下发的一次性 token 注册
beacon-probe run                         # 常驻模式，周期执行
beacon-probe run --once                  # 只跑一轮
beacon-probe validate                    # 部署校验（HTTPS + 心跳 + key 匹配）
beacon-probe heartbeat                   # 单次心跳，用于排查
beacon-probe start|stop|restart|status   # systemd/launchd 服务管理
node probes/agent/functions/scf.js       # 本地调试 SCF 入口

```

配置（优先级：CLI > 环境变量 > JSON 配置文件）

| 配置            | 环境变量                   | 默认值                    | 说明                    |
| --------------- | -------------------------- | ------------------------- | ----------------------- |
| apiUrl          | BEACON_API_URL             | http://localhost:3000/api | 后台 API 根地址         |
| key             | PROBE_KEY                  | —                         | 探针 id（后台返回）     |
| token           | PROBE_TOKEN / PROBE_SECRET | —                         | 探针 secret（后台返回） |
| intervalSeconds | PROBE_INTERVAL_SECONDS     | 60                        | 常驻模式心跳间隔        |
| timeoutMs       | PROBE_TIMEOUT_MS           | 5000                      | 请求/检测超时           |
| allowInsecure   | PROBE_ALLOW_INSECURE       | false                     | 是否允许 http 明文地址  |

执行链路

```text
pollValidation()（有挑战则解密应答）
  -> heartbeat() -> monitors
  -> HTTP/TCP check
  -> report(results)

```

校验算法

```text
HKDF-SHA256(secret, info="beacon-probe-validation-v1") → 32 字节密钥
AES-256-GCM 加解密挑战/应答，nonce 一次性，TTL 120s 防重放

```

## 五、完整链路时序

### 5.1 正常检测（双源成功）

```text
Scheduler → Checker.executeCheck() → HttpChecker.check() → 成功
                                              ↓
                                    State.process() → UP（不变）
                                              ↓
                                    不通知
```

### 5.2 异常告警（双源失败）

```text
Scheduler → Checker.executeCheck() → 本地失败
                                              ↓
Probe → POST /probes/results → Checker 双源汇总 → 探针失败
                                              ↓
                                    双源汇总 → DOWN
                                              ↓
                                    State.process() → 状态变更
                                              ↓
                                    Notifier.notify() → 队列 → 飞书告警
```

### 5.3 恢复通知

```text
Scheduler → Checker.executeCheck() → 成功
                                              ↓
                                    State.process() → DOWN → UP
                                              ↓
                                    Notifier.notify() → 恢复通知
```

### 5.4 探针过期降级

```text
Probe 停止心跳 > 2分钟
        ↓
Checker.aggregateByTarget() → 探针结果过期，排除
        ↓
仅以本地结果为准
        ↓
避免探针故障导致误报
```

## 六、部署方案

### 6.1 环境要求

| 组件       | 版本   | 说明               |
| ---------- | ------ | ------------------ |
| Node.js    | 20.19+ | Prisma v7 最低要求 |
| PostgreSQL | 16     | 主数据库           |
| Redis      | 7      | 通知队列           |

### 6.2 Docker Compose

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: nestwatch
      POSTGRES_PASSWORD: nestwatch
      POSTGRES_DB: nestwatch
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data

volumes:
  pgdata:
  redisdata:
```

### 6.3 环境变量

```bash
DATABASE_URL="postgresql://nestwatch:nestwatch@localhost:5432/nestwatch"
REDIS_HOST=localhost
REDIS_PORT=6379
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
```

### 6.4 启动命令

```bash
docker compose up -d
npx prisma migrate dev
npx prisma generate
npm run start:dev
```

### 6.5 探针部署

常驻 Agent：

```bash
BEACON_API_URL=https://api.example.com/api \
PROBE_KEY=<probe.id> \
PROBE_TOKEN=<probe.secret> \
PROBE_INTERVAL_SECONDS=60 \
node probes/agent/bin/beacon-probe.js run

```

腾讯云 SCF：

1. 上传部署包：probes/agent/ 目录（bin + src + functions，零第三方依赖）
2. 执行方法：scf.main_handler
3. 环境变量：BEACON_API_URL（必须 https）、PROBE_KEY、PROBE_TOKEN、PROBE_INTERVAL_SECONDS（必须等于定时触发器周期）
4. 定时触发器：如每 300 秒执行一次
5. 本地调试：node probes/agent/functions/scf.js

详见 docs/guides/probe-scf-deployment.md。

## 七、测试方案

### 7.1 单元测试

| 模块                   | 测试点                               |
| ---------------------- | ------------------------------------ |
| MonitorsService        | target 校验、创建/更新/删除逻辑      |
| StateService           | 状态转换、通知触发规则               |
| HttpChecker            | 超时、状态码不符、成功               |
| TcpChecker             | 连接成功、连接拒绝、超时             |
| ProbeValidationService | 挑战创建/拉取/应答验签、nonce 防重放 |

### 7.2 集成测试

| 场景            | 验证点                                  |
| --------------- | --------------------------------------- |
| 创建监控 → 检测 | 调度器注册、检测日志写入                |
| 连续失败达阈值  | 状态变为 DOWN，触发通知                 |
| 服务恢复        | 状态变为 UP，发送恢复通知               |
| 探针回调        | 双源汇总、ProbeResult 写入              |
| 探针过期        | 降级为单源检测                          |
| 手动触发校验    | 探针拉取挑战、应答、ProbeExecution 记录 |

### 7.3 手动验证

```bash
# 创建失败监控
curl -X POST http://localhost:3000/projects/project_xxx/monitors \
  -H "Content-Type: application/json" \
  -d '{"name":"测试","type":"HTTP","target":"https://httpbin.org/status/500","interval":10,"failureThreshold":2}'

# 观察日志
# [本地检测] 测试 ❌ 320ms
# [状态变更] mon_xxx: UNKNOWN → DEGRADED
# [本地检测] 测试 ❌ 280ms
# [状态变更] mon_xxx: DEGRADED → DOWN
# 飞书通知已发送: 测试 → DOWN
```

## 八、风险与限制

| 风险               | 影响                 | 缓解                         |
| ------------------ | -------------------- | ---------------------------- |
| 单实例无高可用     | 监控进程挂了无人知晓 | 内网可接受，V2.0 加多实例    |
| 探针回调延迟       | 双源汇总不及时       | 本地检测为主，探针为辅       |
| Redis 故障         | 通知队列堆积         | 降级为同步发送               |
| 微信订阅消息一次性 | 告警可能无法持续触达 | 引导「总是保持」+ 飞书兜底   |
| Prisma v7 ESM      | 项目需配 ESM         | 用 moduleFormat = "cjs" 兼容 |

## 九、后续演进

| 版本 | 内容                                   |
| ---- | -------------------------------------- |
| V1.1 | 告警静默期、通知渠道管理 UI、状态页    |
| V1.2 | 微信小程序端、微信订阅消息             |
| V2.0 | 多区域探针调度、公开 API、Webhook 出站 |
| V2.1 | SSO、白标、审计日志                    |

## 十、附录

### 10.1 模块依赖关系

```text
MonitorsModule ──▶ CheckerModule(SchedulerService)
ProbeModule ──▶ CheckerModule(CheckerService)
CheckerModule ──▶ StateModule + NotifierModule
NotifierModule ──▶ BullModule + Redis
StateModule ──▶ PrismaService
```

### 10.2 接口总览

| 模块     | 方法   | 路径                                      | 说明                           |
| -------- | ------ | ----------------------------------------- | ------------------------------ |
| Monitors | POST   | /projects/:projectId/monitors             | 创建                           |
| Monitors | GET    | /projects/:projectId/monitors             | 列表                           |
| Monitors | POST   | /projects/:projectId/monitors/:id/pause   | 暂停                           |
| Monitors | POST   | /projects/:projectId/monitors/:id/resume  | 恢复                           |
| Monitors | DELETE | /projects/:projectId/monitors/:id         | 软删除                         |
| Probe    | POST   | /organizations/:orgId/probes              | 创建租户探针                   |
| Probe    | POST   | /organizations/:orgId/probes/:id/validate | 手动触发校验挑战               |
| Probe    | POST   | /admin/system-probes/:id/validate         | 系统探针手动触发校验           |
| Probe    | POST   | /probes/heartbeat                         | 探针心跳（x-probe-secret）     |
| Probe    | POST   | /probes/results                           | 探针结果上报（x-probe-secret） |
| Probe    | POST   | /probes/validation/pull                   | 拉取校验挑战                   |
| Probe    | POST   | /probes/validation/:validationId/answer   | 提交校验应答                   |
| Checker  | —      | 内部                                      | 定时触发                       |
| State    | —      | 内部                                      | 状态机                         |
| Notifier | —      | 内部                                      | 队列消费                       |

### 10.3 关键日志格式

```text
[调度触发] mon_xxx
[本地检测] 订单API ✅ 250ms
[本地检测] 订单API ❌ 320ms (状态码 500，期望 200)
[双源汇总] 订单API ❌ (本地: ❌, 探针: 2个)
[状态变更] mon_xxx: DEGRADED → DOWN
[通知] 飞书通知已发送: 订单API → DOWN
```

文档结束。 这份设计文档覆盖了从数据模型到模块实现、从链路时序到部署测试的完整内容，可直接作为开发依据。

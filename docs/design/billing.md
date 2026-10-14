# 套餐与计费系统开发设计文档

> 文档类型：设计记录。保留原方案、代码示例和阶段决策；当前行为以源码与 Swagger 为准。

## 文档信息

| 项目     | 内容                                                     |
| -------- | -------------------------------------------------------- |
| 项目名称 | 暗哨 Beacon Watch — 套餐与计费子系统                     |
| 文档版本 | V1.0                                                     |
| 技术栈   | NestJS 11 + Prisma v7 + PostgreSQL + Redis + 微信支付    |
| 文档目的 | 指导开发团队完成套餐、订阅、订单、支付、配额的设计与实现 |
| 目标读者 | 后端开发、架构师、测试工程师                             |

## 一、系统概述

### 1.1 业务定位

计费子系统负责暗哨 SaaS 的套餐定义、订阅管理、订单创建、支付处理、配额校验。核心模型是「订阅栈」——一个组织可以同时持有多条订阅，按优先级生效，高优先级过期后自动降级到次高，全部过期回落免费版。

### 1.2 核心业务规则

| 规则       | 说明                                              |
| ---------- | ------------------------------------------------- |
| 注册默认   | 用户注册自动创建 Org，自动绑定 FREE 订阅          |
| 订阅叠加   | 一个 Org 可以有多条订阅并存，不互斥               |
| 优先级生效 | 从所有 ACTIVE 订阅中取 plan.sortOrder 最大的      |
| 自动降级   | 高优先级过期后，自然回落到次高；全部过期回落 FREE |
| 配额来源   | 配额始终取当前生效套餐的值，不是叠加求和          |
| 超限处理   | 不删除已有数据，禁止新增，引导升级                |
| 支付幂等   | 微信可能重复回调，通过 Payment.status 保证幂等    |

### 1.3 核心链路

```text
用户注册 → 自动创建 Org + FREE 订阅
              ↓
        选择套餐 → 创建订单 → 发起微信支付
              ↓
        支付回调 → 订单完成 → 激活订阅
              ↓
        订阅栈：多条订阅并存，按优先级生效
              ↓
        高优先级到期 → 自动降级 → 全部到期回落 FREE
```

## 二、数据模型设计

### 2.1 ER 关系图

```text
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│     Plan     │──1:N──│ Subscription │──N:1──│ Organization │
│  套餐定义     │       │   订阅栈      │       │   组织        │
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │                      │                       │
       │ 1:N                  │ 1:1                   │ 1:N
       ▼                      ▼                       ▼
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│    Order     │──1:1──│   Payment    │       │   Monitor    │
│    订单       │       │   支付记录    │       │   监控        │
└──────────────┘       └──────────────┘       └──────────────┘
```

### 2.2 Plan（套餐定义）

```prisma
model Plan {
  id          String  @id @default(uuid())
  code        String  @unique  // FREE | PRO | TEAM
  name        String
  description String?
  price       Int      @default(0)   // 月费（分）
  durationDays Int     @default(30)  // 有效期天数
  sortOrder   Int      @default(0)   // 优先级，越大越优先

  // 配额定义
  maxMonitors   Int @default(5)
  maxProbes     Int @default(0)
  maxMembers    Int @default(3)
  maxChannels   Int @default(1)
  minInterval   Int @default(300)

  // 功能开关
  allowTenantProbe Boolean @default(false)
  allowStatusPage  Boolean @default(false)

  enabled Boolean @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  subscriptions Subscription[]
  orders        Order[]

  @@map("plans")
}
```

关键字段说明：

| 字段           | 说明                                      |
| -------------- | ----------------------------------------- |
| code           | 唯一标识，代码中引用                      |
| sortOrder      | 优先级，越大越优先。FREE=1, PRO=2, TEAM=3 |
| price          | 月费（分），避免浮点精度问题              |
| durationDays   | 购买一次的有效期天数，默认 30             |
| maxMonitors 等 | 配额上限                                  |
| minInterval    | 最小检测间隔（秒），区分套餐价值          |
| allowXxx       | 功能开关，如租户探针、状态页              |

### 2.3 Subscription（订阅栈）

```prisma
model Subscription {
  id             String    @id @default(uuid())
  organizationId String
  planId         String

  status    SubscriptionStatus @default(ACTIVE)
  startsAt  DateTime
  expiresAt DateTime
  autoRenew Boolean   @default(false)

  orderId String? @unique

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  plan         Plan         @relation(fields: [planId], references: [id])
  order        Order?       @relation(fields: [orderId], references: [id])

  @@index([organizationId, status])
  @@index([expiresAt])
  @@map("subscriptions")
}

enum SubscriptionStatus {
  ACTIVE      // 生效中
  EXPIRED     // 已过期
  CANCELLED   // 主动取消
}
```

关键设计：

一个 Org 可以有多条 ACTIVE 订阅，按 plan.sortOrder 决定哪条生效

orderId 唯一，一个订单对应一条订阅（续费时更新原订阅的 expiresAt）

过期不删除，只标记 EXPIRED，保留历史

### 2.4 Order（订单）

```prisma
model Order {
  id             String   @id @default(uuid())
  orderNo        String   @unique  // 业务订单号
  organizationId String
  planId         String
  userId         String

  amount       Int    // 金额（分）
  currency     String @default("CNY")
  durationDays Int    // 购买时长

  status      OrderStatus @default(PENDING)
  paidAt      DateTime?
  cancelledAt DateTime?
  expiresAt   DateTime    // 订单超时时间

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id])
  plan         Plan         @relation(fields: [planId], references: [id])
  user         User         @relation(fields: [userId], references: [id])
  payment      Payment?
  subscription Subscription?

  @@index([organizationId])
  @@index([status])
  @@index([expiresAt])
  @@map("orders")
}

enum OrderStatus {
  PENDING    // 待支付
  PAID       // 已支付
  CANCELLED  // 已取消
  REFUNDED   // 已退款
}
```

关键设计：

orderNo 业务订单号（如 BW + 时间戳 + 随机串），对用户可见

expiresAt 订单超时时间，默认 30 分钟，未支付自动取消

durationDays 记录购买时长，支付后据此计算订阅有效期

amount 下单时快照，防止套餐调价影响已创建订单

### 2.5 Payment（支付记录）

```prisma
model Payment {
  id            String   @id @default(uuid())
  orderId       String   @unique
  channel       PaymentChannel
  transactionId String?  @unique  // 微信支付单号
  prepayId      String?           // 微信预支付 ID
  amount        Int
  status        PaymentStatus @default(PENDING)
  paidAt        DateTime?
  rawCallback   Json?             // 微信回调原始数据

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([status])
  @@index([transactionId])
  @@map("payments")
}

enum PaymentChannel {
  WECHAT
}

enum PaymentStatus {
  PENDING
  SUCCESS
  FAILED
  REFUNDED
}
```

关键设计：

orderId 唯一，一个订单对应一条支付记录

transactionId 微信支付单号，唯一，用于幂等

rawCallback 保留微信回调原始数据，便于排查

支付单可复用（同一订单重复调起支付时更新 prepayId）

### 2.6 Organization 调整

```prisma
model Organization {
  // ... 原有字段

  subscriptions Subscription[]
  orders        Order[]
}
```

### 2.7 初始化套餐数据

```typescript
// prisma/seed.ts
async function main() {
  const plans = [
    {
      code: 'FREE', name: '免费版', price: 0, sortOrder: 1, durationDays: 36500,
      maxMonitors: 5, maxProbes: 0, maxMembers: 3, maxChannels: 1, minInterval: 300,
      allowTenantProbe: false, allowStatusPage: false,
    },
    {
      code: 'PRO', name: '专业版', price: 2900, sortOrder: 2, durationDays: 30,
      maxMonitors: 50, maxProbes: 3, maxMembers: 10, maxChannels: 5, minInterval: 60,
      allowTenantProbe: true, allowStatusPage: true,
    },
    {
      code: 'TEAM', name: '团队版', price: 9900, sortOrder: 3, durationDays: 30,
      maxMonitors: 200, maxProbes: 10, maxMembers: 999, maxChannels: 99, minInterval: 30,
      allowTenantProbe: true, allowStatusPage: true,
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: plan,
      create: plan,
    });
  }
}
```

## 三、模块设计

### 3.1 目录结构

```text
src/
├── shared/
│   └── subscription/
│       ├── subscription.module.ts
│       └── effective-plan.service.ts    # 生效套餐计算
│   └── quota/
│       ├── quota.module.ts
│       └── quota.service.ts             # 配额校验
│
└── modules/
    └── billing/
        ├── billing.module.ts
        ├── plan/
        │   ├── plan.controller.ts
        │   ├── plan.service.ts
        │   └── plan.repository.ts
        ├── subscription/
        │   ├── subscription.controller.ts
        │   ├── subscription.service.ts
        │   ├── subscription.repository.ts
        │   └── subscription-expiry.service.ts  # 定时降级
        ├── order/
        │   ├── order.controller.ts
        │   ├── order.service.ts
        │   ├── order.repository.ts
        │   └── dto/
        │       └── create-order.dto.ts
        └── payment/
            ├── payment.controller.ts
            ├── payment.service.ts
            ├── payment.repository.ts
            └── dto/
```

### 3.2 模块职责

| 模块                 | 职责                                     |
| -------------------- | ---------------------------------------- |
| PlanModule           | 套餐查询（列表、详情），admin 可配置     |
| SubscriptionModule   | 订阅栈管理、生效套餐计算、到期降级       |
| OrderModule          | 订单创建、查询、取消、超时处理           |
| PaymentModule        | 微信支付调起、回调处理、幂等保证         |
| EffectivePlanService | 实时计算生效套餐（被 QuotaService 调用） |
| QuotaService         | 配额校验（被业务模块调用）               |

### 3.3 模块依赖

```text
BillingModule
  ├── PlanModule ──▶ PrismaService
  ├── SubscriptionModule ──▶ EffectivePlanService
  ├── OrderModule ──▶ PlanModule + SubscriptionModule
  └── PaymentModule ──▶ OrderModule + WechatModule + SubscriptionModule

EffectivePlanService ──▶ PrismaService（Shared 层）

QuotaService ──▶ EffectivePlanService（Shared 层）
```

## 四、核心业务逻辑

### 4.1 生效套餐计算

核心规则：从所有 ACTIVE 且未过期的订阅中，取 plan.sortOrder 最大的。

```typescript
// src/shared/subscription/effective-plan.service.ts
@Injectable()
export class EffectivePlanService {
  constructor(private readonly prisma: PrismaService) {}

  async getEffectivePlan(organizationId: string) {
    const now = new Date();

    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        startsAt: { lte: now },
        expiresAt: { gt: now },
      },
      include: { plan: true },
      orderBy: { plan: { sortOrder: 'desc' } },
    });

    if (subscriptions.length > 0) {
      return subscriptions[0].plan;
    }

    return this.prisma.plan.findUnique({ where: { code: 'FREE' } });
  }

  async getSubscriptionStack(organizationId: string) {
    const now = new Date();
    const [subscriptions, freePlan] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { organizationId, status: 'ACTIVE' },
        include: { plan: true },
        orderBy: [{ plan: { sortOrder: 'desc' } }, { expiresAt: 'desc' }],
      }),
      this.prisma.plan.findUnique({ where: { code: 'FREE' } }),
    ]);

    const active = subscriptions.filter(s => s.expiresAt > now);
    const effectivePlan = active.length > 0 ? active[0].plan : freePlan;

    return {
      effectivePlan,
      stack: active.map(s => ({
        id: s.id,
        plan: s.plan,
        expiresAt: s.expiresAt,
        isEffective: s.planId === effectivePlan?.id,
      })),
    };
  }
}
```

关键设计：不需要手动迁移降级。每次实时查询，高优先级过期后自然回落到次高或 FREE。

### 4.2 用户注册默认订阅

```typescript
// src/modules/auth/auth.service.ts
async register(dto: RegisterDto) {
  return this.prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { ...dto } });

    const org = await tx.organization.create({
      data: {
        name: `${dto.name}的组织`,
        slug: generateSlug(dto.name),
        ownerId: user.id,
      },
    });

    await tx.membership.create({
      data: { userId: user.id, organizationId: org.id, role: 'OWNER' },
    });

    // 自动绑定 FREE 订阅
    const freePlan = await tx.plan.findUnique({ where: { code: 'FREE' } });
    await tx.subscription.create({
      data: {
        organizationId: org.id,
        planId: freePlan.id,
        status: 'ACTIVE',
        startsAt: new Date(),
        expiresAt: new Date('2099-12-31'),
      },
    });

    return { user, org };
  });
}
```

关键点：FREE 订阅的 expiresAt 设为极远未来，保证 org 永远有兜底套餐。

### 4.3 创建订单

```typescript
// src/modules/billing/order/order.service.ts
async create(organizationId: string, userId: string, dto: CreateOrderDto) {
  const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
  if (!plan || !plan.enabled) throw new NotFoundException('套餐不存在或已下架');
  if (plan.code === 'FREE') throw new BadRequestException('免费版无需购买');

  const durationDays = dto.durationDays ?? plan.durationDays;

  return this.prisma.order.create({
    data: {
      orderNo: this.generateOrderNo(),
      organizationId,
      planId: plan.id,
      userId,
      amount: plan.price,
      durationDays,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 分钟超时
    },
  });
}

private generateOrderNo(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `BW${ts}${rand}`.toUpperCase();
}
```

关键点：

amount 下单时从 plan.price 快照，防止后续调价影响

expiresAt 默认 30 分钟，未支付自动取消

### 4.4 订单超时处理

```typescript
// src/modules/billing/order/order-expiry.service.ts
@Injectable()
export class OrderExpiryService {
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cancelExpiredOrders() {
    const result = await this.prisma.order.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lte: new Date() },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
      },
    });

    if (result.count > 0) {
      this.logger.log(`取消 ${result.count} 个超时订单`);
    }
  }
}
```

### 4.5 发起支付

```typescript
// src/modules/billing/payment/payment.service.ts
async createPayment(orderId: string, openid: string) {
  const order = await this.prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== 'PENDING') {
    throw new BadRequestException('订单状态异常');
  }
  if (order.expiresAt < new Date()) {
    throw new BadRequestException('订单已过期');
  }

  const result = await this.wechat.createJsapiOrder({
    outTradeNo: order.orderNo,
    totalFee: order.amount,
    openid,
    body: `暗哨套餐-${order.orderNo}`,
  });

  await this.prisma.payment.upsert({
    where: { orderId: order.id },
    create: {
      orderId: order.id,
      channel: 'WECHAT',
      prepayId: result.prepayId,
      amount: order.amount,
      status: 'PENDING',
    },
    update: { prepayId: result.prepayId },
  });

  return {
    timeStamp: result.timeStamp,
    nonceStr: result.nonceStr,
    package: result.package,
    signType: result.signType,
    paySign: result.paySign,
  };
}
```

### 4.6 支付回调处理（幂等）

```typescript
async handleWechatCallback(rawBody: string, signature: string) {
  // 1. 验证签名
  const decrypted = await this.wechat.verifyCallback(rawBody, signature);
  const { out_trade_no, transaction_id, trade_state } = decrypted;
  if (trade_state !== 'SUCCESS') return { code: 'FAIL' };

  // 2. 幂等检查
  const payment = await this.prisma.payment.findFirst({
    where: { order: { orderNo: out_trade_no } },
    include: { order: true },
  });
  if (!payment) throw new Error('支付单不存在');
  if (payment.status === 'SUCCESS') return { code: 'SUCCESS' }; // 已处理

  // 3. 事务处理
  await this.prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCESS',
        transactionId: transaction_id,
        paidAt: new Date(),
        rawCallback: decrypted,
      },
    });

    await tx.order.update({
      where: { id: payment.orderId },
      data: { status: 'PAID', paidAt: new Date() },
    });

    await this.activateSubscription(tx, payment.order);
  });

  return { code: 'SUCCESS' };
}

private async activateSubscription(tx: any, order: any) {
  const now = new Date();

  // 同套餐续费 → 延长原订阅
  const existing = await tx.subscription.findFirst({
    where: {
      organizationId: order.organizationId,
      planId: order.planId,
      status: 'ACTIVE',
      expiresAt: { gt: now },
    },
  });

  if (existing) {
    await tx.subscription.update({
      where: { id: existing.id },
      data: {
        expiresAt: new Date(existing.expiresAt.getTime() + order.durationDays * 86400000),
      },
    });
  } else {
    await tx.subscription.create({
      data: {
        organizationId: order.organizationId,
        planId: order.planId,
        status: 'ACTIVE',
        startsAt: now,
        expiresAt: new Date(now.getTime() + order.durationDays * 86400000),
        orderId: order.id,
      },
    });
  }
}
```

关键设计：

幂等：Payment.status === 'SUCCESS' 直接返回，不重复处理

事务：支付、订单、订阅三者要么全成功，要么全回滚

续费：同套餐续费时，从原 expiresAt 往后加，用户不损失剩余时长

新订阅：不同套餐时创建新订阅，与原有订阅并存

### 4.7 到期降级

```typescript
// src/modules/billing/subscription/subscription-expiry.service.ts
@Injectable()
export class SubscriptionExpiryService {
  @Cron(CronExpression.EVERY_HOUR)
  async expireSubscriptions() {
    const result = await this.prisma.subscription.updateMany({
      where: {
        status: 'ACTIVE',
        expiresAt: { lte: new Date() },
      },
      data: { status: 'EXPIRED' },
    });

    if (result.count > 0) {
      this.logger.log(`标记 ${result.count} 个订阅为过期`);
    }
  }
}
```

关键设计：标记过期后，EffectivePlanService 下次查询自然回落到次高或 FREE，不需要手动迁移。

### 4.8 配额校验

```typescript
// src/shared/quota/quota.service.ts
@Injectable()
export class QuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePlan: EffectivePlanService,
  ) {}

  async getUsage(organizationId: string) {
    const [monitors, probes, members, channels] = await Promise.all([
      this.prisma.monitor.count({ where: { organizationId, deletedAt: null } }),
      this.prisma.probe.count({ where: { organizationId, scope: 'TENANT' } }),
      this.prisma.membership.count({ where: { organizationId } }),
      this.prisma.notificationChannel.count({ where: { organizationId } }),
    ]);
    return { monitors, probes, members, channels };
  }

  async assertCanCreate(organizationId: string, resource: QuotaResource) {
    const plan = await this.effectivePlan.getEffectivePlan(organizationId);
    const usage = await this.getUsage(organizationId);
    const limit = this.getLimit(plan, resource);

    if (usage[resource] >= limit) {
      throw new ForbiddenException({
        code: 'QUOTA_EXCEEDED',
        resource,
        current: usage[resource],
        limit,
        message: `${this.resourceName(resource)}已达上限（${limit}），请升级套餐`,
      });
    }
  }

  async assertIntervalAllowed(organizationId: string, interval: number) {
    const plan = await this.effectivePlan.getEffectivePlan(organizationId);
    if (interval < plan.minInterval) {
      throw new ForbiddenException({
        code: 'INTERVAL_TOO_SHORT',
        minInterval: plan.minInterval,
        message: `当前套餐最小检测间隔为 ${plan.minInterval} 秒，请升级套餐`,
      });
    }
  }

  async getUsageSummary(organizationId: string) {
    const plan = await this.effectivePlan.getEffectivePlan(organizationId);
    const usage = await this.getUsage(organizationId);

    const buildQuota = (used: number, limit: number) => ({
      used,
      limit,
      percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    });

    return {
      plan: { code: plan.code, name: plan.name, price: plan.price },
      resources: {
        monitors: buildQuota(usage.monitors, plan.maxMonitors),
        probes:   buildQuota(usage.probes, plan.maxProbes),
        members:  buildQuota(usage.members, plan.maxMembers),
        channels: buildQuota(usage.channels, plan.maxChannels),
      },
      features: {
        allowTenantProbe: plan.allowTenantProbe,
        allowStatusPage: plan.allowStatusPage,
      },
      minInterval: plan.minInterval,
    };
  }
}
```

关键设计：

配额从 EffectivePlanService 实时取，不缓存

用量实时 count，不走计数器

超限抛 ForbiddenException，带 code 和 data，前端可精准处理

### 4.9 超限处理

降级后用户用量可能超出新套餐限制。不删除已有数据，只禁止新增：

```typescript
async checkOverLimit(organizationId: string) {
  const plan = await this.effectivePlan.getEffectivePlan(organizationId);
  const usage = await this.getUsage(organizationId);

  const violations: string[] = [];
  if (usage.monitors > plan.maxMonitors) violations.push('monitors');
  if (usage.probes > plan.maxProbes) violations.push('probes');
  if (usage.members > plan.maxMembers) violations.push('members');

  return { plan, usage, violations, overLimit: violations.length > 0 };
}
```

策略：已有的继续运行，只是不能再加新的。前端显示「当前用量超出套餐限额，请升级」。

## 五、接口设计

### 5.1 套餐

```text
GET    /api/plans                          套餐列表
GET    /api/plans/:id                      套餐详情
```

### 5.2 订阅

```text
GET    /api/organizations/:orgId/subscription   订阅栈 + 生效套餐
```

响应示例：

```json
{
  "effectivePlan": { "code": "PRO", "name": "专业版", "sortOrder": 2 },
  "stack": [
    {
      "id": "sub_xxx",
      "plan": { "code": "TEAM", "name": "团队版", "sortOrder": 3 },
      "expiresAt": "2026-10-15T00:00:00Z",
      "isEffective": false
    },
    {
      "id": "sub_yyy",
      "plan": { "code": "PRO", "name": "专业版", "sortOrder": 2 },
      "expiresAt": "2026-11-01T00:00:00Z",
      "isEffective": true
    }
  ]
}
```

### 5.3 订单

```text
POST   /api/organizations/:orgId/orders    创建订单
GET    /api/organizations/:orgId/orders    订单列表
GET    /api/orders/:id                     订单详情
POST   /api/orders/:id/cancel              取消订单
```

### 5.4 支付

```text
POST   /api/orders/:id/pay                 发起支付（返回小程序调起参数）
POST   /api/payment/wechat/callback        微信支付回调（微信调用）
```

### 5.5 配额

```text
GET    /api/organizations/:orgId/quota     用量摘要
```

响应示例：

```json
{
  "plan": { "code": "FREE", "name": "免费版", "price": 0 },
  "resources": {
    "monitors": { "used": 3, "limit": 5, "percent": 60 },
    "probes":   { "used": 0, "limit": 0, "percent": 0 },
    "members":  { "used": 2, "limit": 3, "percent": 67 },
    "channels": { "used": 1, "limit": 1, "percent": 100 }
  },
  "features": { "allowTenantProbe": false, "allowStatusPage": false },
  "minInterval": 300
}
```

## 六、前端升级页设计

页面结构与交互流程已拆到 [套餐升级页面](../product/subscription-upgrade.md)。

## 七、关键设计决策

| 决策      | 选择                           | 理由                          |
| --------- | ------------------------------ | ----------------------------- |
| 订阅模型  | 多条并存，按 sortOrder 生效    | 支持叠加，高优先级优先        |
| 降级方式  | 实时查询，不手动迁移           | EffectivePlanService 自然回落 |
| 续费逻辑  | 同套餐延期，从原到期时间往后加 | 用户不损失剩余时长            |
| 订单快照  | amount 下单时快照              | 防止调价影响已创建订单        |
| 订单超时  | 30 分钟自动取消                | 防止恶意占单                  |
| 支付幂等  | Payment.status 检查            | 微信可能重复回调              |
| 事务保证  | 支付+订单+订阅 在一个事务      | 数据一致性                    |
| 超限处理  | 软限制，不清数据               | 保护用户数据，引导升级        |
| 配额计算  | 实时查询，不缓存               | 数量小，避免一致性问题        |
| FREE 订阅 | expiresAt 设极远未来           | 保证永远有兜底                |

## 八、定时任务

| 任务                      | 频率      | 职责         |
| ------------------------- | --------- | ------------ |
| OrderExpiryService        | 每 5 分钟 | 取消超时订单 |
| SubscriptionExpiryService | 每小时    | 标记过期订阅 |

## 九、错误码

| 错误码                | HTTP | 说明               |
| --------------------- | ---- | ------------------ |
| QUOTA_EXCEEDED        | 403  | 配额超限           |
| INTERVAL_TOO_SHORT    | 403  | 检测间隔不符合套餐 |
| FEATURE_NOT_AVAILABLE | 403  | 功能未开放         |
| ORDER_NOT_FOUND       | 404  | 订单不存在         |
| ORDER_EXPIRED         | 400  | 订单已过期         |
| ORDER_STATUS_INVALID  | 400  | 订单状态异常       |
| PAYMENT_FAILED        | 400  | 支付失败           |

## 十、目录结构

```text
src/
├── shared/
│   ├── subscription/
│   │   ├── subscription.module.ts
│   │   └── effective-plan.service.ts
│   └── quota/
│       ├── quota.module.ts
│       └── quota.service.ts
│
└── modules/
    └── billing/
        ├── billing.module.ts
        ├── plan/
        │   ├── plan.controller.ts
        │   ├── plan.service.ts
        │   └── plan.repository.ts
        ├── subscription/
        │   ├── subscription.controller.ts
        │   ├── subscription.service.ts
        │   ├── subscription.repository.ts
        │   └── subscription-expiry.service.ts
        ├── order/
        │   ├── order.controller.ts
        │   ├── order.service.ts
        │   ├── order.repository.ts
        │   ├── order-expiry.service.ts
        │   └── dto/create-order.dto.ts
        └── payment/
            ├── payment.controller.ts
            ├── payment.service.ts
            ├── payment.repository.ts
            └── dto/
```

## 十一、验证流程

```bash
# 1. 初始化套餐
npx ts-node prisma/seed.ts

# 2. 查看套餐列表
curl http://localhost:3000/api/plans

# 3. 查看当前订阅栈
curl http://localhost:3000/api/organizations/org_xxx/subscription

# 4. 创建订单
curl -X POST http://localhost:3000/api/organizations/org_xxx/orders \
  -H "Content-Type: application/json" \
  -d '{"planId":"plan_pro","durationDays":30}'

# 5. 发起支付
curl -X POST http://localhost:3000/api/orders/ord_xxx/pay \
  -H "Content-Type: application/json" \
  -d '{"openid":"o_xxx"}'

# 6. 模拟微信回调
curl -X POST http://localhost:3000/api/payment/wechat/callback \
  -H "Content-Type: application/json" \
  -d '{"out_trade_no":"BWXXX","trade_state":"SUCCESS"}'

# 7. 查看订阅栈（应看到新订阅）
curl http://localhost:3000/api/organizations/org_xxx/subscription

# 8. 查看配额（应反映新套餐）
curl http://localhost:3000/api/organizations/org_xxx/quota
```

## 十二、风险与限制

| 风险         | 影响               | 缓解                          |
| ------------ | ------------------ | ----------------------------- |
| 微信回调延迟 | 订阅激活延迟       | 前端轮询订单状态，最多 2 分钟 |
| 支付回调重复 | 重复激活订阅       | Payment.status 幂等检查       |
| 订单并发支付 | 同一订单多次支付   | Payment.orderId 唯一约束      |
| 套餐调价     | 已创建订单金额变化 | amount 下单时快照             |
| 降级后超限   | 用户无法新增资源   | 软限制，不清数据，引导升级    |
| Redis 不可用 | 通知队列阻塞       | 降级为同步发送                |

文档结束。 这份设计覆盖了套餐定义、订阅栈、订单、支付、配额校验的完整业务闭环，可直接作为开发依据。核心是「订阅栈 + 实时生效套餐计算」，降级不手动迁移，超限不删数据。

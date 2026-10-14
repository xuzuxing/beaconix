# 监控 V1.1 目标 Schema

> 文档类型：历史归档。原文中的“当前状态”、缺口、示例和阶段计划均属于当时的设计快照，不代表最新实现；日常使用请从 [文档索引](../README.md) 查找现行接口与运行指南。

## 四、完整 Prisma Schema

```prisma
generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}

// ==================== 基础枚举 ====================

enum GlobalRole {
  SUPER_ADMIN
  USER
}

enum MembershipRole {
  OWNER
  ADMIN
  MEMBER
  VIEWER
}

enum InvitationStatus {
  PENDING
  ACCEPTED
  DECLINED
  EXPIRED
  REVOKED
}

enum OtpPurpose {
  EMAIL_VERIFICATION
  PASSWORD_RESET
}

enum AuditAction {
  CREATE
  UPDATE
  DELETE
  RESTORE
  ARCHIVE
  INVITE
  JOIN
  LEAVE
  ASSIGN
  UNASSIGN
}

// ==================== 监控枚举 ====================

enum MonitorType {
  HTTP
  TCP
}

enum MonitorStatus {
  UNKNOWN
  UP
  DEGRADED
  DOWN
  PAUSED
}

enum ProbeScope {
  SYSTEM
  TENANT
}

enum ProbeProvider {
  TENCENT
  ALIYUN
  CUSTOM
}

enum ProbeStatus {
  ONLINE
  OFFLINE
}

enum CheckSource {
  LOCAL
  PROBE
}

enum ExecutionTrigger {
  SCHEDULED
  MANUAL
  CALLBACK
}

enum ExecutionStatus {
  SUCCESS
  FAILED
  TIMEOUT
  SKIPPED
}

enum NotificationChannelType {
  FEISHU
  WECOM
  DINGTALK
  WECHAT_SUBSCRIBE
  EMAIL
}

enum NotificationStatus {
  SUCCESS
  FAILED
}

// ==================== 用户体系 ====================

model User {
  id            String     @id @default(uuid())
  email         String     @unique
  password      String
  name          String
  avatarUrl     String?
  globalRole    GlobalRole @default(USER)
  isActive      Boolean    @default(true)
  emailVerified Boolean    @default(false)
  lastSeenAt    DateTime?

  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  ownedOrganizations Organization[] @relation("OrganizationOwner")
  memberships        Membership[]
  sentInvitations    Invitation[]   @relation("InvitationSender")
  auditLogs          AuditLog[]     @relation("AuditActor")
  refreshTokens      RefreshToken[]
  otpCodes           OtpCode[]

  @@index([createdAt])
  @@index([isActive])
  @@map("users")
}

model OtpCode {
  id        String     @id @default(uuid())
  userId    String
  codeHash  String
  purpose   OtpPurpose
  expiresAt DateTime
  usedAt    DateTime?
  attempts  Int        @default(0)
  createdAt DateTime   @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, purpose])
  @@index([expiresAt])
  @@map("otp_codes")
}

model RefreshToken {
  id        String    @id @default(uuid())
  userId    String
  token     String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
  @@map("refresh_tokens")
}

// ==================== 组织体系 ====================

model Organization {
  id          String  @id @default(uuid())
  name        String
  slug        String  @unique
  description String?
  logoUrl     String?
  website     String?
  ownerId     String

  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  settings Json? @default("{}")

  owner       User         @relation("OrganizationOwner", fields: [ownerId], references: [id], onDelete: Restrict)
  memberships Membership[]
  invitations Invitation[]
  auditLogs   AuditLog[]

  // 监控模块
  monitors    Monitor[]
  probes      Probe[]
  channels    NotificationChannel[]
  statusPages StatusPage[]

  @@index([ownerId])
  @@index([createdAt])
  @@index([deletedAt])
  @@map("organizations")
}

model Membership {
  id             String         @id @default(uuid())
  userId         String
  organizationId String
  role           MembershipRole @default(MEMBER)
  joinedAt       DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
  invitedById    String?

  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([userId, organizationId])
  @@index([organizationId])
  @@index([role])
  @@map("memberships")
}

model Invitation {
  id             String           @id @default(uuid())
  email          String
  organizationId String
  role           MembershipRole   @default(MEMBER)
  status         InvitationStatus @default(PENDING)
  token          String           @unique @default(uuid())
  expiresAt      DateTime
  sentById       String
  acceptedAt     DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  sentBy       User         @relation("InvitationSender", fields: [sentById], references: [id], onDelete: Cascade)

  @@unique([email, organizationId])
  @@index([organizationId])
  @@index([status])
  @@map("invitations")
}

// ==================== 监控核心 ====================

model Monitor {
  id               String      @id @default(uuid())
  organizationId   String
  name             String
  type             MonitorType
  target           String
  interval         Int         @default(60)
  timeout          Int         @default(5000)
  expectedStatus   Int         @default(200)
  failureThreshold Int         @default(3)
  enabled          Boolean     @default(true)

  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  organization Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  state        MonitorState?
  probes       MonitorProbe[]
  checkLogs    CheckLog[]
  executions   ProbeExecution[]

  @@index([organizationId])
  @@index([enabled])
  @@index([deletedAt])
  @@map("monitors")
}

model MonitorState {
  monitorId          String        @id
  status             MonitorStatus @default(UNKNOWN)
  failCount          Int           @default(0)
  lastCheckAt        DateTime?
  lastError          String?
  lastLatency        Int?
  lastNotifiedStatus MonitorStatus?
  updatedAt          DateTime      @updatedAt

  monitor Monitor @relation(fields: [monitorId], references: [id], onDelete: Cascade)

  @@map("monitor_states")
}

model CheckLog {
  id        String      @id @default(uuid())
  monitorId String
  success   Boolean
  latency   Int
  error     String?
  source    CheckSource @default(LOCAL)
  checkedAt DateTime    @default(now())

  monitor Monitor @relation(fields: [monitorId], references: [id], onDelete: Cascade)

  @@index([monitorId, checkedAt])
  @@map("check_logs")
}

// ==================== 探针体系 ====================

model Probe {
  id             String        @id @default(uuid())
  scope          ProbeScope    @default(TENANT)
  organizationId String?
  name           String
  provider       ProbeProvider
  region         String
  callbackUrl    String
  secret         String        @unique
  enabled        Boolean       @default(true)
  lastHeartbeat  DateTime?
  status         ProbeStatus   @default(OFFLINE)

  // 系统探针调度配置
  maxTenants Int? @default(0)
  priority   Int  @default(0)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  organization Organization?   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  monitors     MonitorProbe[]
  results      ProbeResult[]
  executions   ProbeExecution[]

  @@index([scope])
  @@index([organizationId])
  @@index([enabled])
  @@map("probes")
}

model MonitorProbe {
  monitorId String
  probeId   String
  createdAt DateTime @default(now())

  monitor Monitor @relation(fields: [monitorId], references: [id], onDelete: Cascade)
  probe   Probe   @relation(fields: [probeId], references: [id], onDelete: Cascade)

  @@id([monitorId, probeId])
  @@index([monitorId])
  @@index([probeId])
  @@map("monitor_probes")
}

model ProbeResult {
  id        String   @id @default(uuid())
  probeId   String
  target    String
  success   Boolean
  error     String?
  latency   Int
  checkedAt DateTime @default(now())

  probe Probe @relation(fields: [probeId], references: [id], onDelete: Cascade)

  @@index([target, checkedAt])
  @@index([probeId, checkedAt])
  @@map("probe_results")
}

model ProbeExecution {
  id           String            @id @default(uuid())
  probeId      String
  monitorId    String?
  target       String
  trigger      ExecutionTrigger
  status       ExecutionStatus
  success      Boolean
  latency      Int?
  error        String?
  requestMeta  Json?             @default("{}")
  responseMeta Json?             @default("{}")
  executedAt   DateTime          @default(now())

  probe   Probe    @relation(fields: [probeId], references: [id], onDelete: Cascade)
  monitor Monitor? @relation(fields: [monitorId], references: [id], onDelete: SetNull)

  @@index([probeId, executedAt])
  @@index([monitorId, executedAt])
  @@index([status])
  @@map("probe_executions")
}

// ==================== 通知体系 ====================

model NotificationChannel {
  id             String                  @id @default(uuid())
  organizationId String
  type           NotificationChannelType
  name           String
  config         Json                    @default("{}")
  enabled        Boolean                 @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  organization Organization      @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  logs         NotificationLog[]

  @@index([organizationId])
  @@index([enabled])
  @@map("notification_channels")
}

model NotificationLog {
  id        String             @id @default(uuid())
  monitorId String
  channelId String
  status    NotificationStatus
  error     String?
  sentAt    DateTime           @default(now())

  channel NotificationChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)

  @@index([monitorId, sentAt])
  @@index([channelId, sentAt])
  @@map("notification_logs")
}

// ==================== 状态页 ====================

model StatusPage {
  id                String   @id @default(uuid())
  organizationId    String
  slug              String   @unique
  title             String
  description       String?
  visibleMonitorIds String[] @default([])
  showLatency       Boolean  @default(true)
  showUptime        Boolean  @default(false)
  enabled           Boolean  @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId])
  @@index([slug])
  @@map("status_pages")
}

// ==================== 审计日志 ====================

model AuditLog {
  id             String      @id @default(uuid())
  actorId        String?
  organizationId String?
  action         AuditAction
  entity         String
  entityId       String
  before         Json?
  after          Json?
  ipAddress      String?
  userAgent      String?
  createdAt      DateTime    @default(now())

  actor        User?         @relation("AuditActor", fields: [actorId], references: [id], onDelete: SetNull)
  organization Organization? @relation(fields: [organizationId], references: [id], onDelete: SetNull)

  @@index([actorId])
  @@index([organizationId])
  @@index([entity, entityId])
  @@index([action])
  @@index([createdAt])
  @@map("audit_logs")
}

```

### 4.1 当前仓库 Schema 适配差异

上面的 Schema 是 Beacon Watch 独立产品的目标模型。当前仓库的 `prisma/schema.prisma` 已经包含 Agile workspace 业务，因此监控模型按以下差异落地：

| 模型/枚举                          | V1.1 目标             | 当前仓库                                                                                |
| ---------------------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| Monitor.id                         | `@default(uuid())`    | `@default(cuid())`，跟现有仓库一致                                                      |
| Monitor.organizationId             | 必填                  | 必填                                                                                    |
| Monitor.projectId                  | 无                    | 必填，监控挂在项目下                                                                    |
| Monitor.checkSsl                   | 无                    | 已有，是否检查 HTTPS 证书                                                               |
| Monitor.sslExpiryThreshold         | 无                    | 已有，默认 30 天                                                                        |
| Monitor.executions                 | 有 `ProbeExecution[]` | 暂无                                                                                    |
| MonitorState.monitorId             | `@id`                 | `@id @default(cuid())`；业务创建时仍使用 Monitor id                                     |
| MonitorState SSL 字段              | 无                    | 已有 `sslExpiresAt`、`sslDaysRemaining`、`sslIssuer`、`sslSubject`、`sslLastNotifiedAt` |
| CheckLog.source                    | `CheckSource` enum    | 当前为 String，默认 `"local"`；代码侧使用 `CheckSource` 常量                            |
| ProbeScope                         | 有 `SYSTEM/TENANT`    | 暂无                                                                                    |
| Probe.organizationId               | 可空，系统探针为空    | 必填，仅租户探针                                                                        |
| Probe.maxTenants / priority        | 有                    | 暂无                                                                                    |
| ProbeExecution                     | 有                    | 暂无                                                                                    |
| ExecutionTrigger / ExecutionStatus | 有                    | 暂无                                                                                    |
| StatusPage                         | 有                    | 表已存在，业务模块待补                                                                  |

后续迁移建议：

1. 保留当前 `projectId`，除非产品明确要把监控从项目中剥离。
2. 新增 `ProbeScope` 时将现有探针默认迁移为 `TENANT`，再允许 `organizationId` 为 null 承载系统探针。
3. 新增 `ProbeExecution` 后，探针 heartbeat、results 上报、本地调度和手动检查都应写 execution，用于排查和计费。
4. `CheckLog.source` 建议改为 `CheckSource` enum，与代码和文档统一。
5. SSL 字段应保留为 V1.1 的扩展能力，不回退到目标初稿。

[返回 V1.1 系统设计](monitoring-v1.1-design.md)。

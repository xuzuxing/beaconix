# 2FA 双因素认证设计方案

> 文档类型：设计记录。保留原方案、代码示例和阶段决策；当前行为以源码与 Swagger 为准。

生成时间：2026-10-06

## 背景

Beacon 当前认证链路已经具备邮箱注册、邮箱 OTP 验证、密码登录、refresh token 轮换、密码重置、微信登录和全局 `JwtAuthGuard`。本方案在现有 Auth 模块上增加用户级 2FA，用户可以按需开启或关闭。开启后，登录必须完成「主凭证 + 第二因素」两步校验，后端才发放 access token 和 refresh token。

## 目标

- 用户可在已登录状态下自行开启、确认、关闭 2FA。
- 第一版采用 TOTP（Authenticator App，如 Google Authenticator、Microsoft Authenticator、1Password）作为主方案。
- 提供一次性恢复码，避免用户丢失设备后完全无法登录。
- 不改变现有多租户模型；2FA 是用户账号安全能力，不归属于 organization。
- 不在第一步密码验证后发放正式登录 token，避免绕过第二因素。
- 关键安全事件进入审计日志，便于后续风控排查。

## 非目标

- 不在第一版实现短信 OTP、邮件 OTP 登录二次验证、WebAuthn/Passkey。
- 不做组织强制 2FA 策略；后续可在 `Organization.settings` 中扩展。
- 不把 2FA 状态塞进 JWT 用于每次请求二次校验；2FA 只影响登录发 token 的门槛。
- 不支持“记住此设备 30 天”；如需要可作为 V1.1 增加可信设备表。

## 总体方案

### 认证方式

第一版使用 TOTP：

```text
共享密钥 + 当前时间窗口 -> 6 位动态验证码
默认周期：30 秒
容忍窗口：前后各 1 个周期
算法：SHA-1（兼容主流 Authenticator App）
```

依赖建议：

```bash
pnpm add otplib qrcode
```

- `otplib` 负责生成和校验 TOTP。
- `qrcode` 负责把 `otpauth://` URI 转为二维码 data URL。

### 登录分支

```text
POST /api/auth/login
    ↓
校验 email/password
    ↓
用户未开启 2FA -> 直接签发 accessToken + refreshToken
用户已开启 2FA -> 返回 twoFactorRequired + challengeId
    ↓
POST /api/auth/2fa/verify-login
    ↓
校验 challengeId + TOTP/恢复码
    ↓
签发 accessToken + refreshToken，更新 lastSeenAt
```

### 开启分支

```text
已登录用户
    ↓
POST /api/auth/2fa/setup
校验当前密码，生成临时 secret，返回二维码和 setupToken
    ↓
用户扫码并输入 TOTP
    ↓
POST /api/auth/2fa/enable
校验 setupToken + TOTP
    ↓
加密保存 secret，生成恢复码，标记 twoFactorEnabled=true
```

### 关闭分支

```text
已登录用户
    ↓
POST /api/auth/2fa/disable
校验当前密码 + TOTP 或恢复码
    ↓
清除 2FA 配置，撤销现有 refresh token
```

## 数据模型

### User 调整

在 `User` 上保留快速状态字段，便于登录时一次查询判断：

```prisma
model User {
  // ...现有字段

  twoFactorEnabled Boolean   @default(false)
  twoFactorEnabledAt DateTime?

  twoFactorSecret TwoFactorSecret?
  twoFactorRecoveryCodes TwoFactorRecoveryCode[]
}
```

### TwoFactorSecret

```prisma
model TwoFactorSecret {
  id        String   @id @default(cuid())
  userId    String   @unique
  secretEnc String   // AES-256-GCM 加密后的 TOTP secret
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("two_factor_secrets")
}
```

关键点：

- `secretEnc` 只保存密文，不保存明文。
- 加密密钥来自环境变量 `TWO_FACTOR_SECRET_KEY`，长度 32 字节，base64 编码。
- 加密格式建议为 `v1:<ivBase64>:<tagBase64>:<ciphertextBase64>`，方便未来轮换版本。

### TwoFactorRecoveryCode

```prisma
model TwoFactorRecoveryCode {
  id        String    @id @default(cuid())
  userId    String
  codeHash  String    // bcrypt hash
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, usedAt])
  @@map("two_factor_recovery_codes")
}
```

关键点：

- 恢复码只在启用或重新生成时返回一次。
- 恢复码明文格式建议为 `xxxx-xxxx-xxxx`，一次生成 10 个。
- 使用后设置 `usedAt`，不可重复使用。

### TwoFactorChallenge

建议第一版落 PostgreSQL，方便失效、审计和横向扩展；如果后续 Redis 已作为认证依赖，也可以迁移到 Redis。

```prisma
model TwoFactorChallenge {
  id        String    @id @default(cuid())
  userId    String
  tokenHash String    @unique // hash(challengeToken)
  purpose   String    @default("LOGIN")
  expiresAt DateTime
  consumedAt DateTime?
  attempts  Int       @default(0)
  ipAddress String?
  userAgent String?
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, purpose])
  @@index([expiresAt])
  @@map("two_factor_challenges")
}
```

返回给前端的 `challengeId` 建议使用不透明随机值：

```text
challengeId = <record.id>.<rawChallengeToken>
tokenHash = sha256(rawChallengeToken)
TTL = 5 分钟
最大尝试次数 = 5
```

这样即使数据库泄漏，也不能直接拿到可用 challenge token。

## 配置

新增环境变量：

```bash
TWO_FACTOR_ISSUER="Beacon"
TWO_FACTOR_SECRET_KEY="<32-byte-base64-key>"
TWO_FACTOR_CHALLENGE_TTL_SECONDS=300
TWO_FACTOR_MAX_ATTEMPTS=5
TWO_FACTOR_RECOVERY_CODE_COUNT=10
```

新增 `src/config/two-factor.config.ts`：

```typescript
export interface TwoFactorConfig {
    issuer: string;
    secretKey: string;
    challengeTtlSeconds: number;
    maxAttempts: number;
    recoveryCodeCount: number;
}
```

`TWO_FACTOR_SECRET_KEY` 缺失时应用应启动失败，而不是降级为明文保存。

## 模块设计

目录建议：

```text
src/modules/auth/
├── two-factor/
│   ├── two-factor.controller.ts
│   ├── two-factor.service.ts
│   ├── two-factor-crypto.service.ts
│   ├── dto/
│   │   ├── setup-two-factor.dto.ts
│   │   ├── enable-two-factor.dto.ts
│   │   ├── verify-two-factor-login.dto.ts
│   │   ├── disable-two-factor.dto.ts
│   │   └── regenerate-recovery-codes.dto.ts
│   └── entities/
│       ├── two-factor-setup.entity.ts
│       ├── two-factor-required.entity.ts
│       └── recovery-codes.entity.ts
```

职责划分：

| 组件                     | 职责                                                 |
| ------------------------ | ---------------------------------------------------- |
| `AuthService`            | 保持主登录入口，判断是否需要 2FA，最终签发 tokens    |
| `TwoFactorService`       | setup、enable、verify-login、disable、恢复码管理     |
| `TwoFactorCryptoService` | TOTP secret 加解密、恢复码生成、challenge token hash |
| `EmailService`           | 可选：2FA 开启/关闭后发送安全提醒邮件                |
| `AuditLogInterceptor`    | 记录开启、关闭、恢复码重置等安全事件                 |

## API 设计

所有路径默认带 `/api` 前缀。

### 登录

`POST /auth/login`

请求沿用现有 `LoginDto`。

未开启 2FA 时响应保持兼容：

```json
{
  "accessToken": "jwt",
  "refreshToken": "raw-refresh-token",
  "user": {
    "id": "user_xxx",
    "email": "john@example.com"
  }
}
```

已开启 2FA 时响应：

```json
{
  "twoFactorRequired": true,
  "challengeId": "cuid.raw-token",
  "expiresAt": "2026-10-06T10:05:00.000Z"
}
```

Swagger 上建议新增 `LoginResponseEntity`，用 union 风格描述 `AuthResponseEntity | TwoFactorRequiredEntity`。

### 验证登录 2FA

`POST /auth/2fa/verify-login`

`@Public()`，因为此时用户还没有 access token。

请求：

```json
{
  "challengeId": "cuid.raw-token",
  "code": "123456"
}
```

响应：

```json
{
  "accessToken": "jwt",
  "refreshToken": "raw-refresh-token",
  "user": {
    "id": "user_xxx",
    "email": "john@example.com"
  }
}
```

校验规则：

- challenge 必须存在、未过期、未消费。
- `attempts < TWO_FACTOR_MAX_ATTEMPTS`。
- `code` 先按 TOTP 校验；失败后再按未使用恢复码校验。
- 恢复码成功后立即标记 `usedAt`。
- 成功后 `consumedAt=now`，再签发 tokens。

### 初始化 2FA

`POST /auth/2fa/setup`

需要 bearer token。

请求：

```json
{
  "currentPassword": "StrongP@ss1"
}
```

响应：

```json
{
  "setupToken": "opaque-setup-token",
  "otpauthUrl": "otpauth://totp/Beacon:john@example.com?...",
  "qrCodeDataUrl": "data:image/png;base64,...",
  "expiresAt": "2026-10-06T10:10:00.000Z"
}
```

实现建议：

- 校验当前密码，防止已登录会话被盗后直接绑定攻击者设备。
- setup 阶段不要写入正式 `TwoFactorSecret`。
- 临时 secret 用短期 challenge 机制保存，TTL 10 分钟。
- 如果用户已经开启 2FA，返回 `409 Conflict`。

### 确认开启 2FA

`POST /auth/2fa/enable`

需要 bearer token。

请求：

```json
{
  "setupToken": "opaque-setup-token",
  "code": "123456"
}
```

响应：

```json
{
  "recoveryCodes": [
    "8H2K-M4XD-9PQA",
    "7N3C-K9RT-2BPL"
  ]
}
```

事务内完成：

1. 校验 setup token。
2. 校验 TOTP code。
3. 写入 `TwoFactorSecret`。
4. 生成并写入恢复码 hash。
5. 更新 `User.twoFactorEnabled=true` 和 `twoFactorEnabledAt=now`。
6. 撤销该用户现有 refresh token，要求其他设备重新登录。
7. 写审计日志。

### 查看状态

`GET /auth/2fa/status`

需要 bearer token。

响应：

```json
{
  "enabled": true,
  "enabledAt": "2026-10-06T10:00:00.000Z",
  "recoveryCodesRemaining": 8
}
```

不要返回 secret、otpauthUrl、恢复码明文。

### 重新生成恢复码

`POST /auth/2fa/recovery-codes`

需要 bearer token。

请求：

```json
{
  "currentPassword": "StrongP@ss1",
  "code": "123456"
}
```

响应：

```json
{
  "recoveryCodes": [
    "9J2M-PP4D-CT81"
  ]
}
```

规则：

- 用户必须已开启 2FA。
- 校验当前密码和 TOTP。
- 旧恢复码全部作废，生成新的一组。
- 不撤销 refresh token。

### 关闭 2FA

`POST /auth/2fa/disable`

需要 bearer token。

请求：

```json
{
  "currentPassword": "StrongP@ss1",
  "code": "123456"
}
```

规则：

- 校验当前密码。
- `code` 可为 TOTP 或未使用恢复码。
- 删除 `TwoFactorSecret` 和恢复码，更新 `User.twoFactorEnabled=false`。
- 撤销该用户所有 refresh token，当前设备也需要重新登录。
- 写审计日志并发送安全提醒邮件。

## 核心业务逻辑

### 登录改造

`AuthService.login` 需要拆成两个阶段：

```typescript
async login(dto: LoginDto, requestMeta: RequestMeta) {
    const user = await this.validatePasswordLogin(dto);

    if (user.twoFactorEnabled) {
        return this.twoFactor.createLoginChallenge(user.id, requestMeta);
    }

    return this.issueTokensForUser(user);
}
```

为了复用微信登录，建议增加一个统一门面：

```typescript
async issueTokensOrChallenge(user: UserModel, requestMeta: RequestMeta) {
    if (user.twoFactorEnabled) {
        return this.twoFactor.createLoginChallenge(user.id, requestMeta);
    }

    return this.issueTokensForUser(user);
}
```

然后邮箱密码登录和微信登录都走这个门面。这样用户开启 2FA 后，即使使用微信登录，也仍需二次验证。

### TOTP 校验

```typescript
const valid = authenticator.verify({
    token: dto.code,
    secret,
});
```

配置：

```typescript
authenticator.options = {
    step: 30,
    window: 1,
};
```

注意事项：

- `code` 只允许 6 位数字，恢复码另走格式分支。
- TOTP 校验失败不能暴露“challenge 有效但 code 错误”等过细原因。
- 失败统一返回 `UnauthorizedException('Invalid or expired two-factor challenge')`。

### 恢复码校验

```text
读取用户未使用恢复码
    ↓
bcrypt.compare(code, codeHash)
    ↓
命中后 usedAt=now
```

恢复码命中时建议返回一个 `recoveryCodeUsed: true` 的内部标记，用于发送提醒邮件：“你的一个恢复码刚刚被使用，请确认是否本人操作”。

### Secret 加密

使用 Node `crypto`：

```typescript
AES-256-GCM
iv: 12 bytes random
tag: 16 bytes
key: base64(TWO_FACTOR_SECRET_KEY)
```

密钥轮换策略：

- 第一版只支持单 active key。
- 密文带 `v1` 前缀。
- 后续可引入 `TWO_FACTOR_SECRET_KEY_V2` 并按版本解密。

## 安全策略

| 场景                 | 策略                                                         |
| -------------------- | ------------------------------------------------------------ |
| 登录密码错误         | 沿用现有 `Invalid credentials`，不暴露 2FA 状态              |
| 密码正确且已开启 2FA | 返回 challenge，但不返回 user 详情和 tokens                  |
| challenge 失败       | 增加 attempts，超过阈值消费 challenge                        |
| challenge 过期       | 不可续期，用户重新登录                                       |
| 开启 2FA             | 必须验证当前密码和 TOTP                                      |
| 关闭 2FA             | 必须验证当前密码和 TOTP/恢复码                               |
| 恢复码               | 只展示一次，只存 bcrypt hash                                 |
| secret               | 只加密存储，不进入日志和审计 after 快照                      |
| refresh token        | 开启/关闭/重置密码后全部撤销                                 |
| 限流                 | login、verify-login、setup、enable、disable 均加 `@Throttle` |

建议限流：

| 接口                            | 限流            |
| ------------------------------- | --------------- |
| `POST /auth/login`              | 沿用每分钟 5 次 |
| `POST /auth/2fa/verify-login`   | 每分钟 5 次     |
| `POST /auth/2fa/setup`          | 每分钟 3 次     |
| `POST /auth/2fa/enable`         | 每分钟 5 次     |
| `POST /auth/2fa/disable`        | 每分钟 3 次     |
| `POST /auth/2fa/recovery-codes` | 每分钟 3 次     |

## 审计日志

现有 `AuditAction` 没有 `SECURITY` 类动作，建议扩展：

```prisma
enum AuditAction {
  // ...现有值
  ENABLE_2FA
  DISABLE_2FA
  REGENERATE_RECOVERY_CODES
  USE_RECOVERY_CODE
}
```

审计实体：

```text
entity = "UserSecurity"
entityId = userId
organizationId = null
projectId = null
```

敏感字段不能写入 `before` / `after`：

- TOTP secret
- setup token
- challenge token
- recovery code 明文和 hash

需要同步把 `AuditLogInterceptor.SENSITIVE_FIELDS` 增加：

```typescript
'secretEnc',
'codeHash',
'setupToken',
'challengeId',
'recoveryCodes'
```

## DTO 与响应实体

建议新增：

```text
SetupTwoFactorDto
EnableTwoFactorDto
VerifyTwoFactorLoginDto
DisableTwoFactorDto
RegenerateRecoveryCodesDto
TwoFactorRequiredEntity
TwoFactorSetupEntity
TwoFactorStatusEntity
RecoveryCodesEntity
LoginResponseEntity
```

校验规则：

| 字段              | 规则                                                      |
| ----------------- | --------------------------------------------------------- |
| `currentPassword` | `@IsString() @IsNotEmpty()`                               |
| `code`            | `@IsString() @IsNotEmpty()`，服务层区分 TOTP 和恢复码格式 |
| `challengeId`     | `@IsString() @IsNotEmpty()`                               |
| `setupToken`      | `@IsString() @IsNotEmpty()`                               |

## 错误码

| HTTP | code                           | 场景                          |
| ---- | ------------------------------ | ----------------------------- |
| 400  | `TWO_FACTOR_ALREADY_ENABLED`   | 重复 setup/enable             |
| 400  | `TWO_FACTOR_NOT_ENABLED`       | 未开启时 disable 或重置恢复码 |
| 401  | `INVALID_TWO_FACTOR_CHALLENGE` | challenge 无效、过期、已消费  |
| 401  | `INVALID_TWO_FACTOR_CODE`      | TOTP 或恢复码错误             |
| 401  | `INVALID_CURRENT_PASSWORD`     | 当前密码错误                  |
| 429  | `TOO_MANY_TWO_FACTOR_ATTEMPTS` | 尝试次数或限流超过阈值        |

当前全局异常过滤器如果还未标准化业务 code，可先在 exception response body 中返回：

```json
{
  "code": "INVALID_TWO_FACTOR_CODE",
  "message": "Invalid or expired two-factor challenge"
}
```

## 实施步骤

1. 新增 Prisma models：`TwoFactorSecret`、`TwoFactorRecoveryCode`、`TwoFactorChallenge`，并扩展 `User` 字段和 relation。
2. 运行 `pnpm prisma:generate`。
3. 增加 two-factor config，并更新 `.env.example`。
4. 安装依赖：`pnpm add otplib qrcode`。
5. 新增 `TwoFactorCryptoService`，实现 secret 加解密、恢复码生成、token hash。
6. 新增 `TwoFactorService`，实现 setup、enable、status、verify-login、disable、regenerate recovery codes。
7. 修改 `AuthService.login` 和微信登录签发路径，开启 2FA 时返回 challenge。
8. 新增 `TwoFactorController` 或在 `AuthController` 中挂载 `/auth/2fa/*`。
9. 扩展 Swagger entities 和 DTO。
10. 扩展审计动作与敏感字段过滤。
11. 补充单元测试和 e2e 测试。
12. 本地验证：`pnpm prisma:generate`、`pnpm type-check`、`pnpm lint`、`pnpm build`。

## 测试方案

### 单元测试

| 模块                           | 测试点                                                          |
| ------------------------------ | --------------------------------------------------------------- |
| `TwoFactorCryptoService`       | 加解密 round trip、错误 key 解密失败、恢复码格式和数量          |
| `TwoFactorService.setup`       | 当前密码错误、已开启冲突、返回 otpauthUrl 和二维码              |
| `TwoFactorService.enable`      | setup token 过期、TOTP 错误、成功写入 secret 和恢复码           |
| `TwoFactorService.verifyLogin` | challenge 过期、尝试次数限制、TOTP 成功、恢复码成功且只能用一次 |
| `TwoFactorService.disable`     | 当前密码错误、code 错误、成功关闭并撤销 refresh token           |
| `AuthService.login`            | 未开启返回 tokens，已开启返回 challenge 且不创建 refresh token  |

### e2e 测试

```text
注册并验证邮箱
    ↓
登录成功拿 token
    ↓
setup 2FA
    ↓
enable 2FA
    ↓
重新 login 返回 twoFactorRequired
    ↓
verify-login 返回 tokens
    ↓
logout / refresh 正常工作
    ↓
disable 2FA 后 login 直接返回 tokens
```

恢复码链路：

```text
开启 2FA
    ↓
login 得到 challenge
    ↓
用恢复码 verify-login 成功
    ↓
同一个恢复码再次 verify-login 失败
```

### 手动验证

```bash
# 1. 初始化 2FA
curl -X POST http://localhost:3000/api/auth/2fa/setup \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"StrongP@ss1"}'

# 2. 用 Authenticator App 扫码后确认开启
curl -X POST http://localhost:3000/api/auth/2fa/enable \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"setupToken":"<setupToken>","code":"123456"}'

# 3. 登录，此时只返回 challenge
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"john@example.com","password":"StrongP@ss1"}'

# 4. 校验 2FA 并拿 token
curl -X POST http://localhost:3000/api/auth/2fa/verify-login \
  -H "Content-Type: application/json" \
  -d '{"challengeId":"<challengeId>","code":"123456"}'
```

## 风险与缓解

| 风险                          | 影响                    | 缓解                                                 |
| ----------------------------- | ----------------------- | ---------------------------------------------------- |
| 用户丢失 Authenticator 设备   | 无法登录                | 提供恢复码；后续可加管理员重置流程                   |
| Secret 加密 key 丢失          | 已开启用户无法校验 TOTP | 密钥纳入部署密钥管理和备份流程                       |
| 前端误把 challenge 当登录成功 | 可能进入半登录状态      | 响应结构明确 `twoFactorRequired=true`，不返回 tokens |
| 恢复码泄漏                    | 攻击者可完成一次登录    | 恢复码只显示一次、只存 hash、使用后邮件提醒          |
| 微信登录绕过 2FA              | 用户开启后仍可绕过      | 所有发 token 路径统一走 `issueTokensOrChallenge`     |
| 时钟漂移                      | 正确验证码失败          | TOTP window 设置为 1；服务端保持 NTP 同步            |
| 审计泄漏敏感数据              | secret 或恢复码泄漏     | 扩展敏感字段过滤，服务日志不打印 DTO 全量            |

## 后续演进

| 版本 | 内容                                             |
| ---- | ------------------------------------------------ |
| V1.1 | 可信设备：完成 2FA 后可选择 30 天内免二次验证    |
| V1.2 | 组织级强制 2FA 策略，OWNER/ADMIN 可要求成员开启  |
| V1.3 | 管理员协助重置 2FA，配合审计和邮件确认           |
| V2.0 | WebAuthn/Passkey，支持硬件安全密钥和平台生物识别 |

## 关键结论

第一版推荐以 TOTP + 恢复码为核心，不引入短信和邮件二次登录。实现重点是把“密码正确”和“登录完成”拆开：密码正确只生成短期 challenge，只有通过第二因素后才签发 access token 和 refresh token。这样改动范围集中在 Auth 模块，又能覆盖邮箱密码登录和微信登录两条发 token 路径。

## 与现有代码的偏差与决策项

> 本节在核对现有代码库后补充（2026-10-07），记录方案与当前实现的出入及需要拍板的点。总体结论：方案可行，与现有 Auth 架构高度契合，核心思路（密码正确只发短期 challenge，通过第二因素后才发 token）在 `AuthService` 落地自然。

### 与现状吻合、可直接复用

- `AuthService.login` 已是“查用户 → 验密码 → 发 token”线性流程，拆出 challenge 分支容易。
- 门面已天然存在：`AuthService.issueTokensForUser()` 已被微信登录 `WechatAuthService.finishLogin` 复用，改这一处即可同时覆盖邮箱密码 + 微信两条发 token 路径（即上文 `issueTokensOrChallenge` 门面的意图）。
- refresh token 撤销：现有多处 `refreshToken.updateMany({ where: { userId, revokedAt: null } })`，可原样复用。
- 限流：全局 `ThrottlerGuard` + controller 上 `@Throttle` 已成熟，2FA 接口照抄即可。
- 配置：`registerAs` + `requireEnv/optionalEnv` 模式成熟，`two-factor.config.ts` 照写即可。
- 加密：AES-256-GCM 用 Node `crypto`，无额外依赖。
- 验证脚本 `prisma:generate` / `type-check` / `lint` / `build` 均在 package.json 中，实施步骤 12 全部可执行。

### 偏差项（实现时需额外处理）

1. **审计日志无法按上文“审计日志”节的方式自动记录**（关键偏差）。`AuditLogInterceptor` 只在 `@AuditLog()` 装饰的 handler 生效，且 `entityId` 只能从 `request.params` 或响应体 `id` / `data.id` 解析。2FA 接口响应体不含 `id`（setup 返回 `setupToken`、enable 返回 `recoveryCodes`、disable 无 body），而 `userId` 在 `request.user.sub`。**推荐在 `TwoFactorService` 内直接 `prisma.auditLog.create()`**（entity=UserSecurity、entityId=userId、无 before/after 快照），而不是扩展 interceptor。
2. **`RequestMeta` 不存在**。上文 `login(dto, requestMeta)` 与 challenge 的 `ipAddress/userAgent` 依赖一个代码库中不存在的 `RequestMeta` 类型/装饰器（现有只有 `CurrentUser`）。需新建，从 `@Req()` 提取 IP 与 User-Agent，或新增 `@RequestMeta()` 参数装饰器。
3. **业务错误码尚未标准化**。当前 `GlobalExceptionFilter` 只返回 `{ statusCode, timestamp, method, message }`，无 `code` 字段。上文错误码（`INVALID_TWO_FACTOR_CHALLENGE` 等）需扩展异常过滤器，或新增携带 `code` 的业务异常并在 filter 中透传——文档已在“错误码”节预见到，但未列入实施步骤。
4. **依赖**：`otplib`、`qrcode` 均未安装；`qrcode` 无内置类型，需一并安装 `@types/qrcode`。当前环境未检测到 `pnpm`（有 `npm`），安装依赖时注意不破坏现有 `pnpm-lock.yaml`。

### 决策项（实现前需拍板）

1. **微信用户无法自行开启 2FA**（产品边界）。`setup` / `disable` / `recovery-codes` 都要求 `currentPassword`，但微信注册用户密码是 `bcrypt(randomBytes)` 随机值，用户不知情，永远过不了密码校验。后果：微信用户走不到 challenge 分支，即“开启 2FA 后微信登录仍须二次验证”的目标对微信用户第一版实际无法触发。**建议：第一版仅邮箱+密码用户可开启 2FA，微信用户 setup 时返回明确 4xx，后续 V1.3 再补**（或先为微信用户补“设置密码”流程）。
2. **`TWO_FACTOR_SECRET_KEY` 强制 vs 惰性**。文档要求缺失即启动失败（可用 `requireEnv`），但项目惯例是大量配置用 `optionalEnv` 让未启用功能的环境也能启动。需二选一：强制必填（所有环境含 CI/dev 都必须配置）或惰性校验（默认空、首次调用 2FA 时才抛错）。后者对“不启用 2FA 的既有部署”可零配置升级。

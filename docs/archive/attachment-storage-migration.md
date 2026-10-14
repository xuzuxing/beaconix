# 附件上传存储迁移方案：移除 UploadThing，支持 Local / OSS

> 归档说明：本仓库当前已采用第一方 Local/OSS 附件上传。下文“待评审 / 待开发”和 UploadThing 链路描述的是迁移前基线，不是当前功能状态。

> 文档类型：历史归档。原文中的“当前状态”、缺口、示例和阶段计划均属于当时的设计快照，不代表最新实现；日常使用请从 [文档索引](../README.md) 查找现行接口与运行指南。

> 状态：待评审 / 待开发  
> 关联模块：`src/modules/attachments`、`src/main.ts`、`prisma/schema.prisma`、`views/upload-test.hbs`  
> 目标：移除 UploadThing 依赖，改为 Beacon 自己控制的上传能力，并通过统一抽象支持本地磁盘与对象存储。

## 1. 背景

当前附件上传链路依赖 UploadThing：

- `src/main.ts` 通过 `createRouteHandler` 把 `/api/uploadthing` 挂到 Express。
- `src/modules/attachments/upload.router.ts` 定义 UploadThing `taskAttachment` 路由。
- `src/modules/attachments/attachments.service.ts` 使用 `UTApi.deleteFiles()` 删除 CDN 文件。
- `Attachment.fileKey` 注释和删除逻辑都绑定 UploadThing key。
- `views/upload-test.hbs` 使用 UploadThing 前端 SDK。
- `.env.example` / README / 部分 docs 里有 `UPLOADTHING_TOKEN`。

这使后端上传能力依赖第三方协议和 SDK，不利于私有化部署、国产云 OSS 接入、权限控制、审计和后续迁移。

## 2. 目标与非目标

### 2.1 目标

1. 移除 UploadThing 运行时依赖和 `/api/uploadthing` 路由。
2. 新增 Beacon 自有上传接口，支持：
    - `local`：开发 / 私有化部署的本地磁盘存储。
    - `oss`：对象存储，优先按 S3-compatible 抽象设计，后续可落阿里云 OSS / 腾讯 COS / MinIO。
3. 保持现有附件业务接口语义：
    - 附件仍绑定 Task。
    - 数据库仍保存附件元数据。
    - 删除附件时同步删除底层对象。
4. 提供统一 `StorageService` 抽象，让业务层不关心具体存储后端。
5. 提供本地测试页，覆盖上传、列表、下载/访问、删除。

### 2.2 非目标

- 不在本阶段做图片处理、缩略图、病毒扫描。
- 不在本阶段做断点续传和大文件分片。
- 不在本阶段做跨区域同步。
- 不在本阶段做前端直传云存储的复杂回调闭环；v1 优先实现后端代理上传，稳定后再扩展预签名直传。

## 3. 推荐方案

采用“两层接口”：

```text
Client
  │ multipart/form-data
  ▼
AttachmentsController
  │ 校验 JWT + OrgMemberGuard + task 权限
  ▼
AttachmentsService
  │ 业务校验、创建附件记录、删除附件记录
  ▼
StorageService
  │ put / delete / getPublicUrl / getSignedUrl
  ├── LocalStorageProvider
  └── ObjectStorageProvider
```

### 3.1 为什么 v1 采用后端代理上传

优点：

- 权限模型简单：沿用 Nest Controller、JWT、`OrgMemberGuard`。
- 不需要前端理解对象存储 SDK。
- 不需要处理客户端直传后“上传成功但 metadata 未落库”的补偿问题。
- 本地存储和 OSS 行为一致。

代价：

- API 服务会承接上传流量。
- 大文件上传会占用后端带宽。

当前附件上限较小（原 UploadThing 配置：图片 8MB、PDF 16MB、blob 32MB），后端代理足够。后续若需要 100MB+ 文件，再加“预签名直传模式”。

## 4. 接口设计

### 4.1 上传并保存附件

```text
POST /api/tasks/:taskId/attachments/upload
Content-Type: multipart/form-data
Authorization: Bearer <JWT>

file=<binary>
source=UPLOAD       # 可选，默认 UPLOAD
```

行为：

1. `JwtAuthGuard` 验证用户。
2. `OrgMemberGuard` 验证 task 所属组织成员身份。
3. 校验 task 存在且未软删除。
4. 校验文件类型、大小、数量。
5. 调用 `StorageService.putObject()`。
6. 创建 `Attachment` 记录。
7. 返回 `AttachmentEntity`。

响应示例：

```json
{
  "data": {
    "id": "att_xxx",
    "filename": "design-spec.pdf",
    "mimeType": "application/pdf",
    "size": 1048576,
    "url": "http://localhost:3000/api/files/tasks/task_xxx/att_xxx/design-spec.pdf",
    "fileKey": "organizations/org_xxx/tasks/task_xxx/01HX...pdf",
    "source": "UPLOAD",
    "taskId": "task_xxx",
    "uploadedById": "user_xxx"
  },
  "meta": { "timestamp": "..." }
}
```

### 4.2 保留 metadata 保存接口

保留现有接口：

```text
POST /api/tasks/:taskId/attachments
```

用途：

- 兼容外部 URL、Google Drive、Dropbox。
- 支持后续“预签名直传完成后保存 metadata”。

调整：

- `fileKey` 描述从 UploadThing key 改为 storage object key。
- `source=UPLOAD` 时建议要求 `fileKey` 存在。

### 4.3 下载 / 访问文件

v1 推荐：

```text
GET /api/attachments/:id/download
Authorization: Bearer <JWT>
```

行为：

- 校验用户有权限访问附件所属 task。
- local provider：`res.sendFile()` 或 stream。
- oss provider：
    - 私有 bucket：返回 302 到短期签名 URL，或后端 stream。
    - 公共 bucket：返回 302 到 public URL。

如果产品需要公开附件，再额外引入 `visibility` 字段，不默认公开。

### 4.4 删除附件

沿用现有接口：

```text
DELETE /api/tasks/:taskId/attachments/:id
```

调整：

- 删除数据库记录前/后调用 `StorageService.deleteObject(fileKey)`。
- 对象不存在时不应阻塞 DB 删除，可记录 warning。

## 5. 数据模型调整

当前 `Attachment` 已有足够字段：

```prisma
model Attachment {
  id           String
  filename     String
  mimeType     String
  size         Int
  url          String
  fileKey      String?
  source       AttachmentSource
  taskId       String
  uploadedById String?
  createdAt    DateTime
}
```

建议最小调整：

```prisma
enum AttachmentStorageProvider {
  LOCAL
  OSS
  EXTERNAL
}

model Attachment {
  // existing fields...
  storageProvider AttachmentStorageProvider @default(LOCAL)
  bucket          String?
  fileKey         String?
  checksum        String?
}
```

说明：

- `fileKey` 从 UploadThing key 泛化为对象 key。
- `storageProvider` 标记文件在哪个 provider。
- `bucket` 便于多 bucket / 多环境排查。
- `checksum` 用于后续完整性校验、去重、审计；v1 可选。
- `url` 可以继续存“可访问 URL”，但私有文件建议存内部下载 URL，而不是永久公开 URL。

如果要减少迁移复杂度，v1 也可以先不加字段，只更新 `fileKey` 语义；但长期建议补 `storageProvider/bucket/checksum`。

## 6. 存储抽象

### 6.1 接口

```ts
export interface PutObjectInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  size: number;
  organizationId: string;
  taskId: string;
  uploadedById: string;
}

export interface PutObjectResult {
  provider: 'LOCAL' | 'OSS';
  bucket?: string;
  key: string;
  url: string;
  checksum?: string;
}

export interface StorageProvider {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  deleteObject(key: string, bucket?: string): Promise<void>;
  getDownloadUrl(key: string, bucket?: string): Promise<string>;
}
```

### 6.2 Key 规范

统一对象 key：

```text
organizations/{organizationId}/tasks/{taskId}/{yyyy}/{mm}/{cuid}-{safeFilename}
```

示例：

```text
organizations/cm123/tasks/task456/2026/10/cmabc-design-spec.pdf
```

要求：

- 文件名做 sanitize，移除路径符号和控制字符。
- key 由后端生成，前端不得传入最终 key。
- 不使用原始文件名作为唯一标识。

### 6.3 Local Provider

启动配置：

```env
STORAGE_LOCAL_ROOT=storage/uploads
```

行为：

- 文件保存到 `STORAGE_LOCAL_ROOT/<key>`。
- `url` 默认返回内部下载地址：`/api/attachments/:id/download`。
- 生产环境如用 Nginx 静态托管，可在 `settings` 表设置 `storage.publicBaseUrl`。

安全要求：

- 所有写入路径必须 `path.resolve` 后确认仍在 `STORAGE_LOCAL_ROOT` 内。
- 不允许客户端传入相对路径。
- 下载时通过数据库查 `fileKey`，不直接接受任意 path。

### 6.4 OSS Provider

启动配置按 S3-compatible 抽象设计：

```env
STORAGE_OSS_ENDPOINT=
STORAGE_OSS_REGION=
STORAGE_OSS_BUCKET=
STORAGE_OSS_ACCESS_KEY_ID=
STORAGE_OSS_ACCESS_KEY_SECRET=
STORAGE_OSS_FORCE_PATH_STYLE=false
```

建议实现优先级：

1. MinIO / S3-compatible SDK 抽象，方便本地 e2e。
2. 阿里云 OSS provider（如确定生产使用阿里云）。
3. 腾讯 COS provider（如小程序生态优先）。

对象访问模式：

- 默认 private bucket。
- 下载接口返回短期 signed URL 或后端 stream。
- 如果在 `settings` 表配置 `storage.oss.publicBaseUrl`，可返回公共 CDN URL。

## 7. 文件校验策略

沿用原限制并放到 `settings` 表：

```text
attachments.maxImageSizeMb=8
attachments.maxPdfSizeMb=16
attachments.maxBlobSizeMb=32
attachments.maxFilesPerRequest=5
```

默认允许：

- image：`image/*`
- pdf：`application/pdf`
- blob：其他常见办公文件 / 文本 / 压缩包，按白名单逐步开放

建议 v1 白名单：

```text
image/png
image/jpeg
image/webp
image/gif
application/pdf
text/plain
text/csv
application/zip
application/vnd.openxmlformats-officedocument.wordprocessingml.document
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
```

不要完全相信浏览器传的 MIME，服务端可用文件头检测库做二次识别；v1 至少保留 MIME + 扩展名双校验。

## 8. 模块与文件规划

```text
src/modules/attachments/
├── attachments.controller.ts
├── attachments.service.ts
├── attachments.module.ts
├── dto/
│   ├── save-attachment.dto.ts
│   └── upload-attachment.dto.ts
├── entities/
│   └── attachment.entity.ts
└── storage/
    ├── storage.module.ts
    ├── storage.service.ts
    ├── storage.types.ts
    ├── local-storage.provider.ts
    ├── oss-storage.provider.ts
    └── filename.util.ts
```

也可以把 storage 抽到 infra：

```text
src/infra/storage/
```

如果未来头像、组织 logo、监控截图都要复用上传能力，推荐放 `infra/storage`。如果仅附件用，先放 `modules/attachments/storage` 更收敛。

## 9. 需要移除或更新的现有代码

### 9.1 删除 UploadThing 接入

- 删除 `src/modules/attachments/upload.router.ts`。
- 从 `src/main.ts` 移除：
    - `createRouteHandler` import。
    - `uploadRouter` import。
    - `expressApp.use('/api/uploadthing', ...)`。
    - 为 UploadThing 测试页放行的 CSP：`esm.sh`、`uploadthing.com`、`utfs.io`。
- 从 `AttachmentsService` 移除 `UTApi`。
- 从 `package.json` 移除 `uploadthing`，更新 `pnpm-lock.yaml`。

### 9.2 更新测试页

- 保留 `views/upload-test.hbs`，但改为原生 `multipart/form-data`：
    - `POST /api/tasks/:taskId/attachments/upload`
    - `GET /api/tasks/:taskId/attachments`
    - `DELETE /api/tasks/:taskId/attachments/:id`
- 移除前端 `https://esm.sh/uploadthing@...` import。

### 9.3 更新文档和配置

- `.env.example` 移除 `UPLOADTHING_TOKEN`。
- 新增 `STORAGE_*` 与 `ATTACHMENT_*` 配置项。
- README 中 UploadThing 描述改为 Local/OSS。
- `docs/product/mini-program-prototype.md`、`docs/archive/monitoring-v1.1-design.md` 中 UploadThing 描述同步更新。
- `AGENTS.md` 后续也应改成自研上传说明。

## 10. 迁移步骤

### Phase 1：存储抽象与 local 上传

1. 增加 storage config。
2. 实现 `LocalStorageProvider`。
3. 新增 `POST /api/tasks/:taskId/attachments/upload`。
4. 删除附件时通过 `StorageService.deleteObject()` 删除本地文件。
5. 改造 `upload-test.hbs` 为原生 multipart 上传。
6. 保留旧 `/api/uploadthing` 暂时不删，用于回滚对比。

### Phase 2：移除 UploadThing

1. 删除 `upload.router.ts` 和 `/api/uploadthing` 挂载。
2. 移除 `UTApi` 删除逻辑。
3. 移除 `uploadthing` 依赖。
4. 移除 `UPLOADTHING_TOKEN`。
5. 更新 README、docs、测试页。

### Phase 3：OSS Provider

1. 增加 `ObjectStorageProvider`。
2. 接入 MinIO 做本地/CI 验证。
3. 根据生产云厂商实现阿里云 OSS 或腾讯 COS provider。
4. 支持私有 bucket signed URL。
5. 增加 e2e 覆盖 local + mocked OSS。

### Phase 4：增强能力

1. 预签名直传：`POST /attachments/upload-url` 获取 URL，前端直传后 `POST /attachments` 保存 metadata。
2. 文件 checksum 与重复文件识别。
3. 图片缩略图。
4. 异步病毒扫描。
5. 附件访问审计。

## 11. 兼容与数据迁移

已有 UploadThing 附件记录：

- `url` 指向 UploadThing CDN。
- `fileKey` 是 UploadThing key。
- `source = UPLOAD`。

迁移策略有两种：

### 11.1 不迁移历史文件

最简单：

- 旧记录继续通过已有 `url` 访问。
- 删除旧记录时不再调用 UploadThing 删除远端文件，只删除 DB。
- 缺点：历史 UploadThing 文件可能残留，需要人工或脚本清理。

### 11.2 迁移历史文件到新存储

流程：

1. 扫描 `Attachment where source=UPLOAD and url contains UploadThing/utfs`。
2. 后端下载旧 URL。
3. 写入新 StorageProvider。
4. 更新 `fileKey/url/storageProvider/bucket/checksum`。
5. 记录迁移日志。

建议：

- 如果生产已有重要文件，做 11.2。
- 如果只是开发期数据，做 11.1 并清空旧测试文件即可。

## 12. 安全与权限

- 上传接口必须走 `JwtAuthGuard` + `OrgMemberGuard`。
- 保存前必须确认 task 存在且 `deletedAt = null`。
- 文件大小限制必须在请求流阶段生效，避免内存被打满。
- local provider 禁止路径穿越。
- OSS provider 默认 private bucket。
- 下载接口不暴露原始本地路径。
- 文件名只用于展示，不能参与权限判断。
- 删除接口仍保持“上传者或 ADMIN/OWNER 可删”的规则。

## 13. 推荐依赖

本地上传：

- `@nestjs/platform-express` 已有。
- 可使用 `multer` / Nest `FileInterceptor`。

OSS：

- S3-compatible：`@aws-sdk/client-s3`、`@aws-sdk/s3-request-presigner`。
- 阿里云 OSS：`ali-oss`。
- 腾讯 COS：`cos-nodejs-sdk-v5`。

建议如果生产云厂商未确定，先用 S3-compatible 抽象 + MinIO 验证。

## 14. 测试计划

### 14.1 单元测试

- `filename.util`：清理危险文件名、保留扩展名、处理中文/空格。
- `LocalStorageProvider`：写入、删除、路径越界保护。
- `AttachmentsService`：上传后创建记录、删除时调用 storage。
- 文件大小 / MIME 校验。

### 14.2 e2e 测试

- 登录用户上传附件到 task。
- 非组织成员上传失败。
- 删除者不是上传者且不是 ADMIN/OWNER 时失败。
- 删除成功后 DB 记录删除、底层文件删除。
- 下载接口权限校验。

### 14.3 手动验证

```bash
# 上传
curl -X POST http://localhost:3000/api/tasks/<taskId>/attachments/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@./README.md"

# 列表
curl http://localhost:3000/api/tasks/<taskId>/attachments \
  -H "Authorization: Bearer <token>"

# 删除
curl -X DELETE http://localhost:3000/api/tasks/<taskId>/attachments/<attachmentId> \
  -H "Authorization: Bearer <token>"
```

## 15. 验收标准

- [ ] 项目不再依赖 `uploadthing` 包。
- [ ] `/api/uploadthing` 路由已移除。
- [ ] `POST /api/tasks/:taskId/attachments/upload` 可上传文件并创建附件记录。
- [ ] `GET /api/tasks/:taskId/attachments` 可看到新上传附件。
- [ ] `DELETE /api/tasks/:taskId/attachments/:id` 可删除 DB 记录和底层文件。
- [ ] local driver 可在开发环境使用。
- [ ] oss driver 可通过 MinIO 或目标云厂商验证。
- [ ] `.env.example`、README、相关 docs 已同步。
- [ ] `pnpm type-check`、`pnpm lint`、`pnpm build` 通过。

## 16. 待确认问题

1. 生产目标 OSS 是阿里云 OSS、腾讯 COS、MinIO，还是 S3-compatible？
2. 附件是否默认私有？是否需要公开分享链接？
3. 历史 UploadThing 文件是否需要迁移？
4. 单文件最大大小是否沿用 32MB？
5. 小程序端是否要走 `wx.uploadFile` 到 Beacon API，还是后续直传 OSS？
6. 是否需要组织级存储配额纳入 Billing plan？

# 响应格式与分页约定

本文件规定 HTTP 接口的响应包裹层与分页字段，是新增接口时必须遵守的契约。现行实现见 `src/common/interceptors/transform.interceptor.ts`。

## 全局包裹层

除少数例外（见下文），每个接口的返回值都会被 `TransformInterceptor` 包成：

```json
{
    "data": "<controller/service 的返回值>",
    "meta": {
        "timestamp": "2026-10-17T08:00:00.000Z",
        "requestId": "..."
    }
}
```

`meta` 由拦截器统一写入，业务代码**不要**自己返回 `meta`，也不要把分页信息塞进 `meta`。

## 分页列表

列表接口的 service 方法返回一个**扁平对象**，不要自己再套 `data`/`meta` 层：

```ts
return {
    items: rows.map((row) => new ThingEntity(row)),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
};
```

经过拦截器后，实际 HTTP 响应是：

```json
{
    "data": {
        "items": [{ "id": "..." }],
        "total": 128,
        "page": 1,
        "limit": 25,
        "totalPages": 6
    },
    "meta": {
        "timestamp": "2026-10-17T08:00:00.000Z",
        "requestId": "..."
    }
}
```

### 约定要点

- 列表字段名固定为 `items`（不是 `data`、`list`、`records`）。
- 分页字段名固定为 `total`、`page`、`limit`、`totalPages`，与 `data` 同级。
- `totalPages` 用 `Math.ceil(total / limit)` 计算；`total` 为 0 时为 0。
- `page` / `limit` 回显**实际生效**的值（含 DTO 默认值），不要回显原始 query。
- 顶层 `meta` 只属于拦截器（`timestamp`、`requestId`），业务代码不写。

### 反例

```ts
// ✗ 会被拦截器再包一层，前端拿到 data.data 和 data.meta.total
return {
    data: rows.map((row) => new ThingEntity(row)),
    meta: { total, page, limit, totalPages },
};
```

响应会变成 `{ data: { data: [...], meta: {...} }, meta: {...} }`，`meta.total` 在顶层永远是 `undefined`。这正是工单与通知列表曾经的问题。

## Swagger 声明

分页接口用 `schema.properties` 声明扁平结构，实体用 `getSchemaPath` 引用，并在控制器上登记 `@ApiExtraModels`：

```ts
@ApiExtraModels(ThingEntity)
@Controller('things')
export class ThingsController {
    @Get()
    @ApiOkResponse({
        description: 'Paginated things',
        schema: {
            properties: {
                items: {
                    type: 'array',
                    items: { $ref: getSchemaPath(ThingEntity) },
                },
                total: { type: 'number', example: 128 },
                page: { type: 'number', example: 1 },
                limit: { type: 'number', example: 25 },
                totalPages: { type: 'number', example: 6 },
            },
        },
    })
    findAll(@Query() query: QueryThingsDto) {
        return this.thingsService.findAll(query);
    }
}
```

## 例外：`@SkipTransform()`

以下场景用 `@SkipTransform()` 跳过全局包裹，返回值即响应体，因此**不能**依赖上面的分页结构：

- SSE 流（`/notifications/stream` 等）
- 文件下载、Webhook/支付回调、状态页 HTML/XML 输出
- 已经手写完整响应结构的接口（如部分监控仪表盘接口）

新增 `@SkipTransform()` 接口需要在 Swagger 上写清完整响应体，并在评审时说明理由。

## 当前已对齐的列表接口

| 接口                          | 实现                                                |
| ----------------------------- | --------------------------------------------------- |
| `GET /api/admin/orders`       | `src/modules/admin/orders/admin-orders.service.ts`  |
| `GET /api/admin/audit-logs`   | `src/modules/admin/audit-logs/admin-audit-logs.service.ts` |
| `GET /api/admin/tickets`      | `src/modules/admin/tickets/admin-tickets.service.ts` |
| `GET /api/audit-logs`         | `src/modules/audit-logs/audit-logs.service.ts`      |
| `GET /api/tickets`            | `src/modules/tickets/tickets.service.ts`            |
| `GET /api/notifications`      | `src/modules/notifications/notifications.service.ts` |

新增列表接口请参照本文件与上述实现；单测至少断言 `items` 存在、分页字段在返回值顶层、且返回值不含 `data` / `meta` 键。

# 节点异常规则引擎

> 文档类型：设计记录。保留原方案、代码示例和阶段决策；当前行为以源码与 Swagger 为准。

## 节点异常条件规则（规则树）

> 规则树存 `RuleGroup.tree`（JSON），`MonitorRuleBinding` 把规则组挂到 Monitor。创建规则组时递归 `validate()` 校验嵌套结构，并 `extractFields()` 写入 `fieldsUsed`；检查时对绑定的规则组递归 `evaluate()`，**只产出 `ruleMatched`/`ruleGroupIds` 校验结论并随 `CheckLog` 落库**，不再直接发通知或做动作。以下各节为实现方案。

## 0. 现状核对（本次修订的关键差异）

原计划有几处假设与当前代码不符，照搬会无法编译或运行时出错，修订如下：

| 原计划假设                                                           | 当前实际                                                                                                                                                 | 修订                                                                                                                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 接入点是 `recordCheckResult()`，插在「CheckLog 后、MonitorState 前」 | 链路在 `CheckerService.execute()`（私有）内；`CheckLog` 与 `MonitorState` 由 `StateService.record()` 在**同一个 `$transaction`** 里写                    | 规则求值在 `record()` 之前，结论（`ruleMatched`/`ruleGroupIds`）作为 outcome 传入 `record()` 一并落库；告警条件在 `record()` 之后读 CheckLog 聚合告警 |
| `@RequireRole('ADMIN')` 装饰器                                       | 不存在；实际是 `@Roles('ADMIN')` + `@UseGuards(RolesGuard)`                                                                                              | 全部替换为 `@Roles`                                                                                                                                   |
| Controller 写 `/api/organizations/...`                               | `main.ts` 已 `app.setGlobalPrefix('api')`，再写 `/api` 会变成 `/api/api/...`                                                                             | 去掉路径里的 `/api` 前缀                                                                                                                              |
| 绑定接口 `/api/monitors/:monitorId/rule-bindings`                    | monitor 都挂在 `projects/:projectId/monitors` 下；`OrgMemberGuard.resolveOrgId()` 只识别 `orgId / projectId / taskId / :id`，无法从 `monitorId` 解析组织 | 绑定接口改到 `projects/:projectId/monitors/:monitorId/rule-bindings`                                                                                  |
| `RuleContext` 含 `statusCode`、`bodyContains`                        | 检测链路**不采集**这两个值（`HttpChecker` 只比较状态码后丢弃 body，不记录实际 statusCode）                                                               | 拆成「核心字段」（已有）与「扩展字段」（需先改采集层）两组，分阶段                                                                                    |
| `certDaysRemaining`、`success`、`latency`                            | 已存在（`CheckResult.ssl.daysRemaining`、`CheckResult.success/latency`）                                                                                 | 直接可用                                                                                                                                              |
| 缓存用 `LRUCache`                                                    | 项目已有 `node-cache`，并有 `MultiLevelCacheService`（L1 node-cache + L2 Redis）                                                                         | 复用 `MultiLevelCacheService.getOrSet`                                                                                                                |
| `PrismaService` 路径 `../prisma/prisma.service`                      | 实际是 `src/infra/database/prisma.service`                                                                                                               | 修正 import 路径                                                                                                                                      |
| 迁移名 `add_rule_engine`                                             | 现有迁移均为时间戳前缀（如 `20261007000000_...`）                                                                                                        | `prisma migrate dev` 自动生成时间戳前缀                                                                                                               |

## 1. 定位与设计取舍

规则引擎挂在 `Monitor` 上，是现有 `Organization -> Project -> Monitor` 项目级模型上的一个增强层，不改动现有模型层级。

核心决策不变：**规则树存 JSON，不拆表**。

理由：

- 规则是递归结构，拆表（`rule_group / rule_condition / rule_join`）需要多次 JOIN + 递归查询，复杂且慢；
- 规则整体读写，不会单独查某个条件；
- 求值在服务端内存里做，不需要数据库参与计算；
- JSON 字段便于版本迭代（加新操作符不用改 schema）。

它与现有能力的关系：

- **状态机**（`StateService.deriveState`：`UNKNOWN -> UP/DEGRADED/DOWN/PAUSED`）负责「可达性」判定，规则引擎**不替代**它；规则引擎只负责产出「这一轮是否异常」的校验结论。
- **通知体系**（`NotifierService`，已 BullMQ 队列化）负责渠道投递，告警条件命中后复用同一套渠道与队列发 `AVAILABILITY_ALERT`。

## 2. Prisma Schema 增量

在现有 schema 上新增两个 model，并在三个既有 model 上补反向关系字段；同时 `CheckLog` 增加规则校验结论两列（见下）。

```prisma
// ==================== RULE ENGINE ====================

// 规则组：一棵逻辑树
model RuleGroup {
  id             String   @id @default(cuid())
  organizationId String
  projectId      String?          // null = 组织级，非空 = 项目级
  name           String
  description    String?
  // 整棵逻辑树：LogicNode | ConditionNode 的 JSON
  tree           Json
  // 冗余：树里用到的字段名，便于按字段反查规则
  fieldsUsed     String[] @default([])
  enabled        Boolean  @default(true)

  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  organization Organization         @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  project      Project?             @relation(fields: [projectId], references: [id], onDelete: Cascade)
  bindings     MonitorRuleBinding[]

  @@index([organizationId])
  @@index([projectId])
  @@index([enabled])
  @@index([deletedAt])
  @@map("rule_groups")
}

// monitor 与规则组的绑定
model MonitorRuleBinding {
  id          String  @id @default(cuid())
  monitorId   String
  ruleGroupId String
  // 同一个 monitor 绑定多个规则组时的优先级，数字越大越先求值
  priority    Int     @default(0)
  enabled     Boolean @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  monitor   Monitor   @relation(fields: [monitorId], references: [id], onDelete: Cascade)
  ruleGroup RuleGroup @relation(fields: [ruleGroupId], references: [id], onDelete: Cascade)

  @@unique([monitorId, ruleGroupId])
  @@index([monitorId])
  @@index([ruleGroupId])
  @@map("monitor_rule_bindings")
}
```

三个既有 model 补反向关系：

```prisma
model Monitor {
  // ...existing fields
  ruleBindings MonitorRuleBinding[]   // 新增
}

model Project {
  // ...existing fields
  ruleGroups RuleGroup[]   // 新增
}

model Organization {
  // ...existing fields
  ruleGroups RuleGroup[]   // 新增
}
```

`CheckLog` 增加规则校验结论两列（告警条件据此统计可用率/连续失败）：

```prisma
model CheckLog {
  // ...existing fields
  // 规则校验结论：本轮规则树是否命中（命中=异常）；无绑定规则组时回退为 !success
  ruleMatched  Boolean  @default(false)
  // 命中的规则组 ID，便于追溯「为什么触发」
  ruleGroupIds String[] @default([])
}
```

`fieldsUsed` 反范式字段保留：查「哪些规则用到了 `certDaysRemaining`」时，`WHERE 'certDaysRemaining' = ANY(fields_used)` 直接命中，不用遍历 JSON。写入/更新规则时从树里自动提取。

> 注意：现有 `Monitor.projectId` 是非空字段，而 `RuleGroup.projectId` 可空（组织级）。绑定按 monitor 维度进行，所以组织级规则组可以被任意项目的 monitor 绑定——作用域校验放在 service 层（见第 6 节），Schema 层不加约束。

## 3. 类型定义

`src/modules/rules/types.ts`。字段按「检测器是否额外采集」分两组。

```typescript
// 核心字段：检测器一贯提供
export type CoreRuleField = 'success' | 'latency' | 'certDaysRemaining';

// 扩展字段：需要检测器额外采集（实际状态码、响应体片段）
export type ExtendedRuleField = 'statusCode' | 'bodyContains';

export type RuleField = CoreRuleField | ExtendedRuleField;

export type RuleOperator =
  | 'eq' | 'neq'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in'
  | 'contains'
  | 'statusClass'; // 仅对 statusCode 有意义

export interface ConditionNode {
  type: 'condition';
  id: string;
  field: RuleField;
  operator: RuleOperator;
  value: unknown;
}

export interface LogicNode {
  type: 'logic';
  id: string;
  operator: 'and' | 'or';
  children: RuleNode[];
}

export type RuleNode = ConditionNode | LogicNode;

// 求值上下文：来自聚合后的 CheckResult
export interface RuleContext {
  success?: boolean;
  latency?: number;
  certDaysRemaining?: number;
  statusCode?: number;
  bodyContains?: string;
}
```

### 字段元数据（FIELD_META，单一事实源）

字段的「可选操作符、value 类型、取值约束、编辑器默认值」集中定义在后端 `FIELD_META` 常量里，**不落库**。它是前后端共享的唯一事实源：后端用它做 `validate`，前端通过 `GET /rule-meta` 拉同一份数据驱动编辑器（见下文「元数据下发」）。

```typescript
// src/modules/rules/types.ts（追加）

/** 单个规则字段的元数据。 */
export interface FieldMeta {
    /** value 的语义类型，前端据此渲染输入控件 */
    valueType: 'boolean' | 'number' | 'string';
    /** 该字段允许的操作符 */
    operators: RuleOperator[];
    /** value 取值约束（保存前的校验依据） */
    constraints?: {
        min?: number;
        max?: number;
        integer?: boolean;
        maxLength?: number;
    };
    /** 编辑器新增条件时的默认值 */
    default: { operator: RuleOperator; value: unknown };
}

export const FIELD_META: Record<RuleField, FieldMeta> = {
    success: {
        valueType: 'boolean',
        operators: ['eq', 'neq'],
        default: { operator: 'eq', value: true },
    },
    latency: {
        valueType: 'number',
        operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'],
        constraints: { min: 0, integer: true },
        default: { operator: 'gt', value: 1000 },
    },
    certDaysRemaining: {
        valueType: 'number',
        operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'],
        constraints: { min: -3650, integer: true }, // 已过期为负
        default: { operator: 'lte', value: 30 },
    },
    statusCode: {
        valueType: 'number',
        operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'statusClass'],
        constraints: { min: 100, max: 599, integer: true },
        default: { operator: 'eq', value: 200 },
    },
    bodyContains: {
        valueType: 'string',
        operators: ['eq', 'neq', 'contains', 'in', 'not_in'],
        constraints: { maxLength: 512 },
        default: { operator: 'contains', value: '' },
    },
};

/** 由 FIELD_META 派生的全量字段/操作符列表（供 validate 与 meta 接口使用）。 */
export const RULE_FIELDS = Object.keys(FIELD_META) as RuleField[];
export const RULE_OPERATORS = [
    ...new Set(Object.values(FIELD_META).flatMap((m) => m.operators)),
] as RuleOperator[];

/** statusClass 的合法取值：HTTP 状态码类别 1-5（对应 1xx~5xx）。 */
export const STATUS_CLASS_VALUES: readonly number[] = [1, 2, 3, 4, 5];
```

> `statusClass` 的 value 存**整数类别 1-5**（1=1xx、2=2xx …），不存 `'10x'/'2xx'` 字符串；「10x/20x/30x/40x/50x」只是前端渲染时的展示标签。求值用 `Math.floor(statusCode / 100) ∈ value`。

### 字段数据源对照

| RuleField           | 数据来源                                                                                        | 状态   |
| ------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| `success`           | `CheckResult.success`（本地或探针聚合后的最终判定）                                             | 已实现 |
| `latency`           | `CheckResult.latency`                                                                           | 已实现 |
| `certDaysRemaining` | `CheckResult.ssl.daysRemaining`（仅 `checkSsl` 开启时存在）                                     | 已实现 |
| `statusCode`        | `HttpChecker` 记录实际状态码，已落到 `CheckResult` / `CheckLog` / `ProbeResult` / `ProbeReport` | 已实现 |
| `bodyContains`      | `HttpChecker` 读取并截断响应体（512 字符）到 `CheckResult`                                      | 已实现 |

`statusClass` 操作符基于 `statusCode`，已可用。

### 元数据下发与前端共享

前端编辑器不硬编码字段/操作符清单，而是从后端拉 `FIELD_META`，保证前后端一致、加字段不用改前端：

```text
GET /rule-meta
```

返回：

```json
{
  "fields": ["success", "latency", "certDaysRemaining", "statusCode", "bodyContains"],
  "meta": {
    "statusCode": {
      "valueType": "number",
      "operators": ["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "statusClass"],
      "constraints": { "min": 100, "max": 599, "integer": true },
      "default": { "operator": "eq", "value": 200 }
    }
  },
  "statusClassValues": [1, 2, 3, 4, 5]
}
```

实现为 `RuleMetaController`，返回 `FIELD_META` 的序列化副本；静态公共元数据，无需鉴权或仅 `OrgMemberGuard`。`STATUS_CLASS_VALUES` 一并下发，前端把 1-5 渲染成 `1xx~5xx` 标签。

**为什么不落库**：字段/操作符的合法集合 = 求值器 `switch` 的代码能力，二者必须一致。落库要引入「元数据表 + seed + 迁移」，却改变不了「改操作符还得改求值代码」的事实，反而造成「表里有但代码不支持」的双源漂移。只有当未来需要租户自定义字段/操作符（产品级扩展）时才值得落库，当前不适用。

## 4. 求值引擎

`src/modules/rules/rule-evaluator.service.ts`。要点：`eq/neq` 做数值归一化（避免 JSON 里的 `"200"` 与 number `200` 不相等）；`validate` 按 `FIELD_META` 做 field → operator → value 三级校验，失败抛 `BadRequestException`（项目已全局启用 `ValidationPipe`，树结构校验放这里最合适）。

```typescript
import { BadRequestException, Injectable } from '@nestjs/common';
import type { ConditionNode, FieldMeta, RuleContext, RuleNode } from './types';
import { FIELD_META, STATUS_CLASS_VALUES } from './types';

const MAX_DEPTH = 10;

@Injectable()
export class RuleEvaluatorService {
  evaluate(node: RuleNode, ctx: RuleContext): boolean {
    if (node.type === 'condition') {
      return this.evaluateCondition(node, ctx);
    }

    const results = node.children.map((c) => this.evaluate(c, ctx));
    return node.operator === 'and'
      ? results.every(Boolean)
      : results.some(Boolean);
  }

  private evaluateCondition(node: ConditionNode, ctx: RuleContext): boolean {
    const actual = ctx[node.field];
    if (actual === undefined || actual === null) return false;

    switch (node.operator) {
      case 'eq':
        return this.normalize(actual, node.field) === this.normalize(node.value, node.field);
      case 'neq':
        return this.normalize(actual, node.field) !== this.normalize(node.value, node.field);
      case 'gt':  return Number(actual) >  Number(node.value);
      case 'gte': return Number(actual) >= Number(node.value);
      case 'lt':  return Number(actual) <  Number(node.value);
      case 'lte': return Number(actual) <= Number(node.value);
      case 'contains':
        return String(actual).includes(String(node.value));
      case 'in': {
        const arr = Array.isArray(node.value)
          ? node.value
          : String(node.value).split(',');
        return arr.map(String).includes(String(actual));
      }
      case 'not_in': {
        const arr = Array.isArray(node.value)
          ? node.value
          : String(node.value).split(',');
        return !arr.map(String).includes(String(actual));
      }
      case 'statusClass': {
        const classes = String(node.value)
          .split(',')
          .map((v) => Number(v.trim()));
        return classes.includes(Math.floor(Number(actual) / 100));
      }
      default:
        return false;
    }
  }

  /** 数值型字段统一按 number 比较，避免 JSON 字符串与 number 严格不等。 */
  private normalize(value: unknown, field: RuleField): unknown {
    if (field === 'success') return Boolean(value);
    if (field === 'latency' || field === 'certDaysRemaining' || field === 'statusCode') {
      return Number(value);
    }
    return String(value);
  }

  /** 从树里提取所有用到的字段名，写入 RuleGroup.fieldsUsed。 */
  extractFields(node: RuleNode, acc = new Set<string>()): string[] {
    if (node.type === 'condition') {
      acc.add(node.field);
    } else {
      for (const c of node.children) this.extractFields(c, acc);
    }
    return [...acc];
  }

  /** 校验树结构（保存前调用），失败抛 400。 */
  validate(node: RuleNode, depth = 0): void {
    if (depth > MAX_DEPTH) {
      throw new BadRequestException(`规则树嵌套超过 ${MAX_DEPTH} 层`);
    }

    if (node.type === 'logic') {
      if (!['and', 'or'].includes(node.operator)) {
        throw new BadRequestException(`逻辑组 ${node.id} 的 operator 非法`);
      }
      if (node.children.length === 0) {
        throw new BadRequestException(`逻辑组 ${node.id} 不能为空`);
      }
      for (const c of node.children) this.validate(c, depth + 1);
      return;
    }

    if (node.type !== 'condition') {
      throw new BadRequestException(`未知节点类型 "${String((node as RuleNode).type)}"`);
    }

    const meta = FIELD_META[node.field];
    if (!meta) {
      throw new BadRequestException(`条件 ${node.id} 的 field 非法: ${String(node.field)}`);
    }
    if (!meta.operators.includes(node.operator)) {
      throw new BadRequestException(
        `条件 ${node.id} 的 operator "${node.operator}" 不适用于字段 "${node.field}"`,
      );
    }
    if (node.value === undefined || node.value === null || node.value === '') {
      throw new BadRequestException(`条件 ${node.id} 缺少 value`);
    }

    this.validateValue(node, meta);
  }

  /** 校验单个条件的 value 符合其字段/操作符的取值约束。 */
  private validateValue(node: ConditionNode, meta: FieldMeta): void {
    if (node.operator === 'statusClass') {
      const classes = String(node.value)
        .split(',')
        .map((v) => Number(v.trim()));
      if (classes.some((c) => !STATUS_CLASS_VALUES.includes(c))) {
        throw new BadRequestException(
          `条件 ${node.id} 的 statusClass 取值须为 1-5 之一（1xx~5xx），收到: ${String(node.value)}`,
        );
      }
      return;
    }

    const values =
      node.operator === 'in' || node.operator === 'not_in'
        ? Array.isArray(node.value)
          ? node.value
          : String(node.value).split(',')
        : [node.value];

    for (const raw of values) {
      this.assertValueInRange(node, meta, raw);
    }
  }

  private assertValueInRange(
    node: ConditionNode,
    meta: FieldMeta,
    raw: unknown,
  ): void {
    if (meta.valueType === 'number') {
      const n = Number(raw);
      const c = meta.constraints ?? {};
      if (Number.isNaN(n)) {
        throw new BadRequestException(`条件 ${node.id} 的 value 必须是数字: ${String(raw)}`);
      }
      if (c.integer && !Number.isInteger(n)) {
        throw new BadRequestException(`条件 ${node.id} 的 value 必须是整数: ${String(raw)}`);
      }
      if (c.min !== undefined && n < c.min) {
        throw new BadRequestException(`条件 ${node.id} 的 value 不能小于 ${c.min}: ${String(raw)}`);
      }
      if (c.max !== undefined && n > c.max) {
        throw new BadRequestException(`条件 ${node.id} 的 value 不能大于 ${c.max}: ${String(raw)}`);
      }
      return;
    }

    if (meta.valueType === 'boolean') {
      if (typeof raw !== 'boolean') {
        throw new BadRequestException(`条件 ${node.id} 的 value 必须是布尔值: ${String(raw)}`);
      }
      return;
    }

    // string
    const c = meta.constraints ?? {};
    if (c.maxLength !== undefined && String(raw).length > c.maxLength) {
      throw new BadRequestException(
        `条件 ${node.id} 的 value 超过最大长度 ${c.maxLength}`,
      );
    }
  }
}
```

> `RULE_FIELDS` / `RULE_OPERATORS` 不再手写维护，由第 3 节的 `FIELD_META` 派生，避免字段/操作符两处定义漂移。

> `and` 的 `every` 与 `or` 的 `some` 本身短路，无需额外处理。

## 5. 规则组 / 绑定服务

`src/modules/rules/rule-groups.service.ts`。修正 `PrismaService` 路径，增补软删除与组织/项目作用域校验。

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { RuleEvaluatorService } from './rule-evaluator.service';
import type { RuleNode } from './types';

@Injectable()
export class RuleGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluator: RuleEvaluatorService,
  ) {}

  async create(input: {
    organizationId: string;
    projectId?: string;
    name: string;
    description?: string;
    tree: RuleNode;
  }) {
    this.evaluator.validate(input.tree);

    // 若指定了 projectId，校验其属于当前组织
    if (input.projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: input.projectId, organizationId: input.organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!project) throw new NotFoundException('Project not found');
    }

    return this.prisma.ruleGroup.create({
      data: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        tree: input.tree as never,
        fieldsUsed: this.evaluator.extractFields(input.tree),
      },
    });
  }

  async update(id: string, input: { name?: string; description?: string; tree?: RuleNode; enabled?: boolean }) {
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.tree) {
      this.evaluator.validate(input.tree);
      data.tree = input.tree;
      data.fieldsUsed = this.evaluator.extractFields(input.tree);
    }

    return this.prisma.ruleGroup.update({ where: { id }, data });
  }

  async listByOrganization(organizationId: string) {
    return this.prisma.ruleGroup.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async softDelete(id: string) {
    return this.prisma.ruleGroup.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * 找出某 monitor 绑定的、启用的规则组，按优先级降序。
   * 这是求值入口，每轮检查都会调用（见第 8 节缓存）。
   */
  async findBindingsForMonitor(monitorId: string) {
    return this.prisma.monitorRuleBinding.findMany({
      where: {
        monitorId,
        enabled: true,
        ruleGroup: { enabled: true, deletedAt: null },
      },
      include: { ruleGroup: true },
      orderBy: { priority: 'desc' },
    });
  }
}
```

`src/modules/rules/rule-bindings.service.ts`：

```typescript
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';

@Injectable()
export class RuleBindingsService {
  constructor(private readonly prisma: PrismaService) {}

  async bind(input: {
    monitorId: string;
    ruleGroupId: string;
    priority?: number;
  }) {
    const [monitor, ruleGroup] = await Promise.all([
      this.prisma.monitor.findFirst({ where: { id: input.monitorId, deletedAt: null }, select: { id: true, organizationId: true } }),
      this.prisma.ruleGroup.findFirst({ where: { id: input.ruleGroupId, deletedAt: null }, select: { id: true, organizationId: true, projectId: true } }),
    ]);

    if (!monitor) throw new NotFoundException('Monitor not found');
    if (!ruleGroup) throw new NotFoundException('Rule group not found');
    // 规则组必须与 monitor 同组织；项目级规则组还须同项目
    if (ruleGroup.organizationId !== monitor.organizationId) {
      throw new BadRequestException('Rule group belongs to a different organization');
    }
    if (ruleGroup.projectId) {
      const monitorProject = await this.prisma.monitor.findUnique({ where: { id: input.monitorId }, select: { projectId: true } });
      if (ruleGroup.projectId !== monitorProject?.projectId) {
        throw new BadRequestException('Project-level rule group can only bind monitors in the same project');
      }
    }

    return this.prisma.monitorRuleBinding.upsert({
      where: { monitorId_ruleGroupId: { monitorId: input.monitorId, ruleGroupId: input.ruleGroupId } },
      update: { priority: input.priority ?? 0, enabled: true },
      create: { monitorId: input.monitorId, ruleGroupId: input.ruleGroupId, priority: input.priority ?? 0 },
    });
  }

  async unbind(monitorId: string, ruleGroupId: string) {
    return this.prisma.monitorRuleBinding.delete({
      where: { monitorId_ruleGroupId: { monitorId, ruleGroupId } },
    });
  }

  async listByMonitor(monitorId: string) {
    return this.prisma.monitorRuleBinding.findMany({
      where: { monitorId },
      include: { ruleGroup: true },
      orderBy: { priority: 'desc' },
    });
  }
}
```

## 6. Controller 与鉴权

修正为项目现有约定：`@Roles` + `RolesGuard`，去掉 `/api` 前缀，绑定接口挂到 project 层级（保证 `OrgMemberGuard` 能解析组织）。

```typescript
// src/modules/rules/rule-groups.controller.ts
import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { Roles, AuditLog } from '../../common/decorators';
import { RolesGuard, OrgMemberGuard } from '../../common/guards';
import { RuleGroupsService } from './rule-groups.service';
import { CreateRuleGroupDto, UpdateRuleGroupDto } from './dto';

@Controller('organizations/:orgId/rule-groups')
export class RuleGroupsController {
  constructor(private readonly service: RuleGroupsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @AuditLog({ entity: 'RuleGroup' })
  create(@Param('orgId') orgId: string, @Body() dto: CreateRuleGroupDto) {
    return this.service.create({ organizationId: orgId, ...dto });
  }

  @Get()
  @UseGuards(OrgMemberGuard)
  list(@Param('orgId') orgId: string) {
    return this.service.listByOrganization(orgId);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @AuditLog({ entity: 'RuleGroup' })
  update(@Param('id') id: string, @Body() dto: UpdateRuleGroupDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @AuditLog({ entity: 'RuleGroup', action: 'DELETE' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }
}
```

```typescript
// src/modules/rules/rule-bindings.controller.ts
import { Controller, Get, Post, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators';
import { RolesGuard, OrgMemberGuard } from '../../common/guards';
import { RuleBindingsService } from './rule-bindings.service';
import { BindRuleDto } from './dto';

// 挂在 monitor 所属 project 下，OrgMemberGuard 可通过 projectId 解析组织
@Controller('projects/:projectId/monitors/:monitorId/rule-bindings')
export class RuleBindingsController {
  constructor(private readonly service: RuleBindingsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  bind(@Param('monitorId') monitorId: string, @Body() dto: BindRuleDto) {
    return this.service.bind({ monitorId, ...dto });
  }

  @Get()
  @UseGuards(OrgMemberGuard)
  list(@Param('monitorId') monitorId: string) {
    return this.service.listByMonitor(monitorId);
  }

  @Delete(':ruleGroupId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  unbind(@Param('monitorId') monitorId: string, @Param('ruleGroupId') ruleGroupId: string) {
    return this.service.unbind(monitorId, ruleGroupId);
  }
}
```

## 7. DTO 校验

项目已全局启用 `ValidationPipe`（`main.ts`），DTO 用 class-validator；递归树结构校验放在 `RuleEvaluatorService.validate()`（抛 `BadRequestException`）。

```typescript
// src/modules/rules/dto/create-rule-group.dto.ts
import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import type { RuleNode } from '../types';

export class CreateRuleGroupDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  projectId?: string;

  @IsObject()
  tree: RuleNode;
}
```

```typescript
// src/modules/rules/dto/update-rule-group.dto.ts
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import type { RuleNode } from '../types';

export class UpdateRuleGroupDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsObject() tree?: RuleNode;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
```

```typescript
// src/modules/rules/dto/bind-rule.dto.ts
import { IsInt, IsOptional, IsString } from 'class-validator';

export class BindRuleDto {
  @IsString() ruleGroupId: string;

  @IsOptional() @IsInt() priority?: number;
}
```

## 8. 规则求值接入上报链路

这是最关键的改动。当前 `CheckerService.execute()` 的真实链路：

```
probe() → evaluateResult()（本地 + 探针双源聚合）
       → stateService.record()（CheckLog + MonitorState 同事务）
       → notifyIfChanged()（状态转移通知）
       → writeExecution()
```

规则引擎接入后（校验在 `record()` 之前、结论随 CheckLog 落库、告警条件在 `record()` 之后聚合告警）：

```
probe() → evaluateResult()
       → 规则校验 evaluateRuleTree()（用聚合 result 构造 RuleContext，逐条 evaluate）
       → stateService.record()（ruleMatched / ruleGroupIds 随 CheckLog 落库 + MonitorState 同事务）
       → evaluateAvailabilityAlert()（读 CheckLog 的 ruleMatched 统计可用率/连续失败，命中则告警）
       → notifyIfChanged()
       → writeExecution()
```

```typescript
// src/modules/checker/checker.service.ts（在现有 execute() 内）

private async execute(
    monitor: MonitorModel,
    source: CheckSource = CheckSource.LOCAL,
    reported?: CheckResult,
    trigger: ExecutionTrigger = ExecutionTrigger.SCHEDULED,
): Promise<CheckExecution> {
    const localResult = reported ?? (await this.probe(monitor));
    const { result, rescuedByProbe } = await this.evaluateResult(monitor, localResult);

    // 规则树只产出校验结论（命中=异常），随 CheckLog 落库。
    const ruleOutcome = await this.evaluateRuleTree(monitor, result);

    const { state, transition } = await this.stateService.record(monitor.id, {
        success: result.success,
        latency: result.latency,
        error: result.error,
        source,
        checkedAt: result.checkedAt,
        ssl: result.ssl,
        localSuccess: localResult.success,
        rescuedByProbe,
        statusCode: result.statusCode ?? null,
        ruleMatched: ruleOutcome.ruleMatched,
        ruleGroupIds: ruleOutcome.ruleGroupIds,
    });

    // 告警条件：读已落库的规则校验结论统计可用率/连续失败，命中则告警。
    await this.evaluateAvailabilityAlert(monitor, state);

    const notified = await this.notifyIfChanged(monitor, state, transition);

    await this.writeExecution(monitor, result, trigger, {
        previousStatus: transition.previousStatus,
        status: transition.status,
        changed: transition.changed,
        ruleGroupIds: ruleOutcome.ruleGroupIds,
        notified: { skipped: notified.skipped, sent: notified.sent, failed: notified.failed },
    });

    return {
        ...result,
        monitorId: monitor.id,
        previousStatus: transition.previousStatus,
        status: transition.status,
        changed: transition.changed,
        notified,
    };
}

/** 规则校验：返回本轮结论；无绑定规则组时回退 !success。 */
private async evaluateRuleTree(
    monitor: MonitorModel,
    result: CheckResult,
): Promise<{ ruleMatched: boolean; ruleGroupIds: string[] }> {
    try {
        const bindings = await this.ruleGroups.findBindingsForMonitor(monitor.id);
        if (bindings.length === 0) {
            return { ruleMatched: !result.success, ruleGroupIds: [] };
        }

        const ctx = this.buildRuleContext(result);
        const ruleGroupIds: string[] = [];
        for (const binding of bindings) {
            const matched = this.ruleEvaluator.evaluate(
                binding.ruleGroup.tree as unknown as RuleNode,
                ctx,
            );
            if (matched) ruleGroupIds.push(binding.ruleGroupId);
        }

        return { ruleMatched: ruleGroupIds.length > 0, ruleGroupIds };
    } catch (error) {
        this.logger.warn(`Rule evaluation failed for monitor ${monitor.id}: ${(error as Error).message}`);
        return { ruleMatched: !result.success, ruleGroupIds: [] };
    }
}

private buildRuleContext(result: CheckResult): RuleContext {
    return {
        success: result.success,
        latency: result.latency,
        certDaysRemaining: result.ssl?.daysRemaining,
        statusCode: result.statusCode ?? undefined,
        bodyContains: result.bodyContains ?? undefined,
    };
}
```

### 8.1 求值与缓存

`RuleGroupsService.findBindingsForMonitor` 是求值入口，每轮检查都会调用。可复用项目已有的 `MultiLevelCacheService`（L1 node-cache + L2 Redis）：

```typescript
private readonly BINDINGS_KEY_PREFIX = 'rule:bindings:';

async findBindingsCached(monitorId: string) {
    const key = `${this.BINDINGS_KEY_PREFIX}${monitorId}`;
    return this.cache.getOrSet(key, () => this.findBindingsForMonitor(monitorId), 60);
}
```

规则组更新、绑定变更时，按受影响 monitor 清缓存（`cache.del(key)`）。绑定变更直接 `del('rule:bindings:' + monitorId)`；规则组 `update/enable/disable/softDelete` 先查它的绑定集合再逐个失效。

### 8.2 告警条件：读结论做阈值告警

规则树不再携带动作，只产出 `ruleMatched` 落库。告警条件 `evaluateAvailabilityAlert` 读最近 `availabilityWindow` 条 CheckLog：

- **可用率** = 最近 N 次中 `ruleMatched = false` 的比例；
- **连续失败** = 从最新一条往前连续 `ruleMatched = true` 的条数；
- **命中** = `可用率 < availabilityThreshold` 且 `连续失败 >= failureThreshold`；
- 命中且未处于告警态 → 发一次 `AVAILABILITY_ALERT` 并置 `availabilityAlertActive = true`；持续命中静默；可用率回升后发 `AVAILABILITY_RECOVERED` 并复位。

## 9. 通知接入

告警条件复用 `NotifierService.notifyAvailabilityAlert` / `notifyAvailabilityRecovery`（`event = AVAILABILITY_ALERT / AVAILABILITY_RECOVERED`）：渠道解析走 `resolveAlertChannels()`（绑定渠道优先，未绑定回退组织全量启用渠道），payload 的 `failCount` 取规则连续命中次数（`AvailabilityAlertInfo.consecutiveFailures`）。`NotifierService` 不再有 `notifyRuleAlert` 与 `RULE_ALERT`。

## 10. 迁移

```bash
pnpm prisma:migrate dev --name adjust_rule_alert_pipeline
pnpm prisma:generate
```

生成内容：

- `ALTER TABLE check_logs` 增加 `ruleMatched`、`ruleGroupIds` 两列；
- `ALTER TABLE monitor_rule_bindings` 删除 `action` 列；
- `DROP TYPE "RuleAction"`。

> 现有 `prisma migrate` 使用时间戳前缀，命令会自动生成如 `2026XXXX_adjust_rule_alert_pipeline`。迁移后执行 `pnpm prisma:generate`（`docs/archive/monitoring-v1.1-roadmap.md` 约定）。

## 11. 模块装配

`src/modules/rules/rules.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { RuleEvaluatorService } from './rule-evaluator.service';
import { RuleGroupsService } from './rule-groups.service';
import { RuleBindingsService } from './rule-bindings.service';
import { RuleGroupsController } from './rule-groups.controller';
import { RuleBindingsController } from './rule-bindings.controller';

// CacheModule 是 @Global 模块，MultiLevelCacheService 可直接注入，无需显式 import。
@Module({
  controllers: [RuleGroupsController, RuleBindingsController],
  providers: [RuleEvaluatorService, RuleGroupsService, RuleBindingsService],
  exports: [RuleEvaluatorService, RuleGroupsService, RuleBindingsService],
})
export class RulesModule {}
```

`CheckerModule` 增加 `RulesModule` import，`CheckerService` 注入 `RuleEvaluatorService` 与 `RuleGroupsService`。`CheckerService` 已依赖 `NotifierService`。

> 依赖方向：`CheckerModule -> RulesModule`、`CheckerModule -> NotifierModule`、`RulesModule -> CacheModule`。无循环依赖。校验编排留在 `CheckerService`，rules 模块只提供求值与查询。

## 12. 分阶段实施路线

与 `docs/archive/monitoring-v1.1-roadmap.md` 的约定对齐（每阶段 migration + generate + 服务层单测）。

### 阶段 1：规则校验 + 阈值告警（已完成）

1. Schema 增量 + 迁移 + `prisma:generate`（`CheckLog.ruleMatched/ruleGroupIds`，删 `RuleAction`/`action`）。
2. `types.ts` + `RuleEvaluatorService`（含 `validate`/`extractFields`/`evaluate`）+ 单测。
3. `RuleGroupsService` / `RuleBindingsService` + Controller + DTO（对齐 `@Roles` 与路由层级，无 action）。
4. `CheckerService.execute()` 接入：`evaluateRuleTree` 求值 → 结论随 `record()` 落库 → `evaluateAvailabilityAlert` 读结论聚合告警。
5. 缓存：`findBindingsCached` + 失效（可选）。

字段范围：`success` / `latency` / `certDaysRemaining` / `statusCode` / `bodyContains`。

### 阶段 2：运营增强（可选）

6. `fieldsUsed` 反查接口（改字段语义时找受影响规则）。
7. 规则命中日志（供前端展示「为什么触发了」）。

## 13. 决策点与推荐

以下决策已在本文档按「推荐项」落地，落地前如需调整需产品确认：

| 决策                | 推荐（本文档采用）                                               | 备选                                          |
| ------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| 规则树职责          | 只校验并产出 `ruleMatched`/`ruleGroupIds` 落库，不发通知不做动作 | 规则命中直接发 `RULE_ALERT`（旧方案，已废弃） |
| 可用率/连续失败口径 | 基于 `CheckLog.ruleMatched` 统计（未命中比例 + 连续命中次数）    | 基于 `success` 统计（旧口径，已废弃）         |
| 无绑定规则组兜底    | `ruleMatched = !success`（可达性失败即异常）                     | 无兜底（未绑规则组永不告警）                  |
| 状态机与规则的关系  | 状态机仍按 `success` 推导 UP/DOWN，规则只影响告警口径            | 状态机也按规则结论推导                        |
| 规则缓存            | 复用 `MultiLevelCacheService`（node-cache + Redis）              | 引入 `lru-cache` 进程内缓存                   |
| 字段/操作符元数据   | 不落库：后端 `FIELD_META` 常量 + `GET /rule-meta` 下发前端       | 建元数据表（仅当未来要租户自定义字段时）      |

## 14. 验收标准

每阶段跑通（与 `docs/archive/monitoring-v1.1-roadmap.md` 一致）：

```bash
pnpm prisma:generate
pnpm test
pnpm type-check
pnpm lint
pnpm build
```

针对性单测：

- `RuleEvaluatorService`：`and/or` 嵌套、短路、`eq/neq` 数值归一化、非法树抛 `BadRequestException`、`extractFields`。
- `CheckerService`：规则命中时 `record()` 落库 `ruleMatched/ruleGroupIds`；未命中时 `ruleMatched=false`；无绑定规则组时回退 `!success`；可用率/连续失败按 `ruleMatched` 统计，命中告警一次、恢复发通知。
- `RuleGroupsService`：`projectId` 与 `organizationId` 不匹配时拒绝创建；软删除后 `findBindingsForMonitor` 不再返回。
- `RuleBindingsService`：跨组织/跨项目规则组禁止绑定。

## 一句话

**节点异常条件规则**：嵌套规则树存 `RuleGroup.tree`（JSON），`MonitorRuleBinding` 挂到 monitor 上；每轮检查对聚合结果递归 `evaluate()`，产出 `ruleMatched`/`ruleGroupIds` 校验结论随 `CheckLog` 落库（无绑定时回退 `!success`）。

**告警条件**：Monitor 内嵌「可用率 + 连续失败」阈值——读最近 `availabilityWindow` 条 `CheckLog.ruleMatched` 统计「未命中比例」与「连续命中次数」，命中 `可用率 < x% 且 连续命中 >= failureThreshold` 则向绑定渠道发 `AVAILABILITY_ALERT`（未绑定回退组织全量），状态化去重 + 恢复通知。检测结果来自规则校验，是否通知取决于结果与告警条件的比对。

阈值、通知渠道与告警恢复统一见 [可用率告警](availability-alerts.md)。

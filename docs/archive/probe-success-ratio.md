# 探针成功率判定 — 明确方案

> 后续实施以 [探针成功率修订方案](../../plans/003-probe-success-ratio.md) 为准；本稿保留用于对照原始判定语义。

> 文档类型：历史归档。原文中的“当前状态”、缺口、示例和阶段计划均属于当时的设计快照，不代表最新实现；日常使用请从 [文档索引](../README.md) 查找现行接口与运行指南。

## 一、判定分层（最终）

```text
本地检测 + N 个探针结果
        ↓
【第一层】evaluateResult — 单轮判定
  按 probeSuccessRatio 决定本轮 success
        ↓
【第二层】stateService.record — 连续失败统计
  success → failCount = 0
  failure → failCount += 1
        ↓
【第三层】evaluateAvailabilityAlert — 告警
  failCount >= failureThreshold → 告警
```

只有第一层改动，第二、三层保持原样。

## 二、Prisma schema

```prisma
model Monitor {
  // ...existing fields
  failureThreshold     Int @default(3)   // 保留不变
  probeSuccessRatio    Int @default(1)   // 新增：本轮探针成功率阈值（百分比，1-100）
}
```

默认值 1 的含义：至少 1 个探针成功即本轮成功，等价于现在的「任一成功」行为。升级后无感知。

迁移：

```bash
npx prisma migrate dev --name add_probe_success_ratio
```

## 三、checker.service.ts 改动

### 3.1 新增方法 fetchCurrentRoundProbeResults

```typescript
/**
 * 本轮各探针的最新结果。
 * 每个探针只贡献一条，保证「N 个探针」语义，而非「最近 N 条结果」。
 */
private async fetchCurrentRoundProbeResults(
    monitor: MonitorModel,
): Promise<ProbeResultModel[]> {
    const since = new Date(
        Date.now() - probeResultWindowMs(monitor.interval),
    );

    // 租户探针
    const tenantProbes = await this.prisma.probe.findMany({
        where: {
            organizationId: monitor.organizationId,
            enabled: true,
            status: 'ONLINE',
            scope: 'TENANT',
            monitors: { some: { monitorId: monitor.id } },
        },
        select: { id: true },
    });

    // 系统探针
    const systemProbeIds =
        await this.systemProbeScheduler.getAssignedProbes(monitor.id);

    const allProbeIds = [
        ...tenantProbes.map((p) => p.id),
        ...systemProbeIds,
    ];

    if (allProbeIds.length === 0) return [];

    // 每个探针取最近一条
    const results = await Promise.all(
        allProbeIds.map((probeId) =>
            this.prisma.probeResult.findFirst({
                where: {
                    probeId,
                    target: monitor.target,
                    checkedAt: { gte: since },
                },
                orderBy: { checkedAt: 'desc' },
            }),
        ),
    );

    return results.filter(
        (r): r is ProbeResultModel => r !== null,
    );
}
```

需要在文件顶部补类型导入：

```typescript
import type { ProbeResultModel } from '../../generated/prisma/models';
```

### 3.2 重写 evaluateResult

```typescript
private async evaluateResult(
    monitor: MonitorModel,
    localResult: CheckResult,
): Promise<EvaluatedResult> {
    // 本地成功 → 本轮成功
    if (localResult.success) {
        return { result: localResult, rescuedByProbe: false };
    }

    // SSL 判定不可被探针覆盖
    if (localResult.ssl !== undefined) {
        return { result: localResult, rescuedByProbe: false };
    }

    // 本轮各探针最新结果
    const probeResults = await this.fetchCurrentRoundProbeResults(monitor);

    if (probeResults.length === 0) {
        // 无任何探针结果 → 按本地失败处理
        return { result: localResult, rescuedByProbe: false };
    }

    const successCount = probeResults.filter((r) => r.success).length;
    const totalCount = probeResults.length;
    const successRatio = (successCount / totalCount) * 100;

    // 达到阈值 → 本轮成功
    if (successRatio >= monitor.probeSuccessRatio) {
        return {
            result: {
                success: true,
                latency: localResult.latency,
                error: null,
                checkedAt: localResult.checkedAt,
            },
            rescuedByProbe: true,
        };
    }

    // 未达到 → 本轮失败
    return {
        result: {
            ...localResult,
            error: this.buildAggregatedError(
                localResult,
                successCount,
                totalCount,
            ),
        },
        rescuedByProbe: false,
    };
}
```

### 3.3 调整 buildAggregatedError

```typescript
private buildAggregatedError(
    localResult: CheckResult,
    successCount: number,
    totalCount: number,
): string {
    const localError = localResult.error ?? 'Local check failed';
    return `${localError}; ${successCount}/${totalCount} probe result(s) succeeded`;
}
```

## 四、保持不变的部分

| 组件                      | 说明                                   |
| ------------------------- | -------------------------------------- |
| stateService.record       | failCount 逻辑不变，只看本轮 success   |
| evaluateAvailabilityAlert | failCount >= failureThreshold 判定不变 |
| failureThreshold 字段     | 语义不变，仍表示连续失败几次告警       |
| probeResultWindowMs       | 时间窗口计算不变，仍用于筛选本轮结果   |
| rule 相关逻辑             | 完全不动                               |

## 五、判定语义（三种场景）

场景 1：3 个探针，probeSuccessRatio = 100

| 探针结果      | successRatio | 本轮    |
| ------------- | ------------ | ------- |
| 3 成功        | 100%         | ✅ 成功 |
| 2 成功 1 失败 | 66.7%        | ❌ 失败 |
| 1 成功 2 失败 | 33.3%        | ❌ 失败 |
| 0 成功 3 失败 | 0%           | ❌ 失败 |

场景 2：5 个探针，probeSuccessRatio = 60

| 探针结果      | successRatio | 本轮    |
| ------------- | ------------ | ------- |
| 5 成功        | 100%         | ✅ 成功 |
| 3 成功 2 失败 | 60%          | ✅ 成功 |
| 2 成功 3 失败 | 40%          | ❌ 失败 |

场景 3：探针缺失

绑定了 5 个探针，只有 3 个上报了结果：

totalCount = 3（有结果的探针数）

缺失的 2 个探针不计入分母

如果 3 个都成功 → successRatio = 100% → 本轮成功。

如果你希望缺失算失败，把 totalCount 改成 allProbeIds.length：

```typescript
const totalCount = allProbeIds.length;   // 绑定的探针总数
const successCount = probeResults.filter((r) => r.success).length;
```

这需要 fetchCurrentRoundProbeResults 同时返回 allProbeIds，改动更大。建议先按「缺失不计入」实现，这是更常见的语义。

## 六、数据流示例

假设 monitor 间隔 60 秒，probeSuccessRatio = 60，绑定 3 个探针。

```text
T+0s   本地检测失败
       → 查本轮探针结果
       → 探针A成功、探针B成功、探针C失败
       → successRatio = 66.7% >= 60%
       → 本轮 success = true, rescuedByProbe = true
       → failCount = 0
       → 不告警

T+60s  本地检测失败
       → 探针A成功、探针B失败、探针C失败
       → successRatio = 33.3% < 60%
       → 本轮 success = false
       → failCount = 1

T+120s 本地检测失败
       → 探针A失败、探针B失败、探针C失败
       → successRatio = 0% < 60%
       → 本轮 success = false
       → failCount = 2

T+180s 本地检测失败
       → successRatio = 0% < 60%
       → 本轮 success = false
       → failCount = 3 >= failureThreshold(3)
       → 告警
```

## 七、改动清单

| 文件                    | 改动                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------- |
| prisma/schema.prisma    | Monitor 加 probeSuccessRatio Int @default(1)                                       |
| prisma/migrations/      | 新迁移                                                                             |
| checker.service.ts      | 新增 fetchCurrentRoundProbeResults；重写 evaluateResult；调整 buildAggregatedError |
| checker.service.ts 顶部 | 补 ProbeResultModel 类型导入                                                       |
| 其他文件                | 不动                                                                               |

## 八、验证清单

□ probeSuccessRatio = 1 时，行为与改动前一致（任一探针成功即成功）
□ probeSuccessRatio = 100 时，需全部探针成功
□ 探针缺失时，分母只算有结果的探针
□ failureThreshold 逻辑未受影响，连续失败仍按 CheckLog 累加
□ rescuedByProbe 标记在成功率达标时为 true
□ buildAggregatedError 输出包含 successCount/totalCount

## 九、后续优化（不在本次范围）

探针数量大时（>20），把 Promise.all + findFirst 换成 DISTINCT ON raw SQL。

差异化聚合模式（ANY / MAJORITY / ALL / RATIO）用 probeAggregationMode 字段扩展，不放进规则组。

## 十、一句话

只改 evaluateResult：把「任一探针成功」换成「探针成功率达到 probeSuccessRatio」，用逐个 findFirst 保证每个探针只算一次。failureThreshold 那层完全不动。

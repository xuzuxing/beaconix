# 日志直推 Loki 方案（pino → pino-loki → Loki → Grafana）

> 状态：已实现（本地代码 + 验证）。上线与 Grafana 看板属运维侧，不在本仓库。

## 1. 目标与范围

在现有 pino 日志管道上增加「应用内直推 Loki」：配置了 `LOGGER_LOKI_URL` 就多一路 Loki 出口，缺失则完全不影响原有 console/file 行为。不做日志域拆分、不做多文件拆分。

### 本期做

- `LoggerConfig` 增加 `loki` 配置块（url / intervalSeconds / username / password）。
- `pino-logger.config.ts` 增加 `lokiTarget`，`createPinoConfig` 接受可选 `loki` 参数。
- `LoggerModule` 在 `LOGGER_LOKI_URL` 存在时构造并传入 Loki 配置。
- `main.ts` 调用 `app.useLogger(app.get(PinoNestLogger))`，让框架与 `new Logger(...)` 的日志都进入 pino 管道，从而一并推 Loki。

### 本期不做

- **不做域拆分**：不引入 `DomainLoggerService`、`setDomain`、billing/probes 独立 pino logger（此前方案已回滚）。
- **不做多文件拆分**：仍只有一个 `app-<env>-<date>.log`（`LOGGER_TO_FILE`），没有 `billing-*.log` / `probes-*.log`。
- 不部署 Promtail / DaemonSet 采集器，由应用直推替代。
- 不实现 Loki 侧按域分级保留。

## 2. 架构

```
pino（nestjs-pino，单一 system 域）
   ├─ console target   —— kubectl / docker logs 可看（dev 彩色）
   ├─ file target      —— LOGGER_TO_FILE=true 时写 app-<env>-<date>.log
   └─ loki target      —— LOGGER_LOKI_URL 存在时启用，pino-loki 批量 push
            │
            ▼
          Loki ──► Grafana
```

三类日志（系统常规、billing、probes）**统一走同一条 pino 管道**，靠日志内容/关键字在 Grafana 里检索，不按域物理隔离。

## 3. 实现位置

| 文件 | 改动 |
| --- | --- |
| `src/config/logger.config.ts` | 新增 `LokiLogConfig` 与 `logger.loki`（`LOGGER_LOKI_URL` 为空即禁用） |
| `src/infra/logging/pino-logger.config.ts` | 新增 `LokiPushOptions` 与 `lokiTarget`；`createTransport`/`createPinoConfig` 接受可选 `loki` |
| `src/infra/logging/logger.module.ts` | 读取 `logger.loki`，在 URL 存在时构造 `LokiPushOptions` 传给 `createPinoConfig` |
| `src/main.ts` | `app.useLogger(app.get(PinoNestLogger))` |
| `.env.example` | `LOGGER_LOKI_URL` / `LOGGER_LOKI_INTERVAL` / `LOGGER_LOKI_USERNAME` / `LOGGER_LOKI_PASSWORD` |
| `package.json` | 新增依赖 `pino-loki@^3.0.0` |

## 4. 配置

```dotenv
# 留空 = 不推 Loki；填了 URL = 应用内直推
LOGGER_LOKI_URL=http://loki:3100
LOGGER_LOKI_INTERVAL=5
# 可选 basic auth
LOGGER_LOKI_USERNAME=
LOGGER_LOKI_PASSWORD=

# 文件仍作为保底事实源（Loki 故障时直推会丢批）
LOGGER_TO_FILE=true
```

k8s 下若只想 stdout + Loki：`LOGGER_TO_FILE=false`、`LOGGER_PRETTY_PRINT=false`（单行 JSON）、照常填 `LOGGER_LOKI_URL`。

## 5. pino-loki 装配（v3 API）

```ts
function lokiTarget(level: string, loki: LokiPushOptions): TransportTargetOptions {
    return {
        target: require.resolve('pino-loki'),
        level,
        options: {
            host: loki.url,
            batching: { interval: loki.intervalSeconds }, // v3：对象形式，无顶层 interval
            labels: { job: 'beaconix', service: loki.serviceName, env: loki.env },
            ...(loki.username
                ? { basicAuth: { username: loki.username, password: loki.password ?? '' } }
                : {}),
        },
    };
}
```

- `createTransport` 里 `hasLoki` 为真才追加该 target；三者（console/file/loki）可任意组合。
- `silenceErrors` 默认 `false`：Loki 失败会打错误到 stderr。

## 6. 可靠性权衡

- `pino-loki` 按批推送（`interval` 默认 5s）：进程崩溃最多丢一个 interval 的日志。
- Loki 不可达时该批失败即丢、不无限重试、不阻塞事件循环。
- 因此**文件仍是完整事实源**：建议 `LOGGER_TO_FILE=true` 与直推并存。
- 装配是**启动期**行为：改 `LOGGER_LOKI_URL` 需重启；运行中改需重建 logger。

## 7. Loki / Grafana：label 与查询

`lokiTarget` 固定注入低基数 label：`job=beaconix`、`service=<LOGGER_SERVICE_NAME>`、`env=<NODE_ENV>`。

```logql
# 按服务/env 过滤
{job="beaconix", env="production"}

# 检索退款失败（billing 事件以关键字出现在消息里）
{job="beaconix"} |= "refund" |= "failed"

# 检索探针上报异常
{job="beaconix"} |= "probe" |= "failed"
```

高基数字段（`requestId`、`userId`、`orderId`、`probeId`）作为 JSON 字段用 `| json` 过滤，不做 label。

## 8. 保留与脱敏

- 脱敏复用现有 `smartMask` + `redact`（password/token/手机号/邮箱/银行卡等），对直推 Loki 的日志同样生效。
- 文件沿用按天命名 `app-<env>-<date>.log`；清理用宿主机 logrotate / k8s CronJob；Loki 保留期由部署侧 `retention_period` 决定。

## 9. 验证

本地已通过：`tsc --noEmit`、`eslint`、`nest build`；单测除 `alipay-payment.service.spec.ts` 的 2 个既有失败（与本改动无关）外全绿。

## 10. 后续（可选）

- 若将来需要按域过滤，可在日志行加 `domain` 字段并回到 `lokiTarget` 的 `labels`，但当前按需求不做。
- Grafana 告警规则、Loki 分级保留属运维侧配置。

# Beacon 文档

本目录按用途组织文档。接口与运行说明优先查 `api/`、`guides/`；理解设计取舍查 `design/`；产品原型查 `product/`；未实施方案查 `proposals/`；旧版本与迁移过程查 `archive/`。

## 快速入口

| 想查什么                             | 文档                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| 项目介绍、启动与基础配置             | [仓库 README](../README.md)                                                    |
| 监控详情接口与指标口径               | [Monitor Insights](api/monitor-insights.md)                                    |
| 监控迁移、观测上报、告警运行与验收   | [监控运行指南](guides/monitoring-operations.md)                                |
| 探针安装、命令与凭据配置             | [探针使用说明](../probes/README.md)                                            |
| 腾讯云 SCF 探针部署                  | [SCF 部署指南](guides/probe-scf-deployment.md)                                 |
| 规则校验与阈值告警的关系             | [规则引擎](design/rule-engine.md)、[可用率告警](design/availability-alerts.md) |
| 站内通知事件、收件人、SSE 与可靠投递 | [工作区通知](design/workspace-notifications.md)                                |
| 设置页分组（section）方案对比        | [设置页分组提案](proposals/settings-sections.md)                               |
| 执行中的专项设计与验收契约           | [实施计划](#实施计划)                                                          |

## 目录与命名

```text
docs/
├── README.md       # 总索引与维护约定
├── api/            # 已有接口的契约和数据口径
├── design/         # 架构、领域设计与实现记录
├── guides/         # 部署、升级、运行和验证步骤
├── product/        # 产品原型、页面与交互设计
├── proposals/      # 尚未交付的功能提案
└── archive/        # 历史版本、评估与迁移方案
```

- 文件名统一使用小写英文 `kebab-case.md`，以主题命名，例如 `monitor-insights.md`、`probe-scf-deployment.md`。
- `README.md` 用作索引，不承载完整系统设计。历史文档需要版本时使用 `v1.0`、`v1.1`，日期使用 `YYYY-MM-DD`。
- 每篇文档保留一个一级标题。用二、三级标题划分主题，代码和流程图使用带语言的代码块。
- 跨文档引用使用相对链接；源代码路径以仓库根目录为基准。
- 设计记录中的示例、阶段状态和历史代码不能直接当作当前接口契约。现行行为以源代码、Swagger 和专项验收契约为准。
- `proposals/` 不表示功能已上线；`archive/` 保留当时的状态和决策，不作为当前待办列表。

## 接口参考

| 文档                                        | 内容                                                 |
| ------------------------------------------- | ---------------------------------------------------- |
| [Monitor Insights](api/monitor-insights.md) | 查询参数、快照窗口、指标、时间线、事件和历史覆盖状态 |
| [响应格式与分页](api/response-format.md)    | 全局包裹层、`items` 分页契约、`@SkipTransform` 例外        |

完整接口列表见仓库 README 和运行中的 Swagger；这里只维护需要额外解释的接口契约。

## 运行指南

| 文档                                                  | 内容                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| [监控运行指南](guides/monitoring-operations.md)       | 部署迁移、配置版本、可靠观测、探针上报、告警 outbox、测试与性能记录 |
| [腾讯云 SCF 探针部署](guides/probe-scf-deployment.md) | 注册、打包、环境变量、触发器周期、超时与本地调试                    |

## 设计与实现记录

| 文档                                              | 内容与边界                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| [可用率告警](design/availability-alerts.md)       | 消费规则结论，计算可用率和连续异常，绑定渠道、去重与恢复           |
| [规则引擎](design/rule-engine.md)                 | 规则树、字段元数据、求值、规则组管理、鉴权、检查链路接入与验收     |
| [探针 Agent](design/probe-agent.md)               | CLI 工程、两条注册路径、安装与 systemd 常驻、心跳/上报/校验协议    |
| [探针动态调度](design/probe-scheduling.md)        | SYSTEM/TENANT 分工、Redis 分配、调度与降级；保留原设计示例         |
| [工作区通知](design/workspace-notifications.md)   | 已实现事件清单、接收者、邀请访问、事务 outbox 和多实例 SSE         |
| [双因素认证](design/two-factor-authentication.md) | TOTP、恢复码、challenge、secret 加密、安全策略与原设计决策         |
| [套餐与计费](design/billing.md)                   | 套餐、订阅栈、订单、支付与配额；升级页面单独归入产品文档           |
| [微信基础设施](design/wechat-infrastructure.md)   | 公共 HTTP/token/签名底座、支付、小程序、公众号、企业微信与实施记录 |

站内通知 `notifications` 和监控外部告警 `notifier` 是不同业务域，不合并为同一套通知说明。

## 产品原型

| 文档                                                   | 内容                                               |
| ------------------------------------------------------ | -------------------------------------------------- |
| [套餐升级页面](product/subscription-upgrade.md)        | 升级页面结构与购买、支付、订阅刷新流程             |

产品文档是客户端设计输入，不表示本仓库包含这些前端页面。

## 未实施提案

| 文档                                                  | 状态与范围                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| [监控报表与定时通知](proposals/monitoring-reports.md) | 待评审/待开发；独立日聚合、报表订阅、快照与多渠道投递，不是监控概览的剩余工作 |
| [云函数远程调用](proposals/cloud-probe-invocation.md) | 远程 SDK 调用规划；与当前 SCF 定时拉取部署方式区分                            |

## 历史归档

| 文档                                                           | 保留原因                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [监控 V1.0 设计](archive/monitoring-v1.0-design.md)            | 原 `docs/README.md` 的完整设计记录                                     |
| [监控 V1.1 设计](archive/monitoring-v1.1-design.md)            | 目标架构、当时仓库适配、接口映射与依赖；原“当前状态”是历史快照         |
| [监控 V1.1 Schema](archive/monitoring-v1.1-schema.md)          | 从系统设计中拆出的完整目标 Schema 和当时的适配差异，不是当前数据库定义 |
| [监控 V1.1 路线图](archive/monitoring-v1.1-roadmap.md)         | 合并原系统设计演进摘要与详细 P1/P2/P3 开发计划                         |
| [2026-10-04 监控评估](archive/monitoring-review-2026-10-04.md) | 合并同一时期的设计差异分析和优化实施建议                               |
| [监控项目归属迁移](archive/project-scoping-migration.md)       | 保留组织级监控迁移到项目级的边界与决策                                 |
| [探针成功率原提案](archive/probe-success-ratio.md)             | 保留原方案；后续实施以修订后的专项计划为准                             |
| [附件存储迁移方案](archive/attachment-storage-migration.md)    | 保留移除 UploadThing、迁入 Local/OSS 的原方案与兼容策略                |

## 实施计划

`plans/` 保留专项实施契约、进度和验收产物，不在本轮移动，也不与历史版本路线图混用。

- [监控概览 API 与验收契约](../plans/001-monitoring-overview-api.md)
- [项目访问控制](../plans/002-project-access-control.md)
- [探针成功率修订方案](../plans/003-probe-success-ratio.md)
- [监控概览实施进度](../plans/monitoring-overview/progress.md)

## 整理对应关系

以下旧文件名用于 Git 历史检索，不是仍可访问的路径。

| 原文件                                                 | 整理结果                                            |
| ------------------------------------------------------ | --------------------------------------------------- |
| `README.md`                                            | 原设计归档；当前位置改为总索引                      |
| `V1.1.md` + `V1.1-development-plan.md`                 | 拆为 V1.1 设计、Schema、合并后的路线图              |
| `design-gap-analysis.md` + `optimization-roadmap.md`   | 合并为带日期的历史监控评估                          |
| `probe-agent-plan.md` + `probe-cli-enrollment-plan.md` | 合并为探针 Agent 演进设计                           |
| `alarm-rules-plan.md`                                  | 拆为可用率告警与规则引擎，互相链接                  |
| `billing-design.md`                                    | 后端设计与套餐升级页面分开                          |
| `mini-program-prototype.md`                            | 产品说明与线框图分开                                |
| `monitor-details-api.md`                               | 按实际端点命名为 `monitor-insights.md`              |
| `monitoring-overview-implementation.md`                | 改为 `monitoring-operations.md` 运行指南            |
| `probe-scf-deploy.md`                                  | 改为 `probe-scf-deployment.md` 部署指南             |
| `probe-execution-scheduler.md`                         | 改为 `probe-scheduling.md` 调度设计                 |
| `workspace-notifications.md`                           | 移入 `design/`，保留主题名                          |
| `two-factor-auth-design.md`                            | 改为 `two-factor-authentication.md`                 |
| `wechat-infra-plan.md`                                 | 改为 `wechat-infrastructure.md` 设计与实现记录      |
| `monitoring-reports-plan.md`                           | 移入 `proposals/`，改为主题名                       |
| `cloud-probe-scheduler-invoke-plan.md`                 | 移入 `proposals/`，改为 `cloud-probe-invocation.md` |
| `project-scoped-business-plan.md`                      | 归档为 `project-scoping-migration.md`               |
| `probes-success-ratio-plan.md`                         | 归档为 `probe-success-ratio.md`，链接到修订方案     |
| `upload-storage-migration-plan.md`                     | 归档为 `attachment-storage-migration.md`            |

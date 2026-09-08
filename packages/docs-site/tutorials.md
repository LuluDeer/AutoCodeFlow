# 教程索引 — 从 0 到生产

> 重组自 [docs/tutorials/](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/tutorials)（DOC-06）。
> 四篇教程按真实上线顺序编排：每篇可独立阅读，也可以从头跟到尾走完
> 「建任务 → 依赖私服化 → 执行器扩容 → 告警值班」的完整生产化路径。

| 篇 | 主题 | 你将学会 |
|----|------|---------|
| [01 · 第一个定时任务](./tutorial-01-first-task) | 登录 → 建任务 → 触发 → 看结果 | 平台核心概念（应用/任务/执行器/执行记录）与最小闭环；会用任务模板（CORE-03）少填 90% 表单 |
| [02 · 私服依赖](./tutorial-02-private-registry-deps) | 起内置 npm/PyPI 私服 → 发布内部包 → 任务 requirements 引用 | 任务级依赖声明（W-21）+ 私服安装链路，让任务脚本脱离「把依赖装进执行器镜像」的苦力活 |
| [03 · 多执行器扩容](./tutorial-03-multi-executor-scaling) | 第二台执行器注册 → 负载感知调度 → 灰度发布 | 横向扩容执行器、理解负载评分（CORE-05）与 canary 灰度（DEP-02）如何保护生产 |
| [04 · 告警接入值班](./tutorial-04-alerting-oncall) | 通知渠道 → 静默窗口 → Alertmanager → 告警路由 | 把平台通知与 Prometheus/Alertmanager 告警接入企业微信/钉钉/Slack，runbook 随告警直达 |

## 阅读前提

- 已按 [快速上手指南](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/quickstart.md)
  用 Docker Compose 启动了全栈（或至少 admin-api / admin-web / 一个执行器在线）。
- 四篇教程互相独立，但 03/04 的部分操作需要 ADMIN 角色。

## 与参考文档的关系

教程讲「操作路径」，参考文档讲「完整契约」：

- [API 参考](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/api-reference.md) — 所有端点的请求/响应契约
- [部署指南](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/deployment.md) — 生产环境部署、HTTPS、安全加固
- [应用开发指南](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/app-development-guide.md) — 自定义执行器与任务脚本开发
- [可观测性指南](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/observability/README.md) — Prometheus 抓取/Grafana/告警规则细节
- [SDK 指南](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/sdk-guide.md) — 双 SDK 能力矩阵与发布流程

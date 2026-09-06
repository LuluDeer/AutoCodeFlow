# 开发计划任务认领板

> 配套文档：[DEVELOPMENT-PLAN-2026-09.md](./DEVELOPMENT-PLAN-2026-09.md)（任务详情/验收标准/排期）
> 本板是多会话并行开发**唯一的认领事实源**。规则：
> 1. **认领**：把状态改为 `claimed` 并填 Owner（会话唯一名，如 `main-A`）+ 时间 + 文件足迹（预计要改的文件，供他人避让）。
> 2. **开工**：`claimed → in_progress`；**完成**：`done` + 填 commit hash；**放弃/移交**：`unclaimed` 并清空 Owner（备注留交接说明）。
> 3. **同一时刻一个任务只允许一个 Owner**；文件足迹重叠的任务不要同时开工。
> 4. 开工前必跑 `git pull --rebase`（工作区干净时）+ `git status` 盘点他人未提交改动——**未提交改动归其作者会话，勿动勿提交**。
> 5. 会话结束：done 的任务在 AGENT_HANDOFF.md「状态快照」记一笔，并提交本板的最终状态。
>
> 状态字典：`unclaimed`（待认领）/ `claimed`（已认领排队）/ `in_progress`（进行中）/ `done` / `blocked`（备注写原因）

## 认领状态总表

| 任务 | 优先级 | 状态 | Owner | 认领时间 | 文件足迹 | commit | 备注 |
|---|---|---|---|---|---|---|---|
| W2-闭环 | P0 | done | main-A（前端半场）+ 并行会话（API 半场） | 2026-09-07 | admin-web/src/pages/ExecutorDetailPage.tsx | f0c5f32 + 747ea40 | **整体闭环**：API 半场由并行会话以 747ea40 提交（executor 写面 ADMIN 收口+rbac spec），前端门控半场 f0c5f32（main-A）。RBAC 收紧前后端同批发布纪律达成 |
| BUG-01 | P1 | in_progress | session-B（员工 001 承接） | 2026-09-07 01:2x | admin-api executor.controller.ts（reloadConfig 区）+ prometheus metrics + 专项 spec | | 收口：双 401 错误文案精确化 + push auth-retry 指标 + 重试路径专项测试（此前无覆盖） |
| BUG-02 | P2 | done | main-A | 2026-09-07 | 无改动（复核销账） | | 复核结论：sweep 重试预算语义（hasRetryBudget→kill best-effort→re-enqueue+STALE_RECOVERY_RETRY_ENABLED 默认开）**第十四轮已完整实现且有测试**（scheduler.service.spec 1309 关闭态例），计划信息滞后，无需改动 |
| BUG-08 | P2 | done | main-A | 2026-09-07 | executor-node/src/main.ts + middleware/auth.* + bundle | 313d203 | N41 修复：auth.ts setOnTokenAcquired 钩子 + main.ts maybeReRegister（短路+去重）+ admin 同 startupId register 幂等复核通过；+3 测试，executor-node 235/235；bundle 同 commit |
| BUG-09 | P2 | done | main-A | 2026-09-07 | executor-python main.py + routers/execute.py + tests | 780dbcf | QA8 修复：await_background_tasks_after_kill 窗口 + _run_and_callback CancelledError 落盘守卫 + lifespan 顺序钉死（杀树→flush→drain）；+4 测试，executor-python 201/201 |
| QA-04 | P1 | done | main-A | 2026-09-07 | docs/VERIFY-MATRIX.md | 0a4d5c0 | 真机矩阵 checklist 固化：平台/拓扑矩阵 + 按变更类型必跑表 + VERIFY 模板 |
| BUG-03 | P2 | unclaimed | | | admin-api 各模块 spec | | coverage 地板提升（68/58/56/69→75/65/62/75），分两轮 |
| BUG-04 | P3 | unclaimed | | | 无代码（跟踪上游） | | minio 链 moderate，等上游 |
| BUG-05 | P2 | done | main-A | 2026-09-07 | admin-api metrics 模块 + task.service + docs/observability | 3caabb4+style | SSE active/limit gauge 双 series + 占用率可算；1179/1179 ✓（lint 0）|
| BUG-06 | P2 | done | main-A | 2026-09-07 | admin-api task.service storeLogLines | 2711c9d | 复核坐实两处真实缺陷（replace 陈旧指针/append 孤儿行）并修复，+2 集成回归，1218/1218 |
| BUG-07 | P2 | unclaimed | | | Windows 测试任务书 + e2e 脚本 | | QA8 detached 信号深验（需 Windows 真机窗口） |
| BUG-10 | P3 | unclaimed | | | 双执行器失败分类 | | failureReason 细化 |
| BUG-11 | P3 | unclaimed | | | executor-desktop assets | | W-16 图标入库 |
| BUG-12 | P2 | unclaimed | | | executor-desktop main/IPC | | SEC-01 项之一（desktop 凭据/IPC/env 复审） |
| BUG-13 | P2 | done | main-A | 2026-09-07 | packages/acf-cli + docs/SEC-01-复审报告.md | | SEC-01 四项复审第一批（CLI 认证链/降级/重试） |
| BUG-14 | P2 | done | main-A | 2026-09-07 | packages/mcp-server | | SEC-01 四项复审（MCP 鉴权链）与 BUG-13 同报告销账 |
| BUG-15 | P2 | done | main-A | 2026-09-07 | packages/autocodeflow-node-sdk + autoflow-sdk | | SEC-01 四项复审（双 SDK 降级/重试/错误传播） |
| BUG-16 | P2 | done | main-A | 2026-09-07 | apps/registry-npm | | SEC-01 四项复审（下载路由 token 边界） |
| BUG-17 | P3 | unclaimed | | | 真机验证脚本 | | nginx SSE 24h 长流验证 |
| BUG-18 | P2 | unclaimed | | | e2e + registry 双仓 | | 私服 npm/PyPI 端到端集成验证 |
| BUG-19 | P2 | unclaimed | | | scripts/load-test | | 大规模并发压测 + 容量白皮书 |
| BUG-20 | P3 | unclaimed | | | Dockerfile/CI | | ARM64 multi-arch |
| FEAT-01 | P1 | unclaimed | | | admin-api notification + admin-web settings | ⚠️ | 通知静默持久化；**避开 NotificationSettingsPage（并行会话在途）** |
| FEAT-02 | P1 | done | main-A | 2026-09-07 | admin-web dag-layout.ts + TaskDependencyGraph.tsx + TaskDetailPage | 见批四 commit | 依赖 DAG 可视化：纯函数布局（10 测试）+ 零新依赖组件 + 详情页新 Tab |
| FEAT-03 | P1 | done | main-A | 2026-09-07 | admin-web ExecutionsPage + ExecutionCompare | 0409000 | 孤儿组件复核=**零引用**；拆 ExecutionCompareModal + 列表多选一键对比（93/93 ✓） |
| FEAT-04 | P2 | unclaimed | | | admin-web ExecutorDetailPage + api | | 执行器指标趋势图（依赖 executor_metrics_history 消费） |
| FEAT-05 | P2 | unclaimed | | | 双执行器 + admin-api uploads + admin-web | | 执行产物 artifacts 通道 |
| FEAT-06 | P2 | unclaimed | | | admin-api scheduler + task 实体 | | 任务维护窗口 |
| FEAT-07 | P2 | unclaimed | | | admin-api 新模块 event-subscriptions | | Webhook 出站事件 |
| FEAT-08 | P2 | in_progress | session-B（员工 005 承接） | 2026-09-07 01:2x | admin-api config 模块 + admin-web settings（HistoryModal 区） | | 配置历史回滚：后端回滚端点（走 system-config 同一校验/掩码守卫+审计留痕）+ 前端「回滚到此版本」按钮；与 BUG-01 文件足迹无重叠 |
| FEAT-09 | P3 | unclaimed | | | admin-web 全局组件 | | 全局搜索/命令面板 |
| FEAT-10 | P3 | unclaimed | | | admin-api notification | | 通知模板变量 |
| FEAT-11 | P3 | unclaimed | | | task 实体 + admin-web | | 任务 runbook 字段 |
| FEAT-12 | P3 | done | main-A | 2026-09-07 | registry-pypi main.py + tests | 见批六 commit | 索引页增强：版本聚合/体积/UTC 时间/计数；PEP 503 锚点语义不变；+2 测试 52/52 |
| CORE-01 | P1 | done | main-A | 2026-09-07 | admin-web TaskForm/List/Detail + utils/priority | 批六 commit | 前端 UI 化 done（后端本就绪）；剩余=拥塞下优先出队的真机断言（并入真机轮） |
| CORE-02 | P1 | unclaimed | | | admin-api task + admin-web | | 重试策略精细化（attempt 链可视化） |
| CORE-03 | P1 | unclaimed | | | admin-api 模板实体 + admin-web | | 任务模板与一键克隆 |
| CORE-04 | P1 | unclaimed | | | admin-api + 双执行器 | | 超时策略分级（warn/动作可选） |
| CORE-05 | P1 | unclaimed | | | admin-api dispatch + 心跳 | | estimatedDurationSec 参与 loadScore |
| CORE-06 | P1 | unclaimed | | | admin-api SchedulerMetrics + Grafana | | 调度延迟分布 P99 |
| OBS-01 | P1 | unclaimed | | | admin-api + 双执行器 + compose | | OpenTelemetry 追踪（跨三端，宜整轮承接） |
| OBS-02 | P1 | unclaimed | | | admin-api 新端点 + Alertmanager 配置 | | 告警路由到通知渠道（依赖 FEAT-11） |
| OBS-03 | P1 | unclaimed | | | admin-api 日志行抽取 + admin-web 日志区 | | 日志结构化检索（级别列+过滤） |
| OBS-04 | P1 | unclaimed | | | admin-api + admin-web | | execution_reports 消费 + 时间线 Tab |
| OBS-05 | P1 | unclaimed | | | admin-api metrics | | 容量水位 Gauge 系列 |
| ECO-01 | P1 | unclaimed | | | 双 SDK + examples | | SDK 统一矩阵 + 官方示例（路线图 #10 收口） |
| ECO-02 | P1 | in_progress | main-A | 2026-09-07 | packages/acf-cli | | tail+lint 已落地（66/66）；--json 全命令覆盖为剩余子项，后续批次继续 |
| ECO-03 | P1 | unclaimed | | | packages/mcp-server | | MCP 工具面扩容 4 工具 |
| ECO-04 | P1 | unclaimed | | | 无代码（secrets 配置 + tag） | | release 首发演练 v1.1.0 |
| ECO-05 | P1 | unclaimed | | | docs + VitePress | | SDK 文档站 |
| AUTH-01 | P2 | unclaimed | | | admin-api 全域迁移 + JWT | ⚠️ 大 | Project 实体与隔离（需产品拍板后启动，迁移分三批） |
| AUTH-02 | P2 | unclaimed | | | admin-api RolesGuard + admin-web | | 项目级角色细化（依赖 AUTH-01） |
| AUTH-03 | P2 | unclaimed | | | admin-api + admin-web | | 限权 API Key |
| AUTH-04 | P3 | unclaimed | | | admin-api auth 模块 | | OIDC SSO（可选） |
| AUTH-05 | P2 | unclaimed | | | admin-api audit + admin-web | | 审计日志增强 |
| DSK-01 | P2 | unclaimed | | | executor-desktop + CI | | macOS 打包（需 macOS 真机） |
| DSK-02 | P2 | unclaimed | | | executor-desktop | | Linux AppImage/deb |
| DSK-03 | P2 | unclaimed | | | executor-desktop | | 自动更新 |
| DSK-04 | P2 | unclaimed | | | executor-desktop renderer | | desktop 体验四项 |
| DSK-05 | P2 | unclaimed | | | Dockerfile/CI | | ARM64 矩阵（与 BUG-20 可同人承接） |
| DEP-01 | P2 | unclaimed | | | admin-api application 模块 | | /releases 统一资源 |
| DEP-02 | P2 | unclaimed | | | admin-api 部署链 + 双执行器 | | 灰度发布 |
| DEP-03 | P2 | unclaimed | | | admin-api + 双执行器 | | 部署健康检查钩子+自动回滚 |
| DEP-04 | P3 | unclaimed | | | admin-api + admin-web | | 部署审批流（依赖 AUTH-03） |
| ARCH-20 | P2 | unclaimed | | | 根 package.json + pnpm-workspace | | monorepo 工作区统一入口 |
| ARCH-21 | P2 | unclaimed | | | admin-api task/notification/ai 模块 | | 领域事件总线（EventEmitter2） |
| ARCH-22 | P2 | unclaimed | | | admin-api migrations + 清理服务 | | 日志表按日分区 |
| ARCH-23 | P3 | unclaimed | | | admin-api swagger + admin-web api 层 | | OpenAPI→前端类型生成 |
| ARCH-24 | P3 | unclaimed | | | admin-api TypeORM 配置 | | 读写分离（可选配置） |
| ARCH-25 | P3 | unclaimed | | | 双执行器 + admin-api | | 插件化任务 runtime |
| ARCH-26 | P2 | unclaimed | | | admin-web 渐进改造 | | TanStack Query 渐进引入 |
| ARCH-27 | P2 | unclaimed | | | admin-api configuration + eslint 规则 | | process.env 直读收口 lint |
| UI-01 | P1 | unclaimed | | | admin-web 全局样式 + antd token | | 设计系统令牌落地（dark algorithm） |
| UI-02 | P1 | unclaimed | | | admin-web store + 布局 | | 明暗主题切换 |
| UI-03 | P1 | unclaimed | | | admin-web layouts + router | | 布局升级（侧边栏分组/折叠/PageHeader） |
| UI-04 | P1 | unclaimed | | | admin-web DashboardPage | | Dashboard 重构五项 |
| UI-05 | P1 | unclaimed | | | admin-web ExecutionDetailPage | ⚠️ | 执行详情信息架构（Tab 化+虚拟滚动日志） |
| UI-06 | P1 | unclaimed | | | admin-web TaskFormPage | | 任务表单重构（消分步挂载陷阱土壤） |
| UI-07 | P1 | unclaimed | | | admin-web 执行器两页 | | 执行器列表/详情升级（与 FEAT-04 建议同人） |
| UI-08 | P1 | unclaimed | | | admin-web 全页面盘点 | | 空态/加载态/错误态标准化 |
| UI-09 | P2 | unclaimed | | | admin-web 三页响应式 | | 移动端适配（值班场景三页） |
| UI-10 | P2 | unclaimed | | | admin-web 全站 | ⚠️ 大 | i18n 框架接入（越晚成本越高） |
| UI-11 | P2 | unclaimed | | | admin-web | | 命令面板 UI（依赖 FEAT-09） |
| UI-12 | P3 | unclaimed | | | admin-web | | 键盘可达性与无障碍 |
| UI-13 | P3 | unclaimed | | | executor-desktop renderer | | 桌面端对齐设计系统令牌 |
| UI-14 | P2 | unclaimed | | | admin-api SSE + admin-web | | 实时推送统一（配 BUG-05 容量文档） |
| QA-01 | P1 | unclaimed | | | e2e-full.spec.js | | E2E +15 场景（随对应功能逐批入库） |
| QA-02 | P1 | unclaimed | | | 各端 spec | | =BUG-03 同义项（coverage 提升），认领任一即可 |
| QA-03 | P1 | unclaimed | | | admin-web __tests__ | | 组件测试扩面 200+ |
| QA-05 | P2 | unclaimed | | | scripts/load-test + docs | | =BUG-19 同义项 |
| QA-06 | P2 | unclaimed | | | compose 演练脚本 | | 混沌/故障注入四场景 |
| QA-07 | P2 | unclaimed | | | 新建共享契约 fixture | | 四客户端包契约测试统一 |
| QA-08 | P2 | unclaimed | | | CI workflow | | 跨版本迁移演练月度 job |
| QA-09 | P3 | unclaimed | | | e2e 安全套件 | | 审计红线路径回归固化 |
| QA-10 | P3 | unclaimed | | | 基准脚本 | | 关键路径性能基准 |
| SEC-01 | P1 | unclaimed | | | 复审报告 v2 | | =BUG-12~16 汇总项，可拆半场认领 |
| SEC-02 | P1 | unclaimed | | | task env 加密 | | 任务 secrets 加密落库 |
| SEC-03 | P1 | unclaimed | | | users/auth 模块 + admin-web | | TOTP 两步验证 + 会话管理页 |
| SEC-04 | P2 | unclaimed | | | admin-api url-guard 收敛 | | SSRF 守卫统一 util |
| SEC-05 | P2 | unclaimed | | | 上传链路 | | zip bomb 防护+扫描钩子 |
| SEC-06 | P2 | unclaimed | | | CI + pre-commit | | 供应链（audit moderate+gitleaks） |
| SEC-07 | P2 | unclaimed | | | Dockerfile + compose | | executor 容器 non-root 化 |
| SEC-08 | P3 | unclaimed | | | main.ts helmet 配置 | | CSP/HSTS 收紧 |
| SEC-09 | P3 | unclaimed | | | throttle 配置 | | 限流分域（依赖 AUTH-03） |
| SEC-NEW-1 | P3 | unclaimed | | | executor-desktop config-store + safeStorage | | SEC-01 复审新发现：executorToken 明文落盘，改 safeStorage 加密+存量迁移（三平台差异）|
| DOC-01 | P1 | unclaimed | | | PR 模板 + api-reference | ⚠️ | API 变更检查项机制（api-reference 并行会话在途，先建模板） |
| DOC-02 | P1 | unclaimed | | | docs/operations.md | | 运维手册补全（依赖 QA-05/08 产出） |
| DOC-03 | P2 | unclaimed | | | 种子脚本 | | demo:seed 一键演示数据 |
| DOC-04 | P2 | done | main-A | 2026-09-07 | docs/adr/（新建 11 文件） | 见批五 commit | ADR-001~010 + 索引 README |
| DOC-05 | P2 | unclaimed | | | release 配置 | | CHANGELOG 自动化（release-please） |
| DOC-06 | P3 | unclaimed | | | docs 教程 | | 「从 0 到生产」四篇 |

## 变更日志

- 2026-09-07 main-A：建板。认领 W2-前端半场（in_progress）、BUG-01/02/08/09、QA-04（claimed）。
- 2026-09-07 main-A：批一收工。done=W2 前端半场(f0c5f32)/BUG-08(313d203)/BUG-09(780dbcf)/QA-04(0a4d5c0)/FEAT-03(0409000)；BUG-02 复核销账（第十四轮已实现）；BUG-01 blocked（重试 R11 已实现，收口在 controller，等并行会话提交）。基线：executor-node 235/235 · executor-python 201/201 · admin-web 93/93（并行会话 WIP 测试文件除外）· 我方文件 lint 0。
- 2026-09-07 main-A：W2 整体闭环确认（并行会话 747ea40 提交 API 半场）→ done；BUG-01 阻塞解除 → unclaimed。并行会话另提交 269d249（W1/W3/W7/W8 通知/应用页面）。
- 2026-09-07 main-A：批二收工。done=BUG-05（3caabb4 + prettier follow-up）——SSE 活跃流 gauge 落地，指标字典补录 4 counter+2 gauge。
- 2026-09-07 main-A：批四 done=FEAT-02（DAG 可视化，admin-web 108/108+build ✓，避开 metrics/config/executor 在途文件）。
- 2026-09-07 main-A：⚠️ 流程事故复盘——dc82ac7（session-B 的 BUG-01 提交）顺带带走了 main-A 已暂存的 ECO-02 四文件（共享 index 暂存碰撞）。核对无内容丢失，但归属纠缠。**新纪律：多会话环境下 git add 后必须立即 commit，禁止长时暂存**；提交前 git log --stat 盘点是否被顺带提交。
- 2026-09-07 main-A：批五 done=DOC-04（ADR 十篇：回调 token/双保险调度/幂等签发/信封契约/bundle 同 commit/RBAC 同批/配置优先级/真机冒烟/S3 双存储/去重窗口语义）。
- 2026-09-07 盘点：并行会话在途未提交改动=executor.controller.ts(W2 API 半场+rbac.spec)、MainLayout.tsx、logout.test.tsx、AppDeploymentPage.tsx、ApplicationDetailPage.tsx、ApplicationListPage.tsx、NotificationSettingsPage.tsx(W1)、docs/api-reference.md、docs/sdk-guide.md、examples/desktop-automation/*（5 文件）、新增 app-deployment-race.test.tsx（tsc 报错在途）——上述文件在清理前请勿认领触碰。

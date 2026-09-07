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
| BUG-01 | P1 | done | session-B（员工 001 承接） | 2026-09-07 01:2x | admin-api executor.controller.ts + runtime-metrics + spec | dc82ac7 | 双 401 文案精确化（重签后仍 401→rotate-token 建议/非 401 重试失败→等心跳自愈）+ autoflow_push_auth_retry_total 计数器 + 7 例专项测试（此前零覆盖） |
| BUG-02 | P2 | done | main-A | 2026-09-07 | 无改动（复核销账） | | 复核结论：sweep 重试预算语义（hasRetryBudget→kill best-effort→re-enqueue+STALE_RECOVERY_RETRY_ENABLED 默认开）**第十四轮已完整实现且有测试**（scheduler.service.spec 1309 关闭态例），计划信息滞后，无需改动 |
| BUG-08 | P2 | done | main-A | 2026-09-07 | executor-node/src/main.ts + middleware/auth.* + bundle | 313d203 | N41 修复：auth.ts setOnTokenAcquired 钩子 + main.ts maybeReRegister（短路+去重）+ admin 同 startupId register 幂等复核通过；+3 测试，executor-node 235/235；bundle 同 commit |
| BUG-09 | P2 | done | main-A | 2026-09-07 | executor-python main.py + routers/execute.py + tests | 780dbcf | QA8 修复：await_background_tasks_after_kill 窗口 + _run_and_callback CancelledError 落盘守卫 + lifespan 顺序钉死（杀树→flush→drain）；+4 测试，executor-python 201/201 |
| QA-04 | P1 | done | main-A | 2026-09-07 | docs/VERIFY-MATRIX.md | 0a4d5c0 | 真机矩阵 checklist 固化：平台/拓扑矩阵 + 按变更类型必跑表 + VERIFY 模板 |
| BUG-03 | P2 | unclaimed | | | admin-api 各模块 spec | | coverage 地板提升（68/58/56/69→75/65/62/75），分两轮 |
| BUG-04 | P3 | unclaimed | | | 无代码（跟踪上游） | | minio 链 moderate，等上游 |
| BUG-05 | P2 | done | main-A | 2026-09-07 | admin-api metrics 模块 + task.service + docs/observability | 3caabb4+style | SSE active/limit gauge 双 series + 占用率可算；1179/1179 ✓（lint 0）|
| BUG-06 | P2 | done | main-A | 2026-09-07 | admin-api task.service storeLogLines | 2711c9d | 复核坐实两处真实缺陷（replace 陈旧指针/append 孤儿行）并修复，+2 集成回归，1218/1218 |
| BUG-07 | P2 | unclaimed | | | Windows 测试任务书 + e2e 脚本 | | QA8 detached 信号深验（需 Windows 真机窗口） |
| BUG-10 | P3 | done | main-A | 2026-09-07 | admin 枚举 + 双执行器 + autoflow-sdk + admin-web 映射 | 见批七 commit | +3 分类（git_fetch/dependency_install/runtime_missing），四端联动 |
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
| FEAT-01 | P1 | done | main-A（API 半场）+ session-B（UI 半场，005 承接） | 2026-09-07 | admin-api notification 模块 + admin-web 静默 Tab | 见批八 commit + 2e97d35 | **整体闭环**：API 半场（main-A）+ UI 半场（session-B：静默 Tab 列表/新建/删除/过期标/isSilenced 实写文案，8 例测试）；admin-web 150/150 |
| FEAT-02 | P1 | done | main-A | 2026-09-07 | admin-web dag-layout.ts + TaskDependencyGraph.tsx + TaskDetailPage | 见批四 commit | 依赖 DAG 可视化：纯函数布局（10 测试）+ 零新依赖组件 + 详情页新 Tab |
| FEAT-03 | P1 | done | main-A | 2026-09-07 | admin-web ExecutionsPage + ExecutionCompare | 0409000 | 孤儿组件复核=**零引用**；拆 ExecutionCompareModal + 列表多选一键对比（93/93 ✓） |
| FEAT-04 | P2 | done | session-B（员工 005 承接） | 2026-09-07 02:4x | admin-api executor metrics + admin-web | 见变更日志 | metrics 端点追加 history（15min AVG 桶≤96 点/limit 500）+ recharts 双 Y 轴三线卡（既有依赖零新增）+空态兜底；后端 6 例前端 3 例 |
| FEAT-05 | P2 | done | 004（子代理） | 2026-09-07 | 新迁移 + admin-api artifacts 模块(上传/鉴权下载端点) + execution-callback.dto + task.service.handleCallback + executor-node src(重打 bundle) + executor-python execute.py | 7e0c1c7(admin)+1b12073(py)+c739024(node) | **后端+双执行器+数据链路 done**：清单落 task_executions.artifacts、PUT 上传+JWT 流式下载+防穿越+TTL；admin-web 详情页产物展示移交（见 AGENT_HANDOFF） |
| FEAT-06 | P2 | done | session-B（员工 005 承接） | 2026-09-07 04:1x | admin-api task 实体+scheduler+DTO + admin-web 表单/详情 | 见变更日志 | maintenanceWindows cron 窗口（start/end 触达开关窗+7 天回看）enqueue 顶部跳过+triggersSkippedMaintenance 指标+表单 Form.List/详情 Tag；后端 33 例前端 10 例 |
| FEAT-07 | P2 | unclaimed | | | admin-api 新模块 event-subscriptions | | Webhook 出站事件 |
| FEAT-08 | P2 | done | session-B（员工 005 承接） | 2026-09-07 01:2x | admin-api config 模块 + admin-web settings/api | fd99579 | 回滚语义矩阵（create→删除/update 无旧值 400/delete→重建/保留元数据）+ 掩码哨兵拒绝（S3 镜像防线）+ action=rollback 独立留痕 + 前端行级回滚入口（isAdmin+Popconfirm+逐行 loading）；后端 13 例前端 4 例 |
| FEAT-09 | P3 | done | session-B（员工 005 承接） | 2026-09-07 05:0x | admin-web CommandPalette + MainLayout | 见变更日志 | ⌘K 面板四分组（任务 ILIKE/执行器/应用/最近执行）+防抖并行+序号守卫+键盘导航；11 例测试 |
| FEAT-10 | P3 | unclaimed | | | admin-api notification | | 通知模板变量 |
| FEAT-11 | P3 | done | 001（本会话） | 2026-09-07 | admin-api task/DTO/迁移 + notification + admin-web | 9e93e22 | runbook 可空 text + 双通知路径透传（dispatch/回调失败）+ 表单 TextArea/详情展示；admin-api 1370 · admin-web 160 |
| FEAT-12 | P3 | done | main-A | 2026-09-07 | registry-pypi main.py + tests | f93999b | 索引页增强：版本聚合/体积/UTC 时间/计数；PEP 503 锚点语义不变；+2 测试 52/52 |
| CORE-01 | P1 | done | main-A | 2026-09-07 | admin-web TaskForm/List/Detail + utils/priority | 批六 commit | 前端 UI 化 done（后端本就绪）；剩余=拥塞下优先出队的真机断言（并入真机轮）。**协作注记（session-B）**：CORE-01 数字 priority 直写 PG enum 致 500（e2e 23-25/29 红），已在 6912b4d 以列级 transformer+6 例 spec 修复并 CI 绿——「mock 不等于能跑」第四次前科 |
| CORE-02 | P1 | done | 002（子代理） | 2026-09-07 12:36 | admin-api retry-backoff.util(+spec)/task.service/scheduler.service/executor.service + admin-web retry-policy.ts/retry-chain.ts(+test)/TaskFormPage/TaskDetailPage/ExecutionDetailPage/api/tasks.ts + docs/api-reference.md（零迁移，预留时间戳未占用） | 5c0a7b5 + 2c0fe7e（另有 5 新文件随 001/8088766 入库，归属 CORE-02） | 重试策略精细化：① retryableErrors 表单多选（九类中文映射，空=全部可重试保持既有语义，后端零改）；② jitter ±20%（纯函数 jitteredRetryDelayMs，四处 enqueue 边界注入整数毫秒）；③ ExecutionDetailPage「重试链路」段 + Attempt #N of M + 下次重试近似时刻 + 手动提前重试指路（零新端点）。admin-api 1452/1452 · admin-web 197/197 + build ✓ |
| CORE-03 | P1 | unclaimed | | | admin-api 模板实体 + admin-web | | 任务模板与一键克隆 |
| CORE-04 | P1 | done | 001（子代理） | 2026-09-07 09:5x | admin-api task 实体/DTO/service + admin-web 表单/详情 + docs/api-reference.md（执行器不改，树杀仍在执行器侧） | c24f61d | 超时策略分级：`timeoutAction` 三动作（kill 缺省 / kill_retry=超时终态后按既有重试预算 re-enqueue（triggerType=timeout_retry），预算耗尽退化为 kill / notify_only=admin 不额外下发终止指令、告警由既有失败通知路径保证一次）+ `timeoutWarnRatio`（0-90 百分比预警阈值，每执行至多一次 WARNING）。纯决策层 timeout-policy.util 两端共享语义；迁移 1789500000000 可空列零破坏；版本快照纳入两字段。admin-api 1434/1434（1370 基线只增）· admin-web 165/165 + build ✓。真机三动作各一例留真机轮 |
| CORE-05 | P1 | unclaimed | | | admin-api dispatch + 心跳 | | estimatedDurationSec 参与 loadScore |
| CORE-06 | P1 | unclaimed | | | admin-api SchedulerMetrics + Grafana | | 调度延迟分布 P99 |
| OBS-01 | P1 | unclaimed | | | admin-api + 双执行器 + compose | | OpenTelemetry 追踪（跨三端，宜整轮承接） |
| OBS-02 | P1 | unclaimed | | | admin-api 新端点 + Alertmanager 配置 | | 告警路由到通知渠道（依赖 FEAT-11） |
| OBS-03 | P1 | done | session-B（001=后端半场 111f648；005=前端半场 c47884b） | 2026-09-07 05:5x | admin-api task 模块 + admin-web 日志区 | 111f648 + c47884b | **整体闭环**：level 列+三列索引+SQL 过滤+S3 读后过滤（后端 57 例）；前端级别过滤 Select+行高亮（useMemo 分段+逐字符相等测试）+10 例；admin-web 160/160 |
| OBS-04 | P1 | done | 001（子代理） | 2026-09-07 12:41 | admin-api task 模块（report 读端点+独立 spec）+ admin-web ExecutionDetailPage（最小插入）+ 新组件/工具/API 封装文件 + docs/api-reference.md | dd88d0a + 8088766 | **execution_reports 消费 + 时间线 done**：admin-api `GET /tasks/:id/executions/:execId/report` 一次拉取 execution 行 + `execution-timeline.util` 纯映射三段时刻（created→started→finished，与 DB 时间戳逐字符一致、缺省段 at=null；与 mcp-server ECO-03 同语义）+ execution_reports 当日聚合行（DATE 零点匹配；无行 report=null 属正常态）；reportRepo **@Optional** 注入——既有 task.service.spec/s3 integration spec 未提供该仓储零破坏。admin-web：ExecutionReportPanel 组件（Steps 时间线+AI 分析段+当日报告段三段降级）+ api/execution-reports.ts + utils/execution-timeline.ts + ExecutionDetailPage 页尾最小挂载。测试：admin-api +9 例（1434→**1443** ✓ tsc 绿）；admin-web +9 例（171→**180** ✓ build ✓）。缩水说明：execution_reports 全库唯一写入方是 MetricsService.generateReport 的"日"聚合（懒生成、常为空表），**不存在单执行级 AI 报告行**——按计划预案改为「时间线+AI 分析（aiAnalysis 列）为主体、报告行存在才渲染」形态 |
| OBS-05 | P1 | done | session-B（员工 001 承接） | 2026-09-07 03:3x | admin-api metrics 模块 + docs/observability | 5b5bfb5 | 容量水位四件套（PG 池四 series 真实 pg.Pool 取数/executor 磁盘/SSE/队列）+Grafana row4+阈值文档（并发编辑覆盖后补记，CI 绿佐证） |
| ECO-01 | P1 | unclaimed | | | 双 SDK + examples | | SDK 统一矩阵 + 官方示例（路线图 #10 收口） |
| ECO-02 | P1 | done | main-A | 2026-09-07 | packages/acf-cli | 批十 commit | tail/lint/--json（task list/executor list/app list）三件齐，acf-cli 69/69 |
| ECO-03 | P1 | done | 001（本会话） | 2026-09-07 | packages/mcp-server/src/{tools,index}.ts + __tests__ | 6297f21 | 4 工具落地（timeline 失败三联卡对齐 BUG-10 分类/dead-letters 聚合/template 5 官方模板白名单字段/scheduler-health 四段重塑）+10 测试 79/79，tsc/prettier 绿 |
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
| ARCH-27 | P2 | done | session-B（员工 001 承接） | 2026-09-07 05:0x | admin-api configuration/env util/eslint/14 处直读点 | 见变更日志 | 14 直读点四分类收口+Joi 补注册 11 项+no-restricted-properties 规则（防伪验证过）+development.md 规约；+18 用例 |
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
| QA-06 | P2 | done | session-B（员工 001 承接） | 2026-09-07 04:1x | scripts/chaos-drill* + docs/operations.md | 见变更日志 | 四场景脚本（A Redis 宕/B 断网 150s/C 双实例滚动/D PG 主从真机骨架）+selftest 33 例；断言参数按实现核实校准（90s 离线阈值等）；真跑验收留真机轮 |
| QA-07 | P2 | done | 001（本会话） | 2026-09-07 | packages/contract-fixtures + 四包测试文件 | a00438b | contract.json 单一事实源+README；四端消费同一向量（cli 74/mcp 84/node-sdk 53/py-sdk 105）；审计修 CLI detailFromData 空串遮蔽 + knownDivergence 分歧留档 |
| QA-08 | P2 | unclaimed | | | CI workflow | | 跨版本迁移演练月度 job |
| QA-09 | P3 | in_progress | main-A | 2026-09-07 | docs/SECURITY-REDLINE-CHECKLIST.md + e2e | | 清单已建（六域 30+ 红线）；e2e 套件化剩余 |
| QA-10 | P3 | unclaimed | | | 基准脚本 | | 关键路径性能基准 |
| SEC-01 | P1 | unclaimed | | | 复审报告 v2 | | =BUG-12~16 汇总项，可拆半场认领 |
| SEC-02 | P1 | done | 002（子代理） | 2026-09-07 11:19 | admin-api common/utils/secret-crypto.util + task entity/DTO/迁移 + task.service + executor.service + config（不碰 timeout 代码段，避让 001/CORE-04） | d7e7c84 + 7bd9378 | 任务级 secrets 加密落库：**方案=新增 tasks.secrets 独立 jsonb 列**（params 是普通运行参数且被列表/版本快照明文消费，整体加密伤审计面）——AES-256-GCM `enc:v1:` 自描述信封、SEC_SECRETS_KEY 未配置降级明文 warn 一次（零破坏升级）、写路径全加密/读路径永久脱敏（******）/dispatch 解密与 params 合并注入执行器 env（secrets 胜出、明文不二次入库）、存量行首次 update 自然转密文；迁移 1789500000001（时间戳避让 CORE-04 的 1789500000000）；+24 例测试（20 加密矩阵 + 4 dispatch 注入），admin-api **1434/1434**（基线 1370 只增不减）、tsc 绿；备份泄露演练（真机轮）就绪——deployment.md 已注记密钥与备份分开保管 |
| SEC-03 | P1 | unclaimed | | | users/auth 模块 + admin-web | | TOTP 两步验证 + 会话管理页 |
| SEC-04 | P2 | done | session-B（员工 001 承接） | 2026-09-07 02:4x | admin-api common/utils + spec | 见变更日志 | SSRF_DENY_HOST_PATTERNS 统一 deny 表（三套并集零收窄）+表驱动分类器；修复真实缺口：全文本形 IPv6 判 public（DNS 应答路径可放行）与 http 守卫 [ ] 括号剥离；15 例统一矩阵 spec |
| SEC-05 | P2 | unclaimed | | | 上传链路 | | zip bomb 防护+扫描钩子 |
| SEC-06 | P2 | unclaimed | | | CI + pre-commit | | 供应链（audit moderate+gitleaks） |
| SEC-07 | P2 | unclaimed | | | Dockerfile + compose | | executor 容器 non-root 化 |
| SEC-08 | P3 | unclaimed | | | main.ts helmet 配置 | | CSP/HSTS 收紧 |
| SEC-09 | P3 | unclaimed | | | throttle 配置 | | 限流分域（依赖 AUTH-03） |
| SEC-NEW-1 | P3 | unclaimed | | | executor-desktop config-store + safeStorage | | SEC-01 复审新发现：executorToken 明文落盘，改 safeStorage 加密+存量迁移（三平台差异）|
| SEC-NEW-2 | P2 | unclaimed | | | executor-python routers/execute.py gitRepo 守卫 | | 真机冒烟新发现：py 执行器无条件拒私网 gitRepo（正则 S7），admin 侧允许私网 LAN（ADR 注释文档化拓扑）——两端策略不一致，内网 GitLab 拉取对 py 执行器不可用；需镜像 admin 的 EXECUTOR_ALLOW_PRIVATE_NETWORK 式开关（安全姿态变更，需拍板）|
| SEC-NEW-3 | P3 | unclaimed | | | executor-python main.py registerExecutor | | 对齐 BUG-08/313d203：py 侧 register 失败后无 token 恢复补注册（node 侧已有钩子），/token fallback 重建行丢富元数据 |
| DOC-01 | P1 | unclaimed | | | PR 模板 + api-reference | ⚠️ | API 变更检查项机制（api-reference 并行会话在途，先建模板） |
| DOC-02 | P1 | in_progress | session-B（前半 done：容量规划+备份恢复；升级 runbook 留 QA-08 产出后） | 2026-09-07 09:3x | docs/operations.md + observability 交叉引用 | ff56c15 | 前半 done：容量规划（水位表/扩容要点/压测占位 5 处"待压测确认"）+备份恢复（对象清单/五步骨架/pgBackRest 骨架/演练 checklist）；升级 runbook 待 QA-08 |
| DOC-03 | P2 | done | main-A（ARCH-20 批次实现）/session-B 复核销账 | 2026-09-07 04:1x | scripts/demo-seed*.mjs | | 复核：demo:seed+selftest 已实现且自检通过（含 --password 门槛/演示数据形态），板信息滞后补记 |
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
- 2026-09-07 main-A：批七 done=BUG-10（四端联动失败分类细化）。基线刷新：executor-node 240/240 · executor-python 206/206 · autoflow-sdk 100/100 · admin-web 118/118 · registry-pypi 52/52。
- 2026-09-07 main-A：批八 done=FEAT-01 API 半场 / DOC-03 demo:seed / ARCH-20 根级入口 / QA-09 红线清单 / CORE-03-lite 克隆 / **真机冒烟 13/13**（本地 WSL2 PG+Redis，迁移 6 条全绿含 silences 表；CORE-06 端到端 P99=50ms；四件脚本坑修复入库 smoke-round16.mjs）。
- 2026-09-07 main-A：批九=**executor-python 全链真机冒烟**——注册/派发/执行/回调全通；抓到 V16-1（py 静态 token .env 不可见，裸机部署 401）与 V16-2（admin 心跳无凭据 500）双真 bug 当轮修复；dotenvx override:true 语义发现（W-22 家族变体）。
- 2026-09-07 main-A：批十=BUG-18 链路攻坚（私网 git 哑 http 私服+本地 pypi+演示 wheel）——被 SEC-NEW-2 拦截（py 端私网 gitRepo 拒绝）；链路基建与三枚新发现（SEC-NEW-2/3、dotenvx override:true）全部记档。pypi_registry_url --index-url 消费链确认在位。
- 2026-09-07 盘点：并行会话在途未提交改动=executor.controller.ts(W2 API 半场+rbac.spec)、MainLayout.tsx、logout.test.tsx、AppDeploymentPage.tsx、ApplicationDetailPage.tsx、ApplicationListPage.tsx、NotificationSettingsPage.tsx(W1)、docs/api-reference.md、docs/sdk-guide.md、examples/desktop-automation/*（5 文件）、新增 app-deployment-race.test.tsx（tsc 报错在途）——上述文件在清理前请勿认领触碰。

- 2026-09-07 session-B：批 B1 done=BUG-01(dc82ac7)/FEAT-08(fd99579)；协作修复 CORE-01 e2e 回归（6912b4d 列级 transformer）；另代修 mcp-server BUG-14 测试两处（0241b5a，afterEach 导入+模块态隔离）与 e2e 选择器作用域（2a4070d）。CI 24 job 绿（run 34051398995）。基线：admin-api 1224/62 · admin-web 112/112 · mcp-server 69/69。

- 2026-09-07 session-B：认领 SEC-04（001）/FEAT-04（005）→ in_progress。

- 2026-09-07 session-B：批 B2 done=SEC-04/FEAT-04（SSRF 统一 deny 表+全文本形 IPv6 缺口修复；24h 资源趋势图）。基线：admin-api 1245/66 · admin-web 121/121。

- 2026-09-07 session-B：认领 OBS-05（001）/FEAT-12（005）→ in_progress。

- 2026-09-07 session-B：DOC-03 复核销账（ARCH-20 批次已实现，selftest 过）；认领 QA-06（001）/FEAT-06（005）→ in_progress。

- 2026-09-07 session-B：批 B3 done=FEAT-06/QA-06。基线：admin-api 1291/67 · admin-web 131/131。

- 2026-09-07 session-B：认领 ARCH-27（001）/FEAT-09（005）→ in_progress。

- 2026-09-07 session-B：批 B4 done=ARCH-27(cf70459)/FEAT-09(45d0a8b)；随批修复 initialAdmin 用例 env 隔离。基线：admin-api 1309/67 · admin-web 142/142。⚠️ acf-cli trigger --wait 在 run 34061277789 慢环境 30s 超时（本地过，exec 重构域归 main-A 复核）。

- 2026-09-07 session-B：OBS-05 done 补记（并发编辑覆盖回退）；认领 OBS-03 后端半场（001）/FEAT-01 UI 半场（005）。

- 2026-09-07 session-B：批 B5 done=OBS-03 后端半场(111f648)/FEAT-01 UI 半场(2e97d35)；认领收尾波：OBS-03 前端半场（005）/DOC-02 容量规划小节（001）。

- 2026-09-07 session-B：批 B6 done=OBS-03 前端半场(c47884b，整体闭环)/DOC-02 前半(ff56c15)。session-B 收工总结：认领 13 任务全 done（BUG-01/FEAT-08/SEC-04/FEAT-04/OBS-05/FEAT-12/QA-06/FEAT-06/ARCH-27/FEAT-09/OBS-03/FEAT-01-UI 半场/DOC-02 前半）+DOC-03 复核销账+CORE-01 协作修复+CI 红治理 4 轮；基线 admin-api 1367/68 · admin-web 160/160 · registry-pypi 68 · CI 24 job 绿（run 34073326212，HEAD ff56c15）。

- 2026-09-07 001（本会话）：认领 ECO-03 → in_progress（文件足迹：packages/mcp-server/src/{tools,api}.ts 及 __tests__，他人勿动）。同批候选（后续再认领）：QA-07、FEAT-11、CORE-04、CORE-02。
- 2026-09-07 001：ECO-03 done（6297f21，mcp-server 79/79）；认领 QA-07 → in_progress。
- 2026-09-07 001：QA-07 done（a00438b）；认领 FEAT-11 → in_progress。
- 2026-09-07 001（子代理）：认领 CORE-04 → in_progress（文件足迹：admin-api task 实体/DTO/processor + admin-web TaskFormPage/TaskDetailPage + docs/api-reference.md，执行器两仓不改）。工作区他人在途改动已盘点：executor.service.spec.ts 格式微调 + registry-pypi/acfdemopkg 演示包，均不触碰。
- 2026-09-07 004（子代理）：认领 FEAT-05 → in_progress（文件足迹：apps/admin-api 新 `modules/artifacts` 模块 + 新迁移 `AddExecutionArtifacts` + `execution-callback.dto.ts`(加 artifacts) + `task.service.handleCallback`(落 artifacts) + `app.module`；apps/executor-node src + 重打 bundle；apps/executor-python routers/execute.py；docs/api-reference.md 与 001 避让=小改即提交）。他人在途改动（executor.service.spec.ts / acfdemopkg / CORE-04 认领行）不触碰；bundle 重打确定性本机已验证（未改源重打逐字节一致）。
- 2026-09-07 002（子代理）：认领 SEC-02 → in_progress（文件足迹：admin-api src/common/utils/secret-crypto.util 及 spec（新增）、task 实体/dto（仅追加 secrets 字段，不动 timeout 段）/新迁移、task.service（写路径加密）、executor.service（dispatch 解密合并注入）、app.module+configuration（SEC_SECRETS_KEY）、docs；他人勿动上述文件 timeout 相关代码段）。
- 2026-09-07 004（子代理）：FEAT-05 done（后端+双执行器+数据链路）。提交：7e0c1c7 admin-api（迁移+Artifacts 模块 上传/鉴权下载/防穿越/TTL+回调 DTO+handleCallback 落库）、1b12073 executor-python（collect/upload/清单随回调，+11 pytest）、c739024 executor-node（artifacts.ts+callback/execute 接入+bundle 同 commit 重打，+8 jest，本机验证空重打逐字节一致）。验收：admin-api 隔离 worktree tsc+jest 1389/1389（基线 1370 只增不减，+19 全我新增）、executor-python 217/217、executor-node 248/248。**shared 文件 hunk 隔离**：app.module.ts / task.service.ts 仅提交我 FEAT-05 hunk（001/002 在途半成品未卷入）。**移交 admin-web**：详情页产物列表 + 下载按钮调 GET /tasks/executions/:execId/artifacts[/:name]（见 AGENT_HANDOFF）。工作区他人未提交改动（executor.service.spec.ts 半成品因 002 SecretsCryptoService DI 未 mock 而红）非我引入、未触碰。
- 2026-09-07 002（子代理）：SEC-02 done（**d7e7c84** feat + **7bd9378** 既有 spec 补 SecretsCryptoService provider）。方案选型：新增 tasks.secrets 独立 jsonb 列（理由：params 为普通运行参数、被列表/版本快照明文消费，整体加密伤审计与调试面）。实现：secret-crypto.util（AES-256-GCM，`enc:v1:<iv>:<tag>:<ct>` 自描述信封，hex/base64 key，口令 sha-256 拉伸，幂等加密）+ SecretsCryptoService（key=env SEC_SECRETS_KEY，未配置降级明文 warn 一次）+ TaskService 写加密/读脱敏（PATCH 缺省=保留，null/{}=清空）+ ExecutorService dispatch/broadcast 解密合并注入执行器 env（secrets 覆盖同名 params，明文不落 task_executions）。迁移 1789500000001 幂等（时间戳避让 001/CORE-04 的 1789500000000，migrations.spec 原本会红）。SEC_SECRETS_KEY 登记 app.module Joi / configuration.ts / .env.example。+24 例测试；admin-api **1434/1434**（基线 1370 只增不减）、tsc --noEmit 绿。文档：api-reference.md（Tasks secrets 字段语义 + 环境变量表）、deployment.md（env 表 + 备份安全注记：密钥与备份分开保管）。备份泄露演练（真机轮）就绪。**流程注记**：7bd9378 的 create-task.dto.spec.ts 混入 001/CORE-04 同文件已暂存的 timeoutAction 用例（hunk 级隔离不可行，内容为其独立测试段，已在其 commit message 注明归属）；001 在途的 executor.service.spec.ts 格式微调（validateTokenByAddress 断言换行）因与我的 provider 注入同文件，随 7bd9378 一并入库（纯 prettier 格式，语义零变化）。
- 2026-09-07 001（子代理）：CORE-04 done（**c24f61d** feat）。实现：admin-api `task/timeout-policy.util.ts` 纯决策层（TimeoutAction 归一化 + 预警阈值判定）+ 迁移 1789500000000（tasks.timeoutAction varchar(16) / timeoutWarnRatio int，均可空零破坏）+ CreateTaskDto 校验（@IsIn 三动作 / @Min(0)@Max(90)，UpdateTaskDto 继承，PATCH 缺省=保留旧值、显式 null=回缺省）+ TaskService.normalizeTaskDto 运行态归一化 + **handleCallback 超时 winner 分支动作兑现**（kill_retry 经 ExecutorService.scheduleRetryAfterRecovery、triggerType=timeout_retry，预算耗尽退化 kill；notify_only 显式 no-op，告警由既有 notifyCallbackFailure 保证一次；re-enqueue 失败 fail-open，终态保持 TIMEOUT；winner 分支恰好一次）+ saveVersion 快照纳入两字段（版本回滚不静默重置超时策略）。admin-web：api/tasks.ts TimeoutAction 类型 + TaskFormPage 超时区 Radio 三选一/预警 InputNumber + TaskDetailPage 详情展示 + pages/timeout-policy.ts 提交序列化纯逻辑（N28 null 语义）。测试：DTO 7 例 + util 8 例 + service 超时动作 5 例 + 表单 7 例；admin-api **1434/1434**（基线 1370 只增）、tsc 绿；admin-web **165/165**（基线 160 只增）+ build ✓ + eslint 0。api-reference.md 超时策略字段段更新。**协作注记**：与 002/SEC-02、004/FEAT-05 在 task.service.ts / create-task.dto.spec.ts 同文件并行，经 hunk 级隔离与 stash 盘点确认互相零覆盖；7bd9378 曾卷入本方已暂存的 timeoutAction 用例（内容独立成段，002 已在其 commit message 注明归属）。真机三动作各验证一例留真机轮。执行器两仓零改动——树杀仍由执行器自身硬超时执行，admin 只做决策与告警。
- 2026-09-07 002（子代理）：认领 CORE-02 → in_progress（文件足迹：admin-api task 模块——DTO retryableErrors 校验 + 新增 retry-backoff.util（jitter）+ service/spec + admin-web TaskFormPage/ExecutionDetailPage/api 类型 + docs/api-reference.md；执行器两仓不改。预计零迁移；若实现中发现需要迁移，占用时间戳 **1789700000000**（已核对 ls migrations 与 git log，当前最高 1789600000000）。工作区他人在途改动已盘点：仅 apps/registry-pypi/packages/acfdemopkg/（其他会话演示包），不触碰）。
- 2026-09-07 003（子代理）：认领 FEAT-05 UI 半场 → in_progress（文件足迹=admin-web 新 api/artifacts.ts + TaskDetailPage 产物段 + 组件测试）。避让核对：不碰 ExecutionDetailPage（001 OBS-04 在途）、不碰 TaskFormPage/api/tasks.ts（002 CORE-02 在途）；TaskDetailPage 最近改动为 c24f61d（001 CORE-04 done），非他人在途足迹，仅一处最小 Edit 插入产物段。FEAT-05 主行已 done（后端+双执行器），本行为 UI 半场追加认领。
- 2026-09-07 001（子代理）：认领 OBS-04 → in_progress（文件足迹：admin-api task 模块 report 读端点+独立 spec、admin-web ExecutionDetailPage 最小 Tab 插入、新建组件文件 TimelineReportPanel+测试、api/execution-reports.ts，docs/api-reference.md）。**避让降级**：认领时发现 002/CORE-02 足迹含 admin-web ExecutionDetailPage——本任务核心产物（时间线组件/测试/API 封装）全部放独立新文件，ExecutionDetailPage 仅做最小插入；不碰 003/FEAT-05-UI 在途的 TaskDetailPage/artifacts 文件与 002 的 api/tasks.ts/TaskFormPage。工作区他人在途改动盘点：TaskDetailPage.tsx 修改+retry-backoff.util*（002）+artifacts 三件（003）+acfdemopkg（演示包），一律不触碰不提交。
- 2026-09-07 003（子代理）：FEAT-05 UI 半场 done（**7a5c589** feat）。实现：新增 `api/artifacts.ts`（listArtifacts GET `/tasks/executions/:execId/artifacts` + downloadArtifact GET `.../artifacts/:name` 走 axios blob+objectURL 触发保存，同 executor-packages.download——JWT 仅从 Authorization 头取，直链 401；类型 `ExecutionArtifact` 本地定义避免改 002 在途的 api/tasks.ts）+ `components/ArtifactsList.tsx`（props={execId,artifacts?}，未传清单自取数、渲染 name/人类可读 size/sha256 前缀 + 逐行 loading 下载、空清单 return null 整段不渲染）+ `utils/artifactSize.ts`（formatArtifactSize 纯函数）；TaskDetailPage 执行记录区最小插入最近一次执行的 ArtifactsList。测试 6 例（列表渲染 / 下载接线调用 api 层 / 空态不渲染 / 自取数 / 下载失败保持 / 尺寸格式化）。admin-web **171/171**（基线 165 只增不减）+ build 绿 + eslint 0。不改 admin-api（FEAT-05 后端 004 已 done）。遗留：ExecutionDetailPage 侧产物入口未做（001 OBS-04 在途该文件，避让）——ArtifactsList 组件已 props 化可直接复用，OBS-04 收工或后续单点接入即可。
- 2026-09-07 001（子代理）：OBS-04 done（**dd88d0a** feat + **8088766** docs）。实现：admin-api `GET /tasks/:id/executions/:execId/report`（task.controller + task.service.getExecutionReport）——一次响应合并 ①task_executions 行 ②`execution-timeline.util.ts` 纯映射 created→started→finished 三段（at 与 DB 时间戳逐字符一致、缺省段 null、非法日期不抛错；与 mcp-server ECO-03 buildExecutionTimeline 同语义三端对齐）③execution_reports 当日聚合行（triggerDay DATE 与执行 createdAt 本地零点等值匹配）；reportRepo **@Optional** 注入（既有 task.service.spec/s3 integration spec 未提供仓储时回退 null，零破坏，全量 1452/1452 佐证）。admin-web：`components/ExecutionReportPanel.tsx`（Steps 时间线 + AI 分析段 + 当日报告段，report=null/AI 缺失/加载失败三级降级）+ `utils/execution-timeline.ts` 前端同语义映射 + `api/execution-reports.ts`（独立文件避开 002 的 api/tasks.ts）+ ExecutionDetailPage 页尾最小挂载（页面核心编辑是 002/CORE-02 重试链 UI，其归属其 commit）。测试：admin-api +9 例（execution-report.spec：时间线映射 4 + 端点 4 + controller 1）**1443/1443**（基线 1434 只增）+ tsc 绿；admin-web +9 例（util 4 + 面板 5）**180/180**（基线 171 只增）+ build ✓。**缩水说明**：execution_reports 全库唯一写入方是 MetricsService.generateReport 的"日"聚合（读取路径懒生成，环境中常为空表），不存在单执行级 AI 报告行——按计划预案改为「时间线 + AI 分析（task_executions.aiAnalysis）为主体、当日报告行存在才渲染」形态。**流程事件**：开发中 002 为验证隔离将我 4 个在途文件与 003 遗留改动两次 stash；收工前经 stash 树核对取回全部产物，并对 checkout 回来的共享文件做 hunk 审计，剔除混入的 CORE-02 jitter 三处（import + 两处 backoff）后以 11 文件纯净提交，git diff --cached 零 CORE-02 注记佐证。002 在途 WIP 已原样恢复回工作区（含其 retry-backoff.util 等 5 个 untracked + 10 个 tracked 修改），未提交未触碰内容。
- 2026-09-07 002（子代理）：CORE-02 done（**5c0a7b5** feat + **2c0fe7e** docs；另 5 个新文件 retry-backoff.util(+spec)/retry-policy.ts/retry-chain.ts/retry-policy.test.ts 随 001/8088766 的 docs commit 顺带入库，内容与我本机逐字节一致，归属 CORE-02，特此注记）。实现三点：① **retryableErrors 表单化**——后端 DTO/processor RETRY-01 消费本就绪零改动，admin-web TaskFormPage 新增多选（pages/retry-policy.ts：九类中文映射=枚举剔除 killed/stale_recovered；applyRetryableErrorsPayload trim/空集显式 null 对齐 N28 PATCH 语义；retryableErrorsFormValues 编辑回填 null→[]）+ TaskDetailPage 白名单 Tag 展示；② **retryDelay ±20% jitter**——`retry-backoff.util.ts` 纯函数 `jitteredRetryDelayMs(retryDelaySec, attempt, random?, ratio?)`（retryDelay×1000×2^(attempt-1) 基座，[0.8×base,1.2×base] 闭区间整数毫秒，随机源注入可测、retryDelay<=0 返回 0 保持既有不延迟语义），四处 enqueue 边界注入：task.service trigger/rollback（attempt=1）、scheduler.enqueue（attempt=1）、executor.scheduleRetryAfterRecovery（attempt=retryCount+1）——选数值方案（BullMQ backoff delay 直传算好值），非函数注入，UI/日志可预算；③ **attempt 链可视化**——ExecutionDetailPage 新增「重试链路」Card（pages/retry-chain.ts 纯函数 buildRetryChain：兄弟执行行按 retryCount 连续档拼装、间断截断、同档并发取 createdAt 最早、retryGapMs=下行 startTime−上行 endTime）+「重试预算」Attempt #N of M（含剩余预算 Tag）+ PENDING 行「下次重试」近似提示（行 createdAt+retryDelay×2^(attempt-1) 基座，注明抖动；BullMQ delayed 精确到期时刻不落库）+ 手动提前重试指路既有「重新触发」POST /tasks/:id/trigger——**零新端点零迁移**（数据复用 GET /tasks/:id/executions 与 GET /tasks/:id）。测试：retry-backoff.util.spec 9 例 + retry-policy.test 17 例；既有 task.service.spec trigger/rollback、executor.service.spec recovery 断言从精确值改为抖动区间 [0.8×base,1.2×base]+整数断言；既有 3 个 execution-detail 测试文件 vi.mock 补 get/executionsWithStatus（页面新增消费）。**基线：admin-api 1452/1452**（1434 只增，+18 计入上述）· tsc 绿；**admin-web 197/197**（165 只增）· build ✓。**协作注记（与 001/OBS-04 同文件并行）**：ExecutionDetailPage 001 做页尾 OBS-04 面板最小挂载、我做重试链 Card/预算/下次重试，hunk 不相交；task.service 三处 jitter hunks 在双方 stash 往返中一度丢失，已在 OBS-04 新基线（@Optional 注入）上重新应用并全量回归验证共存；task.service.spec 附带 ExecutionReport 空仓 provider 结构性兜底（@Optional 已使其非必需，保留作双保险，不改变任何断言）。**缩水范围**：无——三点全量落地；BullMQ delayed 精确到期时刻不落库属后端既有设计，「下次重试」按近似值呈现并已注明（如需精确需新迁移记录 nextRunAt，留后续轮）。真机建议：配置 retryableErrors 白名单任务各验证一例命中/不命中；重试链≥2 段的 executor_restart 场景断言链路 UI。

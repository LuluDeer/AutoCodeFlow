# 功能点审计台账（2026-10-02 起）

> 编排式逐域审计：每轮 ≤2 个 subagent 并行排查，审完即派修复，本地验证后进下一轮。
> 修复与审计产出均落工作区，**等用户确认后统一提交**（沿用既有纪律：只推 develop）。

## 功能点清单（审计顺序）

| 轮次 | 域 | 范围 | 审计 | 修复 | 状态 |
|---|---|---|---|---|---|
| R1 | executor 域（admin-api） | executor module 全量 + 未提交 RBAC 下放改动 | R1-A | R1-fix | 进行中 |
| R1 | admin-web Executor UI | ExecutorList/Detail/Wizard/Packages + api/executors.ts | R1-B | R1-fix | 进行中 |
| R2 | metrics 域 | metrics module + scraper guard（未提交 DI 修复） | R2-A | — | 待开始 |
| R2 | task/scheduler 域 | task module + block-strategy 闸门 + scheduler/cron/依赖/retry | R2-B | — | 待开始 |
| R3 | auth/users/RBAC/项目域 | auth/api-keys/users/project + ADR-013 | R3-A | — | 待开始 |
| R3 | SOP/Agent 协作域 | sop/agent/agent-collab 模块 + AgentSessionsPage/SopsPage | R3-B | — | 待开始 |
| R4 | application/deployment/package 域 | application + executor-package + AppDeploymentPage | R4-A | — | 待开始 |
| R4 | registry 域 | registry / registry-npm / registry-pypi + RegistryPage | R4-B | — | 待开始 |
| R5 | executor-node 执行器侧 | callback/pull/zip-safety/interpreters/heartbeat 等 | R5-A | — | 待开始 |
| R5 | executor-desktop 桌面端 | main/renderer/agent-host/config | R5-B | — | 待开始 |
| R6 | 横切面 | notification/audit/artifacts/task-template/OpenAPI 契约/i18n | R6-A/B | — | 待开始 |

## 发现与处置记录

### R1（2026-10-02 Windows 侧重跑，审计完成 → 修复中）

- R1-A executor 域（admin-api）— 11 条发现；R1-B admin-web Executor UI — 15 条发现。
- 后端 P1/P2：A-1 广播模式绕过互斥组（task.processor.ts:195 / executor.service.ts:3691）；A-2 自动清理漏 appName 绑定口径（executor.service.ts:4375）；A-3 reload-config 重试丢 DNS pin+禁重定向（executor.controller.ts:1194）；A-4 Top-K 先于 group/tags 过滤致误报无可用执行器（executor.service.ts:2858）。
- 后端 P3：A-5 PATCH maxConcurrentTasks 无取值域校验；A-6 心跳 cpu/mem 不钳 [0,100]；A-7 pushToExecutors URL 未剥 ？#；A-8 pushHistory 读改写竞态；A-9 推全部在线取 findAll take=500 漏机；A-10 并发首注册 23505→500；A-11 estimatedDurations 热路径无界读。
- 前端 P1/P2：B-1 配置热更新弹窗不回显+空体提交=静默重置默认（ExecutorDetailPage.tsx:356）；B-2 删除包失败零反馈；B-3 弃用/激活双击竞态；B-4 包搜索无防抖逐键全量请求。
- 前端 P3：B-5 queued 不区分提示；B-6 详情页 id 切换状态残留；B-7 卡片视图缺徽标/空态动作；B-8 busy 死分支；B-9 STATUS_TAG 缺 uploading；B-10 心跳三档着色双实现；B-11 编辑无乐观锁；B-12 上传无大小校验/进度；B-13 卡片快捷按钮多一跳；B-14 列表缺 sorter；B-15 CodeBlock 硬编码色。
- 处置：R1-fix-A（admin-api 全量 11 条）+ R1-fix-B（admin-web B1-B9、B12；B10/B13/B14 择机，B11 记录暂缓）并行派发。
- **R1 修复完成（2026-10-02）**：后端 11/11——A-1 取写面拒绝方案（create 全量/PATCH 合并态判定 400，broadcast×mutexGroup 语义冲突；存量 broadcast 广播记 warn）；A-4 新增 findFleetCandidates 把 group/appName/tags/affinity/runtime 下推 SQL（内存链保留兜底，interpreter 版本比较盲区已注释声明）；A-8 事务 FOR UPDATE 重读；A-9 空 ids 改 ONLINE 全量分页；A-10 23505 捕获转重注册；A-11 每地址采样 50/总量 5000 硬顶。前端 12/15——B-1 回显 maxConcurrentTasks+空体提交二次确认；B-2/3/4 错误反馈、行级 pending、300ms 防抖（复用 useDebounce）；B-13 批量确认流程抽 batchActions.tsx 单按钮直达。B-10（着色双实现合并）/B-11（编辑乐观锁，涉后端契约）/B-15（CodeBlock 色，需设计拍板）记录暂缓。
- 验证：admin-api jest 254 套件 4250 例全绿（dispatch-secrets-injection mock 补 QB 链后修复）；admin-web vitest 179 文件 1369 例全绿；双端 tsc 零错误；lint:i18n 通过。

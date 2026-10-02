# 功能点审计台账（2026-10-02 起）

> 编排式逐域审计：每轮 ≤2 个 subagent 并行排查，审完即派修复，本地验证后进下一轮。
> 修复与审计产出均落工作区，**等用户确认后统一提交**（沿用既有纪律：只推 develop）。

## 功能点清单（审计顺序）

| 轮次 | 域 | 范围 | 审计 | 修复 | 状态 |
|---|---|---|---|---|---|
| R1 | executor 域（admin-api） | executor module 全量 + 未提交 RBAC 下放改动 | R1-A | R1-fix | ✅ 完成（2026-10-02） |
| R1 | admin-web Executor UI | ExecutorList/Detail/Wizard/Packages + api/executors.ts | R1-B | R1-fix | ✅ 完成（2026-10-02） |
| R2 | metrics 域 | metrics module + scraper guard + 告警规则 + Dashboard 消费 | R2-A | R2-fix-A | ✅ 完成（2026-10-02） |
| R2 | task/scheduler 域 | task module + block-strategy 闸门 + scheduler/cron/依赖/retry | R2-B | R2-fix-B | ✅ 完成（2026-10-02） |
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

### R2（2026-10-02，审计完成 → 修复中）

- R2-A metrics 域 10 条：A-1 P1 直方图桶渲染成边际值违反累计不变量（prometheus-metrics.service.ts:345）；A-2 P2 maintenance skip 未渲染进 Prometheus；A-3 P2 HA 双副本单 static target 抓取口径（需先验证 Prometheus static target DNS 展开行为）；A-4 P2 Dashboard SSE error 帧黑洞+停轮询致无限陈旧；A-5 P3 抓取令牌越权读失败详情/执行器地址；A-6 P3 日期口径三端时区错位（暂缓，需时区政策拍板）；A-7 P3 抓取超时与 render 同步 IO；A-8 P3 告警守卫三盲区（暂缓）；A-9 P3 help 文案与 alerts.yml 漂移；A-10 P3 趋势丢 TIMEOUT 终态。
- R2-B task/scheduler 域 13 条：B-1 P1 misfire 阈值对 cron 恒 2min，长周期 cron 每 tick 误判/FIRE_ONCE 补偿致高频触发（scheduler.service.ts:468）；B-2 P2 rollbackToVersion 不重排调度器；B-3 P2 SUCCESS 回调依赖扇出全表扫；B-4 P2 互斥唤醒 sweep take:200 饿死；B-5 P2 block 闸门 TOCTOU 并发穿透；B-6 P2 依赖链任务误入 misfire 补偿绕过依赖检查；B-7 P2 WAITING 可被执行器终态回调写坏；B-8 P2 维护窗口逐分钟 Intl 扫描 CPU 热点；B-9 P3 params 体积门仅 webhook 面；B-10 P3 task_versions 无界+23505 裸 500（23505 捕获修，保留策略暂缓）；B-11 P3 暂停任务在途排队仍被唤醒派发；B-12 P3 读面无项目隔离（暂缓，随 ADR-013）；B-13 P3 OFFSET 深翻页（暂缓，keyset 重构另立项）。
- 处置：R2-fix-A（A-1/2/3/4/5/7/9/10）+ R2-fix-B（B-1/2/3/4/5/6/7/8/9/10 部分/11）并行派发。
- **R2 修复完成（2026-10-02）**：metrics 8/8——A-1 直方图改累计直写+中间桶断言锚定；A-3 查证结论：Prometheus static_configs 不做 DNS 展开（每抓取轮询解析到任一副本 IP），改 dns_sd_configs(type A)+relabel 补 service 标签，随 scale 自动伸缩；A-4 hook 经 events:{error} 接住降级帧→按失败段 refetch+「数据延迟」角标（useSyncExternalStore 独立暴露，不破坏 useExecutorLive 复用）；A-5 抓取令牌收窄为仅 GET /api/metrics。task/scheduler 11/11——B-1 misfire 阈值按 cron 周期推导（estimateCronPeriodMs+TTL 缓存）+FIRE_ONCE 补偿前落点校验双保险；B-3 依赖扇出改值投影表达式 GIN 索引（迁移 1790000000053，CONCURRENTLY）+@> 包含下推，迁移 spec 钉死索引/谓词对齐；B-4 唤醒 sweep keyset 分页（200×10 轮上限）；B-5 触发路径 per-(taskId+params) 5s Redis 门锁（fail-open，占用 409 同 discard 语义）；B-6 misfire 补偿前补依赖闸（dependency-gate.util 与 TaskService.checkDependencies 单一出处）+skipped 指标；B-7 终态回调守卫扩至 PENDING/WAITING 且未派发；B-8 维护窗口判定模块级有界缓存（键含分钟戳，DST 天然失效）；B-9 params 64KB 门统一三入口（params-size.constraint）；B-10 版本唯一冲突降级 warn；B-11 唤醒/claim 前 ACTIVE 闸（豁免 FAILED 保重试）。
- 暂缓记录：A-6 时区三端口径（需时区政策拍板）、A-8 告警守卫盲区扩展、B-12 读面项目隔离（随 ADR-013）、B-13 keyset 分页重构、B-10 版本保留策略。
- 验证：admin-api jest 259 套件 4314 例全绿；admin-web vitest 179 文件 1375 例全绿（含新增 use-metrics-stream 14 例）；双端 tsc 零错误；swagger:export + gen:api-types 已再生成，response-schema 守卫通过（61/218 无倒退）。

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
| R3 | auth/users/RBAC/项目域 | auth/api-keys/users/project + ADR-013 | R3-A | R3-fix-A | ✅ 完成（2026-10-02） |
| R3 | SOP/Agent 协作域 | sop/agent/agent-collab 模块 + AgentSessionsPage/SopsPage | R3-B | R3-fix-B | ✅ 完成（2026-10-02） |
| R4 | application/deployment/package 域 | application + AppDeploymentPage | R4-A | R4-fix-A | ✅ 完成（2026-10-02） |
| R4 | registry 域 | registry / registry-npm / registry-pypi + RegistryPage | R4-B | R4-fix-B | ✅ 完成（2026-10-02） |
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

### R3（2026-10-02，审计完成 → 修复中）

- R3-A auth/users/RBAC/项目域 14 条：A-1 P1 改密后 refresh 链不断（refreshToken 不比对 sessionVersion）；A-2 P1 jwt.strategy validate 丢 sid→revoke-others 反杀当前设备；A-3 P1 OIDC username 撞名自动绑定可接管 admin；A-4 P2 多标签页 refresh 互踢（localStorage 不同步）；A-5 P2 auth-cookie.util 死代码假安心；A-6 P2 API-Key 主体绕过 owner scope；A-7 P2 自改 email 撞唯一索引裸 500；A-8 P2 删用户不清理 project_members；A-9 P3 API Key 无配额；A-10 P3 已吊销 refresh 行滞留 30 天；A-11 P3 JWT 无 clockTolerance；A-12 P3 权限热路径零缓存（暂缓）；A-13 P3 普通用户无自助改密 UI；A-14 P3 task:trigger scope 前端不可达。
- R3-B SOP/Agent 协作域 14 条：B-1 P1 ingestClarification 无归属校验（跨执行器澄清注入+成本放大）；B-2 P1 boundary 对缺 resourceIdParam 放行，sop_get slug 绕过会话 scope；B-3 P1 sop_reply_clarification resourceKind=none 可越权改任意 SOP 并发版；B-4 P2 usage 数值模板拼 SQL（注入面）；B-5 P2 poll 丢 resendAssignments 数组形态；B-6 P2 stalled 僵尸态无复活路径；B-7 P2 clarificationRound 读改写无 CAS；B-8 P2 resume 允许 running 会话双跑；B-9 P2 媒体上传无 multer limits；B-10 P2 会话域 steps/tool_calls 无 retention；B-11 P2 poll 500ms tick N+1；B-12 P2 需审批工具闭环缺失（暂缓，feature 级）；B-13 P3 交付复核退回通道不存在（暂缓）；B-14 P3 前端两页无自动刷新+详情 N+1。
- 处置：R3-fix-A（A-1..11、13、14）+ R3-fix-B（B-1..11、14 部分）并行派发；A-12、B-11 全量、B-12、B-13 暂缓记录。
- **R3 修复完成（2026-10-02）**：auth 侧 12/13——A-1 refreshToken 比对 sessionVersion（无 ver 存量令牌兼容放行，失配断链）；A-2 validate 回填 sid+接线 spec（revoke-others 保留当前会话）；A-3 OIDC 自动绑定收紧为「非 ADMIN+email_verified+email 一致」，ADMIN 仅预置 oidcSub；A-4 前端 refresh 前重读 localStorage+storage 事件跨 tab 同步；A-5 auth-cookie.util 死代码删除（F-06 文档漂移位置已列报告）；A-6 assertCanOperate 归一 principalId（id??userId，API-Key 不再旁路 owner scope，JWT 行为逐字节不变）；A-7 email 预检 409；A-8 删用户同事务清理 project_members；A-9 API Key 每用户 20 把上限（ConfigService 可覆盖）；A-10 吊销行 7 天清理（LeaderGate 代表性用例断言 1→2 同步更新）；A-11 clockTolerance 30s；A-13 SecuritySettings 自助改密表单；A-14 task:trigger 勾选透传。SOP/Agent 侧 12/12——B-1 澄清归属断言+dupe 限定 assignmentId；B-2 闸门对缺 resourceIdParam 判 DENY+slug 先解析再过闸；B-3 sop_reply_clarification 执行体入口校验会话归属；B-4 token 计数 Number 收敛防注入；B-5 resendAssignments 原样透传；B-6 stalled 复活路径；B-7 clarificationRound CAS（胜者才落行）；B-8 resume 拒 running+markRunning CAS+前端 resumable 排除；B-9 媒体上传 multer limits 对齐 100MB；B-10 会话域 retention cron（steps 90d/tool_calls 按 tier 30/180d，3 个可选 env 未入 Joi 走缺省回退，env-drift 守卫通过）；B-11 澄清游标下沉 SQL（最小步）；B-14 两页 15s 轮询+失焦暂停+amendedBodyMarkdown 域。
- 暂缓记录：A-12 权限热路径缓存、B-11 payload 合并与 tick 放宽、B-12 审批闭环（feature 级）、B-13 复核退回通道。
- 验证：admin-api jest 264 套件 4389 例全绿；admin-web vitest 184 文件 1394 例全绿；双端 tsc 零错误；env-drift 通过（199 键）；swagger:export + gen:api-types 再生成（users currentPassword 入契约）。

### R4（2026-10-02，审计完成 → 修复中）

- R4-A application/部署域 12 条：A-1 P1 卡死扫描误杀审批待办行（PENDING 复用挂审批位，5min 阈值强标 FAILED）；A-2 P1 pull 部署 10min 判 FAILED vs 命令 TTL 30min 不共刻度→槽位释放重复部署+心跳复活 FAILED 行；A-3 P2 redeploy 行复用 TOCTOU→乐观锁裸 500；A-4 P2 回滚/升级 entrypoint 被 startCommand 快照优先级吞掉；A-5 P2 应用删除不校验在途部署→孤儿进程+审批行静默级联；A-6 P2 getReleases 全量无界拉取；A-7 P2 同版本号重复上传钉旧包 URL+历史 zip 孤儿；A-8 P2 前端灰度被拒谎报成功（不读 ok/blockedReason）；A-9 P3 卡死扫描对未命中 id 误标快照；A-10 P3 全局审批待办有端点无 UI 入口（暂缓）；A-11 P3 部署 DTO 无尺寸闸；A-12 P3 applications findAll 无分页（暂缓）。
- R4-B registry 域 11 条：B-1 P1 RegistryPage 安装命令指向 ${origin}/pypi/ 与 /npm/，两份 nginx 均无对应 location→200+index.html 静默失败；B-2 P2 compose ${VAR:-default} 使「置空回落官方源」契约失效；B-3 P2 列表代理吞上游错成空 200，前端 UI-16 错误态永不触发；B-4 P2 registry-pypi 无删除端点+索引双遍历；B-5 P2 getPypiPackage 坏契约潜伏代码；B-6 P3 413 在 body 收完后才生效；B-7 P3 multer memory storage 并发内存峰值（暂缓）；B-8 P3 accept 与后端白名单不一致；B-9 P3 索引锚点不解码 HTML 实体；B-10 P3 上游 409 压成 502；B-11 P3 npm auth token 无缓存。
- 处置：R4-fix-A（A-1..9、A-11）+ R4-fix-B（B-1..6、B-8..11）并行派发；A-10、A-12、B-7 暂缓记录。
- **R4 修复完成（2026-10-02）**：application 侧 10/11——A-1 审批待办三层排除（Raw 谓词+JS 防御+批量 UPDATE andWhere）；A-2 pull 豁免复用 statusMessage 前缀 commandId+行龄<cmdTtl 同刻度，心跳 UPDATE 加 In(deploying,upgrading,running) 守卫（含 UPGRADING 因升级全程保持该态、心跳是唯一出口）；A-4 选升级/回滚链同步改写 startCommand（前端确有按部署自定义入口，不反转载荷优先级）；A-6 分页流式聚合（页 1000/上限 5000）替代 SQL GROUP BY 保持响应形状；A-7 同号重传就地更新快照+无引用才 best-effort unlink（checksum/size 列缺记录）。registry 侧 10/11——B-1 选反代（registry 宿主端口 loopback-only，${origin} 是唯一局域网可达入口；补 /pypi/+/npm/+/packages/ 三个剥前缀块，PyPI 锚点是绝对路径 /packages 需同代）；B-2 compose ${VAR-default} 三族键+文档三方同步；B-4 registry-pypi 补 DELETE /admin/packages/{name}+索引单次遍历（ETag 逐字节不变）；B-6 ASGI Content-Length 预检中间件。
- 暂缓记录：A-10 全局审批收件箱 UI、A-12 applications 分页、A-7 版本快照 checksum/size 列、B-7 multer 内存存储并发峰值、B-1 已知边界（verdaccio 上游包 tarball URL 子路径前缀需 url_prefix）。
- 验证：admin-api 全量 4431 例全绿；admin-web 185 文件 1397 例；registry-pypi pytest 126 例；双端 tsc 零错误；compose-sandbox/env-drift/registry-npm selftest 全过。

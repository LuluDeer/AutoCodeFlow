# AutoCodeFlow Agent Handoff

> 跨会话交接文档：新会话从这里恢复。
> 状态以代码与 `docs/optimization-notes.md` 为准，文档可能滞后。

更新时间：2026-09-11（**第七轮：在途产物收口 + ARCH-25 + FEAT-19-B + UI-16-B，主会话主导 + 三路只读侦察子代理**；本轮 12 commit：fe1badb→301ba11。此前第六轮提交前状态校正：NF-04 后端完成、admin-web 半场已实现待验收；UI-09 旧表格半场与当前 Dashboard/ExecutionDetail 移动适配代码/测试分开记录，真实 375px 浏览器验收未完成；QA-05 保持 claimed/未完成容量验收；ARCH-31 保持 documented/blocked。此前 2026-09-08：win 侧接棒会话首轮 DEP-04 部署审批流全栈 done——approvalRequired 应用级开关+第二人规则审批三动作；BUG-03/BUG-11 复核销账；九套件接手基线全绿 admin-api 2037 · admin-web 480；随后主会话建 H2 长期计划 docs/DEVELOPMENT-PLAN-2026-09H2.md——上期 105 任务约 86 done/31 收编，新增 41 任务点注册入 PLAN-CLAIMS「H2 新任务段」，排期 17~26 轮）
当前分支：`develop`

## 状态快照

- **任务认领板：`docs/PLAN-CLAIMS.md`（多会话并行认领唯一事实源，开工前必读；含 2026-09-08 起的「H2 新任务段」41 任务点 + 「迁移时间戳分配表」常设段）；长期计划：`docs/DEVELOPMENT-PLAN-2026-09H2.md`（H2 版，2026-09-08 建账）；上期计划：`docs/DEVELOPMENT-PLAN-2026-09.md`（销账台账用）**
- **本轮（2026-09-11 第七轮：在途产物收口 + 三项新交付，主会话）**：
  - **在途 44 文件分组入库（第六轮子代理遗留，零丢失）**：按任务切成 7 个干净 commit——① `fe1badb` QA-05 压测脚本场景化改造 + 容量边界白皮书（load-test 重写为可编排场景，selftest 26 组过）；② `c01f477` ARCH-31 outbox DB lease/row claim + 矩阵文档同步；③ `710fbbc` UI-13 desktop renderer 抽 CSS 变量 + 新增 renderer.selftest.mjs（根 `test:desktop` 串联）；④ `204e78b` NF-04 亲和约束在模板预填/抽取链路闭环；⑤ `7787821` Query 推广第二阶段——api 层统一 AbortSignal + `tasksApi.listAll` 分页聚合（pageSize 上限 100、并发窗口 6、响应一致性校验、取消后不启下一窗口）+ 四页换装；⑥ `bacd209` UI-09 页头超长任务名溢出与窄屏工具条换行；⑦ `421d0eb` claims/计划状态校正。分组时踩坑：**首次 `git add` + `commit` 把索引里此前已暂存的 admin-web 文件误带入 desktop commit**，已 `git reset HEAD~3` 后按路径精确重做（内容零丢失）——**提交前必须 `git status --short` 确认索引干净**。
  - **`91535cf` FEAT-19-B：outbox 终态落独立死信表（接手子代理在途半成品）**：新实体 `EventOutboxDeadLetter` + 迁移 `1790000000013`（outboxId 唯一 + FK ON DELETE CASCADE）；终态路径事务化——事务内先写死信、再条件 finalize（leaseToken/leaseUntil 守卫），`affected≠1` 抛 `StaleOutboxOwnerError` 整体回滚，源行保持可重试；outbound 派发器 `parkDeadLetter` 返回持久化结果并聚合 `deadLetterPersistenceFailures`，outbox **死信未可靠落库时绝不回写 dispatchedAt**（否则订阅死信 API 查不到 = 事件永久丢失）。迁移结构 spec 5 例 + outbox 用例同步；`docs/PLAN-CLAIMS.md` 分配表已登记 1790000000013（check-migrations 58 项过）。
  - **`cc68083` ARCH-25：任务 runtime 注册表**：新 `modules/runtime`（types 协议 / builtin-runtimes 三项 / registry service / @Global module），app.module 接入（唯一改动点）；`TaskRuntime` 枚举与 DTO `@IsEnum` **零变更** → 零迁移、零 openapi 影响；注册表为描述层（未知 runtime `get()` 返回 null，fail-open；重复注册须显式 override）；6 例单测含「枚举值 ↔ 注册表键」一致性与 deno 示例注册；`docs/development.md` 增「任务 runtime 注册表」节。
  - **`bc7dd1d` UI-16-B 第一批：页内错误态补齐**：盘点 19 个 page 文件，发现 UI-16 行标 done 属信息滞后（仅覆盖 audit + Registry 两页），仍有 10+ 页 toast-only；本批补 **TaskListPage**（query error → StateError + 重试 refetch）与 **AppDeploymentPage**（fetchAll 失败置 loadError → StateError；失败态不再叠加「该应用尚未部署」空态），新增 `ui16-state-error` 5 例行为断言。缩水如实：写操作失败仍走 toast、首屏 PageSkeleton 归 UI-08 遗留；剩余页清单已写入 claims（TaskDetail/NotificationSettings/UserManagement/ExecutorPackages/ApplicationList/TaskForm(在途避让)/ExecutorInstallWizard/Executions/Login）。
  - **事故与纪律**：子代理（code-explorer 侦察岗）**越权实时写代码**，致 `outbox-dispatcher.service.ts` 缺 import、4 个 jest 套件编译红；已广播 + 定向制止、shutdown 违规成员、主会话接手补全。**教训：子代理即「只读」也必须显式禁止写入，并在广播后核查文件 mtime**；另 `task-form-ui06` 一条用例在全量并发下 5s 窗超时（单跑绿），按既有纪律显式放宽至 15s（断言不变）。
  - **基线（本轮收尾）**：admin-api **2253/2253**（上一轮 2193 起，含 +54 在途 +6 本轮新例）· admin-web **605/605** + `tsc -b` 绿 · check-migrations 58 项绿 · desktop renderer selftest / load-test selftest / demo-seed selftest 全过。
  - **`89108cf` FEAT-19-B 收尾（接手子代理最后一批微调）**：outbox 行「已 settled」判定把 `persistenceFailures === 0` 提升为前置必要条件（原与 `targetCount` 并列，死信持久化失败时仍可能被判为已投递）；实体/派发器/迁移注释统一到 `event_outbox_dead_letters` + 迁移 `1790000000013`；admin-api **2263/2263**（141 套件）。
  - **在途（下轮接手先看这里）**：**UI-12 无障碍第一阶段由 scout-002 异步实施中**，限定足迹=`apps/admin-web/src/layouts/MainLayout.tsx`、`src/components/CommandPalette.tsx`、新增 `src/__tests__/a11y-focus.test.tsx`（零新增依赖、手写行为断言）。接手时先 `git status` + 跑 `cd apps/admin-web && npx vitest run src/__tests__/a11y-focus.test.tsx` 与 `npx tsc -b` 验收，再登记 claims（UI-12 行现为 claimed/006，需改 Owner 与 hash）。若工作区只剩这两个文件改动而测试文件缺失，说明子代理中断，需补齐测试后入库。
  - **下轮建议**：① UI-16-B 第二批（TaskDetail/NotificationSettings/UserManagement/ExecutorPackages，避让在途页）；② UI-09 真实 375px 浏览器验收（半场未销账）；③ QA-05 真实容量验收（脚本与白皮书已就绪，缺真实压测数据）；④ AUTH-02（依赖 AUTH-01 拍板）；⑤ e2e 例 23/24（QA-01）。
- **本轮（2026-09-10 第四轮 Wave2：三路子代理 + ECO-04 发布演练，主会话）**：
  - **api-types-drift 二次复发修复（61abdfa）**：NF-04（7494289）把 executorAffinityTags/executorAntiAffinityTags 加入 `CreateTaskDto`，却未重跑 canonical 导出器（test/openapi-export.e2e-spec.ts）与 admin-web `gen:api-types`，致 openapi.json 落后源码 → drift job 又红（与上轮双写方根因同源，教训=改 DTO 必重导出）。修复=经 Jest 导出路径（唯一写入方）重导出 openapi.json（+14 行两字段）+ gen:api-types 同步生成物（+4 行）；**二次导出幂等验证通过**（无二次漂移）。push 后 CI run **34493150403 全 48 jobs 绿，0 失败**——**develop 近期首次整轮绿**。PLAN-CLAIMS NF-04 行已补 61abdfa + 协作注记。
  - **CI 修复链（develop push 连红根治）：api-types-drift 双红根因=openapi.json 双写入方（Jest e2e spec vs ts-node 脚本）md5 不一致——裁定 Jest 路径为 canonical writer，swagger:export 委托 e2e spec（a47e395）；nest build rootDir 回归（scripts/ 目录入编译面致 dist/src/main.js）→ tsconfig.build.json 排除（同 commit）；chromium 安装 flake（runner 自带 google-chrome apt 源 Hash Sum mismatch，deb822 格式 .sources 文件）→ 安装前禁源（63903ff+ab18c8c）；e2e 例 4/8/9/10 ReferenceError: API is not defined（page.evaluate 回调浏览器侧无 Node 作用域 API）→ addInitScript 注入 window.__E2E_API__ + evaluate 内 18 处改引用（a32486f+09b9506）；红线例 32/33/34/35/38/39 契约对齐（POST 默认 201 非 200/pending-inbox 是 GET/webhook @Public DTO 先行 400+签名缺失统一 401/订阅建读是登录面非 ADMIN 面/死信重放陌生 id 404 防枚举）（ede0093..067812a）。**e2e-full 现仅剩例 23/24**（UI-06 后 executorId 残留清理回归，QA-01 挂跟踪待真机复现）。
  - **Wave2 三路子代理交付**：001=FEAT-16（GET /executions/stream SSE+useExecutionsStream+ExecutionsPage 事件驱动）+FEAT-17（queries.ts 扩 11 hooks 八面换装，保留面如实声明）；003=UI-09 旧半场（三页表格响应式+MainLayout off-canvas 抽屉+8 例，3351eb9）；002=P0-3（docs-site GitHub Pages 发布管道+base 路径）+DOC-09（sync-check 七面机检+selftest 14/14，存量 4 项 drift 人工裁定同步）。当前工作区另有 UI-09 Dashboard/ExecutionDetail 移动适配代码与测试，但真实 375px 浏览器验收尚未完成，不能据此销账。3351eb9+0826b5d。
  - **ECO-04 v1.1.0 发布演练全链 done**：develop→main 大合并（414 commit 零冲突）→ release-please 首跑 Release PR #1（三包 lockstep 1.0.1→1.1.0）→ 合并 → tag 重推触发 release.yml → **waiting=environment release 审批闸门（需用户在 Actions UI 批准）**。运维注记：Actions 权限已开（write+PR approve）；Pages 已 API 启用；**docs-site 已上线 https://luludeer.github.io/AutoCodeFlow/**（1.1.0）；lockfile name 债登记（node-sdk lock 内部旧名 @autoflow/sdk，publish 不受影响）。
  - **基线**：admin-api **2193/2193** · admin-web **554/554** · docs-site build+sync-check 七面绿 · e2e-full 41/43（23/24 挂跟踪）。
  - **待用户动作**：①GitHub Actions UI 批准 release environment（v1.1.0 三包发布）；②Settings→Pages 已 API 代启（无需动作）。
  - **2a85b13 销账后 CI 补记（QEMU 抖动）**：2a85b13 为 docs-only（仅 AGENT_HANDOFF.md + docs/PLAN-CLAIMS.md，apps/executor-node 零改动），push 触发 CI run **34494055815** 时 docker-multiarch-build (executor-node) 在 build-push-action（linux/amd64,linux/arm64）步骤卡死 >13min（基线该 job ~2min，同 run 前一次全绿 run 34493150403 同 job 15:03:43→15:05:39），判定为 infra 抖动非代码问题（构建输入与 61abdfa 全绿态逐字节一致）。处置：cancel 该 run → `gh run rerun --failed` 重跑该 job（新 job 102954957370）→ 16:26:00→16:28:05 成功 2min05s。**run 34494055815 现全绿。**
  - **ARCH-31 多实例兼容矩阵 documented/blocked（盘点轮；outbox lease/dead-letter follow-up 已落地）**：`docs/ARCH-MULTI-INSTANCE-MATRIX.md` 已完成 15 项进程内单例状态矩阵、风险分级（🟢/🟡/🔴）、逐项失效路径、outbox 行级 claim / silence Redis 化方案评估与真机双实例验证清单 5 条；这仅代表盘点/评估完成，不代表多实例整体实现完成。结论：调度链（Redis Leader + DB 条件 claim）已多实例安全；outbox lease/dead-letter 代码已落地（`1790000000013` `CreateEventOutboxDeadLetters` 属于 FEAT-19-B/ARCH-31 follow-up），但真实 PostgreSQL 迁移执行、多实例锁竞争/事务隔离仍 pending；🔴 高 = 通知静默/渠道配置（无持久化）/灰度批次（单写者）/本地文件系统；🟡 中 = 执行器令牌缓存逐实例 TTL、8 个未接 Leader 门禁 @Cron。未完成项按 silence（跨实例读穿/Redis 同步）、channel config（共享持久化/Redis）、rollout（批次状态与心跳跨实例协调）拆分，outbox 保留真实 PostgreSQL 双实例竞争验证；真机双实例验证留验；PLAN-CLAIMS ARCH-31 行保持 documented/blocked，勿标 done。
- **上轮（2026-09-10 NF-02 直落，主会话）**：
  - `03e23d1` **NF-02 执行编排 UI done**：TaskFormPage 上游依赖多选（纯逻辑层 task-dependencies.ts，空集显式 null 对齐 N28）+ DAG「触发整条链」按钮 + dashboard-ui04 时间炸弹测试修复（固定日期滚出 7 天窗实爆，改相对日期）；admin-web **538/538**（527 只增 +11）。
  - 缩水声明：fail-fast 失败分支策略未做（需后端新列+迁移+调度语义变更，见 claims 板备注）。
- **上轮（2026-09-09 第三轮 Wave1 验收收口，主会话）**：
  - **Wave1 四路员工子代理交付验收入库**：AUTH-01 多租户 Project 第一批（ff0e644，迁移 1790000000007~009，2137→2176 只增 +39）/ ARCH-24 读写分离（7210e3b+e5db222）/ DSK-02+03 Linux 打包+自动更新（c4a0fbc）/ ARCH-23 导出管道（1bd4d1c+00ef578）。
  - `1bd4d1c` **EventSubscriptionModule DI 解析期环根治**（AUTH-01 加模块改变 DI 求值序暴露的挂死）：两派发器改 ModuleRef 运行时懒取（构造器互注入+useFactory 别名=解析期环，@Optional 拦不住「解析中」）；同 commit 附 ARCH-23 导出脚本/e2e spec + multer/hono audit 抬升。
  - `00ef578` **ARCH-23 收口**：ci.yml api-types-drift job（重导出+重生成双 git diff 闸）+ admin-web openapi-typescript 生成入口；openapi.json（138 paths）与 api-types.ts（7052 行）生成物入库（.gitignore 反转）。
  - `53d95b3` mcp-server lockfile 同步（hono 4.13.7 override 生效）。
  - **注记**：c4a0fbc message 声称的 desktop-linux-bundle CI job 实际未随 commit 入库，00ef578 补交。
  - **基线（收口复跑）**：admin-api **2185/2185** · admin-web **527/527** · 双端 tsc 绿 · 导出两次 md5 一致（字节级幂等）。
  - **留验**：ARCH-23 drift job CI 首验；AUTH-01 Project 二批（角色细化=AUTH-02）；DSK-02 Ubuntu 真机构建；FEAT-19 outbox 补投真机外发；FEAT-19/ARCH-31 真实 PostgreSQL 双实例 lease/row claim 锁竞争与事务隔离验证；P0-2 审批双人真机。
- **上轮（2026-09-09 接手第二轮：两波 20+ 任务清偿，接手会话）**：
  - **主会话直落 4 件**：`3bbe177` ARCH-29 迁移时间戳分配表建账（47 迁移回填归属）+ `scripts/check-migrations.mjs` 撞号/漏登校验（selftest 11 例）+ CI check-migrations job + PR 检查清单改指分配表（分配规则=在盘最大+1）；`ba04183`/`9b1e59c` 两波认领登记；`d528978` QA-08 CI 月度迁移演练（schedule 每月 1 日，主套件旁路，typeorm --check 漂移检查 + revert→重跑 down 路径）；`32ee795` DOC-07 operator 升级 runbook（operations.md：前置检查/步骤判据/回滚/已知坑）。
  - **Wave1（5 路并行，9 任务 done）**：FEAT-18 KILLED 终态事件（ef55581）+ FEAT-19 webhook at-least-once outbox（迁移 1790000000003，e34b018+ab23cee，Symbol 令牌解 DI 成环）；FEAT-13 保存为模板（baa91b1）+ FEAT-14 /releases 版本追溯 Tab（2f49ea7）+ FEAT-15 事件订阅 UI（d450a36）；NF-06 MCP retry_execution/deploy_app（9e76802，侦察坐实 4 处 brief 与真实契约偏差按实落地）+ NF-07 CLI executor rotate/offline（11b349e）；SEC-NEW-3 py 补注册链（85bca38，真实现）+ QA-11 strict warnings（a2aa9f6，filterwarnings=error 不缩水，顺修 2 例 flaky）；P0-1 安全红线 e2e 14 例三 describe（7bf0e24，SSRF/RBAC/审批第二人规则，CI 首验）。FEAT-19 后续迁移 `1790000000012` lease 与 `1790000000013` `CreateEventOutboxDeadLetters`（属于 FEAT-19-B/ARCH-31 follow-up）已落盘并登记 ARCH-29；outbox lease/dead-letter 代码已落地，但真实 PostgreSQL 迁移执行、多实例锁竞争/事务隔离仍 pending；未虚构 commit hash。
  - **Wave2（5 路并行，11 任务 done）**：FEAT-20 部署 triggerType/operator 落库（迁移 1790000000004，f640832）+ NF-01 api_keys.scopes 词表 task:trigger（迁移 1790000000005，b92c39c）；UI-15 mutation 反馈一致性 19 处收口（3eec70c）+ UI-16 StateError 补齐（6019529）；SEC-09 限流三档分域（3fc5359）+ SEC-10 审计防篡改 append-only 触发器+验证工具（迁移 1790000000006，2a44927，真机验证过）；NF-05 飞书渠道含官方加签（4a256f5）+ ARCH-30 AI 分析服务化 AiAnalysisService+指标（f573109）；P0-4 ADR-012 safeStorage 拍板（e6b9ff0）+ SEC-NEW-1 desktop token 加密 enc:ss:（8fe9fe1）+ BUG-12 desktop IPC 复审双修（49a75bb）。
  - `5b26982` api-reference 契约面汇总核对（FEAT-20 列值优先/NF-01 词表段/execution.killed/feishu 渠道）。
  - **收尾基线（全量复跑）**：admin-api **2136/2136**（2037 起 +99）· admin-web **527/527**（480 起 +47）· executor-node 266 · executor-python **234**（strict 0 warning）· mcp-server **98** · acf-cli **82** · node-sdk 61 · autoflow-sdk 110 · registry-pypi 68 · desktop selftest 双套件绿。双端 tsc/build/lint 绿，51 迁移 check-migrations 绿（下一号 1790000000007）。
  - **留验/后续**：P0-1 e2e 14 例 CI 首验；outbox 补投/kill 事件真机外发；desktop Linux keyring 真机加密往返；审批第二人规则双人真机（P0-2）；ECO-04 v1.1.0 需用户 secrets；SEC-10 dead_letters 对 outbox 路径仅日志级（FK 哨兵拒收，需表结构演进）。

- **本轮（2026-09-08 H2 计划建账，主会话）**：
  - 盘点确认 DEP-04 前端（374bbe8）与销账（403b0ad）已全部入库，工作区干净，九套件基线 2037/480/266/222/74/84/61/110/68 有效。
  - 新建 `docs/DEVELOPMENT-PLAN-2026-09H2.md`：P0 清偿 4 项（QA-09 收尾/DEP-04 真机/docs-site host/safeStorage 拍板）+ 遗留 bug 池 7 项 + 功能补漏 FEAT-13~20 + 新功能 NF-01~08 + 架构 ARCH-28~31 + UI-15~16 + QA-11~12 + SEC-10 + DOC-07~09，共 41 个新任务点全部注册入 PLAN-CLAIMS「H2 新任务段」。
  - 里程碑建议：轮 17 清偿速通 → 18 发布+生态（ECO-04 v1.1.0，需用户配 NPM_TOKEN/PYPI_API_TOKEN secrets）→ 19 部署域收口（outbox/KILLED 事件）→ 20 安全纵深（safeStorage/审计防篡改）→ 21 压测容量 → 22 架构二期 → 23 平台扩展 → 24 体验三期 → 25 隔离预研（AUTH-01 拍板）→ 26 i18n。

- **本轮（2026-09-08 win 侧接棒首轮，接手会话）**：
  - `21842fe` 接手建户：PLAN-CLAIMS 复核销账 BUG-03（QA-02 coverage 91.6/81.34/78.47/90.6 超额覆盖目标 75/65/62/75）+ BUG-11（W-16 已 95363aa 闭环，assets 图标含 ico/icns 均在库）；认领 DEP-04（迁移 1790000000002 独占声明）。
  - `abc6e82` **DEP-04 后端 done**：迁移 1790000000002（app_deployments.approvalStatus/approvalMeta 可空列 + applications.approvalRequired 默认 false + 审批待办部分索引，幂等）；deploy() 门控——approvalRequired 应用冻结为 pending_approval 行（approvalMeta 记提交者）**零派发**，待审批行复用 status=pending 天然受 in-flight 部分唯一索引约束（零索引重建）；approve/reject/cancel 三动作——原子认领（UPDATE WHERE approvalStatus='pending_approval'，并发双审批仅首者生效 409）+ 第二人规则（审批者≠提交者 403，脏数据放行+warn）+ reject/cancel 落 FAILED 离开 in-flight + reason≤200；upgrade/stop 对待审批行 409；审计 deployment.approve/reject/cancel（AuditModule 接线 @Optional fail-open）；GET /app-deployments?approvalStatus= 过滤 + /approvals/pending 待办。+24 例（迁移结构 7+service 15+controller 适配 2），admin-api **2037/2037**（2015 只增）tsc 绿。
  - `374bbe8` **DEP-04 前端+docs done**：AppDeploymentPage 待审批行操作区（批准/拒绝 reason Modal/提交者本人撤回 Popconfirm）+ 状态列审批徽标 + 审批待办 Alert + 第二人规则前端禁用 + deploy pending_approval 响应提示；ApplicationListPage 编辑表单「部署审批」Switch；api/applications.ts approve/reject/cancel 封装 + approvalStatus/approvalMeta/approvalRequired 类型；+8 例 UI 测试，admin-web **480/480**（472 只增）+ tsc -b/build/lint 0 errors 绿；api-reference.md 审批流契约（端点/状态机/第二人规则/原子认领/索引约束）。
  - 接手基线复跑（win 侧 80+ 轮后全量盘点）：admin-api 2015→2037 · admin-web 472→480 · executor-node 266 · executor-python 222 · acf-cli 74 · mcp-server 84 · node-sdk 61 · autoflow-sdk 110 · registry-pypi 68 全绿。
  - 交接更正：executor-python unraisable 修复已由 win 侧 86bf0ef 实施（跨会话记忆中"已定位未实施"过期）。
  - 真机轮留验：双人账号第二人规则全链（提交者被禁用审批+他人放行后真机派发）；单管理员团队开启审批后只能 cancel 自撤（文档已写明）。
- 上一轮（2026-09-08 第十六轮·批 subagent-T 终验收）：- 最新提交：见 `git log -1`
- **任务认领板：`docs/PLAN-CLAIMS.md`（多会话并行认领唯一事实源，开工前必读）；中期计划：`docs/DEVELOPMENT-PLAN-2026-09.md`（105 任务分级排期）**
- 本轮（2026-09-08 第十六轮·批 subagent-T 终验收，主会话）：
  - `e9bddce` **AUTH-05 交接项（001）单台高危二次确认 done**：ExecutorDetailPage 轮换改受控 Modal（Alert 警示+Descriptions 影响清单+reason 可选 TextArea ≤200 超限拦截）；新增删除执行器入口同形态；reason 链路与 admin-api 契约逐字对齐（空 reason 不发 body）；+10 例。
  - `409d9f3` **QA-03（001）两阶段整体 done（+94 例，297→472）**：第二阶段四页深交互 38 例——TaskList（筛选组合/批量触发暂停/克隆链路 -copy-XXXX 命名）、ApplicationDetail（回滚三重门控/同步任务门控）、Registry（上传拦截/npm Tab/空态兜底）、ApiKeys（scope 三级/payload 精确/吊销门控——吊销失败无 onError 如实断言未虚报）。
  - `c98e870` **ARCH-20（002）核查补齐 done（非纯销账）**：16 子项目逐包盘点，发现真实缺口并修复——typecheck:web 坏链（引用不存在 script）改 tsc -b；六子项目零测试/typecheck 入口补齐（node-sdk/py-libs×4/desktop）；Makefile 三目标委托根 scripts 消除双清单漂移；typecheck:all 7 环逐条真跑验证（node-sdk 61/lib-http 18/lib-ai 25/lib-notify 18/lib-db 8/desktop selftest）。未引 pnpm-workspace（no-hoisting 保持）。
  - `939bfc0` **SEC-07（002）容器最小权限 done**：复核双 executor Dockerfile non-root 已在位（Q-08/Q-09 先例）；增量=compose 双执行器 cap_drop ALL+no-new-privileges（回滚纪律注释）；deployment.md 容器安全段（真机三步清单）。本机无 docker，build/容器内验证如实留真机轮。
  - `cc5aff8` **SEC-08（002）CSP/HSTS 收紧 done**：部署形态侦察（admin-web 独立 nginx 不同 origin+生产 Swagger 已关+纯 JSON 响应）→ 生产 CSP 收至最严（default-src/script-src 'self'/frame-ancestors none/upgrade-insecure-requests，逐指令理由注记）+HSTS 半年+Referrer-Policy same-origin；开发/测试宽松分支；security-headers.util 工厂+supertest 7 例。
  - 主会话顺手修：s3-log-storage MAX_LOG_BYTES 例第三参显式 15s（coverage 全量并发偶发超 5s 默认窗，188 行先例同形态）并补提交（002 批内未入库）。
- **总终验收基线（全绿，复跑确认）**：admin-api **2015/2015**（接手时 1370）+ tsc ✓ + coverage 90.5/78.3/82.2/91.4 门槛卡点 · admin-web **472/472**（接手时 160）+ build/tsc ✓ · executor-node 266 · executor-python 222 · docs-site build ✓ · 全端 typecheck:all ✓
- **第十六轮子代理批次收官总账（批 C~T 共 16 批，001/002/003/004 轮换参与；截至 2026-09-08 收官时）**：P0+P1 全清；P2 清至仅剩真机硬依赖族（AUTH-01/02 需产品拍板、DSK 全族+BUG-07/11/12/17~20 真机、DEP-04 依赖 AUTH-03 已解锁可下轮、ECO-04 需 secrets）；P3 清至 UI-09/10/12/13、QA-10、SEC-NEW-1、SEC-09（可选）。累计新增测试 **+1150 例**，全部「行为断言」纪律（两处 flaky 治理为显式超时放宽非弱断言）。此处 UI-13「清至」是该历史快照中的未完成清单，不代表当前状态或已验收。
- 本轮（2026-09-08 第十六轮·批 subagent-S 终验收，主会话）：
  - `c98e870`+`939bfc0`+`cc5aff8` **ARCH-20 复核补齐 + SEC-07 + SEC-08（002）done**：ARCH-20=16 子项目逐包核查补三类缺口（admin-web typecheck:web 坏链改 tsc -b / node-sdk+desktop+4 py 库六项 test/typecheck 入口新增 / typecheck:all 补至 7 环全绿）+ Makefile test/lint/typecheck 收敛委托根 scripts，逐条真跑验证（node-sdk 61/61、py 库 18/25/18/8、desktop selftest 过）；SEC-07=executor Dockerfile non-root 复核已在位（Q-08/Q-09），增量=compose 双 executor `cap_drop:[ALL]`+`no-new-privileges` + deployment.md「容器安全」段（本机无 docker，build 与任务可跑留真机轮）；SEC-08=helmet 配置工厂 `buildHelmetOptions`（生产 CSP 显式指令集逐条理由/HSTS 半年+子域不 preload/Referrer-Policy same-origin；开发宽松保留），CSP 依据=部署形态侦察（admin-web 独立 nginx 不同源、admin-api 纯 JSON、生产 Swagger 已关、SSE 同源 connect-src self 覆盖）；+7 例 supertest 端到端。
  - `29e4092`（含 DOC-05 四文件入库，归属记档）→ `d7e1c72` **UI-11（001）命令面板动作区 done**：侦察坐实 FEAT-09 面板已存在（四分组搜索/防抖/键盘导航全齐），本任务=增强 §6.3 动作区——置顶「操作」分组（新建任务/创建应用，零输入键盘直达）+ 任务行内动作（触发/暂停/恢复按状态出键，actingKey 互斥+跳详情+失败 toast）+ isAdmin 门控（admin-only 项隐藏）；MainLayout 零改动（触发体验四项核对全既有）。admin-web **424/424**（基线 418，+6）+ build/tsc ✓。
  - `29e4092`+`77a4d94` **DOC-05+06（002）done**：DOC-05=release-please 选型裁定（中文 conventional commits 原生解析/三包 lockstep 无需 per-package/node+py 混合仓支持，胜 changesets）——衔接设计 release.yml 本体零改动（Release PR→合并→tag v*→恰好触发既有 release.yml，include-component-in-tag:false 保证裸 tag 匹配）；release-please.yml（actionlint 过）+config+manifest 基线 1.0.1+development.md DOC-05 节。DOC-06=tutorials/ 四篇（模板两方式/私服依赖含 publish 链/多执行器含 loadScore 公式与 canary 契约/告警值班含静默 API+HMAC+runbook 双通路+停 Redis 演练），字段逐条对照源码；docs-site「教程」分组接入，build 死链检查绿。
- **主会话终验收基线（全绿）**：admin-web **424/424**（基线 418，+6）+ build ✓ · admin-api 2008（本批未触）· docs-site build 死链绿
- 真机轮留验：release-please 首跑观察点（三包 version 收敛人工核对/__version__ extra-files 同步/GITHUB_TOKEN tag 级联触发，development.md 已固化）· ⌘K 双主题走查
- 交接项累计：执行器页单台 rotate-token/删除二次确认 Modal+reason 输入（API 已就绪）
- 本轮（2026-09-08 第十六轮·批 subagent-R 终验收，主会话）：
  - `bbb7e8a` **UI-07（001）执行器列表/详情升级 done**：卡片/表格双视图（ViewToggle localStorage 记忆，表格视图与 QA-03 的 13 例锚定断言零改动）；分组聚合 CheckableTag 条（扁平 string[] 数据下裁定树形过度）；批量 reload-config/rotate-token（ADMIN 门控对齐 W2；轮换高危二次确认 Modal 列受影响台+重注册警示+新 token 集中展示）；实时状态复用 UI-14 的 /metrics/stream executors 段（**零 admin-api 改动**——侦察确认流字段全量覆盖列表需求，不做逐执行器心跳端点；useExecutorLive 字段级覆盖轮询值+断线轮询兜底+连接状态点）。+22 例，admin-web 415（后随 002 增至 418）。
  - `28c6c7d` **AUTH-05（002）审计增强 done**：AuditQueryDto 加 resourceId 精确筛选（Project 未做缩水声明，AUTH-01 前置）+ admin-web audit 页资源 ID 输入框；CSV 导出 ADMIN 已有核实零改动；**高危操作 reason API 侧**——rotate-token/DELETE executor 接受可选 reason（≤200）经 auditHighRisk 写审计（@Optional 注入 best-effort）；前端二次确认 Modal 留交接（001/UI-07 同期在碰该页）。
  - `a1355a5` **FEAT-10（002）通知模板变量 done**：渠道 config 可选 titleTemplate/contentTemplate（**零迁移**——走既有 ChannelConfigStore 写穿，1790000000002 未占用）；renderTemplate 纯函数（单 pass 阻断递归注入/未知变量保留原文/8KB 截断标记/fail-open 回退默认）；sendToChannels 按渠道渲染独立副本，无模板完全旁路；通知设置页可折叠模板面板。render-template 矩阵 14 例。
  - 顺手治理：s3-log-storage coverage 全量偶发 5s 超时显式放宽 15s（5cd6ac0，flaky 治理断言不变）。
- **主会话终验收基线（全绿）**：admin-api **2008/2008**（基线 1975，+33）+ tsc ✓ + coverage 90.51/78.31/82.16/91.44 门槛卡点 · admin-web **418/418**（基线 390，+28）+ build ✓
- 真机轮留验：模板渲染钉钉/企业微信真机外发 · SSE 3s 实时刷新断线重连 · 批量轮换重注册全链
- 交接项：执行器页 rotate-token/删除的**前端二次确认 Modal + reason 输入**（API 已就绪，UI-07 已做批量版 Modal，单台版留下批）
- 本轮（2026-09-08 第十六轮·批 subagent-Q 终验收，主会话）：
  - `48e4909` **UI-06（001）任务表单重构 done（高危区行为等价）**：Steps 四步 → 单页五分区+左侧 Anchor 锚点条+sticky 提交条，全部 Form.Item 同时挂载（分步挂载缺陷土壤消除，第八轮 missing 兜底保留为双保险改锚点滚动）；Glue 区保持原 step3 语义（创建前锁定占位/成功后解锁）；payload 纯函数链逐字节复用、templateId 预填/N28 null 语义不变。TriggerPreview 零新依赖（trigger-preview.ts 手写 5 字段 cron 解析与 admin-api cronMatchesAt 同口径+逐分钟墙钟推算+Intl timezone，18 例）；pinning/broadcast 输入期互斥禁用（N17 前置）。admin-web **390/390**（基线 362，+28）+ build/tsc/eslint ✓；既有 40 例表单测试适配后语义不变全绿。
  - `f53b095`+`d61b364` **ECO-05（002）SDK 文档站 done**：packages/docs-site 独立 VitePress 1.6.4（中文七页导航：快速开始/双 SDK 参考/能力矩阵/示例库/契约/发布），内容全部从 ECO-01 矩阵/sdk-guide/双 README/examples 重组零臆造（版本号写现值 1.0.1）；lockfile 隔离（独立 package-lock，7 个运行时包零触碰）；CI 尾部轻量 docs-site-build job（死链 fail build 即验收，不部署 host 留后）；构建 5.93s 绿+preview 冒烟全 200。站点为镜像视图纪律：SDK 内容先改源头文档再同步（写进两侧 README）。
- **主会话终验收基线（全绿）**：admin-web **390/390**（基线 362，+28）+ build ✓ · docs-site build ✓ · admin-api 1975（本批未触）
- 真机轮留验：锚点条滚动高亮/表单全链真浏览器走查（UI-06）· 文档站 host 决策（GitHub Pages 或其他）
- 本轮（2026-09-08 第十六轮·批 subagent-P 终验收，主会话）：
  - `7a9188f`+`68e4170` **DEP-02+03（001）灰度发布+健康检查+自动回滚 done**：upgrade-all 新可选 `rollout:{strategy:canary|all,percentage}`（缺省 all 逐字节零破坏）；canary 分台 ceil(N×p%)≥1 台 → 心跳 RUNNING 确认 → admin-api 侧主动探测（manifest healthCheck 声明 path/port/interval/failThreshold，**执行器零改动零 bundle 重打**；buildProbeUrl 纯函数六形态含 IPv6）；批次失败五路判定 → 已升级台自动 rollbackDeploymentToPrevious 落 rolled_back；rolloutState/rolloutMeta 新列（迁移 1790000000001）；重启 sweep 把 pending/probing 标 failed（不自动恢复，契约写明）。+32 例，admin-api **1975/1975**（基线 1936）。admin-web rolloutState Tag 避让 002 留下批。
  - `abc9c91`+`872c4e8`+`957577b` **ARCH-26+UI-14 第一阶段（002）done**：TanStack Query 基础设施（QueryClient 全局 staleTime 30s/retry 2/focus 不重取；queries.ts 七 hooks+queryKey 工厂+invalidateExecutionData）+ 两示范页改造（DashboardPage/ExecutionsPage，发现并合并 trend 双请求）；新端点 GET /metrics/stream（3s 快照推 summary/executors/scheduler/errors，fail-open 降级帧+15s ping+独立 MetricsStreamSlotService 32 槽+runtime gauge）；Dashboard 接 useMetricsStream（setQueryData 直写 query 缓存与轮询互斥共存，断线 3s×2^n 封顶 30s 重连）。零迁移零 lockfile 变更。+7 api/+9 web 专项。全站推广留后续。
- **主会话终验收基线（全绿）**：admin-api **1975/1975**（基线 1936，+39）+ tsc ✓ + coverage 90.44/78.06/82.07/91.4 门槛卡点 · admin-web **362/362**（基线 353，+9）+ build ✓
- 事故记档：001 自留 WIP 曾误入 stash 又 pop 回滚，零丢失完整恢复并立即入库——**「add 后立即 commit」纪律同样适用于子代理自留 WIP**。
- 真机轮留验：三执行器灰度 1+2+坏包自动回滚实测 · Dashboard 双 Tab SSE 槽位与重连观察 · rolloutState Tag（admin-web 避让遗留）
- 本轮（2026-09-08 第十六轮·批 subagent-O 终验收，主会话）：
  - `abc9c91` **ARCH-26（002）TanStack Query 渐进引入第一阶段 done**：新 `src/api/queries.ts` 薄层 hooks（queryKey 工厂 metrics/executions/scheduler 层级前缀 + useMetricsSummary/useMetricsTrend/useExecutorStats/useRecentFailures/useSchedulerMetrics/useSchedulerStats/useExecutionsList 七 hooks + invalidateExecutionData 写后失效辅助）+ main.tsx 全局默认（staleTime 30s 对齐原轮询节奏/retry 2/refetchOnWindowFocus:false 防多 Tab 聚焦请求风暴）；示范页两处=DashboardPage（六个 useRequest 轮询换 query hooks，trend 主卡与 sparkline 卡 days=7 同 key 合并请求消除重复拉取）+ ExecutionsPage（筛选参数进 queryKey，15s 轮询可见性 useEffect 兜底，kill 后 invalidate 列表+Dashboard 缓存）。**引依赖说明**：@tanstack/react-query 5.102.8 初始提交即入 lockfile（UserManagementPage 早已消费 useQuery），本批零 lockfile 变更。其余 13 处 ahooks 页面原样（渐进路线全站推广留后续）。
  - `872c4e8`+`957577b`+`c9a9d3d` **UI-14（002）实时推送统一第一阶段 done（Dashboard 汇总流示范）**：admin-api 新 GET /metrics/stream（@Res() 直写+@SkipTimeout 同 logs/stream 先例；3s 快照 {summary,executors,scheduler,errors} 复用既有三读面零新 SQL；查询失败 fail-open 降级 null 段+error 帧不终止流；空闲 15s ": ping" 保活）+ 新 MetricsStreamSlotService 独立槽位（默认 32 METRICS_STREAM_MAX_GLOBAL，与日志流分开计数——容量画像不同；占用在写 SSE 头前超限真 503；释放幂等+finally 双保险）+ runtime gauge autoflow_metrics_streams_active/limit（BUG-05 同款通道渲染侧零改动）+ configuration metricsStream 节三 env + jwt.strategy SSE 白名单增 /metrics/stream（?access_token= 回退）；admin-web 新 useMetricsStream（EventSource 常驻+快照 setQueryData 直写 queryClient 缓存与 ARCH-26 hooks 共享——SSE 活跃轮询空转、断线 hooks 节奏兜底；退避重连 3s×2^n 封顶 30s；卸载清理）+ Dashboard 页头三态连接状态点。
  - **测试基线**：admin-api +7 例（隔离验证 **1943/1943**，基线 1936 只增不减）+ coverage 90.14/77.84/81.83/91.08 过 75/69/84/84 门槛 · admin-web +9 专项+24 既有适配（**362/362**，基线 353 只增不减）+ tsc -b/build ✓。协作注记：001/DEP-02+03 application 足迹零触碰（其 rollout spec 在途红例经其 7a9188f 自行入库，stash 隔离坐实非我引入）。
- 本轮（2026-09-08 第十六轮·批 subagent-O 终验收，主会话）：
  - `d8158a2`+`e24e49c`+`aa2b2f1` **AUTH-03（002）限权 API Key done**：api_keys 表（迁移 1790000000000：sha256 唯一索引/前 8 位 prefix 展示/明文仅创建响应回显一次/revokedAt 软删+expiresAt）+ `/api-keys` CRUD 全 JWT（非本人 404）；JwtAuthGuard 保持唯一 APP_GUARD，@Optional facade 注入分流 `acf_` 前缀（JWT 是 base64 段不可能命中）——api-keys/auth/users 前缀对 API Key 一律 401（防被窃 Key 自管提权）；scope 三级矩阵（readonly 只读/trigger +POST trigger/manage 全量，403 带所需 scope 提示）；lastUsedAt 每分钟节流防写放大；审计 create/revoke/used/auth_failure 全 fail-open。admin-web settings 末位 API Keys Tab（一次性明文回显+复制+吊销「立即 401」警示）。admin-api **1936/1936**（+51）· admin-web 303（+6）。TOTP/会话回归零破坏。
  - `04c82ee`+`816531d` **SEC-06（001）供应链 done**：npm-audit 升 moderate+矩阵补 executor-desktop 漏审；GHSA 豁免机制（重试后 JSON 提取比对，minio 链上游未解核实（逐版查证），豁免仅 2 条复查 2026-10-01，未登记新漏洞 fail-closed）；lockfile-integrity job（7 包 npm ci --dry-run）；gitleaks 双保险（pre-commit rev 固定+.gitleaks.toml allowlist 逐条理由+CI action 全量历史）。**意外收获：executor-desktop electron-builder→fast-uri 链 1 high 顺手修复**（04c82ee），audit low 归零。
  - `5b15134`~`85877c6` **QA-03 第一阶段（001）done +56 例**：五个零覆盖高频页补核心交互（ExecutionsPage 13/ExecutorListPage 13/UserManagement 9/AuditLog 8/NotificationSettings 7）；类型与 unhandled rejection 收口。admin-web **353/353**（基线 297）。第二阶段：ApplicationDetail/Registry/TaskList 深交互+API Keys 页测试。
- **主会话终验收基线（全绿）**：admin-api **1936/1936** + tsc ✓ + coverage 卡点 · admin-web **353/353**（44 套件）+ build/tsc ✓
- 真机轮留验：API Key 触发→吊销→立即 401 全链实测 · gitleaks CI 首跑 allowlist 验证
- 本轮（2026-09-08 第十六轮·批 subagent-N 压轴，主会话总终验收）：
  - `dff036d`+`5141962`+`e207958`+`54f9f6a`+`4228097` **OBS-01（002）OpenTelemetry 分布式追踪 done（可观测性 2.0 收官）**：架构裁定=只用 @opentelemetry/api 1.9.1 + 自实现极薄 span 管理（不引 sdk-*/exporter——无 collector 部署，span 树以进程内结构化日志承载，升级路径写入 deployment.md，埋点零改动可挂 SDK）；span 树 task.trigger→enqueue→dispatch.http→callback.receive 四站点父子串联；**W3C traceparent 全链贯穿**：traceId 落 task_executions（迁移 1789900000003 可空+索引）→ dispatch 头透传 → 执行器读头注入任务 env AUTOFLOW_TRACE_ID（用户参数不可覆盖）→ 六 pushCallback 站点（node）/_run_and_callback 双路径（py）回传 → admin 关联；OTEL_ENABLED 默认 false 零开销零行为变化，畸形头 fail-open；compose jaeger profile 预置（未启用零资源）；admin-web 详情页 traceId 展示+复制。缩水如实：执行器侧不做完整 span 树（预案内）、py kill 链路无 trace 关联（registry 先移除，注记）、Jaeger URL 不硬编码（纪律）。
  - **主会话五端总终验收（全绿）**：admin-api **1884/1884**（+38）+ tsc ✓ + coverage 门槛卡点 · admin-web **297/297**（+4）+ build ✓ · executor-node **266/266**（+4，bundle 无漂移）· executor-python **222/222**（+5）
- **第十六轮子代理批次总账（批 C~N，主会话派工+统一验收）**：P1 任务全部清零——CORE-01~06 · OBS-01~05 · SEC-01~05 · UI-01~05+08 · QA-02 两阶段 · ECO-01/03 · FEAT-01/02/04/05/06/08~12 · W2 · BUG-01/02/05~10/13~16 · QA-04/06 · ARCH-20/21/22/27 · DOC-01/02/03/04 全 done。测试基线从接手时 admin-api 1370/admin-web 160 增长到 **admin-api 1884 · admin-web 297 · executor-node 266 · executor-python 222**（全端 tsc/build/coverage 卡点绿）。剩余 unclaimed 53 项：P2/P3 长尾（AUTH 多租户族/DSK 桌面族/DEP-02~04/BUG 真机族/ECO-04~05/OBS-02 配套等）——多数依赖真机环境或产品拍板（AUTH-01 scope/DSK 真机/OBS-01 真机链路验证），按计划书 §10 编排滚入后续轮次。
- 本轮（2026-09-08 第十六轮·批 subagent-M 终验收，主会话）：
  - `907af4f`+`a3012ca` **DOC-01（002）PR 检查项机制 done**：新建 .github/PULL_REQUEST_TEMPLATE.md——「API 变更？」四查（端点+api-reference 同批/breaking 影响面+四客户端包同批/env 三处登记引 W-22 前科/迁移时间戳防撞号）+「平台影响？」（bundle 同 commit/真机矩阵）+交付纪律段；development.md「PR 前检查清单」节交叉引用。
  - `726e2ec` **CORE-03 收尾「保存为模板」UI done（整体闭环）**：TaskDetailPage 页头 extra → Modal（名称/描述/分类）→ task-template-extract.ts 白名单抽取 17 项 CreateTaskDto 真实声明字段（priority 双形态归一，排除 id/status/glue 等非配置键）→ POST /task-templates；+7 例，admin-web **293/293**（基线 286）。glue 任务模板化留后续评估。
  - `2fa4888`+`1dab41e` **SEC-05（001）上传面纵深 done**：侦察结论=解压主战场在 executor-node deploy.ts（admin-api 不解压），**双侧同规则双闸**——zip-guard 双端同语义零依赖（EOCD+中央目录解析：解压比 ≤100/条目 ≤10000/单文件 ≤1GiB/全包 ≤2GiB/嵌套探测 1 层/zip64 与 CD 篡改 fail-closed，九项 env 走 Joi）；clamd 可选钩子 CLAMD_ENABLED 默认 false，true 时 fail-closed（无 verdict ≠ 放行）。恶意样件集 12+ 例程序化构造全拒（42MiB 高比/条目洪泛/嵌套套娃/EICAR/截断/zip64）。executor-node bundle 同 commit 重打。admin-api **1846/1846**（+27）· executor-node **262/262**（+14）。缩水：update-package 未接线（本就不自动解压，文档注明）。
- 本轮（2026-09-08 第十六轮·压轴，002 子代理）：
  - `dff036d`+`5141962`+`e207958`+`54f9f6a`+`4228097` **OBS-01（002）OpenTelemetry 分布式追踪 done（第十六轮最后一项）**：**api-only 方案**（@opentelemetry/api 1.9.1，不引 sdk-*/exporter——无 collector 部署，span 树以 admin-api 进程内 `[trace]` 结构化日志承载，埋点按 OpenAPI 语义收敛，未来接 Jaeger/Tempo 只挂 SDK TracerProvider 埋点零改动）；OTEL_ENABLED **默认 false 零开销短路**；traceId 落库 `task_executions.traceId`（迁移 1789900000003 可空列+索引，幂等）；W3C traceparent 双向契约（dispatch 头透传→执行器 env `AUTOFLOW_TRACE_ID`（params 不可覆盖）→回调回传头→admin 解析关联）；执行详情页 traceId 展示+「复制 traceId」按钮（跳转 URL 留配置项不硬编码）；compose jaeger profile 预置（未启用零资源）；docs api-reference「Distributed Tracing」契约段+deployment「OTEL / Jaeger」段（架构论证+升级路径）。**缩水（如实）**：执行器侧不做完整 span 树（计划预案内）；py kill 路径 `_push_killed_callback` 不回传 traceparent（registry 条目先移除，文档注记）。+51 例（api 38/node 4/py 5/web 4）。**基线：admin-api 1884/1884**（1846 只增）+ coverage 90.64/78.58/82.15/91.6 过门槛 · **executor-node 266/266**（262 只增，bundle 同 commit 重打）· **executor-python 222/222**（217 只增）· **admin-web 297/297**（293 只增）+ build/tsc ✓。真机轮留验：OTEL_ENABLED=true 双执行器混布 + UI 复制 traceId 到真 Jaeger 检索。
- **主会话终验收基线（全绿）**：admin-api **1846/1846** + tsc ✓ + coverage 卡点 · admin-web **293/293** + build ✓ · executor-node **262/262**（bundle 无漂移）
- 真机轮留验：PR 模板真实渲染走查 · 存模板→模板页→建任务全链路 · clamd 容器联通+EICAR 端到端 · Windows Expand-Archive 恶意包拒绝
- 本轮（2026-09-08 第十六轮·批 subagent-L 终验收，主会话）：
  - `7ea1ddb`+`13b4c91` **ARCH-22（002）execution_log_lines 按日 RANGE 分区 done**：单迁移 1789900000002 三态守卫式（已分区幂等重入/存量普通表在线搬迁四步 RENAME→建父表（联合 PK (id,createdAt)——侦察坐实 id 无外部消费方零破坏）→INSERT SELECT 搬迁+setval 序列对齐→legacy 保留人工清理/新库直建+预建 9 日分区），中断自动续走；清理服务双路径=分区库 DETACH PARTITION+DROP（双安全闸：边界不可解析跳过+时钟回拨绝不 DETACH 未来分区）+legacy DELETE fallback；每日预建未来 7 天分区；LOG_PARTITION_ENABLED 默认 true（只影响清理路径不影响 schema）。测试为 SQL 结构断言（本机无 PG 约定，先例同形态），真机 DDL 语义+10× 时长如实留真机轮。+32 例，operations.md 运维段含演练/回滚步骤。
  - `0b98ec7`+`0902318`+`1f80433` **UI-08（001）三态标准化 done**：ErrorFallback 增强（Result+重试+复制错误信息 clipboard 降级）+新 StateError 页内错误块+PageSkeleton（table/cards 双形态）+PageFallback 骨架化；17 页三态盘点表入库，15 页接入（骨架屏替换裸 Spin、TaskTemplates/ApplicationList 两页 StateError 标杆）；**UI-03 低频 9 页 PageHeader 遗留清零**。缩水：toast-only 页 StateError 逐页补齐留后续（两页标杆模式已固化）。admin-web **286/286**（基线 278，+8）+ build/tsc ✓；被改页既有 23 例测试复核全绿。
- **主会话终验收基线（全绿）**：admin-api **1819/1819**（基线 1787，+32）+ tsc ✓ · admin-web **286/286**（基线 278，+8）+ build ✓
- 真机轮留验：ARCH-22 存量库升级演练（≥100 万行基线→migration:run→中断续跑→DETACH 时长对比→legacy 人工 DROP，步骤固化 operations.md）· UI-08 双主题骨架/错误块走查
- 本轮（2026-09-08 第十六轮·批 subagent-K 终验收，主会话）：
  - `50c648b`+`dfd73bf` **UI-05（001）执行详情页信息架构 done**：antd Tabs 四页签（日志默认/时间线·报告=ExecutionReportPanel 迁入/重试链/参数与产物=**ArtifactsList 单点接入闭环 FEAT-05 UI 半场**），Tab key 走 ?tab= searchParams 记忆；日志查看器加 300ms 防抖关键词搜索高亮（log-search.ts 纯函数+mark 双主题 ≥4.5:1，不改变文本流复制下载保真）；失败定位卡片（failure-runbook.ts 镜像 mcp FAILURE_RUNBOOK 十二类+runbook pre-wrap+跳时间线锚点+重新触发快捷）。**虚拟滚动缩水决策**：保持 fromLine/limit 服务端分页（limit 封顶 2000）+OBS-03 聚合渲染策略已是常数成本，不引 react-window（零 lockfile 变更），注记入板。admin-web **278/278**（基线 264，+14）+ build/tsc ✓；既有 log-level/sse/truncated-logs 三测试文件零改动全绿。
  - `11cd26e`+`807bc3e`+`457531a` **CORE-05+06（002 打包）done**：CORE-05 loadScore 新公式 `0.5×loadRatio+0.25×cpu+0.25×mem+0.1×longTaskPenalty`（executor-score.util 共享纯函数，前三项与旧实现逐字节一致零回归；估时查询失败降级不断调度）；tasks.estimatedDurationSec 可空列（迁移 1789900000001）+DTO 校验+saveVersion 快照纳入。CORE-06 缺口侦察=直方图/P99/prom series 均已存在零重做，真实缺口仅 Grafana——补 row 5 两面板（P99/均值 timeseries + 瞬时 stat）；per-task 直方图缩为全局（label 爆炸，预案内）。admin-api **1787/1787**（基线 1750，+37），coverage 90.65/78.69/81.49/91.64 门槛全过。
- **主会话终验收基线（全绿）**：admin-api **1787/1787** + tsc ✓ + coverage 卡点 · admin-web **278/278** + build ✓
- 真机轮留验：Tab 双主题+万行日志搜索体感（UI-05）· 双执行器长/短任务分布断言（CORE-05）· Grafana row5 数据面（CORE-06）
- 本轮（2026-09-08 第十六轮·批 subagent-J 终验收，主会话）：
  - `11721b1`+`568d480` **UI-04（001）Dashboard 重构五项 done**：KpiSparkline（7 天窗——后端日粒度下 24h 无意义，缩水声明）/FailureTopList（Top5 聚合+次数色阶+跳详情；失败率无分母不展示）/ExecutorHeatBars（CPU/内存双条 85/65 阈值色阶）/SchedulerLatencyCard（p99/avg/last 三数字，CORE-06 后端字段已存在纯前端呈现）/DashboardEmptyGuide（totalTasks===0 引导创建）。五新组件独立文件+纯函数伴生，theme tokens 双主题不破。admin-web **264/264**（基线 253，+11）+ build/tsc ✓。零迁移零 admin-api 改动。
  - `3b76a30`+`da0b4d1`+`cc17e38`+`af8e083` **QA-02 两阶段整体 done（002，branches 冲 75 达成）**：第二阶段 +63 例（executor dispatch/乐观锁/broadcast 全分支矩阵、task findAll/统计/SSE 槽位/回滚补偿、application 状态机与 spawnAsync 边角、notification 渠道分流/静默/silenceStore 写穿）；coverage 排除 bootstrap 面（main.ts/app.module/migrations 等 7 项逐条理由入库，分母口径变化已注记）；四指标 **91.6/81.34/78.47/90.6**（branches 75 达成超 3.47），门槛上调 **75/69/84/84**。零业务源码改动、零真 bug（+63 例直绿）。admin-api **1750/1750**（基线 1652，+98 两阶段合计）。
- **主会话终验收基线（全绿）**：admin-api **1750/1750** + tsc ✓ + coverage 门槛卡点 · admin-web **264/264** + build ✓
- 真机轮留验：Dashboard 双主题走查与五卡真数据渲染（UI-04）· coverage 新门槛 CI 首跑（QA-02）
- 本轮（2026-09-07 第十六轮·批 subagent-I 终验收，主会话）：
  - `167f886`+`7fce990` **UI-03（001）布局升级 done**：侧边栏六大分组 IA（概览/任务/执行/执行器/应用/系统，antd v6 受控 openKeys+onOpenChange，持久化 localStorage 含脏键回退），任意页面 ≤2 跳达成（IA 表留档）；Sider 折叠态持久化+测试锚点；PageHeader 标准组件（面包屑显式传参，tokens 只读复用）高频 8 页替换完成（低频 9 页留清单，props 化单点接入即可）。admin-web **253/253**（基线 239，+14）+ build/tsc ✓。
  - `f5e5594`+`d64b8c1` **QA-02 第一阶段（002）coverage 提升 done（超额）**：实测基线已高于计划书滞后的 68/58/56/69——本轮 +49 例定向补测（s3-log-storage 流式读边角/scheduler Leader 边角/部署状态机与 completed 事件载荷/心跳鉴权/task.controller 44 方法主链（新 spec）/event-subscription 七端点（新 spec）/config 脱敏矩阵（新 spec）），四指标 82.46/65.35/71.33/82.46→**83.98/69.29/73.07/83.32**，门槛同步上调 83/68/72/82（各留 ≥0.7 余量，CI 卡点通过）。零源码改动、零真 bug 发现（计划点名的心跳裁剪已有完整边界矩阵）。第二阶段建议：主攻 branches（73.07→75，缺口集中 executor.service/task.service/application.service/notification.service 大文件），main.ts 等 bootstrap 建议入排除名单。
- **主会话终验收基线（全绿）**：admin-api **1652/1652**（基线 1603，+49）+ tsc ✓ · admin-web **253/253**（基线 239，+14）+ build ✓
- 真机轮留验：分组折叠/折叠态双主题走查（UI-03）· coverage 门槛 CI 首跑观察（QA-02）
- 本轮（2026-09-07 第十六轮·批 subagent-H 终验收，主会话；**注意：003/004 子代理已删除，后续批次仅 001/002 可派**）：
  - `e54b092`+`76e86b4` **UI-01+UI-02（001，打包实施）设计系统令牌+明暗主题 done**：theme/tokens.ts 程序化镜像 MASTER.md（单一常量源，antd token 与 CSS 变量两处消费防漂移）+ index.css 变量注入（dark 面 #020617 OLED）+ ThemeProviders（darkAlgorithm + colorPrimary=#22C55E）+ zustand persist 三态主题 store（light/dark/system 跟随 matchMedia）+ MainLayout 头部三态循环按钮 + index.html 防 FOUC；字体 @fontsource/fira-code+fira-sans（lockfile +61 行最小变更）；双主题适配=壳层+Dashboard/执行器趋势图/SSE 日志区。admin-web **239/239**（基线 225，+14）。缩水如实：axe 未做（无浏览器环境，改对比度人工核算+高频页抽查，真机轮 Playwright+axe 补扫）；硬编码色值清缴面=壳层+4 高频页约 40 处，其余约 30 处散点留 UI-03~08 顺带。
  - `c962d7a`+`c57bc3e`+`b35ac85` **FEAT-07（002）Webhook 出站事件 done**：event-subscriptions 独占模块（10 文件 1509 行）+ 迁移 1789900000000 两表（订阅+死信）；CRUD+死信查看/replay（JWT：ADMIN 全量/普通用户自有+系统级；url 双层守卫=@IsUrl+assertSafeHttpUrl DNS 逐地址 SSRF 深校验+出站前复核；secret 服务端代生成一次性回显后恒脱敏）；OutboundEventDispatcher 按 ARCH-21 接入形态注册 bus 监听器（主链零改动），**签名与 applications 发版 webhook 逐字节一致**（X-Hub-Signature-256 sha256=hex(timestamp.rawBody) ±5min 窗，实测断言）+ maxRedirects=0；重试=进程内 3 次 1s/2s/4s 指数退避→终败落死信+replay（跨进程 outbox 不做，api-reference 如实声明重启丢在途窗口）。补两个发布点：executor.offline（三路 OFFLINE 翻转每台恰一次）+ deployment.completed（心跳终态落库后），均 @Optional+fail-open。+18 例，admin-api **1603/1603**（基线 1585）。
- **主会话终验收基线（全绿）**：admin-api **1603/1603**（基线 1585，+18）+ tsc ✓ · admin-web **239/239**（基线 225，+14）+ build ✓
- 真机轮留验：双主题全页走查+axe 补扫（UI-01/02）· 订阅真实端点收 execution.failed 验签+重试时序（FEAT-07）· ANTD v6 fontFamilyCode 消费验证
- 本轮（2026-09-07 第十六轮·批 subagent-G 终验收，主会话）：
  - `0b97477`+`cd4f0fb` **SEC-03（002）登录安全升级 done**：① TOTP 两步验证（用户级 opt-in）——totp.util 自实现 RFC 6238（HMAC-SHA1/6 位/30s/±1 步漂移，附录 B 六组官方参考向量测试全过），四端点 setup/enable/verify（@Public+限流+错码计入锁定）/disable（需密码或有效码防被窃 JWT 单独关 2FA）；login 契约写死 200+{totpRequired:true}，未启用用户零变化。② 会话管理——access token 增 sid 声明（=refresh jti），refresh_tokens 落 userAgent/ip，GET /auth/sessions（当前标记）/DELETE :id（属主校验）/revoke-others（无 sid fail-safe 吊销全部）。admin-web：登录二段式 + 设置末位「安全设置」Tab（otpauth 文本+secret 复制替代二维码——零新依赖，lockfile 零变更）。迁移 1789800000001。+69 例（api 57/web 12）。
  - `323b442`+`0933d72`+`de681b8` **ARCH-21（003）领域事件总线 done（红线达成）**：DomainEventBus（原生 EventEmitter 封装，不引依赖；emit fail-open；@Global+@Optional 零 spec 破坏）；handleCallback winner 分支终态后 emit execution.completed/failed；**task.service.ts 零 NotificationService import/注入**，notifyCallbackFailure+审计兜底整体迁入 ExecutionEventsListener（九参数语义逐行等价）。顺带闭合 OBS-02 AlertsController 缺 taskRepo provider 的启动级注入缺口（ADR-008 形态，spec 全 mock 掩盖）。ADR-011 记录事件契约；**有意语义变化：通知从回调响应前同步改为可能在途**（真机轮观察）。范围注记：processor AI+dispatch 失败通知直调保留（验收口径=task.service）；KILLED 未 emit（类型预留）；timeout 折叠进 failed（等价）。FEAT-07 铺路就绪（出站 webhook=注册 execution.* 监听器即可）。+28 例。
  - `7302328`+`114cc94`+`999d30b` **CORE-03（004，会话中断后替补接手收尾）任务模板与一键克隆 done**：后端 task_templates 实体+迁移 1789800000000（幂等 seed 5 官方模板，与 mcp TASK_TEMPLATES 同口径）+CRUD+instantiate 端点（POST /task-templates/:id/instantiate 承担 templateId 展开语义——避开 003 的 task.service 足迹）+config 走 CreateTaskDto 语义校验防脏模板，+30 例；前端 TaskTemplatesPage 模板页/路由/侧边栏菜单/TaskListPage 挂载点+TaskFormPage ?templateId= 预填（timeoutSeconds→timeout 桥接、失败降级空白表单），+16 例。「保存为自定义模板」UI 入口与模板市场 CORE-12 留后续。
- **主会话终验收基线（全绿）**：admin-api **1585/1585**（92 suites，基线 1483，+102）+ tsc ✓ · admin-web **225/225**（基线 197，+28）+ build ✓
- 真机轮留验：SEC-03 真实验证器绑定+错码锁定 · ARCH-21 失败告警异步派发到达观察 · CORE-03 模板页→使用→预填→提交全链
- ⚠️ 流程注记：004 子代理会话在本批中途中断（后端已提交、前端 4 文件半成品在工作区），由主会话指示后按侦察→盘点→续作模式接手完成——**子代理中断后其未提交产物留在共享工作区，接手者先 git status/PLAN-CLAIMS 交叉盘点再续作，勿重做勿覆盖**。
- 本轮（2026-09-07 第十六轮·批 003-G，员工 003 子代理会话——ARCH-21 领域事件总线）：
  - `323b442`+`0933d72`+docs **ARCH-21 done**：进程内 DomainEventBus（原生 EventEmitter 封装薄服务，不引 @nestjs/event-emitter；emit fail-open——监听器同步抛错/异步 reject 只记日志绝不冒泡主链；@Global 模块恒提供 + TaskService @Optional 注入零 spec 破坏）；handleCallback winner 分支终态 UPDATE 后 emit execution.completed/failed（emit 时机=旧通知直调点，「每个失败执行一次告警/每个终态一个事件」不变量保持，重复回调不重发）；**红线达成：task.service.ts 零 NotificationService import/注入**，notifyCallbackFailure+审计兜底整体迁入 notification 模块 ExecutionEventsListener（taskRepo 回查告警配置，九参数通知语义逐行等价）。顺带闭合 OBS-02 AlertsController 缺 taskRepo provider 的启动级注入缺口（forFeature([Task])）。ADR-011 载明事件契约与 FEAT-07 接入形态。**范围注记**：processor isLastAttempt 的 AI+通知直调保留（验收口径=task.service 解耦）；KILLED 未 emit（载荷类型预留）；execution.timeout 折叠进 execution.failed（status 区分，与旧语义等价）；依赖扇出不动。测试 +22 总线/监听器 + 6 主链改写（admin-api 1584 passed；唯一红=004 在途 task-template.migration.spec 非我足迹）。遗留：通知改异步派发为有意语义变化（ADR-011 后果段），真机轮观察失败告警到达；outbox/at-least-once 归 FEAT-07。
- 本轮（2026-09-07 第十六轮·批 subagent-F 终验收，主会话）：
  - `8301cff`+`2a169a5` **OBS-02（001）告警路由到通知渠道 done**：新端点 POST /api/alerts/webhook（@Public + HMAC-SHA256：时间戳 ±5min 窗+X-Hub-Signature-256 rawBody 常数时间比较，复用 applications 发版 webhook 先例；ALERT_WEBHOOK_SECRET 未配置 503 安全缺省，鉴权失败统一 401 防枚举）；Alertmanager v2 载荷纯函数映射（firing→error/全 resolved→info，两态都发，多告警合并，空载荷 400）；runbook 兑现=annotations.runbook_url 优先+labels.taskId 查 tasks.runbook 拼段（FEAT-11 消费点，零迁移）；外发走既有 sendAll，全渠道 skipped 502 供 Alertmanager 重试。+19 例，Alertmanager 侧加签反代部署件已在 observability README §3.5 文档化。
  - `e2574bd`+`029a987`+`0365803` **ECO-01（002）SDK 统一矩阵+官方示例 done（路线图 #10 收口）**：sdk-guide 23 项能力矩阵逐项对齐（每项源码证据路径）+5 条差异裁定（不收敛项写明理由）；补齐两个对等缺口——node ctx.reportSuccess/reportFailure（py 端孪生）+ py HttpClientError 可判别错误子类（零破坏）；官方示例 4 件（回调 py/node + 私服依赖 py/node，每件=入口+README+task.example.json，API 逐行核源，本地降级路径烟测过）。autoflow-sdk 110/110 · node-sdk 61/61。fromEnv 抛错 vs from_env 兜底的失败模式分歧留后续 breaking 拍板。
  - `3e982a6`+`c0c31b5` **DEP-01（004）/releases 统一资源 done**：GET /applications/:id/releases 只读聚合（版本×最近部署一屏追溯；无部署版本行也出现、synthetic 行归一历史数据；分页 50/上限 200；排序纯函数）；零迁移；operator 恒 null 带 operatorMissingReason 标注、triggerType 推导规则已知限制均如实文档化；旧端点保留过渡期 alias。+12 例。
- **主会话终验收基线（全绿）**：admin-api **1483/1483**（+31，基线 1452）+ tsc ✓ · autoflow-sdk **110** · node-sdk **61** · acf-cli 74 · mcp-server 84（本批未触，复跑确认）
- 真机轮留验：OBS-02 全链（Prometheus→Alertmanager→加签反代→/api/alerts/webhook→WECOM 5min 内）· ECO-01 四示例端到端（平台触发+私服真装+回调 token）· DEP-01 一屏追溯 · fromEnv 失败模式统一（breaking，双 SDK 同批）
- 本轮（2026-09-07 第十六轮·批 004-F，员工 004 子代理会话——DEP-01 /releases 统一资源）：
  - `3e982a6`+`c0c31b5` **DEP-01 done**：新只读聚合端点 `GET /applications/:id/releases`（一行=一次版本发布：版本号/包地址取 application_versions 快照当次值，deployedAt/deploymentStatus/deploymentCount/executorAddress/runMode 按 deployedVersion 聚合「最近一次」app_deployments；无部署版本行也出现；有部署无快照历史数据合成 synthetic 行；分页默认 50/上限 200 双重截断；排序=最近部署时刻降序，releaseSortTimestampMs 纯函数）。**零迁移**（纯读视图未占时间戳，1789700000000 仍归 002/ECO-01）。已知来源缺失如实标注：operator=createdBy 列恒 null（写入路径未填充+audit 不覆盖部署写面，行带 operatorMissingReason）；triggerType 按部署行状态面推导（upgrade 指纹/manual/unknown），落库化留后续 schema。旧端点 `/applications/:id/versions` 与 `GET /app-deployments` 原样保留为过渡期 alias（不删除不重定向）。测试 +12 例；admin-api **1483/1483**（+19 为 001/OBS-02 并行入库）+ tsc ✓。**移交/遗留**：admin-web ApplicationDetailPage 消费 releases 契约（docs/api-reference.md「Releases」段已文档化）；triggerType 持久化列；真机一屏追溯验收留真机轮。
- 本轮（2026-09-07 第十六轮·批 subagent-E 终验收，主会话）：
  - `5c0a7b5`+`2c0fe7e`+`221253e` **CORE-02（002）重试策略精细化 done**：① retryableErrors 表单化（retry-policy.ts 九类中文映射剔除 killed/stale_recovered，空集显式 null 的 N28 语义，后端本就绪零改动）；② retryDelay ±20% jitter（retry-backoff.util 纯函数随机源注入，四处 enqueue 边界注入数值方案：trigger/rollback/scheduler.enqueue/scheduleRetryAfterRecovery）；③ attempt 链可视化（retry-chain.ts 兄弟行 retryCount 拼装+间断截断，ExecutionDetailPage 重试链 Card+预算 Tag+下次重试近似时刻，手动提前重试指路既有 trigger）。零迁移（1789700000000 预留未用）。下次重试时间为近似值（BullMQ delayed 精确时刻不落库，精确值留后续）。
  - `dd88d0a`+`8088766`+`fb466d7` **OBS-04（001）执行报告消费+时间线 done**：新端点 GET /tasks/:id/executions/:execId/report 一次合并 task_executions 行+created→started→finished 三段时间线（与 DB 时间戳一致，与 mcp-server ECO-03 buildExecutionTimeline 同语义）+execution_reports 当日聚合行；reportRepo @Optional 注入零破坏；ExecutionDetailPage 挂 ExecutionReportPanel（Steps 时间线缺省「—」+AI 分析段+报告段存在才渲染）。缩水说明：execution_reports 无单执行级写入方（仅 MetricsService 日聚合懒生成），按计划预案降级为「时间线+AI 分析」主体，零 schema 变更。
  - `7a5c589`+`2571c2c` **FEAT-05 UI 半场（003）done**：新 api/artifacts.ts（blob+objectURL 下载，参照 executor-packages.download，直链会 401）+ ArtifactsList 组件（name/size/sha8/逐行 loading，空态不渲染）+ TaskDetailPage 产物段最小插入；ExecutionDetailPage 侧入口留待复用 <ArtifactsList execId={execution.id}/> 单点接入。
- **主会话终验收基线（全绿）**：admin-api **1452/1452**（74 suites，1434 基线 +18）+ tsc ✓ · admin-web **197/197**（165 基线 +32）+ build ✓ · executor-python 217 · executor-node 248（本批未触）
- 真机轮留验：CORE-02 retryableErrors 命中/不命中各一例+重试链 UI 断言 · OBS-04 report 端点真实数据渲染 · FEAT-05 artifacts 端到端一例（上传→列表→下载）
- ⚠️ 流程注记：002 为验证隔离两次 stash 001 在途文件（已原样归还）；001 docs commit 8088766 顺带入库 002 的 5 个新文件（内容逐字节一致，归属已注记）——**并行 hunk 隔离协作连续两轮实操可行，但 stash 交错与顺带入库仍是事故高发点，同文件强冲突任务仍应错峰认领**。
- 本轮（2026-09-07 第十六轮·批 subagent-D 终验收，主会话）：
  - `c24f61d`+`f62b776` **CORE-04（001）超时策略分级 done**：tasks.timeoutAction 三动作（kill 缺省 / kill_retry=超时终态后按既有重试预算 re-enqueue，triggerType=timeout_retry，预算耗尽退化 kill / notify_only=admin 不额外下发终止指令，告警仍由失败通知路径保证一次）+ timeoutWarnRatio（0-90 预警阈值，每执行至多一次 WARNING）；纯决策层 timeout-policy.util 两端共享；迁移 1789500000000 可空零破坏；版本快照纳入两字段；admin-web 表单 Radio+阈值/详情展示（序列化纯逻辑 pages/timeout-policy.ts，清空须发 null 的 N28 语义）
  - `d7e7c84`+`7bd9378`+`a0ae1b3` **SEC-02（002）任务 secrets 加密落库 done**：新增 tasks.secrets 独立 jsonb 列（方案 B——params 是普通运行参数且被列表/版本快照明文消费，整体加密伤审计面）；AES-256-GCM `enc:v1:` 自描述信封（嵌套逐叶加密+幂等）；SEC_SECRETS_KEY 未配置降级明文 warn 一次（零破坏升级，Joi/configuration/.env.example 已登记）；写路径全加密/读路径永久脱敏 ****** /dispatch 解密与 params 合并注入执行器 env（secrets 胜出、明文不二次入库、解密失败不裸派发）；迁移 1789500000001
  - `7e0c1c7`+`1b12073`+`c739024`+`ef0e7e6` **FEAT-05（004）执行产物通道后端+双执行器 done**（详见下方 004 批注）：artifacts 链路 admin-api/executor-python/executor-node 三半场全闭合，node bundle 同 commit 重打（重打幂等已验证）
  - **主会话终验收基线（全绿）**：admin-api **1434/1434**（73 suites，1370 基线 +64）+ tsc ✓ · executor-python **217/217** · executor-node **248/248**（bundle 无漂移）· admin-web **165/165** + build ✓（160 基线）
  - 移交：FEAT-05 admin-web UI 半场（产物列表+blob 下载，见 ef0e7e6/api-reference「Artifacts」）；真机轮留验=CORE-04 三动作各一例 + warn 接线（processor 持 warned 标记调 util）+ SEC-02 备份泄露演练
  - ⚠️ 流程注记：三子代理并行下迁移时间戳曾撞号（001/002 同选 1789500000000，migrations.spec 抓住后 002 改 1789500000001）——后续并行轮次建议认领时预分配迁移时间戳段；shared 文件（task.service.ts/create-task.dto.spec.ts/executor.service.spec.ts）hunk 隔离提交已实操验证可行但成本高，能避让尽量避让
- 本轮（2026-09-07 第十六轮·批 004，员工 004 子代理会话——FEAT-05 执行产物通道）：
  - `7e0c1c7` admin-api：迁移 `1789600000000-AddExecutionArtifacts`（task_executions.artifacts jsonb 可空列）+ 新 `modules/artifacts`（PUT 上传复用包上传通道 memoryStorage 100MB + 机器鉴权复用回调凭据形态；GET `/tasks/executions/:execId/artifacts[/:name]` JWT 守卫 + 裸文件名防路径穿越 + 流式；每日 TTL 清理搭车 LOG_RETENTION_DAYS，根目录 `LOG_ARTIFACT_DIR` 可覆盖）+ CallbackItemDto.artifacts 校验（≤20/裸名/sha256）+ handleCallback 非空清单落库（缺省不擦除）；admin-api 隔离 worktree **1389/1389** 全绿
  - `1b12073` executor-python：`artifacts.py` collect（`<workDir>/artifacts/` ≤20/≤100MB/跳过子目录·超限·非法名）+ httpx multipart PUT + `gather_artifacts_for_callback` 仅入成功项；execute.py 预建目录+注入 `AUTOFLOW_ARTIFACTS_DIR`+终态回调附清单（best-effort）；**217/217**
  - `c739024` executor-node：`src/artifacts.ts` 对等实现（global fetch+FormData/Blob）+ callback.ts CallbackRequest.artifacts + execute.ts prepare/runTask 接入；jest **248/248**；`resources/executor-node/index.js` **同 commit 重打**（本机验证改前空重打逐字节一致，CI bundle-drift 守卫安全）
  - 验收数据链路（截图→artifacts/→PUT→回调清单→task_executions.artifacts→JWT 下载）双执行器均闭合
  - **移交 admin-web（未做）**：执行/任务详情页新增「产物」列表（GET `/tasks/executions/:execId/artifacts`）+ 逐条下载（GET `.../artifacts/:name`，用 axios blob + objectURL，参照 executor-packages.ts 的 download 写法，因 JWT 仅从 Header 取）；api-reference.md「Artifacts」小节已文档化三端点
  - 注：本会话 shared 文件（app.module.ts / task.service.ts）严格 hunk 隔离提交，未卷入 001(CORE-04)/002(SEC-02) 在途半成品；工作区 executor.service.spec 红为 002 SecretsCryptoService 未 mock 所致，非我引入、未触碰
- 本轮（2026-09-07 第十六轮·批 001-C，员工 001 会话；详见认领板变更日志）：
  - `6297f21` **ECO-03**：MCP 工具面扩容 4 工具——get_execution_timeline（OBS-04 时间线+失败三联卡对齐 BUG-10 分类）/list_dead_letters（心跳 deadLetterCount 聚合）/create_task_from_template（5 官方模板，字段全走 CreateTaskDto 白名单）/get_scheduler_health（leader/queue/latency 四段重塑）；mcp-server **79/79**
  - `a00438b` **QA-07**：共享契约 fixture——`packages/contract-fixtures/contract.json` 单一事实源（envelope/passthrough/2xx 区间/错误体形态/knownHeuristicEdge+knownDivergence），四端消费同一向量（acf-cli 74 · mcp-server 84 · node-sdk 53 · autoflow-sdk 105）；审计副产两处修复：CLI detailFromData 空串 message 遮蔽 error 兜底；knownDivergence 留档 cli/mcp 宽松启发式 vs node/py-sdk 严格三键分歧（真实流量不受影响，待统一）
  - `9e93e22` **FEAT-11**：任务 runbook 字段——迁移 1789400000000（tasks.runbook 可空 text）+ DTO/实体 + 通知双路径透传（dispatch 失败/回调失败 notifyFailureWithConfig 增尾参）+ admin-web 表单 TextArea/详情展示条目（**OBS-02 告警 runbook 链接的前置已就位**）；admin-api **1370/68** · admin-web **160/160** + build ✓
  - 未竟移交：CORE-04（超时策略分级）/CORE-02（重试策略精细化）已侦察未开工（触达面：task.processor timeout 路径+DTO+admin-web 表单），无在途半成品；QA-09 e2e 套件化剩余仍归 main-A
- 测试基线（本会话收工时点，全绿）：
  - admin-api **1370/1370**（68 suites）· admin-web vitest **160/160** + build ✓
  - acf-cli **74/74** · mcp-server **84/84** · autocodeflow-node-sdk **53/53** · autoflow-sdk **105/105**
  - 全端 tsc ✓（admin-api/acf-cli/mcp-server/node-sdk 均复验）
- 本轮（2026-09-07 第十六轮·批一，main-A 会话；详见认领板变更日志）：
  - `84ff261` 计划+认领板入库；`f0c5f32` **W2 前端半场**——执行器管理写操作（编辑/配置热更/设置离线/轮换Token）非 admin 隐藏（API 半场 executor.controller.ts+rbac.spec.ts 在途归并行会话，其提交后 W2 整体闭环）
  - `313d203` **BUG-08/N41**：executor-node register 失败自愈——auth.ts setOnTokenAcquired 钩子 + maybeReRegister（已注册短路+in-flight 去重），token 恢复后补注册回填富元数据（admin 同 startupId register 幂等不轮换已复核）；bundle 同 commit 重打；executor-node **235/235**
  - `780dbcf` **BUG-09/QA8**：python 停机树杀后 live 回调收口——await_background_tasks_after_kill 窗口 + _run_and_callback CancelledError 落盘守卫 + lifespan 顺序钉死（杀树→flush→drain）；executor-python **201/201**
  - `0a4d5c0` **QA-04**：docs/VERIFY-MATRIX.md 真机矩阵 checklist（平台/拓扑/按变更类型必跑）
  - `0409000` **FEAT-03**：孤儿组件 ExecutionCompare（零引用）拆出 ExecutionCompareModal 接回 ExecutionsPage 多选对比；admin-web 93/93
  - 复核销账：**BUG-02**（sweep 重试预算第十四轮已实现+测试）；**BUG-01/N51**（401 重签重试 R11 已实现，收口改进在 executor.controller.ts 被并行会话占用→blocked，且该重试路径无专项测试）
  - `3caabb4` **BUG-05**：SSE 活跃流 gauge（autoflow_sse_streams_active/limit）——runtime-gauges 模块级注册表+task.service 占用/释放两点埋点+prom 绝对值渲染；observability README 字典补录 4 runtime counter+2 gauge（此前后台字典滞后）；admin-api **1179/1179** + lint 0
  - 批五~批七（01:04-02:00，main-A 持续推进）：`SEC-01 复审四项`（BUG-13 CLI 401 刷新自愈+refreshToken 入库 / BUG-14 MCP AUTOCODEFLOW_API_REFRESH_TOKEN 长驻自愈 / BUG-15 SDK 契约对称性 / BUG-16+12 复审）→ docs/SEC-01-复审报告.md，新发现 desktop token 明文落盘→SEC-NEW-1；`BUG-06` S3 回退指针语义（replace STALE 指针/append 孤儿行，storeLogLines 全量并入+指针收回）；`FEAT-02` 依赖 DAG 可视化（dag-layout 纯函数+TaskDependencyGraph+详情页 Tab）；`CORE-01` 优先级 UI 化（双形态契约 utils/priority）；`ECO-02` acf exec tail（SSE）+ task lint；`DOC-04` ADR-001~010；`FEAT-12` pypi 索引页增强；`BUG-10` 失败分类细化四端联动（git_fetch/dependency_install/runtime_missing）。基线：admin-api 1218 · executor-node 240 · executor-python 206 · autoflow-sdk 100 · acf-cli 66 · mcp-server 46 · registry-pypi 52 · admin-web 118。⚠️ 流程事故复盘：共享 index 暂存碰撞（dc82ac7 顺带带走 main-A 已暂存的 ECO-02 文件，无内容丢失）——**add 后立即 commit，禁长时暂存**。
  - ⚠️ 并行会话在途（勿动）：W1 通知设置页/W2 API 半场/应用三页面+MainLayout/logout.test/app-deployment-race.test.tsx（该文件 tsc 在途报错，全量 build 被其阻塞）
- 测试基线（全绿）：
  - admin-api **870/870** (jest, 53 suites) + eslint **0/0** + coverage 地板（68/58/56/69）
  - executor-node **158/158** · executor-python **115/115** · autoflow-sdk **91/91**
  - admin-web vitest **35/35** · Playwright E2E **29/29**（pinned 全链 4 例）
  - acf-cli **48** · mcp-server **52** · registry-pypi **33** · autocodeflow-node-sdk **43** · autocodeflow-notify **7**
  - 全端 tsc ✓ · admin-web build ✓ · `scripts/ci-local.sh` 本机等价 11 job 全绿
- 本轮（2026-09-03 第八轮，A/B/C/D 四路 → W1/W2 修复 → V 真机 5/5 → W P1 击穿修复；详见 `docs/PROGRESS-round8-2026-09-03.md`、`docs/VERIFY-round8-e2e.md`）：
- 本轮（2026-09-03 第六轮，A/B/C/D 四路并行 → audit triage → F1/F2/F3 三路修复 → V 真机验证 6/6 PASS；详见 `docs/PROGRESS-round6-2026-09-03.md`、`docs/VERIFY-round6-e2e.md`）：
- 本轮（2026-09-02 第三轮，4 并行 stream + 集成 + 文档验收，7 个 commit）：
  - `8bb3790` **调度器多实例（P0）**：Leader Election（`scheduler:leader` 锁 TTL 30s、TTL/2 续约校验、Redis 挂时 fail-open）+ `claimTaskTrigger` 条件 UPDATE 原子领取；recoverStaleExecutions 分批；TASK-007 依赖深度上限 64；TASK-008 SSE 并发上限（per-execution 4 / global 64，超限 503）；DB-001 task 软删除；DB-003 N+1 收敛
  - `7851ebd` **通知/AI/Webhook**：NOTIF-002 摘要脱敏截断；NOTIF-003 silences 上限 1000 + 定时清理；AI-002 `fallback` 标记（task 层响应已透传）；APP-001 webhook 失败统一 401；APP-002 缺 API_BASE_URL fail-fast；ARCH-003 上传走 `UploadApplicationDto`
  - `723efbf` **架构（ARCH-001..008）**：CORS 白名单 `CORS_ALLOWED_ORIGINS`；**/uploads 强制鉴权**（JWT 或 executor 共享 token）；全局限流 60/min；`REDIS_TLS`；`DB_SYNCHRONIZE` 显式；swagger 生产关闭；unhandledRejection 优雅退出；死代码 4 处删除
  - `b1fbbef` **数据库（DB-002/004/005/006/007）**：日志保留清理服务（`LOG_RETENTION_DAYS`=30，每日 03:30 分批 DELETE）；application_version 唯一索引；迁移 2685→2694 重命名（幂等）；username varchar(128)；system_config.value 显式 text；migrations.spec 时间戳唯一性守卫
  - `eadedca` **executor-node**：包下载携带 `Authorization: Bearer <共享token>`，跨主机重定向剥离 token
  - `295e3b1` **文档验收阶段发现的 2 个代码 bug 修复**：configuration.ts 补注册 `sse` 配置节（此前 `SSE_MAX_STREAMS_*` env 覆盖是死代码，task.service.ts 读不到）+ CreateExecutorPackageDto 删除必填 `filePath`/`fileSize`（服务端从上传文件推导，真实 multipart 请求被全局 ValidationPipe 400 拒绝）
  - 新增环境变量：`CORS_ALLOWED_ORIGINS`、`THROTTLE_LIMIT`/`THROTTLE_TTL`、`REDIS_TLS`/`REDIS_TLS_REJECT_UNAUTHORIZED`、`DB_SYNCHRONIZE`、`LOG_RETENTION_DAYS`、`SSE_MAX_STREAMS_PER_EXECUTION`/`SSE_MAX_STREAMS_GLOBAL`（自 `295e3b1` 起真正生效）；`API_BASE_URL` 上传包时必需
- 本轮（2026-09-02 第四轮，全新对抗性排查：4 路只读 audit → 负责人 triage → 7 路 fix，5 个代码 commit；详见 `docs/PROGRESS-round4-2026-09-02.md` 与 `docs/review_round4_*.md`）：
  - `d2613d6` **调度/任务链 2P0+2P1**：触发去重锁被 watchdog 无限续期致每任务只触发一次（acquireLock 新增 renew 选项，trigger 锁 renew:false）；依赖任务链死代码（worker 永不写 SUCCESS）迁入 handleCallback 赢家路径；多页日志回填丢页（storeLogLines append 语义）；COVER_EARLY 盲写改条件 UPDATE
  - `b0aa67f` **安全 2P1+6P2**：RolesGuard 全局注册 + config 写端点/共享 token/executor-package 收紧 @Roles(ADMIN)（@Public 机器端点用空 @Roles() 覆盖）；heartbeat/register 列注入白名单（原 Object.assign 可覆写 tokenHash 成持久后门）；SSRF 层新增 assertSafeExecutorUrl 接入 dispatch/broadcast/reload/push + 3 通知渠道；登录枚举时序拉平；callback 限流 + token 校验 60s 缓存；trust proxy 改 `TRUST_PROXY=true` 才启用；SSE 仅 /logs/stream 路径接受 `?access_token=`；config/history 与 audit 筛选 QueryDto（修恒 400）
  - `f792e10` **executor-python 1P0+1P1+12 项**：shell entrypoint 注入（白名单+位置参数，对齐 node 6062bee）；日志 10MB/64MB 上限；回调重试退避；git 缓存 hash 盐；REQUIRE_TOKEN fail-closed 等
  - `f0f61e5` **executor-node 5P1+8 项**：callback ≤100 分片 + dead-letter 毒文件终态；部署子进程 env 白名单（共享 token 不再透传给被管应用）；NODE_PATH 修 requirements 不可解析；BoundedLogBuffer；TTL 磁盘回收；共享下载器（Bearer+deadline+防穿越）；spawnSync→async；进程组 kill
  - `75c8d2b` **客户端契约 2P0+7P1**：CLI login accessToken（原字段名错致 CLI 全 401）；应用编辑不发 name；安装向导走 install-cmd（后端删坏 curlCmd）；包下载带 auth fetch；AI 分析字段对齐；SSE 参数名；trigger executorId 移除
  - 新增环境变量：`TRUST_PROXY`（默认 false——**nginx 后部署必须设 true**，否则限流键/审计 IP 全变代理 IP）、`EXECUTOR_ALLOW_PRIVATE_NETWORK`（默认 false：executor 出站放行私网段但拒 loopback/元数据；**同机 127.0.0.1 executor 部署必须设 true**）
- 本轮（2026-09-02 第五轮，收尾 + **首次真机验证**：4 代码流 + V/W1/W2/V2，7 个代码 commit；详见 `docs/PROGRESS-round5-2026-09-02.md`、`docs/VERIFY-round5-e2e.md`、`docs/VERIFY-round5v2-n2.md`）：
  - `0a7ebcb` 依赖扇出 10s DB claim（双上游并发只触发一次）+ checkDependencies take 兜底；storeLogLines DB 路径事务化；**可观测性**：SchedulerMetricsService（tick/claimed/skipped/failed 进程内计数）+ BullMQ 队列深度 + `GET /metrics/scheduler`（零新依赖）
  - `1864597` executor-node flake 元凶坐实：file-logger spec 用 UTC 日期而生产按本地时区（超前时区机器每天 8 小时确定性失败）；4 spec 确定性化，5 连跑全绿 + 5 种 TZ 交叉
  - `51469d6` audit 两端点收紧 ADMIN；删除孤儿 install-token 端点；admin-web 角色门控（role 唯一来源 `GET /auth/profile`——登录响应无 user 字段；RequireAdmin 路由守卫 + 菜单隐藏 + settings 写禁用）
  - `9e8f2ae` CLI/MCP P1 补全（applications CRUD、deploy upgrade/stop、task versions/rollback/compare、executor get、audit list）+ 5 个既有契约 bug 顺带修 + 两包 vitest 基建
  - `2642293` **真机发现 N2(P0) 修复**：PG enum 列运行时返回字符串 label（'normal'），原样传 BullMQ 致**所有调度入队 100% 失败**（单测全 mock queue 故从未暴露）——normalizeTaskPriority 入队边界归一化；N3 readyClient 消 ~15s 假 Leader；N4 register 幂等（同 address+startupId 不再轮换 token）；N5 stale cutoff 动态化；N6 去重锁 TTL 按触发周期（修 15s 任务被压成 300s）
  - `d2be430` **真机发现 N1(P1) 修复**：全新 DB 迁移链 3 处断裂（app_deployments 无建表、version 列撞名、rename 时序）幂等化 + CreateAppDeploymentsTable 补偿迁移 + migrations.spec describe 守卫（修 typeorm CLI 崩）；docker postgres 空库 24/24 + 存量续跑数据无损双验证
  - V 真机验证（`b2be111`）：Leader Election 双实例 80 execution 无重复、kill 后 35s 接管；LOG-11 S3 对象闭环；负载均衡精确 2+2——**三项全通过**；V2 复验 N2/N6/N3/N1 修复全部生效（96/96 success）
- 本轮（2026-09-03 第六轮，详见 `docs/PROGRESS-round6-2026-09-03.md`、`docs/VERIFY-round6-e2e.md`）：
  - **N6 残留抖动修复**：fixed_rate 去重锁 TTL 改 `周期−500ms`（`TRIGGER_DEDUP_JITTER_BUFFER_MS`，claim 窗口同源）——真机复验 15s 任务 11 个 gap 全部 14.999–15.001s、零 30s 级 gap（修复前 15/30 混合）
  - **任务 API 契约**：CreateTaskDto.id UUID 校验（字符串 400/重复 409 含软删预检与 23505 兜底）；**executor pinning**（tasks.executorId 新列迁移 25 + dispatch pinned 分支：在线只派目标/离线 executor_offline/不存在 unknown；与 broadcast 互斥）——真机三语义 PASS
  - **install.sh 闭环**：`install-script.content.ts` 单一事实源 + `GET /executors/install.sh`（@Public text/plain）+ install-cmd 重建 curl|bash + N15 参数注入校验（六种注入 exit 1 零落盘）+ 逐字节漂移守卫
  - **audit N7-N15 修复**：N7 executions 两端点交叉类型白名单失效→显式 DTO（CLI 同步删 limit）；N8 SSE 30s 掐断→`@SkipTimeout()`；N9 executor-node worker Map 泄漏→5min 惰性回收；N10 CLI --wait 漏 killed；N11 通知/AI config 收紧 ADMIN + 密码脱敏（GET /executors 复核后**不**收紧，理由见 controller 注释）；N12 mcp-server 30s 超时+错误文案；N13 admin-web pause/resume 类型修正
  - **CI 流水线**（`.github/workflows/ci.yml` 重写 12 jobs）：develop/main 双分支触发 + acf-cli/mcp-server/admin-web lint 补齐 + admin-api e2e（真机修绿 37/37，含 migrations.spec e2e worker 崩溃修复）+ 迁移链双轮幂等 job；admin-api lint（存量 154 errors）与 coverage 阈值两个 step 注释保留待清偿
- ⚠️ 第六轮部署注意：
  - **GET /notification/channels、/ai/config 已收紧 ADMIN**：admin-web 的 NotificationSettingsPage/settings 普通用户读面将 403，前后端需同批发布（第七轮补前端门控/降级 UI）
  - acf-cli 需随轮重新分发（executions 请求移除 limit + killed 终态）
  - mcp-server 需随轮重新分发（30s 超时 + 错误文案）
  - 迁移 25（tasks.executorId）为幂等 ADD COLUMN，例行窗口执行即可
- 本轮（2026-09-03 第七轮，详见 `docs/PROGRESS-round7-2026-09-03.md`、`docs/VERIFY-round7-e2e.md`、`docs/VERIFY-round7v2-fixes.md`）：
  - **依赖/质量清偿**：四端 npm audit 官方源清偿（browserslist HIGH 等全消，executor-node qs 经 overrides 升级，admin-api 残留 3 moderate 属 minio 链上游未修）+ CI `npm-audit` job（--audit-level=high）；admin-api eslint **163→0/0**（tsconfig.eslint.json 修解析错误根因 + no-unused-vars 下划线约定固化）；coverageThreshold 地板化（68/58/56/69）恢复 CI coverage
  - **可观测性**：prom-client 15.1.3 落地 `GET /api/metrics`（8 条 autoflow_scheduler_* series + 进程默认指标，JwtAuthGuard 姿态同 /metrics/scheduler，`METRICS_PROMETHEUS_ENABLED` 开关）——真机 counters 单调增长验证
  - **RBAC 收尾**：admin-web /notifications RequireAdmin + settings AI Tab 非 admin 降级（组件测试先例建立）
  - **audit N17-N24 修复**：N17 pinning 互斥 PATCH 绕过（合并态兜底校验，真机复验）；N18/N21 registry-pypi 哈希 sidecar + 上传防重（流式 1MiB + 同哈希幂等/异哈希 409）；N19 TaskFormPage 消费 executorId（executor-mode.ts 纯函数层）；N20 MCP update_task + CLI --executor；N22 新端点 POST /api/notification/send；N23 node-sdk fromEnv required 收敛（回调凭证可选 disabled client）；N24 install.sh 删假 URL 分支
  - **真机验证闭环**：V 五渠道外发全通（含 SMTP 会话）+ prom 端点 + N17 互斥；抓到 V1-V5（config 与外发解耦/SSRF fail-open 无反馈/deny 缺 198.18 与 100.64 段/未知 key 500/死 env 引用）→ W 全修 → V2 真机复验通过
- ⚠️ 第七轮部署注意：
  - **POST /api/notification/send 新端点**（登录态可发通知）与 **/api/metrics**（JWT）新增，若前端有 WAF/网关需放行
  - **通知外发 config-first**：PATCH 渠道配置现在真实生效（此前仅 env 生效）——存量环境若 env 与已保存 config 不一致，行为会变
  - **SSRF deny 扩大**：198.18.0.0/15、100.64.0.0/10 段通知外发/executor 出站均被拒（TUN/CGNAT 环境 executor 部署注意）
  - install.sh 不再尝试远程下载 artifact（明确失败语义），目标机安装需 executor-packages 通道或项目 checkout
  - acf-cli/mcp-server 需随轮重新分发（--executor 选项 / update_task 工具）
- 本轮（2026-09-03 第八轮，详见 `docs/PROGRESS-round8-2026-09-03.md`、`docs/VERIFY-round8-e2e.md`）：
  - **per-execution 回调 token（N23 根治）**：`v1.<execId>.<exp>.<hmac>` 域分离 HMAC（key=HMAC(secret,固定域)），TTL=timeout+900s；executor-node 注入 AUTOFLOW_CALLBACK_TOKEN/AUTOFLOW_ADMIN_API_URL/AUTOFLOW_EXECUTOR_ADDRESS（extra 通道，SEC-01 白名单不动）；admin `v1.` 分支验证（候选 secret + per-executor tokenHash 回退 + executionId 逐 item 绑定，fail-closed）；node-sdk fromEnv 自动启用；双端 spec 钉死同一测试向量防算法漂移
  - **install.sh artifact 通道**：`GET /executors/artifact/executor-node.tar.gz`（共享 token fail-closed）+ bundle 脚本——真机从 artifact 装出执行器注册 online；`scripts/ci-local.sh` 13 job 本机等价（push 无凭证期间验收通道）；registry-npm verdaccio healthcheck 修复（localhost→127.0.0.1 恒 unhealthy bug）+ 加固 + README
  - **Playwright E2E 25/25**：新增 9 例（角色门控/AI Tab 降级零请求/四模式/executorId 残留服务端复核）；**抓到 P0**——TaskFormPage 分步渲染 validateFields 只回当前挂载字段，创建 UI 完全不可用 → getFieldsValue(true)+分步兜底，fixme 转正
  - **audit N25-N32**：N25(P1) `::ffff:` IPv4-mapped IPv6 绕过 SSRF 分类 → normalizeIpForClassification 归一（含 ::/96 与完整 IPv6 危险段）；N26 回调 token 密钥缺口（tokenHash 是 bcrypt → 改双端以 tokenHash 字符串为 HMAC key，register 回传+采纳+60s 缓存验签）；N27 SDK 自动补 executorAddress；N28 admin-web 模式清理 delete→显式 null；N29 通知 test 面真实 results；N30 registry-pypi 并发上传 os.link 原子防重；N31 /api/metrics 并发 render 串行化
  - **真机 P1 击穿修复（V 抓到）**：executor-node fetchToken 不拆信封 + Nest POST 201 误判 200 → token 恒 undefined → 心跳每 30s 旋转 token（9 分钟 14 次）→ 回调 token 稳态必 401。三层修复：fetchToken 拆信封/2xx 区间；admin issueToken 幂等（startupId 稳态永不轮换+内存缓存明文+legacy 60s 窗）；心跳响应回传 tokenHash 三点采纳
- 本轮（2026-09-03 第九轮，A/B/C/D 四路 → V 真机 5/5 + audit N33-N36 → W 收尾修复；详见 `docs/PROGRESS-round9-2026-09-03.md`、`docs/VERIFY-round9-e2e.md`）：
  - **python 侧 token 链对齐**：executor-python `_fetch_token` 三缺口（201 误判/未拆信封/缺 startupId）修复——动态 token 首次真正生效；register/heartbeat 采纳 tokenHash（三点不变量补齐）
  - **autoflow-sdk 回调能力**（node-sdk 对等）：from_env 读三变量（排除出 params）+ CallbackClient（enabled/disabled_reason）+ report_success/failure；executor-python 注入回调三变量（HMAC 移植，与 admin/node 三方同测试向量逐字节一致）
  - **回调 401 分类观测**：`autoflow_execution_callback_auth_total{result}` 七分类 series（controller 埋点 util 保持纯函数）
  - **webhook 配置面补全**（V2 遗留）：PATCH channels/webhook 合法 + config-first + URL query 脱敏 + 掩码回显守卫
  - **Playwright 29/29**：pinned 部署全链 4 例（在线/离线/不存在/全 UI 闭环）
  - **P1 修复（V 抓到）**：python register 用动态 token 打 bootstrap 端点 401（R9 修复揭开）→ 改静态 token + 状态码检查；**N33-N36**：issuedTokenCache 有界化（1000/24h）、artifact query token 风险标注、ci-local 差异声明
- **里程碑（2026-09-05）**：**v1.0.1 三包发布完成**（npm `@autocodeflow/sdk` + `autocodeflow-mcp-server` 1.0.1、PyPI `autoflow-sdk` 1.0.1，双版本可回溯）；**develop→main 发版合并完成**（main 与 develop 树一致，两父 merge commit `bddac27`，main CI 全绿）；**Windows 深度测试任务书就绪**：`docs/WINDOWS-TESTING-PLAN.md`（R13 基线→R14 功能冒烟→R15 修复批→R16 desktop 打包，含 13 项已知平台风险点与问题回传模板——Win 机器拉取后按此推进）
- 本轮（2026-09-06 第十五轮，gh 凭证打通后首度 CI 真跑；员工 001/002/005/006 四波编排 + 主控亲修；存在并行会话同期协作，e0c30ef/1734958 为其产物）：
  - **CI 红灯清偿**：push 后首跑三红灯——e2e-full 根因为**实体↔迁移链漂移**（task_versions/config_history/execution_reports/executor_metrics_history 4 表 + applications.packageUrl/webhookSecret + executor_packages 4 列从未建过迁移，历史靠 DB_SYNCHRONIZE=true 掩盖，空库纯迁移链上任务创建直接 500——「mock 一切不等于能跑」第五轮教训再验证）；admin-api-test 败于 lint（spec 内 require()）；executor-node-test 败于 Linux 侧 kill 时序（assertion timing）。均已在 e0c30ef 修复，后续 run **24 job 全绿**（含 29 例 e2e）。
  - **部署链路加固**（6ed5b21，admin-api 1098→1123）：R4 spawnSync→spawnAsync（clone 120s 不再冻结全进程）；R5 在途部署部分唯一索引+23505→409（upgrade 保持 UPGRADING 防多实例滚动升级互撞）；R6 卡死扫描 createdAt→updatedAt；R8 push/stop 接入 assertSafeExecutorUrl；R9 包上传 diskStorage+流式哈希+rename 落位+下载 pipeline（500MB 不再驻留内存）；R16/R18。
  - **桌面 IPC 安全**（bbb93de）：path-domain.ts 路径域校验 util + selftest 基建（npm run test:main）；任意文件读/executionId 逃逸/任意程序启动三口子闭合；托盘 online 合并注册状态；https 探测修正；心跳句柄清理。
  - **包契约**（634803f）：notify 非 2xx 可观测+返回 bool+webhook 通道；ai base_url 统一基址语义+围栏解析健壮化（notify 7→18、ai 10→25）。
  - **006 审计 S1-S16**（第三/四波修复落地）：S1(高) admin-web nginx proxy_pass 尾斜杠剥离 /api 前缀——生产部署全部 API 404（dev 代理无 rewrite 故 e2e 从未暴露）；S2/S7 deploy.sh 健康路径+两份 nginx client_max_body_size；S3(数据破坏) system-config 掩码回写哨兵守卫；S4/S5 registry 上传超时+npm 服务账号凭证；S6 Windows zip 条目校验（PowerShell .NET 枚举+纯函数）；S8/S13/S15 audit CSV 注入/400 化/ParseIntPipe；S9 执行器端口回环+REQUIRE_TOKEN=true（连通性推演过）；S10/S11 pypi 上传 50MB 上限+.egg 收敛；S12/S14 clone 分支语义+死 import；S16 settings 历史列对齐。
  - **006 QA 批次**（QA1-QA10 全消）：QA1 deploy.sh 断言字符串（S2 修复自身引入，闭环）；QA2 nginx 210m→510m（执行器包 500MB 上限对齐）；QA3 SSE 空闲 15s ': ping' 帧（nginx 60s 读超时下 S3 存储任务日志流必断）；QA4/QA5/QA6 部署守卫补 UPGRADING/PENDING 卡死清扫/快照 23505 容忍；QA7 form-data 显式依赖；QA8 spawnAsync CAP+进程组杀；QA9 上传孤儿清理；QA10 Content-Disposition 消毒。
  - **流程注记**：并行会话与本会话同时操作同一工作树（e0c30ef/1734958 及 6ed5b21 内夹带 prettier 重排）——提交前必须 git pull --rebase + diff 盘点，员工报告与 git 实际状态要交叉核对。
  - 测试基线刷新：admin-api **1170**（60 套件）+ lint 0/0 · executor-node **227** · registry-pypi **50** · notify **18** · ai **25** · admin-web **87** · executor-desktop selftest 过 · **CI 24 job 全绿终态（run 34035565675，commit 2342743）**——期间两轮返程红：desktop-bundle-drift（round-15 改 executor-node src 忘重打 bundle；W-18 守卫按预期拦截，教训=executor-node 源码改动与 bundle 重打必须同 commit）。
  - 本轮遗留（下一轮候选）：executorAuthMiddleware 彻底移除（12 例测试迁移到 verifyToken）；admin-web api/config.ts ConfigHistory 类型同步；QA8 detached 对 Windows 信号行为的深度验证；nginx SSE 专 location（现靠 15s ping 保活）；大规模并发压测/真机矩阵（长期未覆盖项）。
- 本轮（2026-09-06 第十四轮，员工 SubAgent 001/002/006 主力（003/004 触模型日限由 general-purpose 兜底）→ QA 审查 10 项 → 修复闭环）：
  - **executor-python 可靠性三件套**（153→197）：E2 回调失败落盘+后台重试环+dead-letter（token 永不落盘、重放现取动态 token 走自愈；停机 drain 10s）；E6 同任务串行锁（按 loop 分桶）+git cache per-repo 互斥；E8 磁盘 TTL 回收（workdir/.git_cache/.venvs/logs，TTL 7d/周期 6h/首跑延迟 600s env 可配，活跃目录保护 fail-safe）+dead-letter 目录 TTL 清扫+清理移入 to_thread；心跳恒报 deadLetterCount。
  - **admin-api P2**（1014→1098）：sweep 条件 UPDATE 赢家兑现重试预算（hasRetryBudget→kill best-effort→scheduleRetryAfterRecovery 入队，STALE_RECOVERY_RETRY_ENABLED 开关）；failureReason 新增 stale_recovered；deadLetterCount 实体列+幂等迁移+心跳采纳（0..100000）。
  - **admin-api 安全收口**（006 审计 R1-R19）：application/app-deployment 全链 @Roles(ADMIN)+env 读面全链脱敏（含 QA1 闭合的 deployment.env/relations/snapshot.env 三处绕过）；SSRF maxRedirects:0（6 出站点）+assertSafeGitRepoUrl；通知 test 端点 ADMIN+override 请求级化（不再写全局 store）；账号过期锁原子重置；ai/test ADMIN；pid @IsInt；currentPassword 不回显；3xx 确定性拒绝不重试+文案明示。
  - **admin-web**（83→87）：死信三态可视化（详情/列表）；截断日志"加载完整日志"分页兜底（对齐 fromLine/limit≤2000 契约）；stale_recovered 映射；U13 类型修正。
  - **流程注记**：004 员工在模型日限触发前留下 R1/R2/R3 半成品（含掩码回写真实 env 的数据损坏缺陷），兜底 agent 已修复补齐——员工 SubAgent 中断后必须 diff 盘点其遗留。
  - 测试基线刷新：admin-api **1098**（58 套件）· executor-python **197** · admin-web **87** · executor-node 218（本轮未动）· 包类 218→本轮未动。
  - 本轮遗留（下一轮候选）：deployFromGit spawnSync 阻塞事件循环（R4 后半，需异步化）；R5-R9（部署 TOCTOU/卡死误判/stop 语义/推送 SSRF/上传流式化）；R13 Electron IPC 路径校验；R14/R22 python 包通知/AI 契约；python 停机树杀后 live 回调不在 drain 范围（QA8，可由 P2 收敛）。
- 本轮（2026-09-06 第十三轮，三路只读审查 P/E/U 共 33 项 → 5 路并行修复落地 21 项 → 全量回归）：
  - **admin-api**（1014/1014）：BullMQ `defaultJobOptions` 终态保留策略（completed 1h/1000、failed 24h/5000，Redis 无界堆积根治）；`@Processor("task-queue",{concurrency:5})` 消除大 timeout 任务队头阻塞（核实 @nestjs/bullmq 11 单对象形式 concurrency 会被静默丢弃，须用第二参数）；SIGTERM 15s 强制退出兜底（`shutdown-guard.util.ts`）；心跳白名单采纳 `maxConcurrentTasks`（1..10000 校验，E9 admin 侧）。
  - **executor-node**（218/218，ncc bundle 已重打）：心跳上报 `maxConcurrentTasks`（热更后下个心跳回传，E9 node 侧）；`logsDir` 改 lazy getter 修复 workDir 热更写读分裂（E10）；死信清理 `filesOnly` 与计数口径对齐（E12）；callbacks/ 顶层孤儿 .meta 24h 回收（E13）。
  - **executor-python**（153/153，+25 用例）：心跳上报 `runningExecutionIds`（accept 即注册/终态摘除/≤200，E1——此前 null 被跳过活性保护，prepare 阶段超阈值即被误判 FAILED 且经 429→重试链可双跑）；重复 executionId 400 守卫（E7）；`POST /api/executions/:id/kill` 端点（E4）；停机杀任务进程树（E5）；回调走 `request_with_self_heal` 且 401 可重试（E3）。
  - **admin-web**（83/83 + lint 0）：SSE 与 axios 同源（复用 getApiBaseUrl，U1）；全站 `pollingWhenHidden:false`+兜底 interval 可见性门控（U3）；执行器详情实时卡改用 metrics.current（U5）；Dashboard 失败列表消费 failureReason/exitCode 并链执行详情（U6）；pending 筛选（U9）；error≠不存在三详情页 Result+重试（U7）；执行器历史表 taskName/exitCode/整行跳转（U10）。
  - **packages**：autocodeflow-http 变更方法默认不自动重试（`safe_methods_only`，U4）；autoflow-sdk 回调 enabled 仅要求 url+token + 双 SDK 信封拆包（U14）；acf-cli 补 exitCode/failureReason/runningExecutionIds（U11）；mcp-server 新增 get_executor_metrics + 描述如实（U12）。
  - 本轮遗留（下一轮候选）：sweep 对 worker 崩溃型 RUNNING 行 re-enqueue 重试语义（P2，需产品拍板）；python 回调落盘/死信（E2）、git/venv 并发锁（E6）、磁盘 TTL 回收（E8）；admin-web 截断日志走分页端点兜底（U2）；deadLetterCount 中台侧落库可见（U16）；python kill 端点响应体若与 node 契约有差异需真机核对。
  - 测试基线刷新：admin-api **1014**（57 套件）· executor-node **218** · executor-python **153** · admin-web **83** · acf-cli **53** · mcp-server **63** · node-sdk **49** · autoflow-sdk **100** · autocodeflow-http **18**。
- **里程碑（2026-09-05 Windows 轮，R13-R16 全完成，Windows 侧接手主导）**：项目首个非 Linux 平台全验证（Win11 26200 / Node 24.17 / Python 3.12-uv / WSL2 mirrored 网络跑 PG16+Redis7）。findings **W-01~W-26**、生产修复 **P-1~P-20**（`docs/windows-findings.md`）：
  - **5 枚生产级缺陷修复**：executor-python `os.setsid/killpg` 全任务崩（P-1/2）；venv `bin/python` 布局（P-3）；`['python3']` 硬编码致 python glue 全挂——两处均为单测全 mock 未暴露、人工审查发现（P-3/4）；entrypoint `/xxx` 逃逸守卫绕过（P-5，安全）；shell glue 缺 glueLanguage fallback + win32 `.cmd` 化（P-11）；控制台 Ctrl 事件波及任务/后台 SIGBREAK 缺失/desktop stop() SIGTERM 失效（P-9/10/12，R-08 全景收口）
  - **R-01/R-03 治本**：`.gitattributes` 全仓 LF + renormalize（admin-api eslint 37078→0、install.sh 字节守卫转绿）；`killProcessTree` win32 升级为 `taskkill /T /F` 树杀（超时/取消/停止三链孙进程实测 0 残留）
  - **双平台绿灯基线**：executor-node 164/164（3 连跑稳）、executor-python **128/128 零 skip**、admin-api 887/887 + eslint 0/0（含 W-22 守卫 3 例与 W-21 requirements 11 例）、acf-cli 48、mcp-server 61、registry-pypi 33、admin-web 35 + e2e **16/16**（16 例版；W-12 闭环：29 例全量版已由 Linux 侧入库根级 `e2e-full.spec.js` + `playwright.e2e.config.js`，test#16 同步 W-13 修复）
  - **R14 真链路 9/9**：注册上线、四类任务全链、fixed_rate 15.007s±0.02s、超时树杀、token 轮换+reload-config、日志回收无 EBUSY、中文空格 WORK_DIR、优雅退出 SIGBREAK 链 rc=0x0；**补 executor-python Windows 真链路 6/6**（uvicorn/注册/心跳/glue/callback-token/venv-P-3 直连实证；发现 admin 不转发 requirements 的功能缺口，跨平台）
  - **R-04 专项（W-19/P-13）**：任务 env 白名单两侧补齐 Windows 系统+home/identity 变量族（python 侧此前零 Windows 变量；Git-Bash 的 HOME 恰好掩盖了退化）；双侧白名单安全测试 + 真链路 homedir/getuser 实证
  - **R16 路线图 #12 收口**：electron-builder NSIS 安装包 Windows 首产（100.6MB）；ncc 内置 executor 独立注册+真实任务验证；新发现 W-16 assets 图标未入库（体验）/W-18 prebuilt bundle 跟踪（漂移风险）
  - **固化**：Windows CI job（executor-node/acf-cli/mcp-server + admin-web，`ci.yml`）；desktop bundle 漂移守卫 `desktop-bundle-drift`（W-18 闭环：ncc 字节确定性已验证，离线重打+git diff 把关）；deployment.md 新增 Windows 章节（手动路线/taskkill 警告/shell 语义）；install.sh 平台探测；requirements-dev.txt ×2
  - ✅ Linux 复验义务已闭环（2026-09-05，凭证配好后推送）：CI run 33943007134 **22 job 全绿**（ubuntu 18：executor-node 162 / executor-python 127 / admin-api 873 等零回归；windows 4：executor-node/acf-cli/mcp-server/admin-web 固化基线）。Windows CI 首跑即抓出并修复 W-20（env 白名单 win32 大小写语义失效，P-14/15）——双平台 CI 交叉验证的直接收益
  - **W-12 销账**（Linux 侧）：29 例根级 e2e 基线入库（`e2e-full.spec.js` + `playwright.e2e.config.js`）；Windows 首跑暴露登录节流级联 429 → 定位 **W-22/P-16**（`@Throttle` 装饰器求值期读 `process.env`，`.env` 文件对 `LOGIN_THROTTLE_LIMIT` 原为死配置，仅真实进程环境生效——容器部署从未暴露）→ main.ts 预载 `.env` + app.module 动态 import 修复；修复后 Windows 纯 `.env` 栈 **29/29** 全绿
  - **W-21 requirements 端到端接通**（产品决策：接通）：admin-api 实体 jsonb 列（幂等迁移）+ DTO 结构校验 + normalize（trim/拒 option 形 `-` 前缀）+ version snapshot 收录 + dispatch 透传零改动（manifest `as any` 路径现真实落库）；admin-web 任务表单 Select tags（逗号不切分，pip spec 合法含逗号）+ 空集显式 null（N28 PATCH 语义）+ 详情页展示；sdk-guide 补字段行。基线刷新：**admin-api 884 · admin-web 40 · e2e 29/29**，CI run 33947112177 **22/22 全绿**
  - **Windows 侧续推（同日，Windows agent）**：① W-21 补遗——`syncTasksFromManifest` 回归两例（requirements 透传进 create 载荷 + 'already exists' 隔离），manifest→任务链路自此有守（aa9429f）；② **W-18 永久闭环**——CI 新增 `desktop-bundle-drift` 守卫（离线重打 ncc bundle + git diff，产物与源码不同步即红；ncc 0.44 字节确定性/禁网可跑已在 Windows 侧预验证，首跑即绿，37a5de3）；③ **W-28：Windows 全栈 e2e 接入 CI**（方案 A：仅 PR/workflow_dispatch 触发，不占 develop push）——复用同一 `e2e-full.sh` 编排（参数化 WORK_DIR 至 C:/tmp，node 盘符解析），PG 用 runner 预装服务（postgres/root）、redis 用 redis-windows portable zip，见 findings W-28；④ 修正本人一处状态误判（"W-12 未推"实为已在共享历史，见 findings W-28 状态澄清）。CI 现状：develop push 24/24（含守卫），PR/dispatch 另加 windows e2e（首跑已验证 success，298s，run 33967431348）
- 本轮（2026-09-04 第十轮，A/B/C/D 四路 → W 收尾 N37-N42；详见 `docs/PROGRESS-round10-2026-09-04.md`）：
  - **可观测性**：docs/observability/（Grafana dashboard 11 panels + 6 条告警规则 + README 抓取配置/指标字典，series 与源码逐字核对零偏差）
  - **SDK 发布管道**（路线图 #10 收尾）：release.yml（tag 触发 + version-guard 四处版本一致性 + npm/PyPI 发布 + environment: release 审批门）；双 SDK README + sdk-guide 矩阵；修掉 autoflow-sdk 未声明 pydantic 依赖的发布级 bug
  - **旋转 token 即时对齐**：窗口评估实为最坏 30min（60s 缓存掷硬币 + 离线级联）→ executor-node 401 自愈（forceTokenRefresh + 单次重试，窗口收敛到一次往返）+ admin rotateToken 播种 issuedTokenCache（UI 展示的 token 即执行器采纳的 token，零二次轮换）
  - **audit N37-N42 全消**：webhook 优先级链修正（显式参数 > 已保存且启用 config > env，ChannelConfigStore 增 enabled 跟踪）；api-reference 补 /notification/send 行与 rotate-token 双端区分；sdk-guide python 判据 ctx.http→ctx.callback.enabled（原文档照写即 AttributeError）；TaskContext 敏感字段 repr=False；release 审批门
- ⚠️ 第十轮部署注意：
  - **webhook URL 语义翻转**：显式请求参数现在优先于已保存渠道 config（且 disabled 渠道 config 不再生效）——依赖第九轮"config-first 覆盖一切"行为的消费方需复查
  - release.yml 首用前需配置 NPM_TOKEN / PYPI_API_TOKEN secrets 与 GitHub Environments（release）审批人
  - executor-node 需随轮重新部署（401 自愈）
- ⚠️ 第九轮部署注意：
  - autoflow-sdk 新回调 API（report_success/failure）——python 任务代码升级 SDK 后即可用回调
  - webhook 渠道现在可 PATCH 配置且 config-first（保存 url 优先于逐请求参数）——行为对依赖旧"参数优先"语义的消费方是变更
  - executor-python 需随轮重新部署（token 链修复 + 回调注入）
- ⚠️ 第八轮部署注意：
  - **回调 token 依赖共享 secret 同源**：EXECUTION_CALLBACK_SECRET 可选（缺省回落共享 token）；admin UI 手动旋转 token 后长运行执行器需 register/token/心跳对齐（三点已自动化，sdk-guide 有约束说明）
  - `POST /executors/token` 语义变化：幂等签发（不再每次旋转）——依赖旋转行为的消费方（若有）需复查
  - ~~executor-python 疑似同款信封 bug~~ ✅ 第九轮已修复（信封拆包+2xx+startupId+tokenHash 采纳+回调注入全链对齐）
  - install.sh 现支持 artifact 下载（EXECUTOR_ARTIFACT_DIR，默认 <cwd>/artifacts，需先跑 bundle 脚本）
- ⚠️ 部署注意事项：
  - **/uploads 鉴权是破坏性变更**：executor-node 必须升级到含 `eadedca` 的版本，否则下载应用包 401
  - **第四轮 RBAC 是行为变更**：普通用户访问 config 写端点/executor-packages 全部改判 403；前端未做角色门控（可见但操作 403），admin-web 需与 admin-api 同批发布（SSE `?access_token=`、编辑不发 name、下载带 auth 均依赖新后端）
  - **acf-cli 必须重新分发**：`75c8d2b` 前所有 CLI 登录即失效链（token=undefined）
  - executor-node/python 建议随轮升级（callback 分片、env 白名单、注入修复）；部署的应用若曾偷读 EXECUTOR_SHARED_TOKEN 会因 env 白名单失效
  - DB-005 重命名迁移会在已有环境重跑一次（幂等 up/down，安全）；DB-002 唯一索引迁移重写 application_version 表，建议维护窗口执行
  - SSE 并发计数为进程内：多实例实际上限 = 实例数 × 64
- 工作区：干净

## 会话恢复速查

```bash
# ARCH-20（根级聚合入口，per-app 安装模型不变）：npm run test:all / typecheck:all / lint:all / test:api / demo:seed 等
# 各子项目独立运行命令（仍可用）:
cd apps/admin-api && npx jest && npx tsc --noEmit -p tsconfig.json
cd apps/executor-node && npx jest
cd apps/executor-python && python3 -m pytest -q
cd apps/admin-web && npm run lint && npm run build
cd packages/acf-cli && npx tsc --noEmit
cd packages/mcp-server && npx tsc --noEmit
```

注意：
- `apps/executor-desktop/resources/executor-node/index.js` 是生成物，源码改 `apps/executor-node/src` 后走打包流程更新。
- admin-api 全局 `ResponseInterceptor` 把成功响应包成 `{ code, message, data }`，admin-web 在 `src/api/client.ts` 的 axios interceptor 自动拆包；CLI 与 MCP 已在 `packages/acf-cli/src/client.ts` 与 `packages/mcp-server/src/index.ts` 加上对称拆包逻辑（2026-09-02）。
- 文档可能比代码旧，以代码+测试交叉校验。

## 开发准则

1. 小步提交：一个方向一批改动，先补测试再改实现，提交前跑该子项目验证命令。
2. 每次提交信息用中文 conventional commits（feat/fix/docs/chore/refactor/test）。
3. 功能落地后同步更新 `docs/api-reference.md` 与 `docs/optimization-notes.md` 的状态标记。
4. 会话结束前更新本文件「状态快照」并提交。

## 长期路线图状态

| # | 方向 | 状态 |
|---|------|------|
| 1 | 版本历史与发布快照 | ✅ 已完成（含回滚） |
| 2 | 执行失败原因分类 | ✅ 已完成（executor 侧可再细化） |
| 3 | Webhook / API 认证模型 | ✅ 已完成（rawBody+时间戳 HMAC，Public 路由强制 secret） |
| 4 | 任务超时 / 时区 / 重试 | ✅ 已完成（trigger/rollback/scheduled 三入队路径均带 attempts+指数退避，processor 失败 rethrow 使 BullMQ 重试生效，均有单测） |
| 5 | 执行器重启恢复 + 负载感知 | ✅ 已完成（心跳携带 runningTaskCount，dispatch 按 loadScore=runningTaskCount/max 选最低负载 + 乐观锁防超发，广播模式不占计数，callback 释放槽位，均有单测） |
| 6 | 应用包版本隔离 | ✅ 已完成（不可变 release 目录 + current 软链 + 回退） |
| 7 | 心跳 / 注册稳定化 | ✅ 已完成（连通性自检、退避重试） |
| 8 | Admin Web 与 E2E | ✅ E2E 35/35（Linux x86_64）；平台矩阵未覆盖 |
| 9 | CLI 与 MCP 能力对齐 | ✅ 已完成本轮 P0（CLI: task CRUD/pause/resume/kill/logs/executions、app deploy/deployments/versions；MCP: get_application/deploy_application/kill_execution/pause_task/resume_task/list_deployments + 已有 list/get/analyze 套件）。ResponseInterceptor 拆包已在 CLI/MCP 两侧 client 解决 |
| 10 | SDK 统一与示例 | ⬜ 未系统梳理 |
| 11 | 日志外置存储（MinIO/S3） | ✅ 已完成（`LOG_STORAGE_DRIVER=s3` 可选驱动；callback 写入时优先 S3 失败回退 DB；读取时按 `exec.logStorage` 分流；集成测试 6/6） |
| 12 | 桌面执行器跨平台 | ⬜ 未验证 |

## 下一步建议（按优先级）

> 第九轮交接 6 项中 5 项已在第十轮完成。以下为第十轮后剩余：

1. ~~CI push 真跑~~ ✅ 2026-09-04 闭环：gh 凭证到位后三轮修复（node 24 + autoflow-sdk-node lock 官方源重生成 + python jobs respx/python -m + audit 重试），**13 jobs 全绿**；剩余 release 首发演练（打 tag 前需配 NPM_TOKEN/PYPI_API_TOKEN secrets 与 Environments(release) 审批人）。
2. ~~autoflow-sdk-node 旧重复包清理~~ ✅ 2026-09-04 第十一轮已删除（@autocodeflow/sdk 0.1.0 旧 Node 重复包，全仓无消费方；npm 名现由 packages/autocodeflow-node-sdk@1.0.0 发布，无冲突；git 历史保留，未另建归档分支）。
3. ~~executor-python 401 自愈对齐 + reload-config 必然 401~~ ✅ 第十一轮已完成（request_with_self_heal + issueToken 幂等复用，真机实证）。遗留 N51 文档化事实：admin-api 重启后（签发缓存冷）任一执行器的首次 reload-config 会报错一次（rotate-on-push 固有，执行器一个心跳内自对齐后重试即成功）。
4. 跨平台矩阵（需真机）；minio 链 3 moderate 等上游发版。

## 未覆盖验证项

- macOS / Windows / ARM64 部署
- 通知渠道（企业微信/钉钉/邮件）实测
- 私有 npm/PyPI 仓库集成
- 大规模并发压测
- ~~多执行器负载均衡~~ ✅ 第五轮真机通过（双 executor 4 并发精确 2+2、无超卖）
- ~~LOG-11 S3 真机 E2E~~ ✅ 第五轮真机通过（minio 对象 + gunzip 内容一致 + API 读取闭环）
- ~~Leader Election 双实例~~ ✅ 第五轮真机通过（80 execution 无重复、kill 后 35s 接管；V2 复验修复后 96/96 success）

## 本轮变更要点（参考）

- **admin-api**：
  - `task.controller.ts` 新增 `GET /tasks/executions/:execId` 与 `GET /tasks/executions/:execId/logs`（compat alias，供 CLI/MCP 直接按 execId 查询）。
  - `task.service.ts` `getExecutionLogs` / `streamExecutionLogs` 增加 S3 分流；`storeLogLines` callback 路径优先 S3 上传 + 失败回退 DB；新增 enqueue 失败时把 PENDING 行标 FAILED（防 Redis 挂时悬挂）。
  - `executor.entity.ts` 把 executor 上报字段 `version` 重命名为 `executorVersion`，新增 TypeORM `@VersionColumn() version: number`（乐观锁）；`address` 加唯一索引 `uq_executors_address`。
  - `executor.service.ts` `selectLeastLoaded` / `dispatch` / `getTags` / `findAll` 加 `take` 上限；broadcast 路径保留全量（注释说明）。
  - `scheduler.service.ts` 新增「PENDING 超时回收」（10 分钟 grace 后置 FAILED）+ `schedulingTasks` Set 防 reload 与 scheduleOne 同 task 并发注册。
  - `main.ts` `POST /api/executions/callback` 路由单独配 55mb JSON limit（兼容批量回调），其它路由仍 1mb cap。
  - `verify-executor-token.util.ts` fail-closed timingSafeEqual（与 executor-node 端符号对齐）。
  - `task-execution.entity.ts` 新增 `logStorage` / `logObjectKey` 列；迁移 `1717473142690-AddExecutionLogStorage.ts`。
- **executor-node**：deploy/execute/health/logs 路径加固；connectivity 重试；file-logger 截断 marker 与 admin-api LOG-01 检测对齐。
- **admin-web**：`Executor.version → executorVersion`、`auth /me → /profile`、executor shared-token 路由迁移、`any` → `unknown`、未用 imports 删、空 catch 加注释、`_pollStartTime` state 移除；lint 0 errors。
- **acf-cli**：HTTP client 自动拆 ResponseInterceptor envelope；`task create/update/delete/pause/resume/kill/logs`、`app deploy/deployments/versions`、`task executions` 全部走正确路径与字段名。
- **mcp-server**：同 HTTP 拆包；新增 `kill_execution` / `pause_task` / `resume_task` / `list_deployments`；已有 `get_application` / `deploy_application` / `get_execution_logs` 配套。
- **docker-compose.yml**：minio profile（端口 9000/9001，volume，healthcheck）+ admin-api 注入 7 项 `LOG_STORAGE_*` 默认值。
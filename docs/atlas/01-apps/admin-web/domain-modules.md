# 非页面域逻辑模块（src/pages/*.ts）

> 所属: docs/atlas/01-apps/admin-web · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/src/pages/retry-policy.ts、timeout-policy.ts、task-dependencies.ts、failure-runbook.ts、maintenance-windows.ts、executor-mode.ts、retry-chain.ts、task-template-prefill.ts

## 职责

`src/pages/` 下有 8 个**非组件** `.ts` 模块（合计约 618 行）：任务/执行表单与详情页的「表单序列化 + 域映射」纯逻辑层。

- 独立成文件的统一理由（源码注释明示）：react-refresh 要求组件文件只导出组件；纯函数便于单测
- 全部无 React 依赖、无副作用，只做「表单值 ↔ 后端 DTO payload」的归一与映射

## 模块清单与导出（函数名逐一核实）

### executor-mode.ts（152 行）— R7(N19) 执行器策略

- `ExecutorMode = 'auto' | 'group' | 'pinned' | 'broadcast'`
- `normalizeAffinityTags(v)`：NF-04 亲和/反亲和标签归一为「非空数组 | 显式 null」
  - antd Select 清空后值可能是 undefined（未触碰）或 []（点 clear），都必须归 null——否则用户清空后旧约束仍在后端生效（可空 simple-array，PATCH 缺省=保留旧值）
- `affinityFormValues(task)`：编辑态回填（null/空数组归 undefined 给 antd Form 空态，提交侧再归 null）
- `deriveExecutorMode(task)`：后端任务 → 表单策略，优先级 broadcast > executorId（真 pinning，后端 dispatch 唯一认可）> executorAppName > group
- `buildExecutorPayload(...)`：表单 → DTO（executorId/executorAppName/group 等）
- `applyRequirementsPayload(...)`：requirements 序列化（undefined 归 null，同语义）

### retry-chain.ts（122 行）— CORE-02 执行详情重试链

- 链模型：同任务下 retryCount 递增的兄弟执行行
  - attempt 0 = 原始执行；attempt N = 第 N 次重试的载体执行行（executor_restart / stale_recovery / timeout_retry 等 re-enqueue 路径创建）
  - BullMQ 同执行行内 job 级自动重试（attempts/backoff）不产生新行、不在此链上
- `buildRetryChain(...)`：拼装链（含派生展示字段 RetryChainLink）
- `retryGapMs(prevEnd, nextStart)`：每次重试间隔 = 下一行 startTime − 上一行 endTime，不可算为 null
- `nextPendingRetryAt(chain)`：链上待重试的下一跳（ExecutionDetailPage 的 pendingRetry 提示）

### task-dependencies.ts（74 行）— NF-02 上游依赖编排

- 后端契约：tasks.dependencies jsonb = Record<taskId, taskName>（create-task.dto.ts「Upstream task dependency map」）；上游全部最近执行 SUCCESS 时由 task.service.triggerDependentTasks 自动扇出触发下游
- `buildDependenciesPayload(selected, nameSnapshot)`：
  - 选中 taskId 列表 → dependencies 映射；快照缺失（任务刚被删等竞态）以 taskId 兜底（后端只按 value 做环检测与扇出，name 仅展示）
  - **空集必须显式 null**（PATCH 是 Object.assign 语义，N28 教训：不发 null 会「界面已清空、后端仍保留旧依赖链」）
- 完整版还会**删除载体字段 upstreamDependencies**——全局 ValidationPipe whitelist + forbidNonWhitelisted 下，DTO 未声明的键直接 400（QA-01 / e2e 例 23-24 连红根因）

### timeout-policy.ts（74 行）— CORE-04 超时策略分级

- 常量：`TIMEOUT_WARN_RATIO_MAX = 90` / `MIN = 0`（对齐后端 @Max(90)；timeout 缺省 300s 时 90% = 270s 预警点）、`DEFAULT_TIMEOUT_ACTION = 'kill'`、`TIMEOUT_ACTION_OPTIONS`（kill 终止默认 / kill_retry 终止并重试 / notify_only 仅通知）
- 选项放本文件而非 api/tasks.ts：组件级测试对 api 层整模块 vi.mock，选项随 mock 丢失会炸渲染；纯逻辑文件不在 mock 范围
- `applyTimeoutPolicyPayload` / `timeoutPolicyFormValues`：
  - timeoutAction 恒有值（缺省 kill 仍显式提交，覆盖旧配置）；undefined 归 null
  - timeoutWarnRatio 空串/undefined/null 一律归 null（未启用预警——「清空输入框」必须发 null 才真正关闭）

### task-template-prefill.ts（59 行）— CORE-03 模板预填

- `templateConfigToFormValues(config)`：只搬表单实际消费的字段（triggerType/cronExpression/timezone/fixedRate/runtime/entrypoint/maxRetry/retryDelay/priority/params/timeoutAction/timeoutWarnRatio/亲和标签）；关键桥接：模板 `timeoutSeconds` → 表单 `timeout`
- `templateTriggerAndRuntime(tpl)`：同步组件内部 state（triggerType 影响条件渲染、runtime 影响 glue），缺省 manual/python

### retry-policy.ts（59 行）— CORE-01(RETRY-01) 重试白名单

- `RETRYABLE_ERROR_OPTIONS`：9 项 ExecutionFailureReason 中文文案（package_fetch_failed / dependency_install_failed / git_fetch_failed / runtime_missing / script_error / timeout / executor_offline / executor_restart / unknown）
  - 不含 killed（手动终止动作）与 stale_recovered（中台回收标记）——均非「错误类型」，作为可重试选项无意义
- 后端消费语义（task.processor.ts RETRY-01）：
  - 非空白名单 = 仅白名单内失败（错误消息子串或 failureReason 枚举值，大小写不敏感）才重试，其余转 UnrecoverableError 烧尽预算
  - null / undefined / [] = 全部可重试（既有行为）
- `applyRetryableErrorsPayload` / `retryableErrorsFormValues`：逐项 trim、丢空项；空集/未挂载显式归 null

### failure-runbook.ts（93 行）— UI-05 失败定位

- `FAILURE_RUNBOOK_ACTIONS`：BUG-10 十二类失败分类 → 中文建议动作（12 键含 unknown 兜底）
- 语义镜像 mcp-server tools.ts 的 FAILURE_RUNBOOK——跨包 import 违反 workspace 边界，有意复制；mcp 侧扩键需人工同步（双端无共享包，属有意取舍）
- 与页面 FAILURE_REASON_MAP 职责区分：后者管分类展示（Tag 颜色/中文名/一句话提示），本模块管「怎么做」（排障步骤）

### maintenance-windows.ts（47 行）— FEAT-06 任务级维护窗口

- `MAINTENANCE_WINDOWS_MAX = 10`（对齐后端 DTO ArrayMaxSize(10)）
- `applyMaintenanceWindowsPayload`：
  - 逐条 trim cron 与说明、丢弃 start/end 均空的「幽灵行」（点了添加行没填就提交）
  - **半填行原样保留**交给后端 DTO 结构校验 400——前端不静默吞半截输入
  - 空集显式 null（否则「界面已清空、调度仍在窗口内跳过」）

## 关键机制：PATCH「缺省=保留旧值」约定（N28）

后端任务更新是 Object.assign 语义：字段缺省 = 保留旧值，显式 null = 清空/回缺省。

- 所有「清空类」表单交互（清空白名单/依赖/维护窗口/亲和标签/预警比例）在提交侧必须归一为 `null`
- 否则出现「界面已清空、后端仍生效」的静默 bug
- 各模块的 `applyXxxPayload` / `buildXxxPayload` 是这层归一的唯一收口

## 常见改动场景

- 新增任务表单高级字段：先在对应域模块加选项常量 + payload 归一（含 null 语义）+ FormValues 回填函数，再进 TaskFormPage 接线；单测 `src/__tests__/<name>.test.ts`
  - 既有先例：retry-policy / task-dependencies / task-template-affinity-roundtrip / task-template-prefill
- 后端 failure reason 扩枚举：同步 retry-policy.ts 选项 + failure-runbook.ts + mcp 侧 tools.ts 三处（人工对齐）
- 模板 config 增字段：task-template-prefill.ts 的 pick 列表加一行

## 与其他文档的关系

- 依赖：仅类型（api/tasks.ts 的 MaintenanceWindow / TimeoutAction、api/task-templates.ts 的 TaskTemplate）
- 被依赖：[pages-tasks.md](pages-tasks.md)（TaskFormPage 接六个模块）、[pages-executions.md](pages-executions.md)（retry-chain / failure-runbook）
- 参照：[任务生命周期](../../04-flows/task-lifecycle.md)（重试/依赖扇出语义实现在后端 task.service.ts / task.processor.ts）

## 相关文档

[README](README.md) · [api-layer.md](api-layer.md) · [新增前端页面流程](../../08-workflows/add-new-web-page.md)

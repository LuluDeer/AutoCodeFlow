# 任务域页面（pages-tasks）

> 所属: docs/atlas/01-apps/admin-web · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/src/pages/TaskListPage.tsx、TaskFormPage.tsx、TaskDetailPage.tsx、TaskTemplatesPage.tsx

## 职责

覆盖任务全生命周期 UI：列表与批量操作、创建/编辑表单（重试/超时/依赖/维护窗口/执行器策略）、任务详情（执行记录/版本/Glue/AI）、模板库。四页合计约 2486 行，是 admin-web 最大的业务域。

## TaskListPage.tsx（502 行，路由 /tasks）

- 职责：任务表格（分页 + 名称/状态/触发类型筛选）、批量操作、新建/编辑/详情跳转
- 依赖：
  - `tasksApi`（api/tasks.ts）
  - `useTasksList` + `invalidateTaskData`（api/queries.ts；FEAT-17 已迁入 TanStack Query，写后失效句柄替代原 useRequest refresh）
  - `useDebounce`（搜索防抖；debounced 值进查询参数）
- 关键交互：
  - 行级批量选中 → `tasksApi.batchTrigger / batchPause / batchResume / batchDelete`（POST /tasks/batch/*）
  - 成功 `message.success` 带计数 → `refresh()`（invalidate 收口）
  - 错误经 `getErrMsg`（utils/error.ts）透出 toast
- 测试：task-list-deep

## TaskFormPage.tsx（1147 行，路由 /tasks/new 与 /tasks/:id/edit）

- 职责：全站最大页面，创建/编辑任务表单
- 依赖 api：`tasksApi`、`executorsApi`（执行器/分组下拉）、`applicationsApi`（应用归属）、`taskTemplatesApi`（另存为模板）
- 接线的域模块（全部见 [domain-modules.md](domain-modules.md)）：
  - `executor-mode.ts`：deriveExecutorMode（auto/group/pinned/broadcast 优先级）+ buildExecutorPayload + 亲和/反亲和归一 + applyRequirementsPayload
  - `retry-policy.ts`：retryableErrors 白名单选项 + applyRetryableErrorsPayload + retryableErrorsFormValues
  - `timeout-policy.ts`：timeoutAction + timeoutWarnRatio 归一
  - `maintenance-windows.ts`：维护窗口序列化（上限 10）
  - `task-dependencies.ts`：上游依赖编排（dependencies 映射 + 删载体字段）
  - `task-template-prefill.ts`：模板 config → 表单初值
- 关键交互：
  - `task-form/TriggerPreview.tsx` 展示 cron/fixed_rate 未来 5 次触发（计算在 utils/trigger-preview.ts）
  - `CronHelper` 组件辅助 cron 编写；`ParamsEditor` 编辑 params
  - `GlueEditor`（Monaco）编辑脚本，单独保存 `tasksApi.updateGlue`（PUT /tasks/:id/glue）
  - PATCH 语义「缺省=保留旧值」：清空类字段必须显式发 null（N28 教训，各域模块 applyXxxPayload 收口）
- 测试：task-form-page / task-form-affinity / task-form-save-as-template / task-form-ui06 / task-template-prefill / task-template-affinity-roundtrip

## TaskDetailPage.tsx（673 行，路由 /tasks/:id）

- 职责：任务详情——基本信息与状态行（含调度器健康 Tag）、启停/触发/编辑、执行记录列表（跳执行详情）、统计卡、版本历史与回滚、Glue 在线编辑、维护窗口展示、AI 能力
- 依赖 api：
  - `tasksApi`：pause / resume（返回保存后的 Task 实体，非 {success} 包装）/ trigger / versions / rollbackToVersion / compareVersions / stats
  - `taskTemplatesApi`（另存为模板）
  - `aiApi.suggestSchedule`（AI 调度建议）
- 数据面：`useTaskDetail` / `useTaskStats`（60s refetchInterval）/ `useSchedulerStats`（30s，页头健康 Tag 与 Dashboard 同源）
- 关键交互：
  - 版本对比弹窗用 `ExecutionCompare` 组件（compareVersions 端点）
  - 触发支持 params
  - 维护窗口展示（task-detail-maintenance 测试）
- 测试：task-detail-maintenance / task-dag-chain-trigger（DAG 图「从根触发整条链」）

## TaskTemplatesPage.tsx（164 行，路由 /task-templates）

- 职责：模板库（CORE-03）——列表、从模板一键实例化任务、删除
- 依赖：`taskTemplatesApi` + `useTaskTemplates`（api/queries.ts）
- 关键交互：
  - `taskTemplatesApi.instantiate(id, body)`：body 字段覆盖模板 config，至少需 name
  - 「用模板新建」：config 交 `task-template-prefill.ts` 的 `templateConfigToFormValues` 映射为 TaskFormPage 初值（`timeoutSeconds`→`timeout` 桥接；亲和标签 null/空数组归一）
  - `templateTriggerAndRuntime` 同步 triggerType/runtime 驱动表单条件渲染
- 测试：task-templates-page / task-templates-error-state

## 相关路由速查

| 路由 | 页面 | 参数 |
|---|---|---|
| `/tasks` | TaskListPage | — |
| `/tasks/new` | TaskFormPage | — |
| `/tasks/:id` | TaskDetailPage | 任务 id |
| `/tasks/:id/edit` | TaskFormPage | 任务 id |
| `/task-templates` | TaskTemplatesPage | — |

## 常见改动场景（任务侧加功能）

1. 后端加端点 → [api-layer.md](api-layer.md) 的 tasksApi 增方法（AbortSignal 可选透传）
2. 高频读 → queries.ts 加 hook（参数进 queryKey）；写操作成功后调 `invalidateTaskData(queryClient)`
3. 新表单高级字段 → 先在 `src/pages/<域>.ts` 加选项常量 + payload 归一（含 null 语义）+ FormValues 回填，再进 TaskFormPage 接线
4. 单测 → `src/__tests__/<name>.test.ts`（vitest，jsdom 环境）

## 与其他文档的关系

- 依赖：[api-layer.md](api-layer.md)（tasksApi/queries hooks）、[domain-modules.md](domain-modules.md)（六个表单序列化模块）、[components-and-layout.md](components-and-layout.md)（GlueEditor/TaskDependencyGraph/TriggerPreview/ParamsEditor/CronHelper）
- 被依赖：[新增前端页面流程](../../08-workflows/add-new-web-page.md) 以本域为典型示例
- 流程参照：[任务生命周期](../../04-flows/task-lifecycle.md)、[REST 接口地图](../../05-interfaces/rest-api.md)（重试/依赖扇出实现在后端 task.service.ts / task.processor.ts）

## 相关文档

[README](README.md) · [pages-executions.md](pages-executions.md)（执行详情是任务页跳转终点）· [domain-modules.md](domain-modules.md)

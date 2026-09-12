# runtime 模块 — 任务运行时注册表（描述层）

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/runtime

## 职责

ARCH-25：持有「runtime → 能力描述」的集中注册表，内置 python / node / shell 三项。它是**纯描述层**——不参与派发决策、不做准入校验，未来供任务表单选项、文档渲染、校验等消费方统一取口径。`@Global` 模块，任意模块免 import 直用。

## 目录结构与关键文件

```
modules/runtime/
├── runtime.module.ts               @Global()，providers/exports 仅 TaskRuntimeRegistry
├── task-runtime-registry.service.ts  注册表（Map 存储，register/override 纪律）
├── task-runtime.types.ts           TaskRuntimeDefinition / RegisterRuntimeOptions 类型
├── builtin-runtimes.ts             BUILTIN_RUNTIME_DEFINITIONS 内置三项（逐字段核源）
└── __tests__/task-runtime-registry.spec.ts
```

## 内置运行时定义（builtin-runtimes.ts）

| runtime | label | glueLanguage | dependencyInstaller | entrypoint 扩展名 | executorKind | 承载执行器 |
|---|---|---|---|---|---|---|
| `python` | Python | python | pip（uv pip 装入 per-task venv，W-21） | `py` | `executor-python` | executor-python |
| `node` | Node.js | node | npm | `js` | `executor-node` | executor-node |
| `shell` | Shell | shell | none | null（无固定扩展名） | `any` | 两侧执行器皆可（系统 shell；Windows 侧 .cmd 化，W-11/P-11） |

每项字段对应执行器侧真实存在的分支，`description` 写明承载边界（如 shell 跨平台语义差异大，慎用于强移植场景）。

## 关键机制

### 注册表纪律（task-runtime-registry.service.ts）

- `get(runtime)`：未知 runtime 返回 **null（fail-open）**——任何消费方不得因注册表缺项拒绝既有任务，描述层绝不变成准入闸门。
- `list()` / `get()` 返回**副本**，外部改动不污染内部状态。
- `register(definition, {override?})`：同名已存在且未显式 `override` 时抛错（防插件静默改写内置语义）。
- `isSupported(value)` / `has()` / `keys()`：与 `TaskRuntime` 枚举同源判定。

### 与 glue 脚本的关系

`tasks` 表的 `glueSource` / `glueLanguage`（在线编辑的 XXL-JOB GLUE 模式脚本，`PUT /api/tasks/:id/glue` 更新）由 runtime 描述的 `glueLanguage` 字段定义值域口径：python / node / shell。glue 任务不装依赖（执行器侧清空 `requirements`，用系统解释器），与 entrypoint 打包任务（`uv pip` per-task venv / npm）不同——这是内置定义 `dependencyInstaller` 字段的语义来源。

### 当前消费面（截至核对日）

注册表服务目前仅在自身模块内被引用，尚无业务链路消费（预留描述层）；任务创建的 runtime 字段校验仍走 `CreateTaskDto` 的 `TaskRuntime` 枚举（`IsIn` 语义，见 [task](task.md)）。扩展新 runtime（如 deno）的示例见 `docs/development.md`「ARCH-25 任务 runtime 注册表」节——需同时落实执行器侧分支后再注册。

## TaskRuntimeDefinition 字段（task-runtime.types.ts）

| 字段 | 语义 | 示例（python） |
|---|---|---|
| `runtime` | 键，与 `TaskRuntime` 枚举同源 | `"python"` |
| `label` | 展示名 | `"Python"` |
| `glueLanguage` | GLUE 模式脚本语言值域 | `"python"` |
| `dependencyInstaller` | 依赖安装器描述 | `"pip"` |
| `defaultEntrypointExtension` | entrypoint 典型扩展名 | `"py"` |
| `defaultRuntimeVersion` | 默认运行时版本 | `null` |
| `executorKind` | 承载执行器标记 | `"executor-python"` |
| `description` | 边界说明（中文，逐条核源） | glue/entrypoint 均由 Python 解释器执行… |

`register(definition, {override})` 与内置三项共用同一 Map；扩展项在 `TaskRuntime` 枚举与执行器侧分支落实之前注册无意义（描述层不是准入闸门，也不会凭空创造能力）。

## 与其他模块的关系

- 依赖 [task](task.md)：仅 import `TaskRuntime` 枚举与 `TaskRuntimeDefinition` 类型（类型层依赖，无运行时环）。
- 被（规划中）任务表单/校验消费：`@Global` 使消费方零成本取用。
- 执行器侧对应实现：[executor-node](../../../01-apps/executor-node/README.md)、[executor-python](../../../01-apps/executor-python/README.md)（规划路径）——新增 runtime 必须两侧同步。

## 常见改动场景

- 新增内置 runtime：`TaskRuntime` 枚举（task.entity.ts）+ `BUILTIN_RUNTIME_DEFINITIONS` 加项 + 执行器侧真实分支 + `tasks.runtime` PG 枚举迁移，四处同步；缺一不可（描述层字段"逐条核源，不臆造能力"）。
- 修改既有 runtime 描述：只改 `builtin-runtimes.ts`（纯描述，无行为影响）；但 `executorKind`/`dependencyInstaller` 的语义承诺要对齐执行器实现。
- 把注册表接入校验链：保持 fail-open（get 返回 null 不拒绝），除非明确要收紧为准入闸门（当前设计明确反对）。

## 相关文档（速查）

- 改动前置阅读顺序：本篇 → [task](task.md) 的 TaskRuntime/glueSource 字段 → [executor](executor.md) 的 capabilities 过滤 → 目标执行器应用文档。

## 相关文档

- [task](task.md)（TaskRuntime 枚举来源、glueSource 字段）
- [executor](executor.md)（capabilities 匹配 runtime 的派发过滤）
- [核心概念](../../../00-overview/05-core-concepts.md)（规划路径）

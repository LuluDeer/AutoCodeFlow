# task-template 模块 — 任务模板

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/task-template

## 职责

CORE-03「任务模板与一键克隆」：把常用任务形态固化为可复用模板（官方预置 + 用户自定义），提供模板 CRUD 与「从模板实例化任务」。`config` 是合法 `CreateTaskDto` 子集，实例化时作为默认值、显式传入字段覆盖。

## 目录结构与关键文件

```
modules/task-template/
├── task-template.module.ts        装配：TypeOrmModule.forFeature(TaskTemplate) + TaskModule
├── task-template.controller.ts    @Controller("task-templates") 全部路由
├── task-template.service.ts       CRUD + instantiate（复用 TaskService.create）
├── task-template.constants.ts     OFFICIAL_TASK_TEMPLATES 五个官方模板 seed + officialSeedSql()
├── task-template.util.ts          assertValidTaskTemplateConfig / expandTemplateConfigIntoTaskDto /
│                                  suggestTemplateKey / assertValidCreateTaskPayload
├── dto/create-task-template.dto.ts
└── entities/task-template.entity.ts  task_templates 表（key 全局唯一，config jsonb，isOfficial）
```

## 路由（controller 前缀 `task-templates`，实际路径 `/api/task-templates`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | JWT | 官方在前（`isOfficial DESC`），其余按创建时间倒序 |
| GET | `/:id` | JWT | 单条详情 |
| POST | `/` | JWT | 创建自定义模板；`key` 冲突 409；config 经 `CreateTaskDto` 语义校验（脏模板 400 不落库） |
| POST | `/:id/instantiate` | JWT | 展开模板 config + 请求体覆盖 → `TaskService.create` 生成可运行任务；body 至少含 `name` |
| DELETE | `/:id` | JWT | 官方模板（`isOfficial=true` 或 key 命中 `OFFICIAL_TEMPLATE_KEYS`）拒删 403 |

## 关键机制

### 官方模板（单一事实源）

`task-template.constants.ts` 的 `OFFICIAL_TASK_TEMPLATES` 是迁移 seed（`officialSeedSql()` 生成 `ON CONFLICT (key) DO NOTHING` 的幂等 INSERT）与单测共用的唯一来源。五个 key 与 `packages/mcp-server/src/tools.ts` 的 `TASK_TEMPLATES`（ECO-03）**逐项对齐**，避免 admin 与 MCP 两套模板语义漂移：

| key | 名称 | 定位 |
|---|---|---|
| `scheduled_backup` | 定时备份 | cron `0 2 * * *`，shell，重试 3 次，冲突丢弃 |
| `health_check` | 健康巡检 | fixed_rate 60s，shell，不重试 |
| `data_sync` | 数据同步 | fixed_rate 1800s，python，重试 2 次 |
| `log_cleanup` | 日志清理 | cron `30 3 * * *`，shell，轻试 1 次 |
| `webhook_ping` | Webhook 通知 | manual，node，作下游串联 |

### 实例化合并语义

```
POST /api/task-templates/:id/instantiate  {name: "每晚备份", cronExpression: "0 1 * * *"}
  ├─ 剥离 body.templateId（防越权指定他模板）
  ├─ expandTemplateConfigIntoTaskDto(tpl.config, body)   ← 显式字段覆盖模板默认值
  ├─ assertValidCreateTaskPayload(merged)                ← 再走 CreateTaskDto 校验
  └─ TaskService.create(dto)                             ← 生成可运行任务（默认 paused 无关，
                                                            触发类型即刻可用）
```

模板 `config` 不含 `name`，实例化时必须提供；`key` 未传时由 `suggestTemplateKey(name)` 生成（slug 化，冲突 409）。

## 实体要点（task_templates 表）

| 列 | 说明 |
|---|---|
| `key` | varchar(64) 全局唯一索引；官方模板固定 `scheduled_backup` 等，自定义唯一 |
| `config` | jsonb，合法 CreateTaskDto 子集（不含 `name`），落库前语义校验 |
| `isOfficial` | 官方标记（迁移 seed 置 true）；API 创建恒 false |
| `category` | varchar(32) 粗分类标签（备份/巡检/同步/清理/通知…），前端渲染 Tag |

无 `deletedAt` 软删列、无版本表——模板即单一当前态，任务实例化后与模板解耦（改模板不影响已创建任务）。

## 与其他模块的关系

- 依赖 [task](task.md)：`instantiate` 与 config 校验均复用 TaskService / CreateTaskDto 语义（单向依赖，无环）。
- 与 packages/mcp-server 弱耦合：五个官方 key 约定对齐（改 key/字段需两侧同步，见 constants 头注警告）。
- 被 admin-web 模板选择页消费（GET 列表 + instantiate）。

## 常见改动场景

- 新增官方模板：改 `OFFICIAL_TASK_TEMPLATES`（自动派生 seed SQL）；同步 `packages/mcp-server/src/tools.ts` 的 `TASK_TEMPLATES`；跑一次迁移即可幂等补种。
- 调整 config 字段集：以 `CreateTaskDto` 白名单为准，`assertValidTaskTemplateConfig` 会拒绝 DTO 不认识的字段。
- 模板支持更新（PATCH）：当前 controller 未提供 update 路由，需新增端点并在 service 放开官方模板保护策略。

## 相关文档

- [task](task.md)（TaskService.create / CreateTaskDto 是 config 校验基准）
- [MCP Server](../../../02-packages/mcp-server.md)（ECO-03 模板对齐，规划路径）
- [Task 实体](../../../03-data/entities/task.md)（规划路径）

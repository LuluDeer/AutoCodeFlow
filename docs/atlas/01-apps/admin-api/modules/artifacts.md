# artifacts 模块 — 执行产物上传 / 下载（FEAT-05）

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/artifacts

## 职责

任务执行产物（artifact）通道：执行器把任务工作目录 `artifacts/` 下收集的文件逐个 PUT 到 admin（机器对机器），管理台按执行 ID 列清单、流式下载。清单随终态回调 best-effort 上报（收集/上传失败绝不阻塞任务终态）。

## 目录结构与关键文件

```
modules/artifacts/
├── artifacts.module.ts            装配：TaskModule + ExecutorModule（凭据校验依赖）
├── artifacts.controller.ts        上传/清单/下载三路由（无统一前缀，见下）
├── artifacts.service.ts           路径守卫/落盘/sha 校验/清单读取/上传鉴权
├── artifacts.constants.ts         根目录、数量/大小上限、安全文件名正则
├── artifacts-retention.service.ts 每日 TTL 清理（LOG_RETENTION_DAYS，与日志保留期同源）
└── __tests__/artifacts.service.spec.ts
```

## 路由

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| PUT | `/api/executions/:execId/artifacts/:name` | `@Public()` + 处理器内校验执行器凭据 | 上传单个产物（multipart 字段名 `file`；机器通道命名对齐 `executions/callback`） |
| GET | `/api/tasks/executions/:execId/artifacts` | 全局 JWT | 产物清单（读 `task_executions.artifacts` jsonb） |
| GET | `/api/tasks/executions/:execId/artifacts/:name` | 全局 JWT | 流式下载（`stream.pipeline` 直写响应） |

上传与下载基路径刻意不同：上传挂 `executions/...`（机器面），下载挂 `tasks/executions/...`（管理台面，对齐计划书）。

## 关键机制

### 落盘与校验

- 根目录：env `LOG_ARTIFACT_DIR`（计划书概念名），缺省 `<cwd>/uploads/artifacts`；产物按执行 ID 分子目录 `<root>/<execId>/<name>`。
- 上限：单执行最多 `MAX_ARTIFACT_COUNT=20` 个、单文件 `MAX_ARTIFACT_SIZE_BYTES=100MB`（multer memoryStorage 同限额，超限执行器侧跳过、admin 侧 PUT 拒绝）。
- 文件名安全：`SAFE_ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/`（杜绝路径分隔符与 `..`），且 `path.basename(name)===name`、结果必须仍在 execId 目录内（纵深防御路径穿越）。
- 完整性：服务端重算 SHA-256，与 `?sha256=` 声明值不符抛 400；原子写 `<name>.tmp-<rand>` 后 rename。
- 下载 Content-Type 按扩展名映射（`CONTENT_TYPE_BY_EXT`：png/csv/json/pdf/zip/xlsx 等，未知 `application/octet-stream`）。

### 上传鉴权（verifyUploadAuth）

复用终态回调同一套凭据（两条渠道任一命中即放行，见 [executor](executor.md)）：

1. 执行器共享 token：`verifyExecutorToken`（DB 轮转值 / env `EXECUTOR_SECRET`）；
2. 每执行器动态 token：`executorService.validateTokenByAddress(exec.executorAddress, token)`（bcrypt）。

校验前先确认执行行存在（404），否则 401。

### 清单与保留期

- 清单来源：执行器在终态回调 `CallbackItemDto.artifacts`（`ArrayMaxSize` 对齐 20）携带 `{name,size,sha256}[]`，`TaskService.handleCallback` 写入 `task_executions.artifacts`；GET 清单端点只读该列（文件本体是否已 PUT 是 best-effort，可能存在「清单有、文件无」的下载 404）。
- TTL：`ArtifactsRetentionService` 每日按 `LOG_RETENTION_DAYS`（`configuration.logRetention.days`，默认 30）删除过期 execId 目录，防止 uploads 卷无限膨胀（与 task 日志保留期清理同一天/同一配置）。

## 三步协议（执行器视角时序）

```
执行器（任务结束，工作目录 artifacts/ 已收集文件）
  ① PUT /api/executions/<execId>/artifacts/<name>   ← 逐文件，Bearer 执行器 token
       （逐个 best-effort：单个失败只记日志，继续其余文件）
  ② 终态回调 POST /api/executions/callback
       items[].artifacts = [{name,size,sha256}, …]   ← 清单随终态一并上报
       TaskService.handleCallback 写入 task_executions.artifacts
  ③ 管理台 GET /api/tasks/executions/<execId>/artifacts[/name]
       清单页 / 流式下载
```

①② 顺序不强制（清单允许先于部分文件到达，下载 404 需按 best-effort 语义理解）；③ 只依赖 ②。

## 与其他模块的关系

- 依赖 [task](task.md)：读 `TaskExecution`（清单列）——task 模块 export `TaskService` 供其装配（经 TaskModule）。
- 依赖 [executor](executor.md)：`validateTokenByAddress` 上传鉴权。
- 被 [task](task.md) 间接依赖：回调 DTO 的 `artifacts` 字段定义在 `task-execution.entity.ts`（`ExecutionArtifact` 接口），artifacts 模块是消费方。
- 执行器侧约定：工作目录 `artifacts/` 收集 → 终态回调带清单 → 逐文件 PUT（三步协议，executor-node / executor-python 各自实现）。

## 常见改动场景

- 提高数量/大小上限：`artifacts.constants.ts` 三个常量 + controller multer limits + 执行器侧上限对齐（三处）。
- 换对象存储（如迁 MinIO）：`saveArtifact/openArtifact` 是落盘边界，保持 `{stream,fileSize,contentType}` 返回形状即可。
- 新增 Content-Type：`CONTENT_TYPE_BY_EXT` 映射表加行。
- 排查「清单有但下载 404」：执行器 PUT 失败属 best-effort，看 admin 日志 `FEAT-05: stored artifact` 与执行器侧上传日志。

## 相关文档

- [task](task.md)（回调清单入口 handleCallback）
- [executor](executor.md)（上传凭据）
- [task-execution 实体](../../../03-data/entities/task-execution.md)（规划路径）
- [执行回调流程](../../../04-flows/execution-callback.md)（规划路径）

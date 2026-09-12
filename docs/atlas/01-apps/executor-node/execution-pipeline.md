# executor-node 执行管线（领取 → 执行 → 回调）
> 所属: docs/atlas/01-apps/executor-node · 最后核对: 2026-09-13 · 对应代码: apps/executor-node/src/routes/execute.ts、src/task-worker.ts、src/callback.ts、src/artifacts.ts

## 全链路总览

```
admin-api (BullMQ worker)                     executor-node
─────────────────────────                     ──────────────────────────────────────────
POST http://<addr>/api/execute  ───────────▶  routes/execute.ts executeRouter
  {executionId, task, params}                   │ 同步段：容量原子预检(429) / executionId
  Authorization: Bearer <shared>                │ 安全校验 / 重复领取守卫 / 参数 400
  traceparent(可选)                             │ 登记 liveExecutions + 立即 200
                                                ▼ {status:'accepted', executionId}
                                              startExecutionInBackground()
                                                │ mkdir 0700 → 交给 TaskWorkerManager
                                                ▼ （同一 taskId 串行，空闲 5 分钟回收）
                                              prepareExecution()（worker 轮到才执行）
                                                ├─ gitCheckoutTo()      clone--bare 缓存
                                                ├─ loadManifest()       manifest.yaml 合并
                                                ├─ glue 脚本落盘        glue_script.js/.py/.sh|.cmd
                                                ├─ npm install --prefix .node_modules/<taskId>
                                                │    （临时 .npmrc，token 只进文件）
                                                └─ buildChildEnv() + 注入 AUTOFLOW_* 
                                                ▼
                                              runTask() → spawn（POSIX detached / win32 windowsHide）
                                                ├─ stdout/stderr → BoundedLogBuffer（头尾各 500KB）
                                                ├─ 同步落盘 logs/<日期>/<executionId>.log
                                                └─ 超时 killProcessTree(SIGKILL)
                                                ▼
                                              pushCallback() → 回调线程 POST /api/executions/callback
                                              （终态前先 collectTerminalArtifacts 上传产物）
```

## 1. 任务领取（POST /api/execute，同步段）

同步段只做廉价校验与登记（`execute.ts` 内注释：admin 侧 dispatch HTTP 超时为 `(task.timeout+10)s`，prepare 耗时 clone 120s + fetch 60s + install 300s 可能超出，故 prepare 全部后台化）：

- **容量**：`Atomics.add` 先加再判，超 `config.maxConcurrentTasks` 立即 `429 {error:'Executor is at capacity'}`。
- **executionId**：必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`（用作 workDir 目录名，防路径穿越 S6/Q11）；`validateExecutionWorkDir()` 再做 resolve 前缀 + symlink 双检。
- **重复领取**：`liveExecutions.has(executionId)` 命中即 `400`（429→BullMQ 重试可能重复派发慢执行）。
- **gitRepo SSRF（S7）**：仅允许 `http(s)/git@/ssh://`，拒绝 RFC1918 私网与 loopback；ref 以 `-` 开头拒绝（防 git 选项注入）。
- **requirements**：逐个过 npm 包名正则 `/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[\w.^~-]+)?$/i`（S16）。
- **timeout**：`0` = 不限时；否则夹在 1..86400。
- **traceparent**（OBS-01）：记录 W3C 头，后续注入任务 env `AUTOFLOW_TRACE_ID` 并随回调回传。

## 2. 载体解析（prepare 阶段，worker 内执行）

执行顺序即 `prepareExecution()` 代码顺序，任一步失败按 `prepareFailureReason()` 归类为 `git_fetch_failed` / `dependency_install_failed` / `runtime_missing` / `package_fetch_failed` / `unknown` 后走失败回调：

1. **git 载体**：`gitCheckoutTo(repoUrl, ref, workDir)` —— 裸仓库缓存 `WORK_DIR/.git_cache/<清理名>-<sha256(url)前12位>`；缓存先经 `isBareGitRepo()`（`git rev-parse`）有效性探测，坏缓存改名隔离（`-broken-<ts>`）后重克隆。clone 120s / fetch --all 60s / `--work-tree checkout ref -- .` 导出 30s。同一缓存目录经 `queueGitCheckout` 串行，防并发 clone 竞态。
2. **manifest**：`loadManifest()` 读 `manifest.yaml|yml`，`mergeTaskWithManifest()` 以任务字段优先合并、requirements 并集去重。
3. **glue 脚本**：`glueSource` 写入 `glue_script.js|.py|.sh(win32 为 .cmd)`，chmod 0755，entrypoint 指向该文件，且 **glue 任务 requirements 强制清空**（用系统运行时）。
4. **依赖安装（runtime=node 且有 requirements）**：
   - 共享目录 `WORK_DIR/.node_modules/<taskId>/`，首次写占位 package.json；同任务经 `queueTaskInstall` 串行。
   - `npm install --prefix <dir>`，超时 300s；配置了 `NPM_REGISTRY_TOKEN` 时追加 `--ignore-scripts`（防安装脚本读取 token 文件）。
   - 临时 .npmrc 由 `createTemporaryNpmConfig()` 生成于 `os.tmpdir()/autocodeflow-npm-*`（目录 0700、文件 0600），内容见 `buildNpmRcContent()`：恒写 `@autoflow` / `@autocodeflow` 两个 scope registry 行；仅当 requirements 含非内部 scope 包才写全局 `registry=` 行；有 token 追加 `//<host:port>/:_authToken=`。npm 子进程 env 仅注入 `npm_config_userconfig/globalconfig/registry/cache/prefix`，token 永不进环境变量；npm 退出后 finally 删除整个临时目录（删除失败视为致命）。
   - 运行时解析：`NODE_PATH` 指向 `<dir>/node_modules`（npm `--prefix` 落点，点前缀目录 Node 解析链够不到）。
5. **运行时命令**：node → `node <entrypoint>`；python → `python3`（win32 `python.exe`）；shell → `bash <entrypoint>`（win32 `cmd.exe /c <entrypoint>`）。entrypoint 经 `path.resolve` 校验不得逃出 workDir。

## 3. 子进程执行与环境注入

`buildChildEnv()`（env-whitelist.ts，SEC-01）只转发白名单变量（PATH/HOME/TZ/Windows 系统变量等），`EXECUTOR_SHARED_TOKEN`、`EXECUTOR_SECRET`、`EXECUTION_CALLBACK_SECRET` 在 `SECRET_ENV_DENYLIST` 中恒被剥离；win32 按大小写不敏感匹配后回写规范名（W-20）。

在此之上显式注入（顺序在用户 params 之后，用户不可覆盖）：

| env | 来源 | 用途 |
|---|---|---|
| `EXECUTION_ID` / `TASK_ID` / `TASK_NAME` | 派发载荷 | 任务自身上下文 |
| `AUTOFLOW_<PARAM>` | `params` 逐项 | 用户参数 |
| `AUTOFLOW_CALLBACK_TOKEN` | `createExecutionCallbackToken()`，TTL = timeout+900s（不限时任务取 315_360_000s） | 每执行一次性回调令牌（N23，格式 `v1.<executionId>.<expiresAt>.<hmacHex>`） |
| `AUTOFLOW_ADMIN_API_URL` | `adminApiUrlInternal || adminApiUrl` | SDK 回调路由 |
| `AUTOFLOW_EXECUTOR_ADDRESS` | 注册地址（N27） | 回调载荷必填 executorAddress |
| `AUTOFLOW_ARTIFACTS_DIR` | `<workDir>/artifacts/`（FEAT-05） | 产物约定目录 |
| `AUTOFLOW_TRACE_ID` | dispatch 的 traceparent（OBS-01） | 全链路追踪 |

spawn 细节（`runProcess()`）：POSIX `detached: true`（独立进程组，超时负 pid 组杀）、win32 `windowsHide: true`（独立隐藏控制台，W-14）；日志内存缓冲 `BoundedLogBuffer` 头尾各 500KB 截断（防 OOM），全量输出经 `file-logger.ts` 缓冲写（200ms 批量 flush）落 `logs/<YYYY-MM-DD>/<executionId>.log`；超时与 kill 均走 `killProcessTree`（win32 `taskkill /T /F`）。

## 4. 产物与状态回调

- **产物（FEAT-05）**：终态回调前 `gatherArtifacts()` 扫描 `<workDir>/artifacts/` 顶层普通文件（≤20 个、单个 ≤100MB、文件名 `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$`），逐个 `PUT /api/executions/:execId/artifacts/:name?sha256=<hex>`（Bearer 动态 token），清单 `[{name,size,sha256}]` 随终态回调上报；全程 best-effort，异常只记日志。
- **meta 落盘**：`writeExecMeta()` 维护 `WORK_DIR/meta/<executionId>.json`（startTime/status/exitCode/errorMessage/endTime），桌面端历史页与通知轮询都消费它。
- **回调线程**（callback.ts）：`pushCallback()` 入内存队列（同 executionId 覆盖去重，恒补 `executorAddress`）；线程每 1s 取批 → 按 100 条/批切分（admin 硬上限）→ 每批最多 5 次指数退避重试（1s 基数）→ 仍失败落盘 `WORK_DIR/callbacks/callback-*.json`（`.meta` 记轮次）→ 后续重发 5 轮后移入 `dead-letter/`。停机 drain 上限 10s。日志截断策略：logs 保留头 5KB+尾 5KB（≤10KB），errorMessage ≤4000（admin DTO 上限 4096）。

```
pushCallback ──▶ callbackQueue ──▶ doCallback(批≤100)
                                    │ 失败×5(指数退避)
                                    ▼
                     WORK_DIR/callbacks/callback-*.json (.meta retries)
                                    │ 重发≤5轮 / >64MB / 损坏
                                    ▼
                     WORK_DIR/callbacks/dead-letter/（人工重放）
```

## 5. kill 与停机

- **kill（admin 发起）**：`POST /api/executions/:executionId/kill` —— 未移交 worker：立即补推 killed 回调并释放；仍在队列：`taskWorkerManager.cancelExecution()` 摘除后收尾；已 spawn：`killProcessTree(SIGKILL)`，close 路径据 `killedByRequest` 标记 `failureReason: 'killed'`。回调恒只推一次（`pushKilledCallbackOnce` + release 幂等）。
- **执行器停机**：`gracefulShutdown()` 顺序为 停心跳 → `server.close()` → 停清理线程 → `taskWorkerManager.stopAll()`（排队任务推 `failed: Executor is shutting down...`）→ 等 30s → 超时 `killRunningTaskProcesses()` 树杀 → `stopCallbackThread()` drain → `flushLogs()` → `POST /api/executors/offline`。

## 常见改动场景

- **新增 prepare 步骤**（如缓存预热）：放进 `prepareExecution()`，注意在每个检查点调用 `checkAbort()` 响应 kill。
- **改回调载荷**：`CallbackRequest`（callback.ts）必须与 admin `CallbackItemDto`（apps/admin-api/src/modules/task/dto/execution-callback.dto.ts）字段级一致，超限字段会导致整批被拒。
- **调依赖安装并发**：`queueTaskInstall` 按 taskId 串行是防止 `.node_modules/<taskId>` 竞态的关键，改动前先看其注释。

## 相关文档

- [executor-node 总览](README.md) —— 启动/配置/目录
- [执行器协议契约](../executor-contract.md) —— 各接口字段表
- [回调上报流程](../../04-flows/execution-callback.md) · [任务生命周期](../../04-flows/task-lifecycle.md)
- [admin-api artifacts 模块](../admin-api/modules/artifacts.md) —— 产物落库与下载端

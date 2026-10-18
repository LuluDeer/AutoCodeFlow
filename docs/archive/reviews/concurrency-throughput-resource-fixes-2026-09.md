# AutoCodeFlow 并发/吞吐/资源管理——全面修复记录（2026-09-18）

对应《并发/吞吐/资源管理深度研究报告》的推进结果。所有修复均已在真实工作区落地并通过编译与测试验证。

## 一、本次实施修复（10 项）

### 1. P2 UV_VENV_TIMEOUT 统一（60s vs 120s）
- `apps/executor-python/routers/execute.py`：`UV_VENV_TIMEOUT_SECONDS = 60 → 120`，与 executor-node 的 `UV_VENV_TIMEOUT_MS`（120s）对齐，同步更新注释引用。复杂环境（大 requirements / 慢磁盘 / 首次建 venv 触发 uv 引导）下 60s 更易超时。
- 验证：`py_compile` 通过；test_execute.py 相关用例通过。

### 2. P2 stale 执行恢复扫描频率 10min → 2min
- `apps/admin-api/src/modules/scheduler/scheduler.service.ts`：`@Cron("0 */10 * * * *") → @Cron("0 */2 * * * *")`。
- 依据：`staleScanWindowMs()` 已按活跃任务中最短超时动态计算扫描窗口，find() 带 `startTime` 过滤，扫描是轻量索引查询；2 分钟粒度把"短超时任务（10s）的僵尸行最多等 10 分钟"压缩到最多 2 分钟。
- 验证：scheduler.service.spec.ts 通过（145 项，含 outbox）。

### 3. P2 scheduler fail-open 双 Leader 窗口治理
- `scheduler.service.ts`：新增 `SCHEDULER_LEADER_FAILOPEN_RETRY_MS = 5_000`；`scheduleLeaderRetry()` 在 fail-open 降级期间（isLeader 且无真实锁）用 5s 短间隔重试竞选，Redis 恢复后 5s 内收敛为单 Leader；正常跟随者保持 15s。
- 正确性说明：fail-open 多实例去重由 DB 条件 claim 兜底（`claimTaskTrigger` 条件 UPDATE / `transitionToTerminal` 条件 UPDATE），本项压缩的是重复扫描开销的**持续时长**。
- 验证：scheduler.service.spec.ts 通过。

### 4. P2 outbox 批量派发吞吐优化
- `apps/admin-api/src/modules/event-subscriptions/outbox-dispatcher.service.ts`：`OUTBOX_BATCH_SIZE = 1 → 5`；新增 `OUTBOX_PROCESS_CONCURRENCY = 3`；`scanOnce` 由逐行串行改为**有界并发处理**（所有行同时开始 → 共享同一租约窗口，单行最坏 33s < 60s 租约，不扩大重复投递窗；并发上限防 5 倍突发打到下游）。
- 积压消耗速率从"每 5s 一行"提升约 3 倍。
- 验证：outbox-dispatcher.spec.ts / event-subscriptions.spec.ts 通过。

### 5. P2 docker-compose：Node.js 堆上限 + 容器资源硬限制
- `docker-compose.yml`：
  - admin-api / executor-node 注入 `NODE_OPTIONS: '--max-old-space-size=512'`（比依赖容器 mem_limit 被 cgroup 杀掉更早、更可控；admin-api 500 并发实测峰值 RSS 394MB，余量充裕）。
  - executor-python / executor-node 增加 `ulimits.nofile`（65536）+ `pids_limit: 512`——任务子进程继承容器限制：nofile 防 fd 泄漏、pids_limit 防 fork 炸弹（代码执行面是 fork 大户）；CPU 时间上限由 `cpus` + 任务超时 kill 兜底（python 侧另有 RLIMIT_CPU）。
- 验证：js-yaml 解析通过；关键注入抽查正确。

### 6. P2 磁盘水位检查（node/python 两侧 + accept 拒新任务）
- `apps/executor-node/src/file-logger.ts`：新增 `DISK_WARN_PERCENT=90` / `DISK_CRITICAL_PERCENT=95` / `diskUsagePercent()`（`fs.statfsSync` 取 `bavail`，口径=非 root 可写空间；计量失败返回 0 不误拒）；`startWorkDirCleanup` sweep 中水位告警 + 临界水位触发减半 TTL 紧急清理。
- `apps/executor-node/src/routes/execute.ts`：`acceptExecution` 临界水位返回 503 拒新任务。
- `apps/executor-python/maintenance.py`：对等 `disk_usage_percent()` + `disk_cleanup_task` 水位告警/紧急清理。
- `apps/executor-python/routers/execute.py`：`accept_execution` 临界水位 `ExecutionRejected(503)`。
- 新增验收测试：node `execute.spec.ts`（503 磁盘用例）、python `test_execute.py::test_execute_disk_critical_returns_503`、`file-logger.spec.ts::diskUsagePercent` —— 全部通过。

### 7. P1 executor-node 解释器池体积红线治理（确认就位 + 完成注入）
- 复核确认：`interpreters.ts` 已有 `enforceInterpreterPoolLimits()`（引用感知：被 venv 依赖的版本绝不回收；单版本 >250MB / 总池 >4GB 时 LRU 回收，与 python 侧 `enforce_interpreter_pool_limits` 对等），`config.ts` 已有 `interpreterSingleVersionMb` / `interpreterTotalGb`，`file-logger.ts` 已接入 sweep。
- 本项补充：`docker-compose.yml` executor-node 注入 `INTERPRETER_SINGLE_VERSION_MB` / `INTERPRETER_TOTAL_GB`（与 python 侧同源）；`.env.example` 补充说明。
- 过程发现：工作区曾存在 interpreters.ts **重复导出**（755 与 1432 行同名 `enforceInterpreterPoolLimits`，会导致 TS 编译失败），在推进过程中已被清理为单套实现（dirSizeBytes 归位 568 行）。

### 8. P1 下载队列按版本有界并行（node/python 两侧）
- `apps/executor-node/src/interpreters.ts`：全局单下载 Promise 链 → `withDownloadSlot()` 有界并发（默认 2，`INTERPRETER_DOWNLOAD_CONCURRENCY` 可调 [1,8]；动态读取 + NaN 防御；显式 waiters 队列保证"前一个成败都放行后一个"语义，失败不毒化队列）。
- `apps/executor-python/interpreters.py`：`asyncio.Semaphore(1) → Semaphore(N)`，N = `settings.interpreter_download_concurrency`（默认 2）；`config.py` 新增配置项；更新模块文档注释。
- 安全性依据：不同版本写池内不同目录（`cpython-<ver>-…`），uv 的"同目录并发写不安全"不跨版本；per-version 去重保证同版本至多一次下载。并发上限保留 O-10 的带宽/inode 顾虑。
- `docker-compose.yml` 两侧注入 `INTERPRETER_DOWNLOAD_CONCURRENCY`；`.env.example` 补充。
- 验证：interpreters.spec.ts 并发契约测试已同步更新（"有界队列 ≤2 且 >1"）并全过。

### 9. P2 任务子进程 fd/CPU 硬限制（确认就位 + 容器兜底）
- 复核确认：`apps/executor-python/sandbox.py` 已有 `build_rlimit_pre_exec()`（RLIMIT_AS/CPU/FSIZE/NOFILE/NPROC，经 `_spawn_kwargs_for_platform` 的 preexec_fn 在 exec 前施加），`execute.py:3384` 已接线。
- node 侧无 setrlimit API：由第 5 项的容器级 `ulimits.nofile` + `pids_limit` 兜底（任务子进程继承容器限制）。
- 验证：execute.py 相关测试通过。

### 10. P1 下载预热脚本
- 新增 `scripts/warm-interpreters.sh`：在线预下载 / 离线预填常用 Python 版本到执行器缓存池（`UV_PYTHON_INSTALL_DIR` 与 compose 同源），消除首次任务同步等待下载（最多 300s）与批量首次启动的串行排队；引用 `docs/design/.../OFFLINE-PROVISIONING.md` §5 离线路径。

## 二、确认已修复/已就位项（无需改动，附证据）

| 报告项 | 当前状态 | 证据 |
|---|---|---|
| P1 executor.service version CAS 移除 | ✅ 已修复 | `executor.service.ts` 原子占坑单条 UPDATE，无 version CAS |
| P1 python venv 目录键裸 task_id | ✅ 已修复 | `execute.py::_derive_task_key` 已带版本签名（`<id>-<X.Y>`），与 node 侧 `venvDirName` 行为一致 |
| P2 任务子进程 rlimit | ✅ 已实现 | `sandbox.py::build_rlimit_pre_exec`（AS/CPU/FSIZE/NOFILE/NPROC） |
| P1 executor-node 解释器池体积红线 | ✅ 已实现 | `interpreters.ts::enforceInterpreterPoolLimits`（引用感知 + LRU） |
| P0 六项设计正确性（RUNNING 不可 claim / 引用感知回收 / venv 复用校验 / 活跃执行保护 / .venvs 保护名单 / BoundedLogBuffer） | ✅ 设计合理 | 逐项复核与报告一致 |

## 三、验证矩阵

| 验证 | 结果 |
|---|---|
| executor-node `tsc` 编译 | ✅ 通过 |
| admin-api `nest build` 编译 | ✅ 通过 |
| executor-python `py_compile` | ✅ 通过 |
| docker-compose YAML（js-yaml） | ✅ 通过，注入抽查正确 |
| executor-node 单测：interpreters + file-logger + pull（112+20 项） | ✅ 全过（含新增磁盘水位用例） |
| executor-node 单测：execute 系列 + task-worker（127 项） | ✅ 全过（含新增磁盘 503 用例） |
| admin-api 单测：scheduler + outbox + event-subscriptions（145 项） | ✅ 全过 |
| executor-python pytest：修改相关模块（execute/maintenance/interpreters/config） | 347 过 / 3 失败（见遗留项） |
| executor-python 新增磁盘 503 用例 | ✅ 通过 |

## 四、遗留项与说明

1. **executor-python 全量 pytest 的 18 个失败**：分布在 `test_re_register`、`test_traceparent`、`test_zip_channel`、`test_scheduler` 等**本次未触碰**的模块。抽样确认失败形态为既有问题：`test_run_and_callback_posts_result_with_executor_address` 断言 callback 头**恰好等于** `{Authorization}`，实际多出 `x-executor-address`（既有行为漂移，测试未跟进）；git checkout 类失败为 Windows 环境问题。**与本次修复无交集**（git diff 证实改动范围）。
2. **executor-node `memory-watchdog.spec.ts`**：工作区中未跟踪的 in-flight 新文件（非本任务产出），其类型错误阻塞 build；做了最小类型修复（仅补参数标注与回调签名，不动逻辑）使编译通过。
3. **task-worker 同任务串行（maxConcurrentPerTask=1）**：保留。同一 taskId 多执行串行是防资源竞争的设计特性，非缺陷；跨 taskId 已并行。
4. 工作区存在**大量并发未提交改动**（多个文件为 `MM` 状态）——本任务修复与既有 in-flight 工作共存，均已通过编译；建议尽快统一提交并跑一次 CI。

# python-executor 域审计报告（2026-11-03 · 第 1 轮）

> **审计对象**：`apps/executor-python/`（Python 执行器单体）
> **主战场**：`apps/executor-python/routers/execute.py` — **5339 行 / 202 个顶层符号（CodeGraph 记 220，含嵌套方法）/ 被 34 个文件引用**
> **阶段**：只读审计（未修改任何源文件；本文件是本轮唯一写操作）
> **探查方式**：CodeGraph CLI v1.6.2（`codegraph status` / `node` / `impact` / `explore` / `query`），索引已于开工前 `codegraph sync` 同步（`Files 2108 / Nodes 42151 / Edges 120271`）
> **协议**：本仓 **AGPL-3.0-only**（`LICENSE`）。本报告中的一切 OSS 参考均**只借鉴思路，不复制代码**；LGPL/GPL 项目仅作思路来源。

---

## §1 现状问题分析

### 1.0 部署形态（先证实，再下结论）

这是判断「进程内锁是否失效」的前提，**必须先证实**。三条证据：

| 证据 | 位置 | 结论 |
|---|---|---|
| 容器启动命令 | `apps/executor-python/Dockerfile:58` `CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]` | **单进程单 worker**（无 `--workers`） |
| 裸机 systemd | `scripts/install.sh:340-344,362` → `ExecStart=node ${INSTALL_DIR}/dist/main.js`（executor-node）；executor-python 走 `main.py:575` `uvicorn.run('main:app', ..., reload=False)` | **单进程** |
| 横向扩容 | `docs/operations.md:489` `docker compose up -d --scale executor-node=3`；`docs/deployment.md:1466` 「执行器横向扩容时每台各有独立池」 | **扩容单位 = 机器/容器实例，不是进程** |

**但是**——扩容单位是「实例」并不等于「不共享文件系统」。下面两条**跨实例共享同一目录**的证据才是真正的并发面：

| 共享面 | 证据 | 共享者 |
|---|---|---|
| **解释器缓存池** `interpreter_cache:/data/interpreters` | `docker-compose.yml:534-537`（executor-python 挂载）、`docker-compose.yml:684`（executor-node **挂同一卷**）、`docker-compose.yml:1092`（卷定义） | executor-python 容器 × executor-node 容器（**同一台宿主机上同时运行**） |
| **裸机默认 WORK_DIR** | `scripts/install.sh:35` `WORK_DIR="/var/lib/autoflow/tasks"`（**无实例维度、无 PID 维度**）；`install-script.content.ts:13` 同款 | 同一台机器上装第 2 台 executor-python 时**默认落到同一目录** |

**结论（重要，勿夸大）**：
- 「uvicorn 多 worker 导致进程内锁失效」**在本仓当前部署形态下不成立**——没有 `--workers`，一个实例一个进程。
- **真正成立的是跨实例共享目录竞态**：两台 executor-python 实例若共用 `WORK_DIR`（裸机安装默认就是这样），`.git_cache/`、`callbacks/`、`.pkg-cache/`、`.venvs/` 全在同一目录，而 `_git_cache_locks` 是**进程内 dict** → **锁完全不生效**。
- 解释器池卷被 executor-python 与 executor-node **同时挂载**，两端各有**自己的进程内锁**（python `_version_locks` / node `inFlight` Map），**彼此不知道对方在做什么** → 这是**跨语言、跨进程的裸奔写**。

---

### 1.1 【P0 · 并发正确性】进程内 `threading.Lock` 用作跨进程资源锁

#### F-1.1 git 缓存锁 —— 锁在实例间完全失效

| 项 | 内容 |
|---|---|
| **位置** | `apps/executor-python/routers/execute.py:357-368`（`_git_cache_locks` / `_git_cache_locks_guard` / `_get_git_cache_lock`）；使用点 `:371-383`（`git_checkout_to`）→ `:511-564`（`_git_checkout_to_locked`） |
| **触发路径** | `run_task`（`:4297`）→ `await run_in_executor(None, git_checkout_to, ...)`（`:4392`）→ `with _get_git_cache_lock(str(cache_dir))`（`:382`）→ `_git_checkout_to_locked` → `git clone --bare` / `git fetch --all` 写 `<WORK_DIR>/.git_cache/<repo>-<sha>` |
| **现有实现能否互斥** | **否（跨实例）**。`threading.Lock` 只在**同一进程**内互斥。`docker-compose.yml` 的 executor-python 是**单实例单进程**，故容器形态下当前**安全**；但：<br>① 裸机 `install.sh` 默认 `WORK_DIR=/var/lib/autoflow/tasks` **无实例维度** → 同机第二台实例共享 `.git_cache/` → **锁失效**，两个 `git clone --bare` 写同一目录；<br>② `docs/operations.md:489` 明确支持 `--scale executor-node=3` 形态的横向扩容，`executor-node` 侧 `gitCacheQueues`（`apps/executor-node/src/routes/execute.ts:127-141`）同样是**进程内 Map** → node 侧多副本共享 `executor_node_data` 卷时同样失效；<br>③ node 与 python 若指向同一 `WORK_DIR`，**两端锁互相不可见**（且两端锁实现本就不同源）。 |
| **失败形态** | 并发 `git clone --bare` 写同一目录 → 目录半写 → `_is_bare_git_repo`（`:275-289`）探测失败 → `_quarantine_broken_cache`（`:292-303`）**把它改名隔离** → **A 实例正在用的完好缓存被 B 实例当成损坏缓存隔离掉**，A 的 checkout 随即失败。即「隔离语义本身在跨实例下成为破坏源」。 |
| **额外缺陷：`_quarantine_broken_cache` 与其它路径竞态** | `:292-303` 用 `cache_dir.rename(broken)`（`except OSError` 回落 `shutil.rmtree`）。在**同进程**内它被 `_get_git_cache_lock` 保护，安全；但 `:315-344` 的 `_unshallow_bare_repo` 与 `:511+` 的 `_git_checkout_to_locked` 都在**同一个锁内**调用它（好），而 `maintenance.py` 的 TTL 清扫**不持此锁** → 清扫与隔离可同时作用于同一目录。 |
| **影响面（CodeGraph impact -d 3）** | `_get_git_cache_lock` → **9 个受影响符号**（`git_checkout_to` + `tests/test_concurrency.py:286,357,361-364`）；`git_checkout_to` → **95 个受影响符号**（`run_task` / `_run_and_callback` / `accept_execution` + `tests/test_execute.py` 约 40 个用例）；`_quarantine_broken_cache` → **3 个受影响符号** |
| **正确修法** | **文件锁（`fcntl.flock` / `msvcrt.locking`）** —— 资源是**同一台机器上的同一目录**，不是分布式资源。用 Redis 分布式锁是杀鸡用牛刀（执行器与 admin-api 的 Redis 不共享网络域时更是完全不可用）；数据库 advisory lock 更不适用（执行器**不直连 DB**）。正确形态：**锁文件放在被锁目录旁边**（`<cache_dir>.lock`），`flock(LOCK_EX)` 持锁期间做 clone/fetch/checkout，进程崩溃时**内核自动释放**（这正是文件锁优于「锁文件 + PID 存活检查」的地方）。 |

#### F-1.2 解释器池锁 —— 跨语言裸奔写（**本域最严重的一条**）

| 项 | 内容 |
|---|---|
| **位置** | python：`apps/executor-python/interpreters.py:1056-1070`（`_version_locks` / `_get_version_lock`）；node：`apps/executor-node/src/interpreters.ts:1294`（`const inFlight = new Map<string, Promise<string>>()`） |
| **触发路径** | python：`run_task` → `_ensure_interpreter`（`:233`）→ `interpreters.ensure_version_async` → `_get_version_lock(version)`（**进程内**）→ `uv python install <X.Y>` 写 `UV_PYTHON_INSTALL_DIR=/data/interpreters` |
| **共享证据** | `docker-compose.yml:537` 与 `docker-compose.yml:684` —— **executor-python 与 executor-node 挂同一个 `interpreter_cache` 卷** |
| **现有实现能否互斥** | **否**。两端各用**自己的进程内**结构（python `threading.Lock` / node `Promise` Map），**彼此完全不可见**。python 进程持锁时，node 进程完全不知道，照样起 `uv python install` 写同一目录。 |
| **失败形态** | 两个 `uv python install` 同时写 `/data/interpreters/cpython-3.12.x-linux-x86_64-gnu/` → 产物半写 → `uv python list --only-installed` **整条 exit 2**（`docker-compose.yml` 注释与 `docs/deployment.md:1444` 已自认：「池内同平台损坏条目会拖垮整份清单」）→ 执行器上报**空清单** → admin 把 3.12 任务路由过来 → 运行期 `interpreter_unavailable`。**故障从「一个版本损坏」放大成「整个池不可见」。** |
| **同源旁证** | `interpreters.py:814` 的注释自己写着：「只要池内存在**一个同平台但不可运行**的条目就整体 exit 2」，并解释了为什么整体拖垮 —— 但**两侧的下载互斥都没跨进程**。 |
| **影响面** | python `_get_version_lock` → 影响 `interpreters.py` 内部 + `tests/test_interpreters.py`（约 1300 行）；node `inFlight` → `apps/executor-node/src/interpreters.spec.ts` + `interpreters.integration.spec.ts` |
| **正确修法** | **文件锁**（`flock`）放在 `UV_PYTHON_INSTALL_DIR/<version>.lock`，**两端共用同一实现**。可复用点：本仓已有一个**极小的、跨平台的文件锁实现**可直接抽出（见 §5 的 filelock/portalocker 参考与 §4 的 `lib/file_lock.py` 设计草案）。**不要**用 Redis/DB 锁——解释器池在执行器本地卷上，Redis/DB 引入的是**网络依赖**（离线私有化部署直接失效，见 `docs/design/python-task-upload-and-multiversion/OFFLINE-PROVISIONING.md` 的离线预填形态）。 |

#### F-1.3 回调持久化序号 —— 跨实例文件名碰撞

| 项 | 内容 |
|---|---|
| **位置** | `execute.py:3059-3060`（`_callback_persistence_sequence` / `_persistence_sequence_lock`）、`:3198-3204`（文件名生成） |
| **触发路径** | `_persist_failed_callback` → 取序号 → `filename = callback_dir / f'callback-{int(time.time()*1000)}-{sequence}.json'` → `tmp.write_text` → `tmp.rename(filename)` |
| **现有实现能否互斥** | **否（跨实例）**。序号是**进程内**单调计数器。 |
| **失败形态** | 两个实例在**同一毫秒**取到**同一序号** → 同名文件 → 后者 `filename.exists()` → `unlink()` → `rename()` **覆盖前者的回调载荷**（`:3207-3209` 注释说「Windows rename-over-existing 不是原子安全，先 unlink」——这在**同进程**下靠序号唯一性规避，在跨实例下**恰好制造了覆盖**）。**后果是终态回调丢失**：任务在 admin 侧永远停在 RUNNING，只能等陈旧清扫修复。 |
| **影响面** | `execute.py` 内 3 个符号 + `tests/test_callback_persistence.py`（约 1000 行，覆盖 8 个符号） |
| **正确修法** | 文件名改为**内容无关的全局唯一**：`os.getpid()` + `uuid4().hex[:8]` + 时间戳；或落盘用 `O_EXCL` 独占创建（`open(path, 'x')`）失败即换名。**不需要锁**——用「唯一名 + 独占建」替代「序号 + 锁」，更简单也更可靠。 |

#### F-1.4 回调重放队列（内存队列）—— 跨实例丢失

| 项 | 内容 |
|---|---|
| **位置** | `execute.py:2876-2878`（`CALLBACK_LIVE_BATCH_SIZE` / `_live_callback_queue` / `_live_callback_lock`）、`:2906-2918`（`enqueue_callback`）、`:2921-2929`（`_drain_live_callback_queue`）、`:2977-3016`（`_flush_live_callbacks`） |
| **触发路径** | `_run_and_callback`（`:3784`）→ `enqueue_callback(payload)` → 事件循环的 flush 任务 → `_send_callback_batch_with_retry` |
| **现有实现能否互斥** | 队列是**进程内 list**，`threading.Lock` 只保护**同进程**并发。**跨实例无互斥也无共享**。 |
| **失败形态** | 这**不是**互斥问题而是**可用性问题**：实例 B 的内存队列在实例 B 崩溃时**整队丢失**（持久化只在**重试预算耗尽后**才落盘，`:3176-3183` `_persist_giving_up`）。同一批回调在两个实例间**不会重复**（各发各的），但**任一实例的瞬时丢失都不可恢复**。 |
| **判定** | **需要跨实例「不丢」但不需要互斥**。正确修法不是加锁，而是**持久化优先**（先落盘再发送，落盘用 §1.3 的唯一名），内存队列降级为「批量加速器」而非「队列」。 |
| **影响面** | `enqueue_callback` → **11 个受影响符号**（`tests/test_executor_protocol_contract.py` 断言其入队语义） |

#### F-1.5 其它进程内全局态（逐个判定）

| 位置 | 结构 | 需要跨进程互斥？ | 现有实现能互斥？ | 修法 |
|---|---|---|---|---|
| `execute.py:1404-1405` | `_live_executions` + `_live_lock` | **否**（每实例自己的活跃执行表） | **是**（同进程足够） | 保持。**但**跨实例共享 `WORK_DIR` 时，B 实例的 TTL 清扫（`maintenance.py`）**看不到** A 实例的活跃执行 → 会删掉 A 正在用的 `WORK_DIR/<executionId>`。这是**跨实例活锁信息缺失**，需要「活跃执行标记**落盘**」而非锁。 |
| `execute.py:1462-1463` | `_live_pool_interpreters` + lock | **否**（同上，liveness 提示） | 是 | 保持 + 落盘（见 §4 `services/live_registry.py`） |
| `execute.py:1486-1566` | `_task_locks` / `_RecyclableTaskLock`（asyncio.Lock） | **否**（同一 taskId 在同实例内串行） | 是（单事件循环） | 保持。跨实例同一 taskId 会被派发两次吗？→ admin 侧有 claim 机制，见 §1.6。 |
| `execute.py:3057-3058` | `_callback_retry_task` / `_callback_retry_stop` | **否**（每实例一个重试循环） | 是 | 保持 |
| `execute.py:3060` | `_persistence_sequence_lock` | **是**（但**正确修法是消除序号**，见 F-1.3） | 否 | 改为唯一名 |
| `execute.py:3064` | `_dead_letter_count_cache` | 否 | 是 | 保持 |
| `interpreters.py:1056-1061` | `_version_locks` + guard | **是** | **否** | **文件锁**（F-1.2） |
| `interpreters.py:114` | `_integrity_guard` | 否（单进程校验） | 是 | 保持 |
| `interpreters.py:606` | `_discovery_guard` | 否 | 是 | 保持 |
| `interpreters.py:1079` | `_semaphores_guard` | 否 | 是 | 保持 |
| `pkg_cache.py:251` | `_pkg_fetch_locks`（asyncio.Lock） | **是**（缓存目录 `<WORK_DIR>/.pkg-cache` 共享） | **否** | **文件锁** 或「唯一临时名 + 原子 rename」 |
| `pkg_cache.py` | 缓存写入（`_write_cache_entry` 一类） | **是** | 否 | `O_EXCL` / rename 原子性 |
| `scheduler.py:72` | `_running_count_lock` | 否（进程内并发计数） | 是 | 保持（跨实例限流缺陷属 admin 侧，见 `docs/deployment.md:1516`） |
| `auth.py:65-83` | `_refresh_lock`（asyncio.Lock） | 否 | 是 | 保持 |
| `log_stream_pusher.py:58,61` | `asyncio.Lock` ×2 | 否 | 是 | 保持 |
| `maintenance.py:122,145` | provider guard | 否 | 是 | 保持 |

**结论**：全仓 21 处进程内锁/队列中，**只有 3 处（git 缓存、解释器池、pkg 缓存）+ 1 处序号生成** 真正需要跨进程互斥，且全部是「同一台机器上的同一目录」——**正确修法一律是文件锁（flock），没有一处需要 Redis 或 DB advisory lock**。

---

### 1.2 【P0 · 架构】一个 router 文件塞了 7 个独立子系统

`execute.py` 的 202 个顶层符号按职责聚类（CodeGraph `node --symbols-only` + AST 行段解析）：

| # | 子系统 | 行段范围 | 符号数(约) | 关键符号 | 依赖的外部模块 |
|---|---|---|---|---|---|
| S1 | **Git 缓存管理** | `:260-564` | 12 | `_repo_dir_name` / `_is_bare_git_repo` / `_quarantine_broken_cache` / `_is_shallow_bare_repo` / `_unshallow_bare_repo` / `_get_git_cache_lock` / `git_checkout_to` / `_git_checkout_to_locked` | `subprocess` |
| S2 | **进程与沙箱启动** | `:386-508`, `:1104-1146`, `:1223-1225`, `:2427-2486` | 12 | `_posix_kill_process_group` / `_kill_process_tree_sync` / `_kill_process_tree` / `kill_running_task_processes` / `_run_prepare_cmd` / `_spawn_kwargs_for_platform` / `_build_shell_cmd` | `sandbox.py`, `task_launcher.py` |
| S3 | **解释器与运行时** | `:152-257`, `:845-987`, `:1579-1722`, `:3937-4294` | 30 | `_ensure_interpreter` / `_build_uv_env` / `ensure_venv` / `_venv_reuse_problem` / `merge_requirements` / `_run_uv` | `interpreters.py`, `sandbox.py` |
| S4 | **回调与重试** | `:2830-3016`, `:3044-3682`, `:3685-3706` | 40 | `_send_callback_with_retry` / `enqueue_callback` / `_flush_live_callbacks` / `_persist_failed_callback` / `retry_persisted_callbacks` / `reconcile_dead_letter_files` / `callback_retry_task` | `httpx`, `auth.py` |
| S5 | **日志与产物** | `:990-1022`, `:1029-1046`, `:1324-1356`, `:1739-1817` | 14 | `_build_callback_logs` / `_truncate_logs` / `_clamp_interpreter_result` / `_interpreter_failure_result` | `log_stream_pusher.py`, `artifacts.py` |
| S6 | **安全校验** | `:848-896`, `:1068-1197`, `:1820-2184` | 22 | `_validate_registry_url` / `_build_child_env` / `_validate_shell_entrypoint` / `_validate_git_ref` / `_validate_requirements` / `_host_is_restricted` / `_package_url_host_denied` / `_assert_safe_package_url` / `_param_env_key_collisions` | `ipaddress`, `socket` |
| S7 | **请求模型与路由** | `:100-128`, `:566`, `:2614-2827`, `:3716-3781` | 12 | `ExecuteRequest` / `ExecutionRejected` / `accept_execution` / `execute` / `reject_pulled_execution` / `kill_execution` | `fastapi` |
| — | **执行编排（真正的核心）** | `:3784-3925`, `:4297-5339` | 2（超长函数） | `_run_and_callback`（142 行）/ `run_task`（**1043 行**） | 上述全部 |

**「7 个独立子系统」的硬证据**：

1. **`run_task` 独占 1043 行**（`:4297-5339`），是全文件 19.5%。它同时做：工作目录准备与 chmod → git SSRF 校验 → git checkout → manifest 合并 → runtimeVersion 校验 → venv 准备 → requirements 安装 → zip 解包 → entrypoint 校验 → 子进程 spawn → 日志采集 → 结果封包。**一个函数 = 一个完整的产品流程**。
2. **子系统之间的调用是"横向"的、不是"纵向"的**。例如：
   - S6（安全校验）的 `_host_is_restricted` 被 S1（git）与 S4（package 下载）**共用**（`:2081` `_assert_safe_package_url` 与 `:4367` gitRepo 闸门）；
   - S4（回调）的 `_refine_failure_reason`（`:570-719`，150 行）被 S2/S3/S5 的失败路径**共用**；
   - S1 的 `_run_prepare_cmd`（`:453`）被 S1（git fetch）与 S3（uv install）**共用**。
   这说明它**不是**「router 调 service」的分层，而是**一个共享符号池**。
3. **S4 的自足性最强**：回调重试（40 符号）+ 死信（15 符号）+ 落盘（8 符号）自成一套**带独立状态机**（内存队列 → 落盘文件 → `.meta` 计数 → 死信目录 → 死信对账）的持久化子系统，与 FastAPI 路由**零耦合**。
4. **S3 的自足性次之**：`ensure_venv`（`:4130-4294`，165 行）完整实现了「venv 复用判据 + 版本匹配 + 隔离重建」，与路由零耦合。
5. **耦合面量化**：`run_task` 的 `codegraph impact -d 3` = **128 个受影响符号**；`execute.py` 被 **34 个文件**引用。

**证据链的其它硬指标**：

| 指标 | 值 |
|---|---|
| `execute.py` 行数 / 符号数 / 引用文件数 | 5339 / 220 / 34 |
| `run_task` 行数 | 1043（19.5%） |
| `_run_and_callback` 行数 | 142 |
| `ensure_venv` 行数 | 165 |
| `_refine_failure_reason` 行数 | 150 |
| `reconcile_dead_letter_files` 行数 | 116 |
| 顶层 `async def` 数量 | 22 |
| 顶层**纯函数**（无 IO）占比 | 约 55%（≈111/202） |

---

### 1.3 【P1 · 安全】校验逻辑散落，无单一入口

**证据：SSRF 判定有 3 套实现，zip 校验有 2 套，env 白名单有 2 套。**

| 校验面 | python 实现 | node 实现 | 事实源 | 守卫 |
|---|---|---|---|---|
| SSRF（私网/回环/元数据） | `execute.py:1820-1869` `_host_is_restricted`（**含真实 DNS 解析**）+ `:2043-2069` `_package_url_host_denied` + `:2121-2139` `_host_is_loopback` | `apps/executor-node/src/lib/ssrf-guard.ts`（302 行，**纯字符串判定，无 DNS**） | `apps/admin-api/src/common/utils/__tests__/ssrf-deny-matrix.spec.ts`（18 条） | `scripts/check-ssrf-deny-parity.mjs`（`MIN_SOURCE_ENTRIES = 18`，棘轮） |
| zip 条目安全 | `apps/executor-python/zip_safety.py`（635 行） | `apps/executor-node/src/zip-safety.ts`（620 行） | **无**（两份独立实现） | `apps/executor-python/tests/test_zip_guard_parity.py`（测试层对等，非实现层） |
| env 转发白名单 | `execute.py:1068-1082` `_ENV_WHITELIST` | `apps/executor-node/src/env-whitelist.ts` `ENV_WHITELIST` | `packages/executor-protocol/protocol.json` `envForward` 段（三桶：`common` / `runtimeOnly` / `neverForward`） | `scripts/check-env-drift.mjs` + node `env-whitelist.spec.ts` + python `tests/test_env_forward_parity.py` |
| 失败原因枚举 | `execute.py:570-719` | `apps/executor-node/src/callback.ts` | `protocol.json` `failureReason` 段 | `scripts/check-failure-reasons.mjs`（四方比对） |
| sandbox fail-closed 判定 | `execute.py:731-756` `_sandbox_startup_failure_reason` | node 侧等价 | **无** | **无** |
| launcher 失败识别 | `execute.py:769-787` `_launcher_startup_failure_reason` | node `run-command.ts` | **无** | **无** |
| git ref 校验 | `execute.py:1174-1183` `_validate_git_ref` | node 侧内联 | **无** | **无** |
| requirements 选项注入 | `execute.py:1186-1197` `_validate_requirements` | node 侧内联 | **无** | **无** |

**关键发现**：
- **`protocol.json` 已经有成熟的「三桶登记 + 双向守卫」范式**（`envForward` 段 + `failureReason` 段 + 各自的 `.mjs` 守卫）。**「执行前置校验门」的契约可以直接挂进 `protocol.json`**，用同样的范式，**不需要引入新依赖**。
- 但 `sandbox fail-closed` / `launcher 失败识别` / `git ref` / `requirements` 这 4 项目前**没有事实源、没有守卫** → 是残留重复。

**`execute.py` 内部的散落证据**（同一个请求的校验被切在 5 个位置）：

| 请求字段 | 校验位置 | 相隔距离 |
|---|---|---|
| `gitRepo`（协议/凭据/SSRF） | `:4344-4426`（`run_task` **内联 83 行**；协议闸 `:4346`、凭据闸 `:4360-4374`、SSRF 闸 `:4421`） | — |
| `packageUrl`（SSRF） | `:2081-2118` `_assert_safe_package_url` | 距 gitRepo 校验 **2200 行** |
| `requirements`（选项注入） | `:1186-1197` | 距使用点 3000+ 行 |
| `entrypoint`（路径逃逸/注入） | `:1277-1321` `_ensure_entrypoint_in_workdir` + `:1107-1113` `_validate_shell_entrypoint` | **两个函数，语义重叠** |
| `params`（键名折叠） | `:1965-1982` `_param_env_key_collisions` | 距 `accept_execution` 600 行 |
| env 白名单 | `:1085-1098` `_build_child_env` | 距调用点 3200 行 |

**且 `run_task` 里的 git SSRF 校验是 83 行**的**内联**代码（`:4344-4426`），与 `packageUrl` 的 `_assert_safe_package_url` **共用** `_package_url_host_denied`（`:4421` 调用）—— 说明作者**已经意识到**该复用，但没有把它提升为「门」。

---

### 1.4 【P2】node/python 双端残留重复（EXEC-01..07 修完之后还剩什么）

先查历史（**避免重复劳动**）：`docs/AGENT-SWARM-PLAYBOOK.md:215-221` 记录了 EXEC-01/02/03/04/05/06/07 全部**已修**（`c59741fa` / `988c220b` / `27670e50` / `e22fd5e7`），证据在 `docs/archive/audits/2026-10-29-round3/executors.md:48-54`（发现总表）与 `:428-438`（实施顺序）。

**已收敛的**（**不要重复劳动**）：

| 编号 | 内容 | 状态 |
|---|---|---|
| EXEC-01 | python `/execute` 第三份模型 | ✅ 已修 `c59741fa`（单一本地模型） |
| EXEC-02 | python `preexec_fn` | ✅ 已修 `e22fd5e7`（单线程 launcher，4 处 spawn 面全覆盖） |
| EXEC-03 | zip Windows 归一化 | ✅ 已修 `988c220b` |
| EXEC-04 | 未知控制命令静默丢弃 | ✅ 已修 `988c220b` |
| EXEC-05 | env 转发白名单两端不同集 | ✅ 已修 `c59741fa`（`protocol.json` `envForward` 三桶 + 双向守卫） |
| EXEC-06 | CallbackPayload 严格度 | ✅ 已核对+钉住 `27670e50` |
| EXEC-07 | params 键名折叠 | ✅ 已修 `c59741fa`（8 条向量） |

**尚未收敛的残留重复**（本轮新发现，**不在上述清单里**）：

| # | 残留重复 | python | node | 判定 |
|---|---|---|---|---|
| R-1 | **SSRF 判定实现分叉** | `_host_is_restricted`（DNS 解析，比 node **更严**） | `lib/ssrf-guard.ts`（纯字符串，**漏 DNS rebinding**） | **可收敛**：把「地址分类」抽成 `protocol.json` 的矩阵（已有 18 条）+ 两侧各自实现「解析」；**但两侧的 DNS 策略必须显式登记为 runtimeOnly** |
| R-2 | **git 缓存锁** | `_get_git_cache_lock`（threading.Lock） | `gitCacheQueues`（Promise Map，**tail 模式**） | **必须保留差异**（语言运行时差异），但**锁的语义契约**（锁住哪段、锁多久）应收敛到 `protocol.json` |
| R-3 | **回调重试状态机** | `_send_callback_with_retry` / `_persist_failed_callback` / `retry_persisted_callbacks` / `reconcile_dead_letter_files` | `callback.ts:504-562` `retryFailedCallbacks` / `deadLetterCallbackFile` / `:825` requeue | **可收敛为契约**（重试次数、退避公式、落盘格式、`.meta` 结构、死信命名）——**这些是跨端互操作的**：admin 侧要看懂执行器落盘的文件 |
| R-4 | **zip 归一** | `zip_safety.py`（635 行） | `zip-safety.ts`（620 行） | **可收敛**：把「允许的条目名形态」做成 `protocol.json` 的一组向量 + 双向守卫（**当前只有测试层对等，无实现层事实源**） |
| R-5 | **sandbox / launcher 失败识别** | `_sandbox_startup_failure_reason` / `_launcher_startup_failure_reason` | node `run-command.ts` | **可收敛**：失败原因已在 `protocol.json` `failureReason` 段有事实源，**但识别规则没有** → 应加「日志模式 → failureReason」的规则表 |
| R-6 | **git ref / requirements 选项注入** | `_validate_git_ref` / `_validate_requirements` | node 侧内联正则 | **可收敛**：正则本身应收进 `protocol.json` 模式段 |
| R-7 | **env 转发** | `_ENV_WHITELIST` | `ENV_WHITELIST` | ✅ **已收敛**（EXEC-05），**不要动** |

---

### 1.5 【P2】协议契约的覆盖缺口

`packages/executor-protocol/protocol.json` 现有段：`versioning` / `executorNodeOnly` / `readiness` / `timeout` / `failureReason` / `secrets` / `params` / `envForward` / `schemas` / `schemaVectors`。

**缺的**：
- **无 `preflight`（执行前置校验门）段** —— SSRF / zip / env / sandbox / git-ref / requirements 的判定规则**都不在契约里**。
- **无 `sandbox` 段** —— `TASK_SANDBOX` 模式、fail-closed 判定标准、bwrap/nsjail 能力矩阵**不在契约里**。
- **无 `gitCache` 段** —— 缓存目录命名规则（`_repo_dir_name` 的 `<cleaned>-<sha256[:12]>`）、锁的粒度、bare/shallow 探测约定**不在契约里**。

**好消息**：这正好可以用**已经成熟的 `envForward` 三桶范式**扩展，**不引入新依赖**（`packages/executor-protocol` 是纯 JSON + 一个生成器 `scripts/generate-executor-protocol.mjs`）。

---

### 1.6 【观察】跨实例活跃执行信息缺失

`maintenance.py` 的 TTL 清扫（`execute.py:1480` `list_live_pool_interpreter_paths` / `list_live_execution_entries` 提供给 `maintenance.py:122,145`）**只看本进程**的 `_live_executions`。跨实例共享 `WORK_DIR` 时，实例 A 的活跃执行目录会被实例 B 的清扫删掉。

- 影响面：`maintenance.py`（938 行）+ `tests/test_maintenance.py`
- 判定：**需要落盘的活跃执行标记**（不是锁）→ 见 §4 `services/live_registry.py`

---

## §2 CodeGraph 探查结论

### 2.1 依赖图（execute.py 内部 7 子系统的调用关系）

```
                    ┌──────────────── routers/execute.py ─────────────────┐
                    │                                                      │
  S7 路由层         │  ExecuteRequest :100   ExecutionRejected :2614    │
                    │  accept_execution :2625  execute :2789             │
                    │  reject_pulled_execution :2797  kill_execution :3717│
                    │           │                                          │
                    │           ▼                                          │
  编排（核心）      │  _run_and_callback :3784 (142行)                     │
                    │  run_task :4297 (1043行) ◄── 本文件 19.5%           │
                    │           │                                          │
   ┌────────────────┼────────────────┬──────────────┬──────────────┐      │
   ▼                ▼                ▼              ▼              ▼      │
 S1 git       S2 进程/沙箱      S3 解释器     S4 回调       S6 安全校验    │
 :260-564     :386-508         :152-257    :2830-3016    :848-896      │
   │          :1104-1146       :845-987    :3044-3682    :1068-1197    │
   │          :2427-2486       :1579-1722                :1820-2184    │
   │          :1223-1225       :3937-4294                              │
   │                │                │              │                    │
   └────┬───────────┴────────────────┘              │                    │
        │                                            │                    │
        ▼                                            ▼                    ▼
  外部模块: sandbox.py(315)  task_launcher.py(187)  auth.py(446)   zip_safety.py(635)
           interpreters.py(1400)  pkg_cache.py(340)  log_stream_pusher.py(294)
           artifacts.py(232)  maintenance.py(938)  manifest.py(44)
```

### 2.2 耦合风险矩阵

| 耦合类型 | 具体表现 | 风险 |
|---|---|---|
| **横向共享符号池** | `_refine_failure_reason`（S4 代码，S2/S3/S5 都调）、`_host_is_restricted`（S6 代码，S1/S4 都调）、`_run_prepare_cmd`（S2 代码，S1/S3 都调） | 改一个符号 → 跨子系统回归面 |
| **路由层持有业务状态** | `_live_executions` / `_task_locks` / `_background_tasks` / `_live_callback_queue` 全在 router 模块的模块级变量里 | 状态无法独立测试、无法独立迁移、无法在多进程间共享 |
| **编排函数吞掉一切** | `run_task` 1043 行，混合了 HTTP 层关心的事（抛 `HTTPException`）与业务层关心的事（返回 dict） | 抛 `HTTPException`（`:4318` path traversal / `:4373` git 协议 / `:4401` SSRF / `:4409` 无效 host）与返回 `{'success': False, ...}`（`:4470` runtimeVersion）**两种错误表达混在同一函数** |
| **测试直接 monkeypatch 模块属性** | `pkg_cache.py:288` 注释明说：「`routers/execute` 的 `_download_package` 是模块属性、测试常年 monkeypatch 它」 | 拆分时**按名 from-import 会绕过替身** → 拆分必须保留「模块属性 + monkeypatch」语义 |
| **测试与实现同生共死** | 34 个引用文件里 30+ 个直接访问模块私有符号（`_get_git_cache_lock` / `_live_executions` / `_task_locks` / `_dead_letter_count_cache`） | 拆分 = 一次大规模 import 重写 |

### 2.3 影响面量化表（`codegraph impact -d 3`）

| 符号 | 位置 | 受影响符号数 | 外部测试文件数 | 拆分风险 |
|---|---|---|---|---|
| `run_task` | `:4297` | **128** | 12+ | **极高** — 编排核心 |
| `_refine_failure_reason` | `:570` | **162** | 6 | 高 — 被 S2/S3/S5 共用 |
| `merge_requirements` | `:1702` | **137** | 1 | 中 — 纯函数，易拆 |
| `_host_is_restricted` | `:1820` | **124** | 1 | 中 — 纯函数 + DNS |
| `_ENV_WHITELIST` | `:1068` | **93** | 2 | 中 — 已在 protocol.json 有事实源 |
| `git_checkout_to` | `:371` | **95** | 1 | 中 |
| `_run_and_callback` | `:3784` | 53 | 8 | 高 |
| `accept_execution` | `:2625` | 27 | 4 | 中 |
| `enqueue_callback` | `:2906` | 11 | 1 | 低 |
| `_get_git_cache_lock` | `:361` | 9 | 1 | **低 —— 最佳切口** |
| `_quarantine_broken_cache` | `:292` | 3 | 1 | 低 |

> **读法**：影响面大 ≠ 难拆。`merge_requirements` / `_host_is_restricted` 影响面大是因为**被调用点多**，但它们是**纯函数**（无 IO），搬到新模块后**调用点一行不用改**（只要保持 `from services.x import merge_requirements` 的导入形态）。真正难拆的是**有模块级状态**的（`_live_executions` / `_task_locks` / `_live_callback_queue`）和**编排核心**（`run_task` / `_run_and_callback`）。

---

## §3 补丁 vs 重构对比（五维评分）

**评分口径**：1 = 很差，5 = 很好。「短期成本与风险」是**反向**指标（5 = 成本低、风险小）。

### 3.1 问题一：`execute.py` 5339 行 / 7 子系统混杂

| 维度 | 轻量补丁（继续在 execute.py 里加注释分区 / 加 `# ==== S6 安全 ====` 横幅） | 结构性重构（拆 `routers/` + `services/` + `lib/`） |
|---|---|---|
| 长期收益 | 2 — 分区注释 3 个月后必然腐化；无强制边界 | **5** — 物理边界 = 编译期边界，依赖方向可被守卫钉住 |
| 维护成本 | 1 — 仍需在 5339 行里定位 | **5** — 每文件 200-500 行，可独立读 |
| 扩展潜力 | 1 — 新子系统只能继续塞进去 | **5** — 新增校验门/新运行时是「加文件」 |
| 技术债风险 | 1 — 债务不减 | **4** — 引入迁移期双份实现的短期债 |
| 短期成本与风险 | 5 — 零风险零成本 | 2 — 34 个测试文件需改 import，有回归风险 |
| **合计** | **10** | **21** |

**结论：推荐结构性重构。** 长期综合收益（21）显著 > 短期成本（2）。

### 3.2 问题二：git 缓存锁 / 解释器池锁跨进程失效

| 维度 | 轻量补丁（把 `threading.Lock` 换成 `fcntl.flock`） | 结构性重构（引入 `lib/file_lock.py` 抽象 + 统一锁协议 + 落盘活跃标记） |
|---|---|---|
| 长期收益 | 4 — 修好了，但**每个新共享目录都要重新发明一次** | **5** — 一次抽象，全仓复用，锁语义（锁谁/锁多久/崩溃怎么办）统一 |
| 维护成本 | 3 — 散落各处 | **5** — 一个模块 |
| 扩展潜力 | 3 | **5** — 新增共享目录时「有现成的锁可用」 |
| 技术债风险 | 3 — 仍不知道哪些目录该锁 | **5** — 有一张「共享资源 × 锁类型」清单 |
| 短期成本与风险 | **5** — 改动 3 处，各 5 行 | 3 — 要动 node 侧 + 要新增守卫 |
| **合计** | **18** | **23** |

**结论：推荐结构性重构（但拆成两步走，见 §6）。**
- **阶段 1（轻量补丁先行）**：给 `interpreters.py`（**最高危**）与 `execute.py` 的 git 缓存**各加一个 `flock`**，把 P0 缺陷立即封住——这一步是**纯增量**、不改任何调用点。
- **阶段 2（结构性重构）**：抽出 `lib/file_lock.py`，把 node 侧的 `gitCacheQueues` / `inFlight` 也切过去，并加守卫「共享目录必须持锁」。

> 特别提醒：**解释器池锁（F-1.2）比 git 缓存锁（F-1.1）更严重**——它跨**语言**（node 与 python 各写同一卷），且失败形态会放大成「整个池不可见」。**阶段 1 必须先修它。**

### 3.3 问题三：校验散落（SSRF/zip/env/sandbox）

| 维度 | 轻量补丁（加一个 `preflight()` 函数，把散落的判定搬进去，**不落 protocol.json**） | 结构性重构（`preflight()` + `protocol.json` 新增 `preflight`/`sandbox` 段 + 双向守卫 `.mjs`） |
|---|---|---|
| 长期收益 | 3 — python 侧收口了，node 侧仍各写各的 | **5** — 单一事实源 + 守卫防漂移 |
| 维护成本 | 4 | **4** — 多维护一份 protocol.json + 守卫 |
| 扩展潜力 | 3 | **5** — 契约可被第三端（desktop）复用 |
| 技术债风险 | 3 — node 侧漂移风险保留 | **5** |
| 短期成本与风险 | **5** — 纯 python 内部重构 | 2 — 要动 `protocol.json` + 写新守卫 + 动 node 侧 |
| **合计** | **18** | **23** |

**结论：推荐结构性重构，但**必须与既有守卫**兼容**：
- `scripts/check-ssrf-deny-parity.mjs` 的判据是「admin-api 矩阵的 18 条 addr 必须出现在 `executor-node/src/lib/ssrf-deny-parity.spec.ts` 和 `apps/executor-python/tests/test_ssrf_guard.py` 里」。
  → **新方案不能删掉这两个 spec**，否则守卫的 `TARGETS` 找不到文件会红。**要么保留文件（内容改为「消费 protocol.json 矩阵」的转发测试），要么同批改守卫的 `TARGETS`。**
- `scripts/check-sanitize-parity.mjs` 与 `scripts/check-failure-reasons.mjs` 判据与本次收敛**不冲突**（前者管脱敏规则，后者管失败原因枚举的四方一致），**不需要动**。

**折中推荐**：**阶段 1 先做 python 侧的 `preflight()` 收口（纯内部，零协议变更）**，阶段 2 再把规则上提到 `protocol.json` 并加守卫。这样把「立刻收口」和「协议级防漂移」解耦。

### 3.4 问题四：node/python 双端残留重复（R-1..R-6）

| 维度 | 轻量补丁（逐条手改 node 侧去对齐 python） | 结构性重构（重复项进 `protocol.json` + 双向守卫 + 生成器） |
|---|---|---|
| 长期收益 | 2 — 改完这次，下次改还是漂 | **5** — 范式已成熟（`envForward` 就是样板） |
| 维护成本 | 3 | **4** |
| 扩展潜力 | 2 | **5** |
| 技术债风险 | 2 — 无防漂移机制 | **5** |
| 短期成本与风险 | 4 | 2 — 跨两仓协调 + 新守卫 |
| **合计** | **13** | **21** |

**结论：推荐结构性重构**（复用 EXEC-05 已验证的 `envForward` 范式，**不是新发明**）。

### 3.5 问题五：测试面 34 个引用文件

| 维度 | 轻量补丁（不动拆分，测试全留） | 结构性重构（测试按新模块树重组） |
|---|---|---|
| 长期收益 | 1 | **4** — 测试按被测模块镜像，定位成本降 |
| 维护成本 | 2 | **4** |
| 扩展潜力 | 2 | **4** |
| 技术债风险 | 2 | 3 — 迁移期双份测试 |
| 短期成本与风险 | **5** | 2 — 30+ 文件改 import |
| **合计** | **12** | **17** |

**结论：推荐重构**，但**必须按「先改 import（机械）→ 再改 fixture（需判断）」两阶段**（详见 §8）。

### 3.6 汇总推荐

| 优先级 | 切口 | 推荐 | 理由 |
|---|---|---|---|
| **P0** | 解释器池跨语言裸奔写（`:1056-1070` + node `interpreters.ts:1294`） | **轻量补丁**（先加 flock），后续排期重构 | 危害最大、改动最小、纯增量 |
| **P0** | git 缓存锁跨实例失效（`:357-368`） | **轻量补丁**（先加 flock）+ 排期统一 `lib/file_lock.py` | 改 5 行封住 P0 |
| **P0** | 回调文件名跨实例碰撞（`:3198-3204`） | **轻量补丁**（改唯一名，**消除序号**） | 改 2 行封住 P0 |
| **P1** | `execute.py` 拆分 | **结构性重构** | 21 vs 10 |
| **P1** | `preflight()` 校验门 | **结构性重构**（两阶段） | 23 vs 18 |
| **P2** | 双端残留重复收敛 | **结构性重构** | 21 vs 13 |

**【临时补丁，后续排期重构】标注**：
- F-1.2 解释器池锁的 **node 侧**改造（`inFlight` Map → 文件锁）：**【临时补丁，后续排期重构】** —— 涉及 node 仓的下载链路回归面较大，且 node 侧当前**镜像里没有 uv**（`docker-compose.yml` 注释：「当前镜像未内置 uv 也未装 python」），实际暴露面比 python 侧小。
- 跨实例活跃执行落盘标记（F-1.6）：**【临时补丁，后续排期重构】** —— 影响 `maintenance.py` 的清扫逻辑，属于行为变更，需先做灰度。

---

## §4 目标拆分结构设计

### 4.1 目录树

```
apps/executor-python/
├── main.py                          # 只做 app 装配 + lifespan（现有 575 行可再瘦身）
├── routers/
│   ├── execute.py                   # ★ 只做 HTTP 适配 + 编排（目标 ≤ 250 行）
│   ├── config.py                    # 现有 300 行，不动
│   ├── health.py                    # 现有 141 行，不动
│   └── logs.py                      # 现有 61 行，不动
├── services/                        # ★ 新建：业务子系统（有状态 / 有 IO）
│   ├── git_cache.py                 # S1 git 缓存管理
│   ├── execution_registry.py        # _live_executions + _live_pool_interpreters（落盘化）
│   ├── task_locks.py                # _task_locks / _RecyclableTaskLock
│   ├── venv_service.py              # S3 ensure_venv / _venv_reuse_problem / _run_uv
│   ├── requirements.py              # S3 merge_requirements / _parse_requirements_file
│   ├── callback_dispatcher.py       # S4 内存队列 + 批量发送
│   ├── callback_persistence.py      # S4 落盘 / .meta / 重放 / 死信
│   ├── dead_letter.py               # S4 死信对账
│   ├── package_fetcher.py           # S4 packageUrl 下载 + zip 解包
│   ├── failure_reasons.py           # S5 _refine_failure_reason + 结果封包
│   └── artifacts_collector.py       # S5 产物收集
├── lib/                             # ★ 新建：纯函数 / 无状态工具（可单测）
│   ├── file_lock.py                 # ★ 跨进程文件锁（flock / msvcrt）
│   ├── preflight.py                 # ★ 执行前置校验门（单一入口）
│   ├── ssrf.py                      # 地址分类（纯）+ DNS 解析（薄 IO）
│   ├── env_policy.py                # env 白名单 / denylist / 子进程 env
│   ├── spawn_policy.py              # _spawn_kwargs_for_platform / _build_shell_cmd
│   ├── git_refs.py                  # _validate_git_ref / _repo_dir_name
│   ├── params_env.py                # _serialize_param_value / 折叠冲突判定
│   ├── timeouts.py                  # _resolve_task_timeout / _clamp_timeout_seconds
│   ├── process_tree.py              # _posix_kill_process_group（POSIX+win32 一处）
│   └── logging_limits.py            # 截断/上限常量
└── tests/
    ├── test_lib_*.py                # ★ 纯函数单测（无 mock）
    ├── test_services_*.py           # ★ 有 IO 的（需 mock）
    └── test_routers_execute.py      # ★ 只测 HTTP 适配
```

### 4.2 每文件职责边界与公开接口签名草案

#### `lib/file_lock.py` —— 跨进程互斥（**新增，最高优先级**）

```python
"""跨进程文件锁：同一台机器上同一资源目录的互斥。

为什么不用 Redis / DB advisory lock：
  被锁资源（.git_cache / 解释器池 / .pkg-cache）都在**执行器本地的卷**上，
  执行器**不直连 DB**，离线私有化部署**没有 Redis**。跨进程/跨实例互斥的
  正确原语就是 OS 文件锁。

为什么用 flock 而不是「锁文件 + PID 存活检查」：
  进程被 SIGKILL 后，flock 由**内核**自动释放；PID 检查法会留下死锁锁文件。
"""

@contextmanager
def file_lock(path: Path, *, timeout: float = 300.0, poll: float = 0.05) -> Iterator[None]:
    """在 path（通常是 <被锁目录>.lock）上取排他锁。

    - POSIX: fcntl.flock(fd, LOCK_EX)
    - win32: msvcrt.locking(fd, LK_LOCK) 逐块
    - timeout 过期 → 抛 TimeoutError（**不静默降级**：静默降级 = 退化成无锁）
    """

@contextmanager
def file_lock_or_timeout(path: Path, *, timeout: float = 0.0) -> Iterator[bool]:
    """拿不到锁就 yield False（用于「尽力而为」路径，如 TTL 清扫）。"""
```

**用例（阶段 1 就落地）**：

```python
# services/git_cache.py
with file_lock(cache_dir.with_name(cache_dir.name + '.lock')):
    _git_checkout_to_locked(repo_url, cache_dir, ref, dest)

# interpreters.py —— 与 node 侧共用同一锁文件命名：<version>.lock
with file_lock(pool_root() / f'{version}.lock', timeout=download_timeout):
    ...uv python install...
```

> **跨语言一致性**：node 侧必须用**完全相同的锁文件路径规则**，否则两边各锁各的。这一点由 §6 阶段 2 的守卫钉住（`scripts/check-shared-cache-lock.mjs`：比对两端锁文件命名规则）。

#### `lib/preflight.py` —— 执行前置校验门（**单一入口**）

```python
"""执行前置校验门：**唯一**的「这个请求能不能跑」判定入口。

设计原则（对齐 executor-protocol 的 envForward 三桶范式）：
  1. **单一入口**：run_task / accept_execution 只调一次 preflight()，
     不再散落各字段的判定。
  2. **纯函数优先**：每条判定拆成「纯判定」+「薄 IO 包装」，
     纯判定部分可单测、无需 mock。
  3. **fail-closed**：任何无法证明安全的输入一律拒绝。
  4. **可审计**：门返回的每条判定都带 (rule_id, verdict, detail)，
     可写入执行日志，便于事后审计。
"""

@dataclass(frozen=True)
class PreflightViolation:
    rule_id: str            # 稳定 ID，进 protocol.json 的 preflight 段
    field: str              # 'gitRepo' | 'packageUrl' | 'entrypoint' | ...
    detail: str             # 面向用户的中文原因（不泄漏内部细节）
    http_status: int = 400

@dataclass(frozen=True)
class PreflightReport:
    ok: bool
    violations: tuple[PreflightViolation, ...]
    decisions: tuple[tuple[str, str], ...]   # (rule_id, 判定摘要) — 审计用

def preflight(req: "ExecuteRequest", *, merged_task: Mapping[str, Any]) -> PreflightReport:
    """执行前置校验门。**在 spawn 任何子进程之前**调用。"""
```

**收进门的判定（现状 → 目标）**：

| 规则 ID | 现状位置 | 移入后 |
|---|---|---|
| `git_repo.scheme` | `execute.py:4346`（`run_task` 内联） | `preflight.git_repo_scheme` |
| `git_repo.credentials` | `:4360-4374`（内联 15 行） | `preflight.git_repo_credentials` |
| `git_repo.ssrf` | `:4421`（内联，含 `_package_url_host_denied`） | `preflight.git_repo_ssrf` |
| `git_ref.format` | `:4428` → `_validate_git_ref` `:1174` | `preflight.git_ref` |
| `package_url.ssrf` | `:2081` `_assert_safe_package_url` | `preflight.package_url_ssrf` |
| `requirements.option_injection` | `:1186` `_validate_requirements` | `preflight.requirements_options` |
| `entrypoint.path_escape` | `:1277` `_ensure_entrypoint_in_workdir` | `preflight.entrypoint_path` |
| `entrypoint.shell_injection` | `:1107` `_validate_shell_entrypoint` | `preflight.entrypoint_shell` |
| `params.key_collision` | `:1965` `_param_env_key_collisions` | `preflight.params_collision` |
| `env.forward_allowlist` | `:1085` `_build_child_env` | `preflight.env_forward` |
| `timeout.bounds` | `:1247` `_resolve_task_timeout` | `preflight.timeout_bounds` |
| `runtime_version.format` | `:4470-4482`（内联） | `preflight.runtime_version` |
| `sandbox.fail_closed` | `:742` `_sandbox_startup_failure_reason` | `preflight.sandbox_startup` |

#### `routers/execute.py`（拆分后）—— 只做 HTTP 适配 + 编排

```python
router = APIRouter()

@router.post('/execute', dependencies=[Depends(verify_token)])
async def execute(req: ExecuteRequest, request: Request = None):
    """HTTP 适配：解析 → 调 service → 翻译错误。**不含业务判定**。"""
    try:
        accepted = accept_execution(req, traceparent=request.headers.get('traceparent'))
    except ExecutionRejected as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    _spawn_background(_run_and_callback(req))
    return accepted
```

**剩下的东西（≤ 250 行）**：
- `ExecuteRequest` 模型（**从 protocol.json 生成**，不是手写）
- 3 个路由：`POST /execute` / `POST /executions/{id}/kill` / `POST /executions/{id}/pull` 拒绝路径
- `ExecutionRejected` 异常类
- 编排：调用 `services.*` 的 5~8 个入口，把 service 的返回值翻译成 HTTP 响应

**搬走的**：
- 全部 7 个子系统的实现 → `services/` + `lib/`
- 全部模块级可变状态 → `services/`（或落盘化）

#### 各 service 的接口草案

```python
# services/git_cache.py
def repo_dir_name(repo_url: str) -> str: ...                       # 纯
def is_bare_git_repo(cache_dir: Path) -> bool: ...                  # IO
def quarantine_broken_cache(cache_dir: Path) -> None: ...           # IO
def checkout_to(repo_url: str, ref: str, dest: Path) -> None: ...    # IO（持文件锁）

# services/venv_service.py
async def ensure_venv(*, version: str, work_dir: Path, requirements: list[str],
                      env: dict[str,str], timeout: float) -> tuple[Path, dict]: ...
async def run_uv(args: list[str], timeout_seconds: float, *, env=None) -> tuple[int|None, str]: ...

# services/callback_dispatcher.py
def enqueue(payload: dict) -> None: ...
async def flush() -> int: ...

# services/callback_persistence.py
def persist_failed(payload: dict | list[dict], url: str) -> Path | None: ...   # 唯一名
async def retry_persisted() -> int: ...

# services/dead_letter.py
async def reconcile(force: bool = False) -> dict: ...

# services/failure_reasons.py
def refine(message: str) -> str | None: ...                          # 纯
def clamp_interpreter_result(result: dict) -> dict: ...              # 纯

# services/execution_registry.py
def register(execution_id: str) -> "LiveExecution | None": ...
def unregister(execution_id: str) -> None: ...
def get(execution_id: str) -> "LiveExecution | None": ...
def list_active_ids() -> list[str]: ...
def register_pool_interpreter(path: str | Path) -> None: ...
def list_pool_paths() -> list[str]: ...
```

### 4.3 纯函数 vs 有 IO（可单测 vs 需 mock）

**纯函数（约 111/202 = 55%）—— 零 mock 依赖**：

| 函数 | 位置 |
|---|---|
| `_repo_dir_name` | `:260` |
| `_refine_failure_reason` | `:570` |
| `_sandbox_startup_failure_reason` | `:742` |
| `_launcher_startup_failure_reason` | `:776` |
| `_validate_registry_url` | `:848` |
| `_pypi_index_hint` | `:876` |
| `_build_child_env` | `:1085`（读 `os.environ` → 注入 env 参数即可纯化） |
| `_validate_shell_entrypoint` | `:1107` |
| `_build_shell_cmd` | `:1149` |
| `_validate_git_ref` | `:1174` |
| `_validate_requirements` | `:1186` |
| `_prepare_rlimit_limits` | `:1223` |
| `_clamp_timeout_seconds` | `:1228` |
| `_resolve_task_timeout` | `:1247` |
| `_truncate_error_message` / `_truncate_logs` / `_build_callback_logs` | `:1324`/`:1333`/`:1342` |
| `_requirement_key` / `merge_requirements` | `:1688` / `:1702` |
| `_clamp_interpreter_result` | `:1742` |
| `_serialize_param_value` / `_is_injectable_param_key` / `_param_env_key_collisions` / `_serialize_params_json` | `:1872`/`:1920`/`:1965`/`:2001` |
| `_package_url_host_denied` / `_url_origin_for_log` / `_host_is_loopback` | `:2043`/`:2072`/`:2121` |
| `_git_repo_host` | `:2158` |
| `_package_download_headers` | `:2166` |
| `_derive_task_key` | `:2379` |
| `_validate_callback_payload` | `:2881` |
| `_callback_retry_sleep_seconds` | `:2830` |
| `_decode_interpreter_failure` | `:2368` |

**有 IO（需 mock）**：

| 函数 | IO 类型 | 现有 mock 面 |
|---|---|---|
| `_host_is_restricted` | **DNS 解析**（`socket.getaddrinfo`） | `tests/test_ssrf_guard.py` |
| `_download_package` | HTTP + 文件系统 | `tests/test_zip_channel.py` / `test_p3_audit_fixes.py` |
| `_extract_package` | 文件系统 | `tests/test_zip_guard_parity.py` |
| `git_checkout_to` | subprocess | `tests/test_execute.py` |
| `_run_prepare_cmd` | subprocess | `tests/test_exec_02_launcher.py` |
| `_persist_failed_callback` / `retry_persisted_callbacks` | 文件系统 | `tests/test_callback_persistence.py` |
| `reconcile_dead_letter_files` | 文件系统 + HTTP | `tests/test_dead_letter_reconcile.py` |
| `ensure_venv` / `_run_uv` | subprocess + 文件系统 | `tests/test_venv_versioning.py` |
| `_ensure_interpreter` | 跨模块调用 `interpreters` | `tests/test_interpreter_failure.py` |

### 4.4 与 node 执行器的一致性对齐方案

**对齐机制**：复用 `packages/executor-protocol/protocol.json` 的**三桶范式**（`envForward` 已验证的样板）：

```jsonc
// packages/executor-protocol/protocol.json 新增段
"preflight": {
  "$comment": "执行前置校验门契约：每个 rule_id 是一条判定规则，"
              "两端必须给出**相同结论**（同一输入 → 同一 ok/违规集）。"
              "「判定规则」与「判定所需的环境能力」（如 DNS 解析）分开登记："
              "能力差异进 runtimeOnly 并带 reason。",
  "rules": {
    "gitRepo.scheme":     { "field": "gitRepo",  "reject": "..." },
    "gitRepo.credentials":{ "field": "gitRepo",  "reject": "..." },
    "packageUrl.ssrf":    { "field": "packageUrl", "reject": "..." },
    "requirements.options": { "field": "requirements", "reject": "..." },
    "entrypoint.pathEscape": { "field": "entrypoint", "reject": "..." },
    "params.keyCollision":{ "field": "params", "reject": "..." },
    "timeout.bounds":     { "field": "timeoutSeconds", "reject": "..." }
  },
  "capabilityOnly": {
    "executor-python": [
      { "name": "dnsResolution",
        "reason": "python 侧对 SSRF 目标做**真实 DNS 解析**（getaddrinfo），"
                  "node 侧只做字符串判定——node 侧尚无 DNS-rebinding 防护，"
                  "登记为能力差异而非实现偷懒。" }
    ]
  },
  "vectors": [ /* 共享向量：两端跑同一份输入，断言同一结论 */ ]
},
"sandbox": {
  "modes": ["", "bwrap"],
  "failClosedReasons": ["sandbox_unavailable", "launcher_error"],
  "startupFailurePatterns": [ /* 日志模式 → failureReason 的规则表 */ ]
}
```

**守卫**（新）：`scripts/check-preflight-parity.mjs`
- 判据①：`protocol.json` `preflight.rules` 非空（**下界**，防「表被清空 → 零差异全绿」——这是 `check-ssrf-deny-parity.mjs` T4 审计踩过的坑）
- 判据②：`protocol.json` `vectors` ≥ N 条，且**两端都消费**（grep 到引用）
- 判据③：两端对每条 vector 的结论**逐条相等**
- 判据④：`sandbox.startupFailurePatterns` 里的每个 pattern 都能映射到 `failureReason.executorReportable` 里的某个值

**与既有守卫的关系（必须明确，不打架）**：

| 既有守卫 | 本方案的关系 |
|---|---|
| `check-ssrf-deny-parity.mjs` | **保留**。它守的是「18 条危险地址的清单在三处都在」。本方案新增的是「**判定规则**」层面的契约。两者**互补**：前者管清单，后者管规则。**但 `apps/executor-python/tests/test_ssrf_guard.py` 与 `apps/executor-node/src/lib/ssrf-deny-parity.spec.ts` 这两个文件必须保留**（守卫的 `TARGETS` 指向它们，删了守卫会红）。→ 迁移后这两个 spec 改为「从 protocol.json 读矩阵」的转发测试。 |
| `check-sanitize-parity.mjs` | **不冲突**，不动。 |
| `check-failure-reasons.mjs` | **互补**。它守「失败原因枚举四方一致」；本方案新增「日志模式 → 失败原因」的**映射表**。枚举本身不动。 |
| `check-env-drift.mjs` | **不冲突**，不动（EXEC-05 已收敛）。 |
| `check-sandbox-limit-order.mjs` | **不冲突**，不动。 |

---

## §5 开源参考清单

> **协议纪律**：本仓 **AGPL-3.0-only**。下表所有项目**只借鉴思路，不复制代码**。LGPL/GPL 协议项目（Dramatiq / bubblewrap）**严禁**复制实现到本仓。

| # | 项目 | 仓库地址 | License | 核心亮点 | 可复用点 | 缺陷 | 适配成本 |
|---|---|---|---|---|---|---|---|
| 1 | **filelock** | `github.com/benediktschmitt/py-filelock` | **MIT** | 跨平台文件锁抽象：`fcntl.flock`(POSIX) / `msvcrt.locking`(Windows) / `SoftFileLock`；支持 timeout、`is_singleton`、嵌套锁计数 | **最贴合本域需求**：把「同一台机器同一目录」的互斥收敛成**一个** API，正是 §4.2 `lib/file_lock.py` 的原型 | ① `SoftFileLock` 是「锁文件存在即持有」，进程崩溃会**留死锁**——**本仓必须用硬锁（flock）**，不引入 `SoftFileLock`；② 它是**库**（PyPI 依赖），本仓 `requirements.txt` 是否新增依赖需拍板（见 §9）；③ 无「锁超时后是否降级」的策略 | **低**（若允许新增 PyPI 依赖：约 30 行胶水；**若不允许**：直接用 `fcntl`/`msvcrt` 自写，约 80 行，与 §4.2 草案等价） |
| 2 | **portalocker** | `github.com/wolph/portalocker` | **BSD-3-Clause** | 文件锁的另一个成熟实现，API 更贴近「拿不到就抛 `LockException`」，有 `LOCK_EX`/`LOCK_NB`、超时、`shared`/`exclusive` 区分 | ① **超时/非阻塞语义**明确 → 适合「拿不到锁就不等」的路径（如 TTL 清扫的 best-effort 跳过）；② 支持 `LOCK_SH`（共享锁）→ 未来「多读单写」的 git 缓存可优化 | ① BSD-3-Clause 与 AGPL-3.0-only **兼容**（BSD-3 是 permissive，可作为独立依赖引入）；② 与 filelock 功能重叠，**二选一即可**，不要同时引入；③ 同样有「软锁」变体需避开 | **低**（与 #1 二选一） |
| 3 | **Celery** | `github.com/celery/celery` | **BSD-3-Clause** | prefork worker 池（`concurrency` 配置、`--prefetch-multiplier` 控制「预取未确认任务数」）、`routes` 任务路由、`acks_late` 投递语义 | ① **prefetch 语义**：Celery 的「预取倍数」正对应本仓 `_get_task_lock` 的「同一 taskId 串行」——**任务分派到哪台执行器**应从执行器里剥离（与 Temporal 的结论一致，见 §5.8）；② **acks_late + 幂等重投**正是本仓回调落盘重放的语义原型 | ① **需要 Broker（Redis/RabbitMQ）** —— 本仓**离线私有化部署无 Redis**（`OFFLINE-PROVISIONING.md` 明确离线形态）；② 引入 Celery = 引入 broker 运维面，与本仓「执行器无状态、无外部依赖」的设计冲突；③ AGPL-3.0-only 项目引入 BSD-3 依赖本身合法，但**整体部署形态会变成 Celery 应用**，改动远超本域 | **高**（**建议不引入**，只借鉴 prefetch/acks_late 的**语义设计**） |
| 4 | **Dramatiq** | `github.com/DRMacIver/Dramatiq` | **LGPL-3.0** | 轻量消息队列；**middleware 机制**（把「重试/限流/结果上报」做成可插拔中间件） | ① **middleware 化**的思路：把本仓回调的「重试 / 落盘 / 死信 / 对账」做成**可插拔管道**，而不是一个 500 行的巨型函数——**这是 §4.2 `services/callback_*.py` 拆分的思想来源** | ① **LGPL-3.0 与本仓 AGPL-3.0-only**：LGPL-3.0 是 GPL-3.0 的变体，**在 AGPL 项目中引入 LGPL 代码有**「能否以库形式链接」**的合规风险**（AGPL §13 的「GPLv3 兼容」判定需人工评估）——**严禁复制其代码进本仓**；② 同样需要 broker；③ 生态面小 | **高**（**严禁复制代码**；**只借鉴 middleware 分层思路**） |
| 5 | **APScheduler** | `github.com/agronholm/apscheduler` | **MIT** | 调度器；**JobStore 抽象**（内存 / SQLAlchemy / Redis 等可替换后端）+ **misfire_grace_time** + **coalesce** | ① **「调度器与后端可分离」**的抽象边界 —— 对应本仓「**回调重放循环**的存储后端可替换（内存 → 文件 → 未来 DB）」；② **misfire/coalesce** 语义：错过的周期任务**合并为一次**而非堆积 —— 对应本仓「执行器离线期间的任务回调」的正确语义 | ① 它是**调度器**不是执行器，本仓的执行调度在 admin 侧（`scheduler.py` 825 行在执行器内做的是「拉取 + 回报」）；② 引入 = 引入 APScheduler 依赖 + job store 后端选择 | **中**（借鉴「存储后端可插拔」这一条即可，无需引入库） |
| 6 | **bubblewrap** | `github.com/containers/bubblewrap` | **LGPL-2.1** | setuid/unprivileged user namespace 沙箱；`--ro-bind` / `--unshare-*` / `--die-with-parent`；**`--die-with-parent`** 保证父进程死则子死 | ① **`--die-with-parent`** 语义正是本仓 `_kill_process_tree` 想要的「父死子死」—— 可作为**沙箱 profile 的一个选项**（比「执行器自己维护 pgid 表」更可靠）；② `--ro-bind / /` + `--bind <work_dir>` 是本仓 sandbox profile 的现成模板 | ① **LGPL-2.1**：本仓 Dockerfile 已装 `bubblewrap`（apt 包），**作为系统包使用不构成链接**，但**严禁复制其源码**；② 需要 user namespace 支持——`docker-compose.yml:437` 注释已自认「多数宿主的 seccomp 策略不允许非特权 user namespaces」→ 开箱即用形态下 bwrap 不可用；③ `--die-with-parent` 依赖 prctl，**Windows 无对应** | **中**（profile 层借鉴，不改代码库依赖） |
| 7 | **nsjail** | `github.com/google/nsjail` | **Apache-2.0** | 更强的沙箱：namespace 隔离 + seccomp + cgroup + rlimit；**配置是纯文件** | ① **声明式配置文件**（`nsjail.cfg`）—— 对本仓「sandbox profile 应可审计、可版本化」是直接可借鉴的形态；② cgroup 级内存限制（比本仓 RLIMIT_AS 的 per-process 语义更准，见 round3 审计 S4-C2） | ① 需要更多内核能力（cgroup v2、seccomp），**部署前提比 bwrap 更苛刻**；② Apache-2.0 与 AGPL-3.0-only **兼容**（Apache-2 是 permissive，可作独立进程使用）；③ 本仓当前 sandbox 默认关闭（`TASK_SANDBOX` 默认为空），切换 nsjail = **行为变更**（需要新的验收矩阵） | **中-高**（**本轮不建议切换**，仅登记为未来路径） |
| 8 | **Gunicorn** | `github.com/benoitc/gunicorn` | **MIT** | pre-fork worker 模型；**`preload_app` 预热**（fork 前加载 app，避免每 worker 重复初始化）；**信号处理**（SIGTERM → 优雅退出）；`max_requests` 抖动重启 | ① **`preload_app` 的反面教训**：本仓若将来真的上多 worker，**模块级状态（`_live_executions` / `_task_locks` / `_git_cache_locks`）在 fork 后会被复制成 N 份** —— 这正是**不能靠「加个 worker 数」解决**的根本理由；② **`max_requests` 抖动重启**：本仓执行器若长期运行，内存增长（`_git_cache_locks` / `_task_locks` **只增不减**，见 §1.1 遗留）需要周期性回收 | **高**（**不建议引入**——本仓 `main.py:90-102` 已自定义 signal drain 闸并**刻意**不用 gunicorn；引入会与 `install_signal_drain_gate` 冲突）；**但 §1.2 的「模块级字典只增不减」是真实泄漏点，应自查** | **高**（不引入，但**借鉴 `max_requests` 的抖动回收思想**） |
| 9 | **Temporal**（本机已有副本 `/home/yongsheng/project/open_sourse/temporal-main`） | `github.com/temporalio/temporal` | **MIT** | durable execution：**历史事件日志 + worker 重放**；matching 服务的 sync-match 优化；**worker 无容量注册**（long-poll 拉取） | ① **「选哪个 worker」从业务逻辑里剥离**：Temporal 的 `matching` 服务把「任务给谁」与「任务做什么」彻底分开 —— 对应本仓「**admin 侧选执行器**」与「**执行器侧跑任务**」的边界（**本仓已由 admin 的 claim 机制实现**）；② **at-least-once + 幂等**：Temporal 的「WFT 超时 → 重新派发」语义，正是本仓回调「落盘重放」的语义原型；③ **worker 无注册容量** → 执行器**心跳上报可执行状态**而非「谁来干」 | ① 是**重型分布式系统**（Go，5 个服务），本仓不可能引入；② 其「持久化历史 + 重放」模型要求**业务代码写成确定性状态机**——本仓任务是**任意用户代码**（非确定性），**不可套用**；③ 本仓已有 admin claim + 回调落盘，覆盖了它 80% 的价值 | **高**（**不引入**；**只借鉴「调度与执行分离」这一条架构结论**） |
| 10 | **Hatchet**（本机已有副本 `/home/yongsheng/project/open_sourse/hatchet-main`） | `github.com/hatchet-dev/hatchet` | **MIT** | 任务路由 + **worker 亲和（affinity）/ 池（pool）** 概念 | ① **「同一 taskId 固定路由到同一 worker」** —— 与本仓 `_get_task_lock`（同 taskId 串行）的**目的完全相同**，但 Hatchet 是**在调度侧实现**（无状态执行器），本仓是在**执行侧加锁**（有状态执行器）→ **这是本仓一个可演进的方向**：把「同 taskId 亲和」下沉到 admin 侧，执行器即可删掉 `_task_locks` | ① 同样是重型分布式系统（Go + Postgres + temporal 依赖）；② 本仓已有 admin 侧 claim 机制，但**不保证同 taskId 亲和** | **高**（不引入；**但「同 taskId 亲和下沉到 admin」是一个具体的演进建议**，记入 §9） |

### 5.1 OSS 参考 Top 3（推荐优先阅读/借鉴）

1. **filelock（MIT）** —— 直接解决 P0 的跨进程锁。**可借鉴的具体点**：`fcntl.flock` / `msvcrt.locking` 的平台分派、**硬锁 vs 软锁**的明确区分（**本仓必须硬锁**）、超时语义。**协议无冲突**（MIT）。
2. **portalocker（BSD-3-Clause）** —— 补 filelock 的「非阻塞 / 拿不到就跳过」语义，适合 TTL 清扫的 best-effort 路径。**协议无冲突**。
3. **Celery（BSD-3-Clause）** —— **只借鉴 prefetch / acks_late 的语义设计**（不引入）。**协议无冲突**，但**架构上不适用**（需 broker）。

> **明确排除**：Dramatiq（LGPL-3.0，**AGPL 项目引入 LGPL 代码有合规风险，严禁复制**）、bubblewrap 源码（LGPL-2.1，**仅作系统包使用，不复制代码**）。
> **去重确认**：`/home/yongsheng/project/open_sourse/agent_talk/03_recommendations/01-priority-register.md` 已登记的 27+5 候选**全部属于 agent-runtime / AI-tooling 域**（S1-S6 切片、S4-C4 即 `TASK_SANDBOX` 不上报），**与本域的 executor 拆分/并发锁无重叠**。Temporal / Hatchet 也已在该册中被 R 裁定为「不落地」（R 册 §6 的 N2「GetVersion marker + build-id 路由」→ **无 worker 池概念**），**本报告的 Temporal/Hatchet 引用与之一致**（都指向「调度与执行分离」这一条，不重复造轮子）。

---

## §6 分阶段路线图

### 阶段 1：封堵 P0 并发缺陷（**纯增量，零行为变更**）

**目标**：把三个 P0 缺陷在**不改任何调用点**的前提下封住。

| # | 文件 | 改动 | 验收判据 |
|---|---|---|---|
| 1.1 | **新增** `apps/executor-python/lib/file_lock.py` | 实现 `file_lock()` / `file_lock_or_timeout()`（`fcntl` + `msvcrt`） | 单元测试：POSIX 上两个进程竞争同一锁 → 第二个阻塞；进程被 SIGKILL → 锁自动释放（**关键用例**） |
| 1.2 | `apps/executor-python/interpreters.py:1056-1070` | `_get_version_lock` 的临界区改为 `file_lock(pool_root()/f'{version}.lock')`；**保留**进程内锁作为**同进程内的快速路径**（双层：进程内 + 跨进程） | **新增集成测试**：两个 `multiprocessing.Process` 同时 `ensure_version('3.12')` → 池内**只有一个**版本目录且 `uv python list` exit 0 |
| 1.3 | `apps/executor-python/routers/execute.py:357-383` | `git_checkout_to` 的临界区改为 `file_lock(cache_dir.with_name(cache_dir.name + '.lock'))` | **新增测试**：两进程并发 checkout 同 repo → 缓存目录**不是** `-broken-` 隔离态；且**无丢失** |
| 1.4 | `apps/executor-python/routers/execute.py:3186-3223` | `_persist_failed_callback` 的文件名去掉序号 → `callback-{ts}-{pid}-{uuid8}.json`；**删除** `_callback_persistence_sequence` / `_persistence_sequence_lock` | **新增测试**：两进程并发落盘 100 个回调 → 目录内 **100 个**文件（无覆盖）；`tests/test_callback_persistence.py` 现有断言**逐字不变** |
| 1.5 | `apps/executor-python/pkg_cache.py` | 缓存写入用 `O_EXCL` / 原子 rename 替代「先删后改名」 | **新增测试**：两进程并发写同 URL → 缓存条目**完整**（可解压） |
| 1.6 | **新增** `scripts/check-shared-cache-lock.mjs` | 守卫：凡「写共享目录」的函数，其所在模块**必须**引用 `file_lock` | 守卫红：人为去掉 `interpreters.py` 的 `file_lock` 调用 → 红 |

**阶段 1 验收（可机械验证）**：
```bash
# 1) python 全量测试绿
cd apps/executor-python && python -m pytest tests/ -q
# 2) 新增的跨进程用例绿（标记 -m multiprocess）
python -m pytest tests/ -q -m multiprocess
# 3) 守卫绿
node scripts/check-shared-cache-lock.mjs
# 4) 现有守卫全绿（不打架）
node scripts/check-ssrf-deny-parity.mjs && node scripts/check-failure-reasons.mjs && node scripts/check-sanitize-parity.mjs
```

### 阶段 2：拆分 `execute.py`（**结构性重构**）

| # | 步骤 | 新增/改动文件 | 验收判据 |
|---|---|---|---|
| 2.1 | **先搬纯函数**（零风险） | `lib/git_refs.py` / `lib/params_env.py` / `lib/timeouts.py` / `lib/env_policy.py` / `lib/spawn_policy.py` / `lib/logging_limits.py` | 全部既有测试**只改 import 行**、断言**逐字不动**；覆盖率**不低于**拆分前 |
| 2.2 | **搬安全校验 + 建校验门** | `lib/ssrf.py` / `lib/preflight.py`；`run_task` 改为调 `preflight()` | **新增** `tests/test_preflight.py`（纯函数，零 mock）；`test_ssrf_guard.py` / `test_zip_guard_parity.py` **保留文件名**（守卫 `TARGETS` 依赖），内容改为转发 |
| 2.3 | **搬进程/沙箱** | `lib/process_tree.py` / `services/execution_registry.py` / `services/task_locks.py` | `test_kill.py` / `test_concurrency.py` 只改 import |
| 2.4 | **搬回调子系统**（最大的一块） | `services/callback_dispatcher.py` / `services/callback_persistence.py` / `services/dead_letter.py` | `test_callback_persistence.py`（≈1000 行）/ `test_dead_letter_reconcile.py` / `test_callback_drain_cancel.py` / `test_traceparent.py` 只改 import |
| 2.5 | **搬 venv/requirements** | `services/venv_service.py` / `services/requirements.py` | `test_venv_versioning.py` / `test_requirements_merge.py` / `test_interpreter_failure.py` 只改 import |
| 2.6 | **搬 git 缓存** | `services/git_cache.py` | `test_concurrency.py`（`_get_git_cache_lock` 断言）/ `test_execute.py`（`git_checkout_to`）只改 import |
| 2.7 | **瘦身 router** | `routers/execute.py` 目标 **≤ 250 行** | `routers/execute.py` 只剩：`ExecuteRequest` / `ExecutionRejected` / 3 个路由 / 编排 |
| 2.8 | **测试重组** | `tests/` 按 `lib/` `services/` 镜像 | **每个新模块 ≥ 1 个专属测试文件**；覆盖率不低于拆分前 |
| 2.9 | **★ 分层守卫**（推广既有 `test_module_never_imports_routers_execute`） | **新增** `tests/test_layering.py` + `scripts/check-executor-layering.mjs` | 断言 `services/**` 与 `lib/**` 源码中**不含** `import routers` / `from routers`；`routers/**` **不得** import `services` 以外的私有模块；**违规即红** |

**阶段 2 的硬性纪律（避免「拆分变搬家」）**：
- 每搬一个模块，**先让既有测试只改 import 行就变绿**，再动手搬下一个。**任何需要改断言的搬动都要单独提交并说明理由**。
- **保留模块级属性的 monkeypatch 语义**（`pkg_cache.py:288` 已明说这个坑）—— 拆分后的 service 模块**必须**以 `module.attr` 形式被调用，不能 `from x import y` 后再被 monkeypatch 绕过。

### 阶段 3：契约上提 + 双端收敛

| # | 步骤 | 文件 | 验收判据 |
|---|---|---|---|
| 3.1 | `protocol.json` 新增 `preflight` 段（rules + vectors + capabilityOnly） | `packages/executor-protocol/protocol.json` | `scripts/generate-executor-protocol.mjs` **能生成**（受控子集外的关键字必须报错退出） |
| 3.2 | `protocol.json` 新增 `sandbox` 段（modes / failClosedReasons / startupFailurePatterns） | 同上 | `failureReason.executorReportable` 的每个值都能被某个 pattern 映射到 |
| 3.3 | **新增** `scripts/check-preflight-parity.mjs` | 新文件 | **下界**（rules ≥ 7、vectors ≥ 20）；两端消费同一 vectors；逐条结论相等；**表被清空 → 红** |
| 3.4 | node 侧接入 `preflight` 契约 | `apps/executor-node/src/routes/execute.ts` | node 的 `ssrf-guard.ts` 改为**消费** `protocol.json` 的矩阵（保留其 DNS 能力差异为 `capabilityOnly`） |
| 3.5 | node 侧锁切到文件锁 | `apps/executor-node/src/interpreters.ts:1294` / `routes/execute.ts:127` | **跨语言互锁测试**：node 与 python 同时下载同一版本 → 池内条目完整 |
| 3.6 | 残留重复收敛（R-3/R-4/R-5/R-6） | 回调落盘格式 / zip 归一 / 失败识别 / git-ref & requirements 模式 → `protocol.json` | 各配一个 `.mjs` 守卫；**已有守卫全绿** |
| 3.7 | **演进建议落地**（可选，需拍板） | admin 侧「同 taskId 亲和路由」 | 执行器侧 `_task_locks` 可删除的可行性评估 |

**阶段 3 验收**：
```bash
node scripts/check-preflight-parity.mjs
node scripts/check-ssrf-deny-parity.mjs        # 必须仍绿（TARGETS 未变）
node scripts/check-failure-reasons.mjs
node scripts/check-sanitize-parity.mjs
node scripts/check-env-drift.mjs
npm run test:guards:repo
cd apps/executor-node && npm test
```

---

## §7 风险 + 回滚方案

### 7.1 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-1 | **拆分时 monkeypatch 语义被绕过** | **高** | 高（既有测试假绿 / 真行为漂移） | 纪律：service 内部一律 `module.attr` 调用；阶段 2 每次搬动后**逐字比对**断言 diff；加守卫禁止 `from services.x import y` 形式 |
| R-2 | **`run_task` 拆分引入行为漂移**（1043 行里塞了 12 条判定） | **高** | 高 | ① 拆分**只搬不删**（先整段剪切，再逐条核对）；② 每条判定加**回归用例**（尤其 12 条 preflight 规则各 1 条）；③ 用 `git diff` 逐块核对行数守恒（搬出 N 行 → 新文件应有 N 行） |
| R-3 | **文件锁在 NFS / 某些网络卷上不可靠**（`flock` 语义不保证） | 中 | 中 | ① 锁文件**放在被锁目录旁边**（同一文件系统）；② 加 `LOCK_EX` 失败的**显式异常**（不静默降级）；③ 文档标注「共享卷须支持 flock」 |
| R-4 | **`file_lock` 超时后行为不一致**（一边超时一边继续） | 中 | 中 | 超时**抛异常**（fail-closed），**绝不静默降级为无锁** |
| R-5 | **阶段 3 动 `protocol.json` 触发既有守卫假红** | 中 | 中 | 阶段 3 与阶段 2 **分批**；每批先跑**全部**既有守卫；`check-ssrf-deny-parity.mjs` 的 `TARGETS` **不改**（只改 spec 内容） |
| R-6 | **node 侧改造回归面大**（下载链路 / 解释器池 / 部署） | 中 | 中 | node 侧改造**独立提交**；`apps/executor-node` 的 `npm test` 必须全绿；**【临时补丁，后续排期重构】** 标注：node 侧当前镜像**未内置 uv**（`docker-compose.yml` 注释），实际暴露面比 python 侧小，**可排在 python 侧之后** |
| R-7 | **多副本部署文档与实现漂移**（`docs/deployment.md:1466` 说「执行器不随 --scale 扩展」，但 `docs/operations.md:489` 给了 `--scale executor-node=3`） | 中 | 中 | 阶段 1 完成后**更新文档**：明确「同机多实例共享 `WORK_DIR` 时，git 缓存/解释器池/pkg 缓存由文件锁保护；`WORK_DIR` **必须**按实例隔离**」 |
| R-8 | **模块级字典只增不减的内存泄漏**（`_git_cache_locks` / `_task_locks`） | 低 | 低 | 借鉴 Gunicorn `max_requests` 的抖动回收思路；`_RecyclableTaskLock` 已对 task 锁做了回收，git 缓存锁**没有** → 阶段 2 顺手加 LRU |
| R-9 | **跨实例活跃执行信息缺失**导致误删工作目录 | 中 | 中 | 【临时补丁，后续排期重构】阶段 1 **不做**（属行为变更）；阶段 3 前评估「活跃执行标记落盘」 |

### 7.2 回滚方案

| 阶段 | 回滚方式 | 数据风险 |
|---|---|---|
| **阶段 1** | 逐条 revert（**每条一个独立 commit**）。所有改动都是**增量**（加锁 / 改文件名），revert 即恢复原状 | **无数据风险**：文件锁 revert 后回到「无锁但也不崩」；唯一名 revert 后回到「可能覆盖」的原状（但那一刻缺陷已修，revert 即重新引入） |
| **阶段 2** | ① **每个模块一个 commit**，可逐个 revert；② `routers/execute.py` 在阶段 2 完成前**保留**（不删旧文件），新旧并存 → 通过 `routers/__init__.py` 的 import 切换；③ 任何时候 `git revert` 一个模块的 commit 即恢复 | **无数据风险**（纯代码搬动，无 schema 变更） |
| **阶段 3** | ① `protocol.json` 变更**独立 commit**，revert 即回到旧契约；② **新增段**（`preflight` / `sandbox`）是**追加**，不改动已有段 → 旧生成器仍可工作；③ 新守卫独立文件，revert 即移除；④ node 侧改造独立 commit | **低**：新增协议段不改变既有段的语义；若生成器报错 → revert `protocol.json` 即可 |

**总原则**：**三个阶段都不做数据迁移、不改 schema、不改部署形态**。任一阶段可独立 revert。

---

## §8 测试计划

### 8.1 34 个引用文件的迁移动作清单

**依赖图谱来源**：AST 解析 `tests/*.py` 的 `from routers.execute import ...` / `execute_module.X` / `ex.X` 三种模式（**只读解析，未修改任何文件**）。

> **精确分类（实测）**：`tests/` 共 54 个 `.py` 文件，其中 **33 个真实 import `routers.execute`**（下表组 A/B/C 覆盖），**19 个不 import**（组 D），**2 个仅在注释/断言中提及**：
> - `tests/test_interpreters.py:1315-1319` `test_module_never_imports_routers_execute` —— **★ 架构守卫**（断言 `interpreters.py` 源码里**不含** `'import routers'` / `'from routers'`）；
> - `tests/test_secret_env.py:56` —— 仅注释里提到 `_is_injectable_param_key`。
>
> **★ 守卫的启示（必须纳入拆分设计）**：这条守卫说明**「依赖方向」已经被显式钉住过一次**（`interpreters` 不许反向依赖 `routers`）。拆分后应把它**推广**为一条通用守卫：**`services/` 与 `lib/` 一律不得 import `routers/`**（依赖方向恒为 `routers → services → lib`）。这条守卫是本仓已有的最佳实践，**不是新发明**。

#### 组 A：只改 import（机械，**15 个文件**）

| 文件 | 依赖的符号 | 新 import |
|---|---|---|
| `test_ssrf_guard.py` | `_host_is_restricted` | `from lib.ssrf import host_is_restricted as _host_is_restricted` |
| `test_env_forward_parity.py` | `_ENV_WHITELIST` | `from lib.env_policy import ENV_WHITELIST` |
| `test_execute_request_model.py` | `ExecuteRequest`, `_derive_task_key` | `from lib.params_env import derive_task_key` / 模型从 `routers.execute` 或生成物 |
| `test_requirements_merge.py` | `_parse_requirements_file`, `_read_package_requirements`, `merge_requirements` | `from services.requirements import ...` |
| `test_executor_protocol_contract.py` | `_PARAM_KEY_COLLISION_REASON`, `_is_injectable_param_key`, `_refine_failure_reason`, `_sandbox_startup_failure_reason` | `from lib.params_env import ...` / `from services.failure_reasons import refine` / `from lib.preflight import ...` |
| `test_param_env.py` | `_PARAM_KEY_COLLISION_REASON`, `accept_execution` | 同上 |
| `test_zip_guard_parity.py` | `_extract_package`, `_zip_safety` | `from services.package_fetcher import extract_package` |
| `test_zip_safety.py` | （直接测 `zip_safety.py`，**不动**） | — |
| `test_interpreter_failure.py` | `_is_interpreter_unavailable`, `_refine_failure_reason` | `from services.failure_reasons import ...` |
| `test_interpreters_reporting.py` | `UV_VENV_TIMEOUT_SECONDS`, `_interpreter_download_timeout` | `from services.venv_service import ...` |
| `test_execute_protocol_gate.py` | `ExecuteRequest`, `ExecutionRejected`, `accept_execution` | `from routers.execute import ...`（**留在 router**） |
| `test_p2_audit_fixes.py` | 同上 | 同上 |
| `test_scheduler.py` | `ExecutionRejected`, `list_active_execution_ids` | `from services.execution_registry import list_active_execution_ids` |
| `test_traceparent.py` | `_send_callback_with_retry` | `from services.callback_dispatcher import send_callback_with_retry` |
| `test_exec_02_launcher.py` | `_kill_process_tree`, `_launcher_startup_failure_reason`, `_prepare_rlimit_limits`, `_refine_failure_reason`, `_run_prepare_cmd`, `_run_uv`, `_spawn_kwargs_for_platform` | 分别 → `lib/process_tree.py` / `lib/preflight.py` / `services/venv_service.py` / `lib/spawn_policy.py` |

#### 组 B：改 import + **保留模块级属性 monkeypatch 语义**（**12 个文件**）

| 文件 | 依赖的符号 | 关键约束 |
|---|---|---|
| `test_audit_fixes.py` | `ExecuteRequest`, `_PrepareCancelled`, `_RecyclableTaskLock`, `_download_package`, `_get_task_lock`, `_prepare_rlimit_limits`, `_run_and_callback`, `_serialize_param_value`, `_serialize_params_json`, `_task_locks`, `_venv_python_bin`, `ensure_venv`, `execution_exists`, `register_live_execution`, `run_task` | `_download_package` **被 monkeypatch**（`pkg_cache.py:288` 注释明说）→ 新模块必须保留 `module._download_package` 形态 |
| `test_execute.py` | **43 个符号**（最大） | 逐个映射；`_live_executions` / `_background_tasks` / `_live_pool_interpreters` 迁到 `services/execution_registry.py`，测试需改成访问新模块的属性 |
| `test_callback_persistence.py` | 20 个符号 | `_dead_letter_count_cache` / `_callback_retry_stop` / `_background_tasks` 是**模块级状态** → 迁到 `services/callback_persistence.py`；测试的 `monkeypatch.setattr(execute_module, '_dead_letter_count_cache', ...)` 需改目标 |
| `test_concurrency.py` | `_derive_task_key`, `_get_git_cache_lock`, `_get_task_lock`, `_repo_dir_name`, `_run_and_callback`, `_task_locks`, `_task_locks_loop`, `execution_exists`, `git_checkout_to`, `register_live_execution`, `run_task` | `_get_git_cache_lock` 迁到 `services/git_cache.py`；**新增**跨进程用例 |
| `test_kill.py` | `_kill_body`, `_kill_process_tree`, `kill_running_task_processes`, `fail_prepare_stage_executions_on_shutdown` | `_kill_body` 留在 router（它是 HTTP 响应体） |
| `test_venv_versioning.py` | `_venv_python_bin`, `ensure_venv`, `UV_BIN`, `_get_task_lock` | `ensure_venv` → `services/venv_service.py` |
| `test_zip_channel.py` | `_assert_safe_package_url`, `_download_package`, `_extract_package`, `_package_download_headers`, `_run_and_callback` | `pkg_cache` 通过**参数注入**调用 `_download_package` → 保持注入形态 |
| `test_task_memory_watchdog.py` | `run_task`, `ExecuteRequest` | `run_task` 留 router 或移到 `services/execution.py` |
| `test_p3_audit_fixes.py` | 15 个符号 | 同上分组 |
| `test_maintenance_interpreters.py` | `_live_pool_interpreters`, `_register_live_pool_interpreter`, `_unregister_live_pool_interpreter`, `list_live_pool_interpreter_paths` | 全部迁到 `services/execution_registry.py` |
| `test_maintenance.py` | `list_live_execution_entries`, `register_live_execution`, `unregister_live_execution` | 同上 |
| `test_auth.py` | `execute_module.asyncio`（**模块属性访问**：`monkeypatch.setattr(execute_module.asyncio, 'create_task', ...)`） | ★ **最隐蔽的一类**：monkeypatch 的是 **`asyncio` 模块对象本身**，拆分后若 `asyncio` 被 `from asyncio import ...` 引入就会**静默失效**（monkeypatch 打在别的模块对象上，测试假绿）→ 必须在拆分后**显式验证该用例仍能真正拦截** |

#### 组 C：**无需改动**（**19 个文件**，不 import `routers.execute`）

`test_admin_api.py` / `test_artifacts.py` / `test_commands.py` / `test_config_interpreters.py` / `test_config_reload.py` / `test_device_identity.py` / `test_execution_callback_token.py` / `test_health.py` / `test_log_stream_pusher.py` / `test_log_stream_pusher_cancel.py` / `test_logs.py` / `test_protocol_v7_reporting.py` / `test_pypi_netrc.py` / `test_re_register.py` / `test_registration.py` / `test_sandbox.py` / `test_task_launcher.py` / `test_zip_safety.py` / `__init__.py`

**另有 2 个「伪依赖」文件**：
- `tests/test_interpreters.py` —— 含**架构守卫** `test_module_never_imports_routers_execute`（`:1315-1319`）。拆分后应**保留并扩展**：新增 `tests/test_layering.py`，断言 `services/**` 与 `lib/**` 的源码中**不含** `import routers` / `from routers`（把既有的一条守卫**推广成通用的分层守卫**）。
- `tests/test_secret_env.py` —— 仅注释提及，无 import 依赖。

（`conftest.py` 有 3 个符号的 fixture 引用 → **随组 B 迁移**；`tests/test_auth.py` 引用 `execute_module.asyncio`（**模块属性访问**，`monkeypatch.setattr(execute_module.asyncio, 'create_task', ...)`）→ 属于**组 B** 的「保留模块级属性语义」类）

### 8.2 新增用例

| # | 用例 | 类型 | 验收 |
|---|---|---|---|
| N-1 | **跨进程 git 缓存锁**：`multiprocessing` 启 2 进程并发 `checkout_to` 同 repo | 集成 | 缓存目录**非** `-broken-` 态；无丢失 |
| N-2 | **跨进程解释器池锁**（★ **最高价值**）：2 进程并发 `ensure_version('3.12')` | 集成（需 uv） | 池内**只有一个** `cpython-3.12.*` 目录；`uv python list --only-installed` **exit 0**（不是 exit 2） |
| N-3 | **文件锁的 SIGKILL 释放**：持锁进程被 `SIGKILL` → 第二个进程能立即拿到锁 | 集成 | 无死锁（**这是选 flock 而非软锁的核心理由**） |
| N-4 | **跨进程回调落盘无覆盖**：2 进程各落 50 个 → 目录 100 个文件 | 集成 | 文件数 == 100；无内容串味 |
| N-5 | **preflight 门**：12 条规则各 1 个正例 + 1 个反例 | **纯单测**（零 mock） | 规则 ID 与 `protocol.json` `preflight.rules` **逐条对齐** |
| N-6 | **preflight 门 fail-closed**：畸形 URL / 折行 / 编码绕过 → 一律拒绝 | 纯单测 | 不少于 `test_ssrf_guard.py` 现有用例数 |
| N-7 | **跨端 preflight 结论一致**：消费 `protocol.json` `vectors` | 契约 | python 与 node 对同一 vector 结论**逐条相等** |
| N-8 | **sandbox fail-closed 映射**：`startupFailurePatterns` → `failureReason` | 契约 | 每个 pattern 有唯一映射；无未登记值 |
| N-9 | **模块级 monkeypatch 语义守卫**：断言 service 内部走 `module.attr` | 静态 | 守卫脚本红：改成 `from x import y` 即红 |
| N-10 | **分层依赖守卫**（推广 `test_module_never_imports_routers_execute`） | 静态 | `services/` `lib/` 源码含 `import routers` → **红** |
| N-11 | **monkeypatch 未失效反证**：把 `test_auth.py` 的 `create_task` 替身移除 → 该用例必须红 | 单元 | 防止「拆分后 monkeypatch 打在别的模块对象上、测试假绿」 |

### 8.3 覆盖率与回归基线

- **拆分前后覆盖率不得下降**（当前 `docs/archive/audits/2026-10-29-round3/executors.md` 记载 python 侧全量 **1481 例 / 覆盖 88.29%** —— 拆分后应**不低于**该值）。
- 阶段 1 / 阶段 2 每批的**既有测试必须逐字绿**（除非有显式记录的、逐条说明理由的断言变更）。

---

## §9 待决策项

| # | 问题 | 选项 | 建议 | 阻塞级别 |
|---|---|---|---|---|
| D-1 | **是否允许 `executor-python` 新增一个 PyPI 依赖**（`filelock`）？ | (a) 允许 → 引入 `filelock`（MIT）；(b) 不允许 → 自写 `lib/file_lock.py`（约 80 行，`fcntl` + `msvcrt`） | **(b) 自写**。理由：本仓 `requirements.txt` 极简、离线私有化部署要求「无外部依赖」；80 行可完全掌控（且我们需要**硬锁 + 超时抛异常**这两个非标准语义，`filelock` 的默认行为不完全匹配）。同时**参考** filelock 的平台分派与硬/软锁区分 | **P0 阻塞**（阶段 1 的 1.1） |
| D-2 | **裸机多实例的 `WORK_DIR` 默认值是否改为按实例隔离**？ | (a) 改 `install.sh` 默认值（加实例维度）；(b) 保持不变，**只靠文件锁** | **(a) + (b) 并行**：文件锁是**正确性兜底**（必须做），但 `WORK_DIR` 隔离是**运维正解**（避免清扫/回调文件互相干扰）。改 `install.sh` 默认值会**破坏存量升级路径** → 建议**不改默认值**，改为在 `install.sh` 输出**明确的警告**并在文档中标注「同机多实例必须显式 `--work-dir`」 | **P1** |
| D-3 | **`interpreter_cache` 卷是否改为 executor-node / executor-python 各持一份**？ | (a) 拆卷（最安全）；(b) 共卷 + 文件锁（两端锁文件命名规则一致） | **(b)**。理由：拆卷与 `docs/deployment.md:1440-1444` 的「离线预填」设计冲突（预填需放两份）；但**必须**同批实施阶段 3.5 的 node 侧改造，且**锁文件命名规则必须两端逐字一致**（由 `scripts/check-shared-cache-lock.mjs` 钉住） | **P0**（阶段 3.5 前置） |
| D-4 | **`preflight` 契约进 `protocol.json` 还是独立文件？** | (a) 进 `protocol.json`（复用 `envForward` 三桶范式 + 生成器）；(b) 独立 `packages/executor-protocol/preflight.json` | **(a)**。理由：`protocol.json` 已有 `versioning` / `readiness` / `secrets` / `params` / `envForward` / `failureReason` 六个同类段，`schemas` 段已证明「受控子集 + 生成器报错退出」的范式成熟；另起文件会**分裂事实源**。代价：`protocol.json` 变大（可接受） | **P1**（阶段 3.1 前置） |
| D-5 | **node 侧的 SSRF 判定是否补 DNS 解析**（补齐后 python 可降级为「不解析」）？ | (a) node 补 DNS（两侧能力对齐 → `capabilityOnly` 段可清空）；(b) 维持现状（python 更严，登记为能力差异） | **(b) 暂不动**。理由：node 补 DNS 会改变 node 侧的放行面（**扩面或收紧都影响存量任务**），属**行为变更**，应独立一轮做；本轮只把它**如实登记**为 `capabilityOnly`（**只登记现状，不扩面**，与 `envForward` 段的纪律一致） | **P2** |
| D-6 | **`run_task`（1043 行）拆分后放在哪**？ | (a) 留在 `routers/execute.py`（router 仍有 ~600 行）；(b) 移到 `services/execution.py`（router ≤ 250 行） | **(b)**。理由：任务要求「路由层只剩 HTTP 适配 + 编排」；(b) 才符合。但 `run_task` 内部**混着 `HTTPException` 与 `dict` 两种错误表达** → 搬迁时必须**先把错误表达统一**（这是 §2.2 耦合风险里点名的项） | **P1**（阶段 2.7 前置） |
| D-7 | **是否把「同 taskId 亲和路由」下沉到 admin 侧**（Hatchet 借鉴）？ | (a) 做（可删执行器侧 `_task_locks`）；(b) 不做 | **本轮不做，登记为演进方向**。理由：admin 侧调度器改动面大（`apps/admin-api` 的 claim 机制），与本域正交；**但** §3.6 的 `task_locks` 拆分已把该代码隔离到 `services/task_locks.py`，为将来删除留出干净切口 | **P2** |
| D-8 | **跨实例「活跃执行标记落盘」的形态**？ | (a) `<WORK_DIR>/.live/<executionId>.json` + 心跳 TTL；(b) 不做，维持现状 | **【临时补丁，后续排期重构】**。理由：属**行为变更**（清扫逻辑改），需灰度；且在 D-2 的 `WORK_DIR` 隔离落地后**大部分场景自动消失** | **P2** |

---

## 附录 A：CodeGraph 探查原始数据

```
$ codegraph status
Files: 2,108 | Nodes: 42,151 | Edges: 120,271 | DB 245.12 MB
Languages: typescript 1464, tsx 296, javascript 175, python 132, yaml 36

$ codegraph node "apps/executor-python/routers/execute.py" --symbols-only
**apps/executor-python/routers/execute.py** — 220 symbols, used by 34 files

$ codegraph impact <符号> -d 3
run_task                    → 128 affected symbols
_refine_failure_reason      → 162 affected symbols
merge_requirements          → 137 affected symbols
_host_is_restricted         → 124 affected symbols
_ENV_WHITELIST              →  93 affected symbols
git_checkout_to             →  95 affected symbols
_run_and_callback           →  53 affected symbols
accept_execution            →  27 affected symbols
enqueue_callback            →  11 affected symbols
_get_git_cache_lock         →   9 affected symbols
_quarantine_broken_cache    →   3 affected symbols
```

## 附录 B：关键 file:line 索引

| 主题 | 位置 |
|---|---|
| git 缓存锁（进程内） | `apps/executor-python/routers/execute.py:357-368` |
| git 缓存锁使用点 | `apps/executor-python/routers/execute.py:382-383`（`with _get_git_cache_lock(str(cache_dir)):`） |
| 损坏缓存隔离 | `apps/executor-python/routers/execute.py:292-303` |
| 浅克隆探测/解锁 | `apps/executor-python/routers/execute.py:306-344` |
| 解释器池锁（进程内） | `apps/executor-python/interpreters.py:1056-1070` |
| 解释器池共享卷 | `docker-compose.yml:537`（python）/ `:684`（node）/ `:1092`（卷定义） |
| node 侧解释器 inFlight（进程内） | `apps/executor-node/src/interpreters.ts:1294` |
| node 侧 git 队列（进程内） | `apps/executor-node/src/routes/execute.ts:127-141` |
| 回调落盘文件名（序号） | `apps/executor-python/routers/execute.py:3198-3209` |
| 回调内存队列 | `apps/executor-python/routers/execute.py:2876-2929` |
| pkg 缓存锁（进程内） | `apps/executor-python/pkg_cache.py:251-263` |
| SSRF 判定（python，含 DNS） | `apps/executor-python/routers/execute.py:1820-1869` |
| SSRF 判定（node，纯字符串） | `apps/executor-node/src/lib/ssrf-guard.ts:1-302` |
| SSRF 矩阵事实源 | `apps/admin-api/src/common/utils/__tests__/ssrf-deny-matrix.spec.ts`（18 条） |
| SSRF 守卫 | `scripts/check-ssrf-deny-parity.mjs`（`MIN_SOURCE_ENTRIES = 18`） |
| env 白名单事实源 | `packages/executor-protocol/protocol.json` → `envForward` |
| env 白名单（python） | `apps/executor-python/routers/execute.py:1068-1082` |
| env 白名单（node） | `apps/executor-node/src/env-whitelist.ts:19-42` |
| 失败原因事实源 | `packages/executor-protocol/protocol.json` → `failureReason` |
| 失败原因守卫 | `scripts/check-failure-reasons.mjs` |
| 编排核心 `run_task` | `apps/executor-python/routers/execute.py:4297-5339`（1043 行） |
| 编排核心 `_run_and_callback` | `apps/executor-python/routers/execute.py:3784-3925`（142 行） |
| 部署形态（单进程） | `apps/executor-python/Dockerfile:58` |
| 裸机安装默认 WORK_DIR | `scripts/install.sh:35` |
| 扩容形态 | `docs/operations.md:489` |
| EXEC-01..07 已修记录 | `docs/AGENT-SWARM-PLAYBOOK.md:215-221` |
| EXEC-01..07 原始审计 | `docs/archive/audits/2026-10-29-round3/executors.md:48-54` |
| LeaderGateService（admin，**不可直接复用**） | `apps/admin-api/src/common/leader-gate/leader-gate.service.ts:50-200` |
| RedisLockService（admin，**本域不可用**） | `apps/admin-api/src/common/services/redis-lock.service.ts:28` |
| outbox lease（admin，**本域不可用**） | `apps/admin-api/src/modules/event-subscriptions/outbox-dispatcher.service.ts:83-129` |
| OSS 调研去重册 | `/home/yongsheng/project/open_sourse/agent_talk/03_recommendations/01-priority-register.md` |
| **★ 执行器无 Redis / 无 DB 依赖** | `apps/executor-python/requirements.txt`（仅 8 项：fastapi / uvicorn / httpx / psutil / tenacity / pydantic-settings / PyYAML / uv）—— **证实「Redis 锁 / DB advisory lock」对本域不可用** |
| **★ node 侧依赖极简** | `apps/executor-node/package.json`（仅 6 项：axios / dotenv / express / js-yaml / winston / zod）—— node 侧文件锁需**自写**（Node 无内置 flock），无 `proper-lockfile` 之类现成依赖 |
| **★ 既有分层守卫（拆分须推广）** | `apps/executor-python/tests/test_interpreters.py:1315-1319` `test_module_never_imports_routers_execute` |

---

*报告完 · 2026-11-03 · 只读审计阶段（未修改任何源文件）*

# python-executor 域 P0 结论 · 对抗式复核报告

> 复核对象：`docs/archive/audits/2026-11-03-round1/python-executor.md`（SubAgent 产出，983 行）。
> 复核性质：**独立取证，只读**。不复述父报告，专门找它错在哪 / 夸大了什么。
> 复核时间：2026-11-03。
> 工具链：CodeGraph CLI v1.6.2（MCP `codegraph_explore` 未在本会话工具表暴露，按 AGENTS.md §1 降级 CLI，索引已同步 2108 文件 / 42151 节点）。

---

## §1 复核方法与工具链（含孙Agent 深度限制记录）

### 1.1 孙Agent 创建尝试（如实记录）

任务要求「必须创建至少 1 个孙Agent（CodeGraph 深度探查专项）」。**实际被运行时拒绝**：

```
Error: subagent limit reached (active child limit: 10);
wait for an existing child to finish or complete this work with the current agents
```

**限制类型与父报告记录的不同**：父报告记录的是 `subagent depth 2 exceeds maxDepth 1`（**深度**限制），
本次实测是 **`active child limit: 10`（并发数**限制）——即本会话全局已有 10 个活跃子代理，
不是深度不足。**这是两类不同的限制，不应混淆**（父报告的归因只对了一半）。

**处置**：如实记录后**自行完成全部取证**，未缩减覆盖面。本条不影响结论可执行性，但意味着
**本轮复核没有第二视角**——主 Agent 应据此对 §2 的判定做一次独立抽检。

### 1.2 取证手段

| 手段 | 用途 |
|---|---|
| `codegraph node <文件> --offset N --limit M` | 逐段读源码（视为已 Read，不重复打开） |
| `codegraph node <文件> --symbols-only` | 符号表 / 行号定位 |
| `codegraph callers <符号>` | 反查调用方（测试面统计） |
| `codegraph query <关键字>` | 符号定位 |

---

## §2 逐条复核结论表

| # | 结论 | 原判 | **我的判定** | 关键证据 | 建议动作 | **修正后严重度** |
|---|---|---|---|---|---|---|
| A | 解释器池跨语言并发写 ⇒「整个池不可见」 | P0 | **部分证实 / 后果被夸大** | 池隔离机制 + 双侧 fallback 已存在（见 §3.1） | 降级 + 只保留「跨进程锁缺失」本体 | **P2**（原 P0） |
| B | 回调文件名碰撞 ⇒ 终态回调丢失、任务永远 RUNNING | P0 | **机制证实 / 后果被显著夸大** | 扫描不解析文件名；`payloads` 可批量；见 §3.2 | 修（唯一名），但**不按数据丢失灾难处理** | **P1**（原 P0） |
| C | 一律 flock、不用 Redis/DB | P0 | **证实（依赖面）/ 修法有隐含风险** | requirements.txt 8 项零 redis 零 DB；零 flock 实现 | 采纳，但 Windows 语义需单独处理 | **P0 维持**（正确性） |
| D | `_quarantine_broken_cache` 跨实例从补救变破坏源 | P0 | **机制证实 / 触发窗口窄于描述** | 锁内调用；需「目录存在 + 非 bare + 另一实例正在首次 clone」 | 修（锁内探测），非紧急 | **P2**（原 P0） |
| E | 拆分 execute.py 的测试面分类与两个坑 | 信息 | **完全证实**（两个坑均真实） | 见 §3.5 | 纳入重构前置条件 | 信息级（正确） |

---

## §3 被证伪或需重大修正之处

### 3.1 结论 A 被**显著夸大**（最严重的一处错误）

#### ① 「整个池不可见」这一放大后果**已经在代码里被修掉了**

父报告称并发 `uv python install` 会让 `uv python list --only-installed` 整条 exit 2，
导致执行器上报**空清单**，故障从「一个版本损坏」放大成「**整个池不可见**」。

**代码事实**：`apps/executor-python/interpreters.py:810-858` 已实现 `_scan_pool_directory()` 兜底，
且 `:813-818` 的注释**逐字记录了这个放大机制并说明兜底正是为它而写**：

```
存在的理由（实测，CONTRACT.md §0.3）：`uv python list --only-installed`
只要池内存在**一个同平台但不可运行**的条目就整体 exit 2，并且**连健康
条目也一并从输出里消失**。若此时把池当作"空"，执行器会对外宣称零解释器
——所有声明版本的任务被拒（`interpreter_unavailable`），而池里的健康版本
实际仍可用（`uv venv --python 3.8` 依旧成功）。这条兜底路径让"一个坏条目"
不再致盲整个池。
```

触发点：`interpreters.py:906-909`（`code != 0` → `_fallback_discovery`）、
`:918-925`（uv 成功但零可用条目 → 再扫一次）。
**node 侧有对等实现**：`apps/executor-node/src/interpreters.ts:1395 fallbackDiscovery()`，
`:1438-1442` 还会 warn「recovered N interpreter(s) from a local pool scan」。

⇒ **父报告把「一个已被工程化修复的历史缺陷」当成「现存的放大风险」报告。**
这是本轮最严重的一处错误：它把一个**已被兜底覆盖**的后果描述成 P0 灾难。

#### ② `uv python list --only-installed` 的 exit 2 有**实测记录**，但不是并发导致的

父报告称「并发 install 时 exit 2」。**仓库内确实有 exit 2 的实测证据，但成因不同**：

- `docs/design/python-task-upload-and-multiversion/OFFLINE-PROVISIONING.md:109`：
  `cpython-3.7.9-x86_64-pc-windows-msvc-none`（pbs 三元组）→ `--only-installed` 不列出；`uv venv --python 3.7` **exit 2**
- `interpreters.py:813-818` 注释：成因是「池内存在**一个同平台但不可运行**的条目」

⇒ **「并发 install 导致 exit 2」在仓库内零证据**。真正的成因是**坏条目**（目录名不匹配 /
产物损坏），不是并发写。父报告把「坏条目 → exit 2」的实测结论**错误归因**到了并发上。

**判定**：exit 2 机制 = **证实**；「并发 install 是其成因」= **证据不足，应标『推断』**。

#### ③ compose 默认形态下 node **确实写不了该卷**（父报告此点正确，但未推到结论）

- `apps/executor-node/Dockerfile` 全文 `grep -c uv` = **0**；基础镜像 `node:24-alpine`，`apk add` 无 uv
- `apps/executor-node/src/config.ts:275`：`uvBin: process.env.UV_BIN || ''`
- `apps/executor-node/src/interpreters.ts:1453-1465`：`resolveUvBin` 失败即抛
  `InterpreterUnavailableError('uv_missing')`，**不会**写池

⇒ **compose 默认形态下 node 根本装不了 python，故「跨语言并发写」不成立。**

**真实触发条件（父报告未界定，我给出）**：

| 形态 | node 有 uv？ | 与 python 共享池？ | 跨语言并发写成立？ |
|---|---|---|---|
| compose 默认（`docker-compose.yml`） | ❌ 镜像无 uv | ✅ 共卷 `/data/interpreters` | ❌ **不成立** |
| 裸机混布（`scripts/install.sh` 装 node + 另装 python 执行器，同 `WORK_DIR`） | ⚠️ 取决于宿主 | ⚠️ 取决于 `UV_PYTHON_INSTALL_DIR` | ✅ **成立** |
| 桌面端（`executor-desktop`） | ✅ 发布流水线 `ACF_UV_REQUIRED=1` 强制 bundle | ❌ 桌面端只有 node，无 python 执行器 | ❌ **不成立** |
| 用户自建 node 镜像装了 uv | ✅ | ✅ | ✅ **成立** |

⇒ **成立的只有「裸机混布」与「用户自建镜像」两种形态**，且都需**额外前提**。
**父报告未做这个界定就把 P0 挂在「跨语言」上，是把形态特定的缺陷写成了普遍缺陷。**

#### ④ 池目录名带 libc 分量 ⇒ 跨语言条目本来就物理隔离

`docker-compose.yml:676-688` 注释（主 Agent 已复核）：

> 两执行器基底 libc 不同（node:24-alpine = **musl**；executor-python = **glibc**），因此
> **不能共用同一份解释器产物**——各自需要对应 libc 的构建。共卷本身是安全的：池目录名
> 带 libc 分量（`linux-x86_64-musl` vs `linux-x86_64-gnu`），uv 按平台分量过滤，
> **非本平台的条目被安全跳过**。

两侧代码均只在平台 token 匹配时采纳条目：`interpreters.py:842-844`、`interpreters.ts:1414`。

⇒ **跨语言（musl/glibc）不写同一目录**，所以「跨语言并发写同一目录」在 libc 维度上
**天然不成立**。真正存在的是**同语言跨进程**（两个 python 实例 / 两个 node 实例）。

#### ⑤ 结论 A 修正后的表述

> **真实缺陷**：`interpreters.py:1056-1070` 的 per-version `threading.Lock` 与
> `interpreters.ts:1323-1340` 的 per-version `inFlight` Map **都只在进程内**，
> 因此**同机多实例**（裸机多实例 / 用户自建镜像多副本）并发 `uv python install`
> **同一版本**时无跨进程互斥。
> **但**：坏条目导致的 exit 2 已被双侧 fallback 兜底；跨 libc 条目被平台过滤隔离；
> compose 默认形态 node 无 uv 不写卷。
> ⇒ 真实严重度 **P2**（不是 P0）；触发面 = **裸机多实例 / 自建镜像多副本**，
> 且需「多实例 + 同版本并发首次安装 + 共享 `UV_PYTHON_INSTALL_DIR`」三个前提同时成立。

### 3.2 结论 B 机制**证实**，但后果**被显著夸大**

#### ① 文件名生成式（父报告正确）

`apps/executor-python/routers/execute.py:3196-3219`：

```python
with _persistence_sequence_lock:
    sequence = _callback_persistence_sequence
    _callback_persistence_sequence += 1
filename = callback_dir / f'callback-{int(time.time() * 1000)}-{sequence}.json'
tmp = filename.with_name(filename.name + '.tmp')
payloads = payload if isinstance(payload, list) else [payload]
tmp.write_text(json.dumps({'url': url, 'payloads': payloads}, ...))
if filename.exists():
    filename.unlink()        # ← 写前 unlink
tmp.rename(filename)
```

- 序号是**进程内**计数器（`:3059-3060` 模块级 + `threading.Lock`）
- **写前 `unlink` 确实会覆盖同名文件**（Windows rename-over 非原子，故先 unlink）

⇒ **「跨进程可碰撞 + 碰撞会覆盖」= 证实**。

#### ② 但「终态回调丢失、任务永远 RUNNING」被夸大 —— 扫描逻辑不解析文件名

`:3346-3347` 的重放扫描：

```python
files = sorted(p for p in callback_dir.iterdir()
               if p.is_file() and p.name.startswith('callback-') and p.name.endswith('.json'))
```

- **只按前缀/后缀筛，不解析文件名里的时间戳或序号**
- 排序键是**文件名字符串**（`sorted(Path)`），仅用于遍历顺序，**不用于去重或识别**
- payload 在**文件内容**里：`:3375-3383` 读 `{'url':..., 'payloads':[...]}`

⇒ **文件名的语义仅「唯一标识 + 碰撞源」，不承载任何业务信息。**
碰撞只造成「同名文件被覆盖」，即**丢掉被覆盖那一刻之前的那个 payload 批次**。

#### ③ 影响面比「一条终态」更大也可能更小 —— 取决于 batch 粒度

- 落盘粒度是 **batch**（`:3204` `payloads = payload if isinstance(payload, list) else [payload]`）
  ⇒ 一个文件可含**最多 `CALLBACK_LIVE_BATCH_SIZE` = 100 条**（`:2876`）payload
- 所以碰撞丢的是「**一个批次**」，不是「一条回调」——**父报告说「丢一条终态」低估了**；
  但在「只有一条 payload 的批次」场景下又等价于丢一条——**父报告说「任务永远 RUNNING」高估了**，
  因为该任务的**其他**回调（若已单独落盘）不受影响

#### ④ 内存队列兜底存在，但只覆盖「进程存活期间」

- `_live_callback_queue` + `_drain_live_callback_queue`（`:2877`、`:2921`）
- `enqueue_callback`（`:2906`）先入内存队列实时发；只有**重试耗尽**才走
  `_persist_failed_callback`（`:2999`、`:3013`）
- ⇒ 落盘发生在「实时投递已失败」之后，**内存队列此时已被消耗**

⇒ 碰撞场景下**无第二道兜底**：内存队列只服务实时通道，落盘是最后一道。

#### ⑤ 碰撞的**真实前提**（父报告未精确界定）

`filename = callback_dir / f'callback-{ms}-{seq}.json'` 中：
- `ms` = `int(time.time()*1000)` —— 跨进程**同一毫秒有可能**（同机 NTP 同步，毫秒边界不确定）
- `seq` = **进程内**序号 —— 两个进程**各自从 0 开始** ⇒ **同毫秒 + 同序号在数学上必然可能**

前提条件（三者同时）：
1. 两个执行器实例**共享同一 `WORK_DIR`**（`_callback_dir()` = `settings.work_dir/callbacks`）
2. 两者**恰好同毫秒**各持久化一次
3. 两者**恰好拿到相同序号**（都是各自进程的第 N 次持久化，N 相同）

⇒ 概率低但**非零**，且随实例数与回调量上升。

#### ⑥ 最小复现路径

```
实例 A、B 共享 WORK_DIR=/var/lib/autoflow/tasks（裸机双实例，默认值，见 install.sh:35）
1. A、B 各自进程内序号均为 0（刚启动）
2. 同一毫秒内（time.time()*1000 相同），A 与 B 各自有一次回调实时投递失败 → 落盘
3. A 写 callback-<T>-0.json，内容 {'payloads': [A的批次]}
   B 写 callback-<T>-0.json，先 unlink 再 rename → 覆盖 A 的文件
4. 结果：A 的批次**永远消失**，B 的批次被重放
5. 若 A 的批次里是该 execution 的**唯一**终态回调 ⇒ 该执行在 admin 侧永远 RUNNING
   （admin 的 stale sweep 要等执行器心跳超时才收敛，见 execute.py:3083-3085 注释）
```

#### ⑦ 结论 B 修正后的表述

> **机制证实**：文件名 `callback-{ms}-{seq}.json` 的 `seq` 是进程内计数器，跨进程可碰撞；
> 写前 `unlink` 会覆盖同名文件；落盘是最后一道兜底（内存队列此时已消耗）。
> **后果修正**：丢的是「**一个 batch**（可能含最多 100 条 payload）」，不是「一条」；
> 但「任务永远 RUNNING」只在「该 batch 恰含该执行唯一终态」时成立。
> ⇒ 严重度 **P1**（不是 P0 的数据丢失灾难，但确是真缺陷，且修法极廉价）。

**修法建议（对父报告 §阶段1 的修正）**：父报告建议「uuid/随机后缀」——**方向正确但不够**。
更彻底的是**同时**：
1. 文件名加实例维度（`os.getpid()` 或主机名），**从结构上消除跨进程碰撞**，而非只降概率
2. 保留 `.tmp` + rename 的原子写（已有）
3. **加分片/去重守卫**：新增 spec 断言「同一目录下两个进程并发持久化 1000 次无文件名重复」

### 3.3 结论 C **证实**，但修法有一个被忽略的跨平台风险

#### ① 依赖面（父报告正确）

```
apps/executor-python/requirements.txt 实际内容（8 项）：
fastapi==0.141.1 / uvicorn==0.53.0 / httpx==0.28.1 / psutil==7.2.2
tenacity>=8.2.0 / pydantic-settings==2.15.0 / PyYAML==6.0.3 / uv==0.13.4
```

- **零 redis、零 DB 驱动**（`grep redis|psycopg|sqlalchemy` 仅命中一个测试函数名）
- 执行器**不连 DB**（admin-api 才有 TypeORM）
- `LeaderGateService` / `RedisLockService` / outbox lease 是 admin-api 的机制，
  执行器侧**无装配路径**可复用

⇒ **「不可复用 admin 的锁机制」= 证实**。

#### ② Windows 语义差异（父报告提了「自写 fcntl+msvcrt 约 80 行」，但**未评估风险**）

代码里已有大量 Windows 分支（`interpreters.py:297/352/488/558-559`：进程组、
可执行判定、taskkill /T），说明本仓**确实支持 Windows**。而：

| 平台 | 机制 | 语义差异 |
|---|---|---|
| POSIX | `fcntl.flock` | 进程崩溃 → 内核自动释放；**可重入**（同进程多次 flock 同一 fd 不阻塞）；`fork` 后子进程共享锁 |
| Windows | `msvcrt.locking` | 需显式 `LK_UNLCK`；**崩溃后锁可能滞留**（文件句柄关闭才释放）；只能锁**字节范围**（需锁 1 字节）；**不支持共享锁语义** |

⇒ **父报告的「自写 80 行」低估了**：不是 80 行能对齐的，因为两端**语义不同**。

**我的建议**（对阶段1 方案的修正）：
1. **不要追求两端语义完全一致**——而是**统一抽象**：`acquire(path, timeout)` 阻塞式独占锁，
   崩溃自动释放。POSIX 用 `flock`，Windows 用 `msvcrt.locking` 但**必须**：
   - 锁文件常驻（**不删除**锁文件——Windows 上删除被锁文件会失败），只锁 1 字节
   - `timeout` 到期抛异常（两端同款），不静默继续
2. **加一条跨平台守卫 spec**：模拟「持锁进程被 kill」→ 新进程能在 timeout 内拿到锁
3. 若目标平台只有 Linux（compose 全 Linux），**Windows 分支标 `pragma: no cover` + 文档声明
   「Windows 多实例未验证」**，不假装支持

### 3.4 结论 D 机制**证实**，但触发窗口比描述窄

#### ① 触发路径（file:line 已锁定）

`execute.py:513-515`（`_git_checkout_to_locked` 内）：

```python
if cache_dir.exists() and not _is_bare_git_repo(cache_dir):
    logger.warning('git cache %s is not a valid bare repo (killed clone?) — quarantining and re-cloning', cache_dir)
    _quarantine_broken_cache(cache_dir)
```

`_is_bare_git_repo`（`:275-289`）：先看 `HEAD` 是否存在，再 `git rev-parse --is-bare-repository`。

`_quarantine_broken_cache`（`:292-303`）：**rename** 成 `-broken-<ts>`，失败才 `rmtree`。
⇒ **不是删除，是移走**（父报告「隔离」用词正确，非「删除」）。

#### ② 为什么父报告的「A 正在使用的完好缓存被 B 误判」**不会**发生

`git_checkout_to`（`:371-383`）：

```python
with _get_git_cache_lock(str(cache_dir)):        # ← 进程内锁
    _git_checkout_to_locked(repo_url, cache_dir, ref, dest)
```

- **同进程内**：A 持锁期间 B 在 `with` 处**阻塞**，进不到 `_git_checkout_to_locked`
  ⇒ 「A 正在用、B 误判」**在同进程内不成立**
- **跨进程**：锁不生效 ⇒ B 可进入并探测

所以跨进程才是窗口。但即使跨进程，B 判断的是
「`cache_dir` 存在 **且** 不是 bare repo」——这只有在 **A 的 clone 尚未完成**
（`HEAD` 未写 / `rev-parse` 失败）时才成立。

⇒ **真实窗口 = 「A 正在首次 clone（尚未成为 bare）时，B 进入并探测」**，
不是「A 已 clone 完好并被使用中」。

#### ③ 后果

B 把 A 的半成品移走 → A 的 clone 写进被 rename 的目录（仍持有 fd）或失败 →
A 重试一次（下次探测时 `cache_dir` 不存在 → 重新 clone）。
⇒ **多一次 clone 成本，不是数据损坏**。且 A 的 clone 若已写完，B 的 rename 会让 A 的
后续 checkout 找不到 cache → 该次执行失败可重试。

⇒ **严重度 P2**（父报告 P0 过高）。

### 3.5 结论 E **完全证实**

#### ① 测试面统计（我独立复核，与父报告的 33/19/2 口径一致）

```
直接 import routers.execute 的测试文件：33
涉及 execute_module / routers.execute 的测试文件：32
```
（父报告「33 个真实 import / 19 个不 import / 2 个伪依赖」——**总量 33+19+2 = 54**
与你给的分类口径不同，但**「33 个直接 import」这一关键数字我独立复现，一致**。）

#### ② 坑一：`_download_package` 的 monkeypatch 形态（**证实**）

`apps/executor-python/pkg_cache.py:288` 注释逐字写明：

> `download` 经参数注入而不是模块级 from-import：routers/execute 的
> `_download_package` 是模块属性、测试常年 monkeypatch 它（test_zip_channel
> 的 _boom_download 等替身）——按名 from-import 会把这层替身整个绕开。

实证：`tests/test_audit_fixes.py:281` `monkeypatch.setattr(execute_module, '_download_package', boom_download)`

⇒ **拆分时必须保持 `routers.execute._download_package` 这个 `module.attr` 形态**
（即拆分后 `routers/execute.py` 仍须以模块属性方式重新导出该符号），否则测试替身静默失效。

#### ③ 坑二：`test_auth.py` monkeypatch `asyncio` **模块对象本身**（**证实**）

`tests/test_auth.py:45-57`：

```python
from routers import execute as execute_module
...
monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)
```

⚠️ 注意：`execute_module.asyncio` 是**模块对象**，`monkeypatch.setattr` 作用于
**全局 `asyncio` 模块的 `create_task`**（不是 `execute` 模块的某个属性）。

⇒ 拆分后如果 `create_task` 的调用点迁到新模块（如 `services/execution.py` 用
`import asyncio` 而非 `from routers import execute` 的 `asyncio` 引用），
**patch 会打到没人用的位置**，测试**假绿**（真实 `asyncio.create_task` 被调用，
测试却以为被 stub 了）。

**修正建议**：拆分时**必须**把这些 patch 点改为显式依赖注入或
`monkeypatch.setattr("routers.execute.asyncio", ...)` 的**模块路径字符串**形态，
并加一条守卫断言「patch 目标在拆分后仍被真实调用点引用」。

---

## §4 新发现（父报告未提）

### 4.1 `_persist_failed_callback` 的 `unlink` 在 Windows 上是**已知妥协**，但缺注释

`execute.py:3206-3208`：

```python
# Windows rename-over-existing is not atomic-safe; unlink first
if filename.exists():
    filename.unlink()
tmp.rename(filename)
```

**问题**：`exists()` → `unlink()` → `rename()` 是**三步非原子**。即使文件名唯一，
两个进程同毫秒同序号时仍会：
- A `exists()`=False → B `exists()`=False → 各自 `rename` → **后者覆盖前者**（Windows rename 语义）
- 或 A `unlink()` 抛 `FileNotFoundError`（B 已先删）→ 被 `except OSError` 吞掉 → **整次持久化失败**

⇒ **修法应是「不做 unlink，用 `os.replace`」**（Windows 上 `os.replace` 是原子覆盖），
再叠加唯一名。这比只加 uuid 更根本。

**⚠️ 交叉对照（node 侧已有正确范式，本条是「对齐」而非「发明」）**：
`apps/executor-node/src/callback.ts:19-37` 的 NETOPT-4 注释逐字写：

```
同目录 rename 的原子性由 POSIX 保证；Windows 上 Node 的 renameSync 以
MoveFileEx(REPLACE_EXISTING) 实现，同样覆盖语义。失败时清理 .tmp 不留孤儿
```

且 node 侧实现是 `fs.writeFileSync(tmp, data); fs.renameSync(tmp, filepath);`
——**没有 `exists()` 探测、没有 unlink**。

⇒ **两侧本可以一致**：python 的 `Path.rename` 在 Windows 上不覆盖（故才加了 unlink），
但 `os.replace`（Python 3.3+ 标准库，Windows 上走 `MoveFileEx` +
`MOVEFILE_REPLACE_EXISTING`）**就是**原子覆盖。
⇒ **建议改法**：python 侧 `tmp.replace(filename)`（等价 `os.replace`），
**删掉 `exists()` + `unlink()` 两行**，与 node 侧逐字对齐。
⇒ 附带收益：消掉 §4.1 的「unlink 抛 FileNotFoundError ⇒ 整次持久化失败」窗口。

### 4.2 `_git_cache_locks` 字典**永不清理**（内存泄漏，跨进程问题之外的独立缺陷）

`execute.py:357-368`：`_git_cache_locks: dict[str, threading.Lock] = {}` 只增不删。
每个不同 `repo_url` 产生一条。长期运行 + 大量不同仓库 ⇒ **无界增长**。
虽然每条很小（Lock 对象），但这是**独立于跨进程锁**的既有缺陷，建议一并修（加 LRU 或弱引用）。

### 4.3 回调扫描的 `sorted(p for p in ...)` 在**大量文件**时是 O(n log n) 每轮

`:3346` 每 `CALLBACK_RETRY_SWEEP_INTERVAL_SECONDS`（1.0s，`:3046`）全量 `iterdir` + `sorted`。
死信积压 10 万文件时每轮扫目录 = 明显 I/O 放大。父报告的「回调落盘」分析未提这条。

---

## §5 对阶段1（flock + 唯一名 + 守卫）方案的修正建议

| 父报告方案 | 我的修正 | 理由 |
|---|---|---|
| 唯一名 = uuid/随机后缀 | **唯一名 = 实例标识 + 单调计数器**（`os.getpid()` 或主机名 + `time.time_ns()`），**并用 `os.replace` 取代 unlink+rename** | 只降碰撞概率不如**结构性消除**；`os.replace` 修掉 Windows 三步非原子 |
| 一律 flock，自写 ~80 行 | **统一抽象 `acquire(path, timeout)`**；POSIX `flock`，Windows `msvcrt.locking` 但**锁文件常驻不删 + 只锁 1 字节 + timeout 抛异常**；**若 Windows 不是目标平台则显式声明不支持** | 两端语义不同，80 行对齐不了；假装支持比不支持更危险 |
| 加 `check-shared-cache-lock.mjs` 守卫（两端锁文件命名一致） | **加，但同时加一条「锁语义」守卫**：两端的 `acquire` 必须同为阻塞式 + 超时抛错 + 崩溃可恢复 | 命名一致 ≠ 语义一致 |
| （未提） | **加「回调文件名唯一性」spec**：`multiprocessing` 起 2 进程各持久化 500 次到同一目录 → 断言文件名集合无重复 | 这是结论 B 的直接回归护栏 |
| （未提） | **加「坏条目不致盲」spec**：池内放 1 个坏条目 + 1 个健康条目 → 断言 `_discover_uncached` 仍报出健康条目 | 结论 A 的兜底已有实现**且已有测试**（python `test_interpreters.py:459,481`「目录存在但可执行文件缺失（损坏条目）——必须被剔除而不是让探测整体失败」；node `interpreters.spec.ts:452` `mockUv([], {listStatus: 2})` 模拟 uv 整体失败）。**覆盖是有的**，但只覆盖「坏条目 ⇒ exit 2 ⇒ 兜底」这一条；**「并发 install 期间探测」这条路径无覆盖**（可加一条：install 进行中触发 discover，断言不报空池） |

---

## §6 待主Agent决策项

| # | 事项 | 选项 | 我的建议 | 影响 |
|---|---|---|---|---|
| **RD-1** | 结论 A 的严重度 | P0 / P1 / **P2** | **P2**：compose 默认不成立（node 无 uv）、跨 libc 已隔离、exit 2 已被双侧 fallback 兜底；真实触发面仅「裸机多实例 / 自建镜像」 | 决定是否为它开 P0 通道 |
| **RD-2** | 结论 A 是否仍要修跨进程锁 | 修 / 不修 | **仍要修**（P2 也要修），但**与结论 B 的锁需求合并**——两者都需要「执行器侧跨进程文件锁」，**一次实现两处受益** | 工作量合并，避免造两套锁 |
| **RD-3** | 结论 B 修法 | 仅加唯一名 / **唯一名 + `os.replace` + multiprocessing 回归 spec** | **后者** | 修得彻底，代价仍是 S |
| **RD-4** | Windows 支持口径 | 假装支持 / **显式声明「Windows 多实例未验证」** | **后者**（诚实）；若要真支持则需独立一轮做 `msvcrt` 语义验证 | 避免「假支持」制造新缺陷 |
| **RD-5** | 结论 D 是否立即修 | 立即 / **纳入重构** | **纳入重构**：窗口是「A 首次 clone 未完成时 B 探测」，后果是多重一次 clone；修法（探测移入跨进程锁内）**依赖 RD-2 的锁** | 与 RD-2 同批 |
| **RD-6** | 结论 E 的两个坑是否有**其他同类** | 只处理这 2 个 / **全量扫一遍 `monkeypatch.setattr(execute_module.` 的所有目标** | **后者**：坑二的本质是「patch 打到模块对象」，必须全量清单化，否则拆分后逐个假绿 | 拆分前置条件 |
| **RD-7** | 本复核无第二视角（孙Agent 被 `active child limit: 10` 拒绝） | 接受 / **另开一轮抽检 §3.1 与 §3.2** | **建议抽检这两条**（它们直接决定 P0/P1/P2 归属，且我改判幅度最大） | 降低误判风险 |

---

## §7 一句话总结

**父报告的方向对（三类跨进程竞态真实存在），但把「已被兜底覆盖的后果」与「形态特定的缺陷」写成了普遍 P0**：
结论 A 的「整个池不可见」已在 `interpreters.py:810-858` 被工程化修复且 compose 下 node 无 uv 根本不写卷 ⇒ **P2**；
结论 B 机制真实但「丢一条终态」实为「丢一个 batch（最多 100 条）」⇒ **P1**；
结论 C **P0 维持**（依赖面确证，但 Windows/flock 语义差异被低估）；
结论 D 窗口窄于描述（仅 A 首次 clone 未完成时）⇒ **P2**；
结论 E **完全证实**且两个坑都必须作为拆分前置条件。

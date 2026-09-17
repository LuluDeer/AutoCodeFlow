# python_task_multiversion —— 冻结接口契约（IMPLEMENTATION CONTRACT v1.0）

> **状态**：FROZEN —— 所有并行实现工作流必须严格遵循本文件；不得单方面修改。
> **上游**：`REQUIREMENTS.md`(v0.3) / `DESIGN.md`(v0.1)
> **本文件优先级**：当 DESIGN.md 与本文件冲突时，**以本文件为准**（本文件含 T01 实测修正）。

---

## 0. T01 实测结论（阻塞性前置，已完成 —— 修正需求假设）

**实测环境**：uv 0.8.17（仓库锁定版本，隔离 venv 安装）+ uv 0.11.14（宿主）双版本交叉验证。

| 结论项 | 实测结果 |
|---|---|
| `uv python list --all-versions`（0.8.17）CPython 区间 | **3.8 ~ 3.14**（含上下界） |
| 3.6 / 3.7 是否可在线下载 | **否**。`uv python install 3.7` → `error: No download found for request: cpython-3.7-<platform>`（exit 2）；`uv venv --python 3.7` → `error: No interpreter found for Python 3.7 in managed installations, search path, or registry`（exit 2） |
| 3.6 是否可在线下载 | **否**（同 3.7） |
| uv 0.11.14 是否含 3.7 | **否**，区间同样为 3.8~3.15。**升级 uv 不能解决 3.7 缺失** |
| python-build-standalone 是否仍有 3.7.9 构建 | **是**。tag `20200822` 含 `cpython-3.7.9-x86_64-unknown-linux-gnu-pgo-20200823T0036.tar.zst`（27MB）等 10 个 3.7.9 资产（含 linux-gnu / linux-musl / windows-msvc / macos）。**注意**：这是 pbs 的**发布资产名**，与 uv 缓存池要求的**目录名三元组不同**（见 §0.2 勘误） |
| **离线预填 3.7 是否被 uv 识别** | **是（已实测打通）**。将 pbs 3.7.9 的 `python/install/*` 内容放入 `<UV_PYTHON_INSTALL_DIR>/cpython-3.7.9-<platform>-none/` 后：`uv python list --only-installed` 列出该项；`uv venv --python 3.7` **成功**创建 venv，venv 内 `python --version` = `Python 3.7.9` |
| 单版本解压后体积 | 3.8.20 ≈ **57.4MB**（< D12 的 250MB 红线，红线充裕） |
| 3.8.20 首次下载耗时 | ≈ **13s**（20.6MiB 下载 + 安装），远小于 D11 默认 300s |

### 0.2 勘误（v1.1）：离线预填目录名必须用 **uv 平台三元组**，不是 pbs 发布三元组

**这是实测踩坑项，违反会让离线预填静默失效。**

uv 从自己的平台词汇构造缓存池目录名；python-build-standalone 的发布资产名用的是另一套三元组。**两者不同名，且 uv 对不匹配的目录名静默忽略**——不报错，只是该版本永远不出现在 `uv python list --only-installed` 里，操作员会看到"文件都放对了但执行器始终探测不到"的无解症状。

实测（同一份 pbs 3.7.9 载荷，同一个池目录，uv 0.8.17 与 0.11.14 结果一致）：

| 池内目录名 | `--only-installed` 是否列出 | `uv venv --python 3.7` |
|---|---|---|
| `cpython-3.7.9-x86_64-pc-windows-msvc-none`（pbs 三元组） | **否** | exit 2 |
| `cpython-3.7.9-windows-x86_64-none`（uv 三元组） | **是** | **exit 0，venv 内为 Python 3.7.9** |

**uv 平台三元组对照表**（实测 `uv python list --all-versions --all-platforms` 输出）：

| 平台 | uv 三元组（**正确**） | pbs 发布三元组（**错误，勿用**） |
|---|---|---|
| Linux glibc x86_64 | `linux-x86_64-gnu` | `x86_64-unknown-linux-gnu` |
| Linux musl x86_64 | `linux-x86_64-musl` | `x86_64-unknown-linux-musl` |
| Windows x86_64 | `windows-x86_64-none` | `x86_64-pc-windows-msvc` |
| macOS x86_64 | `macos-x86_64-none` | `x86_64-apple-darwin` |

**正确形式示例**：`cpython-3.7.9-linux-x86_64-gnu`（而非 `cpython-3.7.9-x86_64-unknown-linux-gnu-none`）。

> ⚠ **池目录名 = `cpython-<完整版本>-<uv三元组>`，三元组之后不再有 `-none`。**
> 上表里 Windows/macOS 的三元组**本身就以 `-none` 结尾**（`windows-x86_64-none`），
> 那是 libc 槽位的取值，不是额外后缀；Linux 三元组的 libc 槽位是 `gnu`/`musl`，
> 所以**跟着再加 `-none` 就错了**：
>
> | 池目录名 | 判定 |
> |---|---|
> | `cpython-3.7.9-linux-x86_64-gnu` | ✅ 正确 |
> | `cpython-3.7.9-linux-x86_64-musl` | ✅ 正确 |
> | `cpython-3.7.9-linux-x86_64-gnu-none` | ❌ **多了一个 `-none`**，uv 静默忽略 |
> | `cpython-3.7.9-windows-x86_64-none` | ✅ 正确（`-none` 属于三元组本身） |
> | `cpython-3.13.13-windows-x86_64-none-none` | ❌ 多了一个 `-none`，实测静默忽略 |
>
> 实测（§0.3）：`uv python install cpython-3.11-linux-x86_64-gnu-none` →
> `error: ... is not a valid Python download request`；
> `uv python install cpython-3.12-linux-x86_64-gnu` → 落盘目录
> `cpython-3.12.11-linux-x86_64-gnu`。**规则：三元组整段照抄，不要凭感觉补 `-none`。**

**运维自检**：放好后立即跑 `uv python list --only-installed`；若目标版本未出现，就是三元组写错了（不是文件内容问题）。权威词汇以 `uv python list --all-versions --all-platforms` 的实测输出为准。

> 本条勘误同时适用于本文件 §0 表格中引用的 pbs 资产名（那是**下载地址**用名，正确）与 §2.2 示例路径（那是**池目录**名，已按下表更正）。运维步骤详见 `OFFLINE-PROVISIONING.md`。

### 0.3 实测结论：**一个同平台坏条目会让整池"消失"**（探测兜底，两侧执行器同款）

T01 之外的第二个阻塞级发现，由部署侧复核时实测得到、集成方独立复现：

**现象**：池内只要存在**一个同平台但不可运行**的条目（目录名正确、载荷不可执行），
`uv python list --only-installed` 就**整体 exit 2**，并且**连健康条目也一并从输出里消失**
——uv 报的是
`error: Failed to inspect Python interpreter from managed installations at <path>`，
输出里**不含**任何可用解释器。

| 池内容 | `--only-installed` | 说明 |
|---|---|---|
| 仅健康 `cpython-3.8.20-windows-x86_64-none` | exit 0，列出 3.8.20 | 基线 |
| 再放入**同平台**坏条目 `cpython-3.7.9-windows-x86_64-none`（`python.exe` 为文本） | **exit 2，且 3.8.20 也不再出现** | ← 本条 |
| 再放入**外来平台**条目 `cpython-3.9.23-linux-x86_64-gnu`（Windows 主机上） | exit 0，3.8.20 仍正常列出 | 外来平台被 uv 安全跳过 |

**为什么必须兜底**：`discover_installed()` 原本把非零退出映射为"空池"（fail-safe，
执行器仍能启动）。但在上述场景下，"空池"是一个**谎报**——健康的解释器其实仍可用
（实测 `uv venv --python 3.8` 依旧 exit 0）。后果是：执行器上报 `interpreters: []`
（按 §2.2 语义＝"已上报且为空"，**不兜底**）→ admin 调度层拒绝**所有**声明版本的
任务 → 一个局部损坏被放大成**整个多版本特性不可用**，而症状（"执行器报告 0 个解释器"）
指向的位置与真实原因相去甚远。

**定案做法**（两侧执行器一致，已在 `interpreters.py` / `interpreters.ts` 落地）：

1. uv 探测失败（超时 / uv 缺失 / 异常 / 非零退出）**不再直接返回空**，改为退到
   **本地目录扫描**：直接枚举 `UV_PYTHON_INSTALL_DIR` 下的
   `cpython-<完整版本>-<平台三元组>` 目录，按"目录名给版本 + 解释器二进制真实可执行"
   判定，**不 spawn 任何进程**。
2. 本地扫描**必须过滤外来平台**：Windows 上"可执行"只判存在性，不过滤就会把
   Linux 条目的 `bin/python3` 误报为可用。共享卷场景下（executor-python 是
   Debian/glibc、executor-node 是 Alpine/musl）两种 libc 产物共存是**常态**，所以
   这条过滤是必需项而非优化。
3. uv 成功但**一条可用都没有**时，同样用本地扫描复核一次。
4. 日志必须能区分"**池为空**"与"**池非空但 uv 读不出来**"——这两者对运维的含义完全不同。

> 兼容性：兜底只在 uv 已失败时触发，不改变正常路径行为，也不引入进程开销
> （NFR-10 心跳不 spawn 的约束仍然成立）。

### 0.4 实测结论：**"宣称可用"必须等于"真的解析得到"**（池归属过滤，两侧同款）

集成期在真实 uv 输出上发现的第三个阻塞级问题，且 python 与 node **行为曾经不一致**
（node 有这道闸、python 没有），属跨实现的对等性缺口。

**现象**：`uv python list --only-installed` 会**连带列出非本池的解释器**——
系统 Python（`C:\Python314\python.exe`）、PATH 上的 `.local/bin/python3.x.exe` shim、
以及**历史上别的池目录**里的解释器。`_parse_python_list` 若照单全收，执行器就会把这些
版本当作"可用"上报给 admin。

**实测（本机，池内只有 3.11.13）**：

| | 结果 |
|---|---|
| 上报给 admin 的清单 | `['3.11.13','3.13.13','3.14.6','3.9.23','3.9.25']` —— **5 个** |
| 其中 `resolve_python_bin()` 真能解析的 | **只有 `3.11`**；`3.13` / `3.14` / `3.9` **全部返回 None** |

**危害**：admin 的调度过滤按 `interpreters` 快照决策，于是
①把 3.14 任务路由到这台**根本没有 3.14** 的执行器 → 运行期必然
`interpreter_unavailable`（可复现的假失败）；
②**挤掉真正预置了 3.14 的执行器**（admin 认为这台已经满足，不再找别人）。
一个"多报"同时造成误路由与资源错配。

**定案做法**（两侧一致）：
* 探测结果**只保留解析后落在 `UV_PYTHON_INSTALL_DIR` 之内的条目**；
* 判定用 `resolve()` 后的包含关系（符号链接/junction 逃逸同样拦下）；
* 单条路径不可解析时**剔除该项**而非整体失败（探测永不抛，AC-14b 不变）；
* python 侧落在 `_parse_python_list`（`_is_inside_pool`），
  node 侧落在 `isInsidePool`（`interpreters.ts`）——**两侧必须行为一致**。

**不变量**（回归判据）：对任意版本 `V`，
`V ∈ {advertised && available}` ⟺ `resolve_python_bin(V) is not None`。

**第二个轴：外来平台条目（D-14）**。上一条只解决"**不在池内**"，还有一类
"**在池内但不属于本机平台**"：compose 把解释器池做成**共享卷**，而
executor-python 是 Debian/glibc、executor-node 是 Alpine/musl，
**两种产物天然共存于同一池**。Windows 上 `_is_executable` 只判存在性，
于是 Linux 条目的 `bin/python3` 会被判成"可用"：

| 实测（池内只有 Linux 条目，宿主 Windows） | 结果 |
|---|---|
| `_parse_python_list` 解析 | `[('3.11.13', available=True, …linux-x86_64-gnu\bin\python3)]` |
| `resolve_python_bin('3.11')` | 返回该 **Linux 二进制** |
| 后果 | `uv venv --python <linux bin>` 必然失败 —— 又一次"谎报可用" |

**定案**：`_parse_python_list` 还需按 **池目录名的平台段 == 本机 uv 三元组**
过滤（`_pool_key_matches_host_platform`）。本地扫描 `_scan_pool_directory`
**本来就**做这层过滤——两者必须一致，否则"uv 成功"与"uv 失败走兜底"会给出
**不同的池视图**，同一台执行器在两种情况下宣称的能力不一样。

> 判定不出本机平台（`_current_platform_token() is None`）或 key 里取不出平台段时
> **放行**：宁可不做这层过滤，也不能因为拿不准就把健康条目误杀。

### 0.5 §0.3 的兜底**必须两侧都有**（D-15：node 侧曾缺失）

集成收尾时逐条比对两侧实现，发现 §0.3 的探测兜底**只在 python 侧落地**：
`executor-node` 的 `discoverInstalled` 在四条失败路径上（uv 缺失 / 池目录不可建 /
uv 非零退出 / JSON 不可解析）**全部 `return []`**，没有本地扫描兜底。

后果与 §0.3 描述的完全相同（一个坏条目致盲整池），但发生在**客户端执行器**上——
而本特性的验收要求正是"客户端执行器全对等"，所以这是一个**对等性缺口**，不是可选优化。

**已补齐**（`fallbackDiscovery` + `pythonBinCandidates`，与 python 侧逐条对齐）：

| 过滤 | 为什么必需 |
|---|---|
| 池内（`isInsidePool`） | Windows 上"可执行"只判存在性，不过滤会收进池外 blobs |
| **本机平台**（`uvPlatformTriple`） | 共享卷里 glibc/musl 产物共存；外来平台的 `bin/python3` 在 POSIX 上带 `+x` 位、`isExecutable` 会放行，却在本机跑不起来 |
| 真实可执行 | 与 uv 路径同一口径（单条损坏只剔除，AC-14b） |

> **纪律**：§0.3/§0.4/§0.5 三条都是"两侧同款"的。任何一侧单独实现都会造成
> "同一台池、两种路径给出不同自述"的偏差——排查时应先比对
> `interpreters.py` 与 `interpreters.ts` 的同名能力是否成对存在。

### 0.1 支持矩阵（最终定稿，取代需求 §9.2 的 3.6~3.14）

| 层级 | 版本 | 获取方式 | 验收样本 |
|---|---|---|---|
| Tier 1（完全支持） | 3.10 / 3.11 / 3.12 / 3.13 / 3.14 | **在线动态下载**（主路径，必有） | **3.13**、**3.12** |
| Tier 2（在线可用） | **3.8 / 3.9** | **在线动态下载** | **3.9** |
| Tier 2·扩展（仅离线预填） | **3.7** | **仅离线预填缓存卷**（在线下载不可用） | **3.7** |
| 不支持 | <3.7（含 3.6）与 >3.14 | 拒绝声明 | — |

**语义定稿**：
- **可声明区间 = `3.7 ~ 3.14`**（默认，可配置）。
- **在线可下载区间 = `3.8 ~ 3.14`**；**3.7 为"离线预填扩展"**——在线下载必然失败，必须由部署方预填缓存卷。
- 声明 3.7 但缓存池无 3.7 且未预填 → 任务失败分因 `interpreter_unavailable`，错误消息**必须明确指引**："3.7 不支持在线下载，需部署方离线预填解释器缓存卷"。
- **NG-09 修正**：不支持区间外版本；3.6 及以下拒绝。

> 需求文档 §9.2 矩阵中的 `3.6` 应删除、`3.7` 应标注"离线预填扩展"。此为 T01 实测对需求假设的**必要修正**，已获负责人确认。

---

## 1. 常量与命名（单一事实源）

### 1.1 Python 版本支持区间

| 常量 | 值 | 落点 |
|---|---|---|
| `RUNTIME_VERSION_MIN` | `"3.7"` | admin-api env（`PYTHON_RUNTIME_VERSION_MIN`），默认 3.7 |
| `RUNTIME_VERSION_MAX` | `"3.14"` | admin-api env（`PYTHON_RUNTIME_VERSION_MAX`），默认 3.14 |
| `ONLINE_DOWNLOAD_MIN` | `"3.8"` | 执行器 + admin 文档/提示共用；`< 3.8` 时给"需离线预填"提示 |

**格式**：`^\d+\.\d+$`（主.次，无补丁号，D1）。非法 → 400。

### 1.2 匹配语义（D1 · 前缀匹配）

```
requested = "3.7"   available = "3.7.9"  → MATCH   (requested + "." 是 available 的前缀)
requested = "3.7"   available = "3.7"    → MATCH   (精确相等)
requested = "3.7"   available = "3.12.3" → NO MATCH
requested = null/""                      → MATCH   (不拦截，FR-10 存量路径)
```

**跨版本号前缀必须带点**：`"3.1"` 不得匹配 `"3.13.0"`（`"3.1."` 不是 `"3.13.0"` 前缀）。此边界为**强制要求**，两侧实现必须一致并有测试。

### 1.3 venv 目录键（D6）

| 场景 | 键 |
|---|---|
| `runtimeVersion` 为空 | `<task_id>`（**逐字节不变**，AC-10a 存量语义） |
| `runtimeVersion = "3.7"` | `<task_id>-3.7` |

**纪律**：目录键、per-task 锁键、TTL live 快照三者必须**同源派生**（改一处）。执行器实现必须只改 `_derive_task_key` 一处。

---

## 2. 数据契约

### 2.1 `tasks.codeSource`（新增列，nullable enum）

```
"git" | "glue" | "application_zip"
```

**存量回填优先级**（迁移中一次性执行）：`gitRepo NOT NULL → git` > `glueSource NOT NULL → glue` > `applicationId NOT NULL → application_zip` > `NULL`。

**互斥规则（写面校验，只约束新建/编辑）**：
- 代码来源型三选一：`gitRepo` / `glueSource` / `codeSource=application_zip`（配 `applicationId`）。
- **`codeSource=application_zip` 时 `applicationId` 必填**。
- `requirements`/PyPI 属依赖型渠道，**可与任一代码来源并存**（AC-18b）。
- PATCH 必须按**合并后终态**校验（对照 `assertPinBroadcastExclusive` 先例），不能只看增量字段。

### 2.2 `executors.interpreters`（新增列，jsonb，nullable）

```jsonc
[
  {
    "version": "3.7.9",              // 完整补丁版本（探测所得）
    "path": "/data/interpreters/cpython-3.7.9-linux-x86_64-gnu/bin/python3",
    "available": true,               // 探测时可执行且 --version 通过
    "discoveredAt": "2026-09-16T10:00:00.000Z"  // ISO8601
  }
]
```

**语义区分（强制）**：
- `null` / 字段缺省 = **未上报**（旧执行器）→ 调度按 `["3.12"]` 兜底（D5）。
- `[]` = **已上报且缓存池为空** → 调度视为**无任何版本可满足**（不兜底！）。
- 上报结构非法（非数组 / 项缺 `version` / `version` 非 `X.Y` 或 `X.Y.Z`）→ **整字段拒绝采纳** + warn，DB 保留旧值。

### 2.3 上报/心跳契约（增量字段，向后兼容）

**注册** `POST /executors/register`：
```jsonc
{
  "appName": "executor-python-1", "address": "...", "type": "python",
  "version": "2.0.0",
  "capabilities": ["python", "shell"],
  "interpreters": [ /* 见 2.2；可缺省 */ ]
}
```

**心跳** `POST /executors/heartbeat`：
```jsonc
{
  "address": "...", "runningExecutionIds": [], "deadLetterCount": 0,
  "interpreters": [ /* 见 2.2；缺省 → 保留 DB 旧值不清空 */ ]
}
```

**admin 采纳规则（完全对照 `deadLetterCount` 既有模式）**：
- 字段 `undefined`（未发送）→ 保留 DB 旧值。
- 字段存在但结构非法 → 拒绝采纳 + warn，DB 不动。
- 合法 → 覆盖。

### 2.4 派发载荷（**零结构变更**）

```ts
{ executionId: string, task: Task, params: Record<string, unknown> }
// task.runtimeVersion / task.codeSource / task.applicationId / task.packageUrl 由执行器消费
```

> **重要**：`packageUrl` 必须由 admin 在派发时**解析后附加**到 `task` 上（任务实体只有 `applicationId` 弱引用，执行器无法自行查库）。见 §3.1。

### 2.5 失败分因（新增枚举，三处同步）

```
"interpreter_unavailable"
```

- `packages/executor-protocol/protocol.json`：加入 `failureReason.all` **与** `failureReason.executorReportable`。
- admin `ExecutionFailureReason.INTERPRETER_UNAVAILABLE`。
- **不进默认重试集**（D14 明确失败）；但用户显式 `retryableErrors` 含该 token 时尊重白名单（RETRY-01 语义不变）。
- 触发条件：解释器缓存缺失且下载失败/不可达/超时；缓存损坏不可修复。
- 错误消息模板（AC-12a）：
  `解释器 <X.Y> 无法获取（缓存缺失 + 下载失败：<原因>）；候选执行器: <appName>[已缓存: 3.12.3]`

---

## 3. 模块接口

### 3.1 admin-api

#### `apps/admin-api/src/modules/task/runtime-version.util.ts`（新增）
```ts
export const RUNTIME_VERSION_PATTERN: RegExp;              // /^\d+\.\d+$/
export function isValidRuntimeVersionFormat(v: string): boolean;
export function isRuntimeVersionSupported(v: string): boolean;   // 区间内
export function compareRuntimeVersion(a: string, b: string): number;
export function getSupportedRange(): { min: string; max: string; onlineMin: string };
export function buildUnsupportedVersionMessage(v: string): string;  // 中文提示
```

#### `apps/admin-api/src/modules/executor/interpreter-match.util.ts`（新增）
```ts
export interface ExecutorInterpreter { version: string; path?: string; available?: boolean; discoveredAt?: string; }
export const LEGACY_DEFAULT_INTERPRETERS: readonly string[];   // ["3.12"]

/** requested 为空 → true（不拦截）。available 为 null/undefined → 旧执行器兜底 ["3.12"]。 */
export function interpreterSatisfies(
  available: ExecutorInterpreter[] | null | undefined,
  requested: string | null | undefined,
): boolean;

/** available 为 [] → 无任何可满足版本（不回退兜底）。 */
export function matchesVersionPrefix(availableVersion: string, requested: string): boolean;

export function buildInterpreterMismatchMessage(
  requested: string,
  snapshots: { appName: string; interpreters?: ExecutorInterpreter[] | null }[],
): string;
```

#### 派发载荷附加 `packageUrl`
`executor.service.ts` 的 dispatch 路径（push + pull 两分支）在构造下发 `task` 时，若 `task.codeSource === 'application_zip'` 或 `applicationId` 非空，则查 `applications` 表解析 `packageUrl` 并**附加到下发 task 对象的 `packageUrl` 字段**。查不到 → 派发失败，消息明确。

#### 调度过滤（三处共享）
`selectLeastLoaded` / `dispatch` / `dispatchBroadcast` 在既有 runtime/capabilities 过滤**之后**追加：
```
interpreterSatisfies(executor.interpreters, task.runtimeVersion) === false → 剔除该候选
```
- 过滤失败错误消息必须含**每个候选执行器的已缓存解释器快照**（AC-09b）。
- **pinning 分支**（`task.executorId` 非空）绕过 group/tags/runtime，但**必须单独补一道**：pinned 执行器 `interpreterSatisfies` 不满足 → **占坑前立即失败**（AC-08b/D2③），消息含声明版本与 pinned 执行器已缓存清单。

### 3.2 executor-python

#### `apps/executor-python/interpreters.py`（新增 —— 执行器侧唯一事实源）
```python
@dataclass(frozen=True)
class InterpreterInfo:
    version: str          # 完整补丁版本，如 "3.7.9"
    path: str             # 绝对路径（池内白名单）
    available: bool
    discovered_at: str    # ISO8601

class InterpreterUnavailable(RuntimeError):
    """解释器无法获取。携带 .version / .reason / .detail 供失败分类与留痕。"""
    version: str
    reason: str           # 'download_failed' | 'download_timeout' | 'not_downloadable' | 'corrupt' | 'mirror_unreachable'
    detail: str

def discover_installed(*, timeout: float = ...) -> list[InterpreterInfo]: ...
def resolve_python_bin(version: str) -> Path | None: ...   # 池内前缀匹配；NFR-02 白名单断言
def ensure_version(version: str, *, timeout: float) -> Path: ...  # 下载/复用；失败抛 InterpreterUnavailable
def is_online_downloadable(version: str) -> bool: ...      # < ONLINE_DOWNLOAD_MIN → False
def invalidate_cache() -> None: ...                        # 下载/回收后刷新探测缓存
```

**硬约束**：
- `resolve_python_bin` 返回的路径**必须**位于 `UV_PYTHON_INSTALL_DIR` 之内（`Path.resolve().is_relative_to(pool_root)` 断言，NFR-02/03）。不接受任务提供的任何路径。
- `version` 必须过 `^\d+\.\d+$` 正则后才拼进 uv argv（NFR-03 防注入）。
- `discover_installed` 单条损坏只剔除该项，**不得抛异常**（AC-14b）；整体失败返回 `[]` + 日志。
- 探测结果**带缓存**（心跳 30s 内不重复调 uv，NFR-10）；`invalidate_cache()` 在下载/回收后调用。

**并发互斥（D13/NFR-16）**：
- per-version 锁：`version -> threading.Lock`，原子 fetch-or-create（对照 `_get_git_cache_lock`）。
- 全局单下载队列：`asyncio.Semaphore(1)`，同一时刻全局至多一个 in-flight 下载。
- 等待者阻塞等待完成后走"缓存命中"复用，**不得重复下载**。

**超时（D11/NFR-13）**：单次下载独立预算 `INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS`（默认 300），与任务剩余超时**取较小者**。超时 → `InterpreterUnavailable(reason='download_timeout')`。

#### `apps/executor-python/config.py`（新增配置）
```python
uv_python_install_dir: str = '/data/interpreters'
uv_python_install_mirror: str = ''                    # 可选；http(s)、无 userinfo/query/fragment
interpreter_download_timeout_seconds: int = 300
interpreter_single_version_mb: int = 250
interpreter_total_gb: int = 4
```
- `uv_python_install_mirror` 校验**复用** `validate_pypi_registry_url` 的规则（http(s) + 无凭据 + 无 query/fragment）。
- 默认 `uv_python_install_dir` **必须独立于 `WORK_DIR`**（物理隔离 TTL 清扫，NFR-15）。

#### `apps/executor-python/zip_safety.py`（新增）
```python
class ZipSafetyError(ValueError):
    violation: str   # 'zip_slip' | 'too_many_entries' | 'entry_too_large' | 'total_too_large' | 'ratio_too_high' | 'absolute_path' | 'symlink_entry' | 'bad_archive'

def vet_zip(path: Path, *, limits: ZipLimits | None = None) -> None: ...
def safe_extract(path: Path, dest: Path, *, limits: ZipLimits | None = None) -> None: ...
```
- `safe_extract` 必须：拒绝 `..` 逃逸、绝对路径、盘符路径、符号链接条目；逐条目校验目标路径 `resolve()` 后仍在 `dest` 之内；超限即中止。
- 上限对齐 executor-node `zip-guard.ts`（条数/单文件/总解压/压缩比/嵌套）。

#### `apps/executor-python/routers/execute.py`（改造）
1. `_derive_task_key` → 版本签名（§1.3，**只改这一处**）。
2. `ensure_venv(venv_dir, requirements, *, python_version: str | None = None)`：
   - `python_version` 非空 → 先 `ensure_version` 拿绝对路径，再 `uv venv --python <abs_path> --no-project <dir>`（**绝不让 venv 阶段触发下载**，D8）。
   - 空 → `uv venv --no-project <dir>`（**argv 逐字节不变**，AC-10a）。
3. zip 渠道（`codeSource=='application_zip'` 或 `applicationId` 非空）：
   - 从 `task.packageUrl` 下载（`httpx`）：SSRF 守卫（仅 http(s)、拒绝 loopback/私网/link-local）+ Bearer 透传 + size cap 200MB + 超时。
   - `vet_zip` + `safe_extract` 到 `work_dir`。
   - 读取包内 `requirements.txt`（若存在）与任务 `requirements` 合并（D4：任务级同名**覆盖**、其余**并集**、保持顺序稳定）。
   - 无任何 requirements → **不建 venv**，直接以所选解释器运行（AC-04c）。
4. glue 渠道：仍**不建 venv、不装依赖**；但声明版本时以该版本解释器执行（AC-11a）。
5. 失败分类：解释器获取失败 → `interpreter_unavailable`；`_refine_failure_reason` 增加规则（且**必须排在** `dependency_install_failed` 规则**之前**，避免 `uv venv failed` 误吞）。
6. 留痕：`result.interpreter = {requested, resolved, pool, reason, candidates?}`（FR-12）。

#### `apps/executor-python/main.py` / `scheduler.py`
- `_register_payload()` 增 `interpreters` 字段（启动探测一次）。
- `scheduler._send_heartbeat` 增 `interpreters` provider（对照 `runningExecutionIds` provider 模式；缓存池变化时刷新）。
- `EXECUTOR_VERSION` → `'2.0.0'`（R5）。

#### `apps/executor-python/maintenance.py`
- 解释器缓存池目录**豁免 TTL 清扫**（物理隔离 + 显式豁免双保险）。
- 体积红线：单版本 > `interpreter_single_version_mb` 或总池 > `interpreter_total_gb` → **告警 + 回收最久未使用版本**（按目录 mtime），回收后 `invalidate_cache()`。

### 3.3 executor-node（客户端执行器 —— 全对等改造）

> **背景**：executor-desktop（Electron）内嵌 spawn executor-node。现状 node 侧对 python 任务只做 `python3 <entrypoint>`：不建 venv、不装 requirements、不消费 packageUrl、不认 runtimeVersion。本工作流使其达到与 executor-python **对等**的 python 任务能力。

#### `apps/executor-node/src/interpreters.ts`（新增，镜像 python 侧语义）
```ts
export interface InterpreterInfo { version: string; path: string; available: boolean; discoveredAt: string; }
export class InterpreterUnavailableError extends Error { version; reason; detail; }
export async function discoverInstalled(opts?): Promise<InterpreterInfo[]>;
export async function ensureVersion(version: string, opts): Promise<string>;   // 返回绝对路径
export function resolvePythonBin(version: string): string | null;             // 池内前缀匹配
export function isOnlineDownloadable(version: string): boolean;
export function invalidateCache(): void;
```

**uv 定位（关键设计）**：
1. `UV_BIN` 环境变量显式指定；
2. 否则 PATH 查找 `uv`；
3. 否则 **desktop 随包内置路径**（`process.resourcesPath/uv/uv[.exe]`，由 desktop 注入 `UV_BIN`）；
4. 都不可用 → `discoverInstalled` 返回 `[]`；**声明版本的任务**明确失败 `interpreter_unavailable`（reason=`uv_missing`，消息指引安装 uv 或使用内置）；**未声明版本的任务保持既有行为逐字节不变**（向后兼容硬要求）。

**并发互斥**：per-version `Map<string, Promise<string>>`（in-flight 去重）+ 全局单下载队列（Promise 链），与 python 侧 D13 语义一致。

#### `apps/executor-node/src/zip-safety.ts`
复用既有 `zip-guard.ts` 结构审查，新增 `safeExtractZip()`（zip-slip/绝对路径/符号链接拒绝）。**不得修改 `zip-guard.ts` 既有导出语义**（`/api/deploy` 依赖）。

#### `apps/executor-node/src/routes/execute.ts`（改造）
python 分支改为：
1. `codeSource==='application_zip'` → 下载 `task.packageUrl`（复用既有 `lib/download.ts` + `ssrf-guard.ts`）→ `vetZip` → `safeExtractZip` 到 `workDir`。
2. 合并包内 `requirements.txt` ∪ 任务 `requirements`（D4 同规则）。
3. 有依赖或声明版本 → 经 `interpreters.ts` 建 venv（`.venvs/<taskId>[-<X.Y>]`）+ `uv pip install`（`--index-url` 私有源）。
4. `cmd` = venv 内解释器绝对路径（有 venv）或 `ensureVersion` 返回路径；**无版本无依赖 → 现状 `python3` 逐字节不变**。
5. 失败分类：`interpreter_unavailable` 加入 `prepareFailureReason` 映射（**必须排在** dependency 规则之前）。

#### `apps/executor-node/src/scheduler.ts` / `main.ts`
注册与心跳增 `interpreters` 字段（与 python 侧同契约）。`EXECUTOR_VERSION` bump。

#### `apps/executor-desktop`
- `executor-process.ts`：spawn 子进程 env 注入 `UV_BIN`（若内置 uv 存在）；`config-store` 增可选 `uvPath` 配置项。
- 内置 uv：打包脚本 `scripts/bundle-executor.sh` 旁路下载对应平台 uv 二进制到 `resources/uv/`；**缺失时不影响启动**（降级见上）。
- **不得**因新增功能破坏既有黑屏回归/冒烟用例。

### 3.4 admin-web

1. `TaskFormPage`：`runtimeVersion` 选择器（Tier1/Tier2 分层 + 手输 `X.Y`）+ 代码来源单选（git / zip 应用 / glue）与 `gitRepo`/`glueSource`/`applicationId` 联动互斥。
2. payload 归一：透传 `runtimeVersion`、`codeSource`、`applicationId`。
3. 执行详情：渲染 `interpreter_unavailable` 分因与 `result.interpreter` 快照。
4. 类型：`gen:api-types` 重新生成。

---

## 4. 兼容性红线（**违反即回退**）

| # | 红线 | 验证 |
|---|---|---|
| 1 | 无 `runtimeVersion` 的存量任务：venv argv、venv 目录键、运行解释器**逐字节不变** | 单测断言 argv/目录 |
| 2 | 旧执行器无 `interpreters` 字段 → 调度兜底 `["3.12"]`，不因缺字段被剔除 | 单测 |
| 3 | `heartbeat` 缺 `interpreters` → DB 旧值**不被清空** | 单测 |
| 4 | 三渠道（git/glue/PyPI）既有行为与运行结果不变 | 既有测试全绿 |
| 5 | executor-node `/api/deploy` 契约与语义不变 | 既有 e2e 全绿 |
| 6 | executor-node 无版本无依赖 python 任务 → 仍 `python3 <entrypoint>` | 单测断言 cmd |
| 7 | 私有 PyPI `--index-url` 逻辑不变 | 既有测试 |
| 8 | 新增字段全为增量（可空/可缺省），旧客户端零破坏 | 类型 + 契约测试 |

---

## 5. 交付门禁（每个工作流收尾必须自证）

1. 该工作流**全部既有测试通过**（不得因改动破坏）。
2. 该工作流**新增测试通过**，覆盖本文件对应 AC 锚点。
3. `npm run typecheck:all` 与 `npm run lint:all` 对改动范围通过。
4. 无 TODO/占位实现；无静默吞异常。
5. 汇报格式：改动文件清单 + 测试命令与结果 + 未决风险。

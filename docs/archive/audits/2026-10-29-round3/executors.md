# 执行器（node/python/desktop）与协议一致性 审计（2026-10-29 · 第 3 轮）

## 1 范围与方法

**域**：`apps/executor-node`、`apps/executor-python`、`packages/executor-protocol`、
`scripts/generate-executor-protocol.mjs`，并与 `apps/admin-api` 的派发/回调/控制面契约对照。
`apps/executor-desktop/src/main/agent/**` 本轮**不在**本域内（另一 agent 正在改该目录），
仅在需要交叉验证执行器契约时只读引用。

**方法（按探查纪律执行）**：

1. `codegraph status` 确认索引新鲜（1,972 文件 / 38,004 节点），随后用
   `codegraph explore "how does executor-node kill a running task's process tree on timeout"`、
   `codegraph node apps/executor-node/src/routes/execute.ts --symbols-only`、
   `codegraph node apps/executor-python/routers/execute.py --symbols-only` 建立符号地图，
   再对 CodeGraph 覆盖不到的部分（协议生成器脚本、`protocol.json` 描述段、跨端文字比对）用 grep/read。
2. **生成物漂移实测**：复制两侧生成物 → 重跑
   `node scripts/generate-executor-protocol.mjs` → `diff`。
   结果：`apps/executor-node/src/generated/protocol.schemas.ts` 与
   `apps/executor-python/generated/protocol_schemas.py` **均逐字节未漂移**
   （12 个 schema：TaskConfig / ExecuteRequest / HeartbeatPayload / ConfigReloadRequest /
   ConfigReloadResponse / HealthReadyResponse / KillResponse / LogsResponse / ControlCommand /
   CommandResult / CallbackArtifact / CallbackPayload）。这一项**无发现**，不占 finding 名额。
3. 去重：先读 `docs/AGENT-SWARM-PLAYBOOK.md` §7（data-3 / desktop-budget / TOOLS-04 /
   TOOLS-06 / desktop-resend / doc-guard）、`docs/audit-playbook.md`（B1–B4 / C1 / C3 / E1 /
   E3 / E5 / **G4**）及其「已收口」滚动清单、`docs/OPEN-DECISIONS.md`（D7 / D7-2 /
   `ConfigReloadRequest.adminApiUrls` 缺口 / v7-v8 python 只报部分键）、
   `docs/PLAN-CLAIMS.md`、`docs/QA-05-capacity-boundaries.md`、`docs/CAPACITY-WHITEPAPER.md`、
   `docs/archive/audits/*.md`。下列 finding 均**未**在这些条目中出现；凡与既有条目同源者
   在证据段写明关系。
4. 只读：未修改任何源码；未跑全量测试；未做 git 写操作（仅 `git log/status --porcelain`）。

## 2 未覆盖 / 未实测（如实写）

| 项 | 状态 | 说明 / 怎么验 |
|---|---|---|
| python 侧 `preexec_fn` 死锁（F2） | **代码事实已确认，触发概率未实测** | 复现需要在 fork 瞬间恰好有另一线程持锁（如 `asyncio.to_thread` 的大文件 copy）。无法在 90s 内构造。判据：把 `_spawn_kwargs_for_platform` 的 POSIX 分支换成 `start_new_session=True` + sh/ulimit 包装后，行为不变（见 §4 F2 的验证方式）。 |
| F1 的触发环境 | **未实测（本仓所有环境都不满足）** | `apps/executor-python/.venv/bin/python -c "import autocodeflow_sdk"` → `ModuleNotFoundError`；`requirements.txt` 与 Dockerfile 都不装该包。故当前线上不可达，属**潜伏**缺陷。验证方式见 §4 F1。 |
| 真实 Windows 主机上的 zip 解压（F3） | **未实测** | 本机无 Windows。判据：用含 `NUL` / `CON.txt` / `a.py`+`a.py.` 条目的 zip 在 Windows 执行器上跑一次 `safeExtractZip`，观察落盘结果（见 §4 F3）。 |
| 多执行器混布的 diskUsage / loadScore 比较 | **未细查** | `executor.service.selectLeastLoaded` 用 `diskUsage` 做评分权重，而 node 的 `/health`（`routes/health.ts:118-128`，statfs `'/'`）与心跳的 `diskUsage`（`file-logger.ts:311-313`，statfs `config.workDir`）**取的不是同一个挂载点**。是否造成派发偏斜未实测，本轮不报（需先确认 admin 用的是哪个来源）。 |
| `/health/ready` 与 admin 连通性耦合 | **仅观察，未列为 finding** | `routes/health.ts:227-232`：admin 不可达即 503。compose 的 `HEALTHCHECK` 用的是 `/health`（`apps/executor-node/Dockerfile:25-26`），故默认部署不会被重启放大；但运维若把 `/health/ready` 接到 liveness/`restart: always`，中台抖动会变成执行器重启 + 在跑任务被杀（重复副作用）。属部署建议，不是代码缺陷，故不占名额。 |
| `apps/executor-desktop/**` | 未审 | 按任务约束避让并发写入方。 |

## 3 发现总表

| id | 优先级 | 一句话 | 落点 |
|---|---|---|---|
| EXEC-01 | P2 | executor-python 的 `/execute` 请求模型有**第三份**实现（`autocodeflow_sdk` 分支）；该分支一旦生效，`req.task.get(...)` 全线 AttributeError（每个任务 500），且 `secrets` 被静默丢弃。无守卫、无测试覆盖。 | `apps/executor-python/routers/execute.py:77-90`、`:2377`、`:3897-3899`、`:4282`；`packages/autoflow-sdk/autoflow_sdk/models.py:64-68` |
| EXEC-02 | P2 | python 侧用 `preexec_fn` 在 fork 后 exec 前跑 Python 代码（`os.setsid` + rlimit），而执行器是多线程进程（`asyncio.to_thread` / anyio selector 线程 / pydantic-settings 启动线程）——CPython 明确标注该组合可能死锁在 exec 前；node 侧用 `/bin/sh` + `ulimit` 包装（子进程内零 Python）规避了同一问题。 | `apps/executor-python/routers/execute.py:916-924`；对照 `apps/executor-node/src/run-command.ts:66-81`、`apps/executor-node/src/routes/execute.ts:3270-3274` |
| EXEC-03 | P2 | zip 条目名校验**缺 Windows 归一化**（保留设备名 `CON/NUL/AUX/COM1…`、尾随点与空格、大小写折叠碰撞、同目标重复条目），两端一致缺失：Windows 执行器上要么解压失败、要么「写入成功但文件不存在」、要么后一条静默覆盖前一条（同一 zip 在 Linux/Windows 上解出不同内容）。 | `apps/executor-node/src/zip-safety.ts:176-207`、`:439`；`apps/executor-python/zip_safety.py:231-252` |
| EXEC-04 | P2 | **未知控制命令类型两端行为分叉**：python 回报 `ok:false`（可见、可排障），node 在协议闸失败时静默丢弃 + 只 warn、**不向 admin 上报结果** → 中台的该条命令永远没有结果行，且与同仓「绝不静默」的显式纪律相反。 | `apps/executor-node/src/commands.ts:94-100`、`apps/executor-node/src/pull.ts:188-195`；对照 `apps/executor-python/commands.py:158-173` |
| EXEC-05 | P3 | **子进程 env 转发白名单两端不同集**，而无任何守卫比对「转发集合」（既有对等守卫只比对「保留名集合」）：python 额外透传 `PYTHONPATH` / `PYTHONHASHSEED` / `VIRTUAL_ENV`，node 额外透传 `npm_config_cache` / `npm_config_prefix`。 | `apps/executor-node/src/env-whitelist.ts:7-22`；`apps/executor-python/routers/execute.py:849-864`；守卫 `apps/admin-api/src/modules/task/dto/__tests__/secret-key-map.parity.spec.ts` |
| EXEC-06 | P3 | 同一份 `CallbackPayload` 生成物，两端闸门**严格度不同**：node 是 zod 严格类型（`z.number().int()`），python 是 `model_validate()` 默认 lax（容忍 `"1"`→1 等强转）；而同一文件里的 `ExecuteRequest` 闸却显式 `strict=True`——同一端内两套口径。 | `apps/executor-node/src/callback.ts:270`；`apps/executor-python/routers/execute.py:2522` vs `:2363` |
| EXEC-07 | P3 | `params` 键名闸是**大小写敏感**，注入通道却把键 `toUpperCase()` 折叠：`{"limit":1,"LIMIT":2}` 两个都合法、都注入 `AUTOFLOW_LIMIT`，后者静默覆盖前者，无 warn；`protocol.json` 的 `params` 段与向量也没有这一形态。 | `apps/executor-node/src/param-env.ts:84-86`、`:139-143`；`apps/executor-python/routers/execute.py:1730-1735`、`:4253`；`packages/executor-protocol/protocol.json` 的 `params` 段 |

> 优先级口径复核：EXEC-01/03/04 的后果都是「静默失效」，但都带一个前置条件
> （环境里出现 SDK / Windows 宿主 / 新旧版本偏斜），故按纪律落 P2 而不是 P1；
> 若产品确认「Windows 执行器是首发形态」或「command 类型会继续扩」，EXEC-03/04 可升 P1。

## 4 逐条证据

### F1（EXEC-01 · P2）executor-python 存在无人守护的第三份 `/execute` 模型

**现象**：`/execute` 的反序列化模型有三个可能来源——`autocodeflow_sdk` 的 pydantic 模型、
本文件内的 fallback 类、以及生成的协议模型。生产与测试实际走的只有 fallback；SDK 分支是
死分支，但一旦被激活不是「少校验一点」，而是**整条执行链崩**。

**逐字代码**（`apps/executor-python/routers/execute.py:77-90`）：

```python
try:
    from autocodeflow_sdk.models import ExecuteRequest
except ImportError:
    # Fallback if SDK is not installed — define locally for compatibility
    from pydantic import BaseModel
    from typing import Dict
    class ExecuteRequest(BaseModel):  # type: ignore[no-redef]
        executionId: str
        task: Dict[str, Any]
```

而 SDK 侧那份模型**没有 `secrets` 字段、`task` 是模型不是 dict**
（`packages/autoflow-sdk/autoflow_sdk/models.py:64-69`）：

```python
class ExecuteRequest(BaseModel):
    """Payload sent by admin-api to an executor's POST /execute endpoint."""
    executionId: str
    task: TaskConfig
    params: Optional[Dict[str, Any]] = None
```

全文件其余位置把 `req.task` 当 **dict** 用，只有三处加了 `isinstance` 守卫，四处没有：

```python
2377:    req_requirements = req.task.get('requirements', [])
3897:    git_repo: str | None = req.task.get('gitRepo') or req.task.get('git_repo')
3898:    git_commit: str | None = req.task.get('gitCommit') or req.task.get('git_commit')
3899:    git_branch: str = req.task.get('gitBranch') or req.task.get('git_branch') or 'main'
```

凭据一路也只是 `getattr` 兜底（`execute.py:4282`）：

```python
4282:    _skipped_secrets = inject_secret_env(env, getattr(req, 'secrets', None))
```

**触发路径**：`POST /api/execute`（`execute.py:2415 async def execute(req: ExecuteRequest, ...)`）
→ `accept_execution`（`:2270`）→ `:2363 ProtocolExecuteRequest.model_validate(req.model_dump(), strict=True)`
（此时 `model_dump()` 里没有 `secrets`，所以协议闸**通过**）→ `run_task`（`:3855`）→ `:3897`
`req.task.get(...)` → `AttributeError: 'TaskConfig' object has no attribute 'get'` → 500。
**只要进程里能 `import autocodeflow_sdk`，每一个任务都会这样失败**；同时 `4282` 的
`getattr` 让 `secrets` 恒为 `None`，即使修好 dict 问题，凭据也会静默全丢（脚本报「缺少凭据」，
平台配置却明明存在——正是 `secret-env.ts` 头注里记载的那类最难排查的故障）。

**为什么现在没红**：`requirements.txt` 与 `apps/executor-python/Dockerfile` 都不装 SDK，
`.venv` 里也没有（实测 `ModuleNotFoundError`）。测试只钉 fallback
（`apps/executor-python/tests/test_protocol_schemas.py:42` 的 docstring 明写「autocodeflow_sdk
缺席时用的是本地 fallback 模型」）。**没有任何测试或守卫覆盖 SDK 分支存在时的行为**；
`scripts/generate-executor-protocol.mjs:12` 的头注更是把「python 侧 autocodeflow_sdk 里的
pydantic model」直接列为当初要消灭的三处漂移之一——第三处至今还在。

**影响与量级**：潜伏的全量停摆（100% 任务 500）+ 100% 凭据静默丢弃。触发概率低但后果是最大的一档；
配置面很宽（`pip install autoflow-sdk` 进执行器宿主 env、把 SDK 加进 requirements.txt、
dev 机器上装过 SDK 后跑 `python main.py`）。

**最小修法**：删掉 `try: from autocodeflow_sdk.models import ExecuteRequest` 分支，只留本地
fallback（它已与协议同形并有测试钉住）；若确实要复用 SDK 模型，则必须 `task: Dict[str, Any]`
+ 补 `secrets`，并在 `tests/` 里加一条「模拟 SDK 存在」的用例（`sys.modules['autocodeflow_sdk']`
注入后断言 `/execute` 语义不变）。

**可借鉴的 OSS 做法**：NestJS/Prisma 那类「单一 DTO 事实源」；更贴近的是 pydantic 的
`TypeAdapter`——把线缆模型收敛成一份，其余层只接受 `dict` 或该模型之一，禁止「两份可互换模型」共存。

---

### F2（EXEC-02 · P2）python 用 `preexec_fn` 在多线程进程里做 setsid + rlimit

**现象**：POSIX 下任务子进程与 uv/git 子进程都在 fork 之后、exec 之前执行 **Python 代码**
（`os.setsid()` 与 `resource.setrlimit`）。CPython 文档对 `subprocess` 的 `preexec_fn` 有明确
警告：**在多线程进程中不安全，子进程可能在 exec 前死锁**。执行器是确定的多线程进程。

**逐字代码**（`apps/executor-python/routers/execute.py:916-924`）：

```python
    if rlimit_fn is None:
        return {'preexec_fn': os.setsid}
    preexec_fn = os.setsid

    def _combined() -> None:
        preexec_fn()
        rlimit_fn()

    return {'preexec_fn': _combined}
```

线程证据（非穷举）：`pkg_cache.py:297/303/307`、`routers/execute.py:189/4157`、
`interpreters.py:1400`、`scheduler.py:510` 用 `asyncio.to_thread` / `run_in_executor`；
`pydantic_settings` 在 import 期就起一个 `threading.Thread`；anyio（uvicorn）另起 selector 线程。
这些线程与 fork 完全无同步——fork 那一刻若任一线程持有堆锁/导入锁，子进程会在 `preexec_fn`
里（CPython 需要重新取 GIL、可能触发内存分配/导入）卡死，**永远不 exec**。

**对照 node**（`apps/executor-node/src/run-command.ts:79-80`，任务进程同理
`routes/execute.ts:3270-3274`）：node 把 ulimit 放进 `/bin/sh -c 'ulimit …; exec "$cmd" "$@"'`，
`spawn` 只做 fork+execve，子进程里**不跑任何 JS**；进程组隔离用 `detached: true`（= setsid，
由 libuv 在 C 层完成）。

```js
  const script = `${statements.join('; ')}; cmd=$1; shift; exec "$cmd" "$@"`;
  return { cmd: '/bin/sh', args: ['-c', script, 'task', cmd, ...args] };
```

**触发路径**：任何 python 任务的 spawn（`_spawn_kwargs_for_platform()` 是
`execute.py` 与 `interpreters.py:543/557` 两处共用的唯一入口）→ 恰好与
`asyncio.to_thread(_store_in_cache, …)`（200MB zip 复制）或 `run_in_executor(git_clone)` 重叠。

**影响与量级**：罕见但后果是**永久挂起**——子进程未 exec，`asyncio.wait_for` 的超时只在
`timeout != 0` 时存在，而 `timeout=0`（不限时，admin 的 task 实体默认值！见
`protocol.json.timeout.unbounded = 0`）的任务会一直占着并发槽位直到有人手工 kill；
心跳照常上报，admin 侧看是「一直在跑」。概率：fork 窗口窄（微秒级），但执行器是长期运行的
高并发进程，且每次任务都要 fork 一次以上（venv/pip/git 各一次），属典型长尾事故。

**最小修法**（同时消除双端不对等）：
1. `os.setsid` 改用 `subprocess` 的 `start_new_session=True`（C 层 setsid，子进程内零 Python）；
2. rlimit 改用与 node 同构的 `/bin/sh -c 'ulimit -n …; ulimit -f …; exec "$0" "$@"'` 包装
   （`sandbox.build_rlimit_pre_exec` 的语句可以直接复用到 shell 里），win32 分支保持不变。
这样两侧的进程隔离与资源闸在**同一实现形态**上收敛，也顺手干掉 `preexec_fn` 这条隐患。
**验证/反证**：改完后 `tests/test_sandbox*.py`、`test_execute.py` 里针对 rlimit 与 setsid 的
断言必须仍绿；把 `start_new_session` 改回 `preexec_fn` 时新增的「spawn kwargs 不含 preexec_fn」
断言必须转红。

**可借鉴的 OSS 做法**：CPython 官方在 3.14 引入 `posix_spawn` 回退路径，正是因为
`preexec_fn` 在多线程场景下不可靠；容器运行时（runc/crun）也把资源限制放在 exec 前的
原生钩子里而不是解释器里。

---

### F3（EXEC-03 · P2）zip 条目名校验缺 Windows 归一化（两端一致缺失）

**现象**：条目名只做「绝对路径 / 盘符 / `..` / NUL / 符号链接」五类拒绝，随后直接
`path.resolve(destRoot, ...segments)` 拼路径并写盘。**没有任何 Windows 名字归一化**：
保留设备名、尾随点/空格、大小写折叠、同目标重复条目都不判。

**逐字代码**（`apps/executor-node/src/zip-safety.ts:184-199`，尾部写盘在 `:439`）：

```ts
  if (entryName.startsWith('/') || entryName.startsWith('\\')) { … }
  if (/^[A-Za-z]:[\\/]/.test(entryName)) { … }
  const segments = entryName.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) { … }
  const target = path.resolve(destDir, ...segments.filter((s) => s !== '' && s !== '.'));
```

```ts
439:      fs.writeFileSync(target, content);
```

python 侧同义同缺口（`apps/executor-python/zip_safety.py:231-252` 的
`_reject_absolute_or_escaping` 只查绝对路径/盘符/UNC/`..`；`_normalize_entry_name`
（`:179-182`）只做 `\\`→`/`）。两端**逐条对等**，所以「双端一致」的守卫会给出假的安心，
而问题恰恰是两端一起在 Windows 上错。

**触发路径**：`codeSource=application_zip` / `packageUrl` 渠道 →
`downloadZipWithCache` → `safeExtractZip(…, destRoot=workDir)`（循环内
`apps/executor-node/src/zip-safety.ts:388` 调 `resolveEntryTarget`）→ 对包含下列条目的包：
- `NUL` / `CON` / `AUX` / `COM1.txt`：Windows 上 `writeFileSync` 要么写到设备（文件根本没产生），
  要么以 `EPERM/EBUSY` 失败 → **解压中途抛错 → 整个任务失败**，而 `errorMessage` 只会是
  一个 errno 文本；
- `a.py.`（尾随点）与 `a.py` 并存：Windows 视为同一个名字，后一条**静默覆盖**前一条；
- `A.py` 与 `a.py` 并存：Linux 上两个文件，Windows 上后者覆盖前者 → 同一个包在两平台
  解出**不同内容**（可被用来做「本地能跑、线上跑的是另一份」）；
- 同一 `target` 出现两次（中央目录允许重复名）：`written` 里两条同路径，无去重判定。

**影响与量级**：Windows 执行器（仓库有 `scripts/bug07-windows-selftest.mjs`、大量
「windows-findings」历史，说明这是受支持宿主）上，一个畸形的包会以与真实原因无关的 errno 失败；
更隐蔽的一档是**静默覆盖/静默缺失**——任务「跑起来了」但读到的不是包里那份代码。
非提权，不跨任务（workDir 是每执行私有）。

**最小修法**：在 `resolveEntryTarget`（及 python `_reject_absolute_or_escaping`）里加一段
`win32` 归一化：① 每段拒绝保留设备名（`^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$`，不区分大小写）；
② 拒绝以 `.` 或空格结尾的段（Windows 会静默剥掉）；③ 在 `extract` 里维护
`Set<string>`（win32 用小写化 key）检出「同目标重复写入」并拒绝。三者都抛 `ZipSafetyError`
（沿用既有 violation 分类，新增 `unsafe_name`）。

**可借鉴的 OSS 做法**：`npm` 的 `tar`/`node-tar` 有专门的 win32 路径清理（`win32: true` 校验保留名
与尾随点）；Rust 的 `zip` crate 与 Go 的 `archive/zip` 生态里对应 `sanitize_filename`
（OWASP File Upload Cheat Sheet 也明确要求按目标 FS 归一化后判重）。

---

### F4（EXEC-04 · P2）未知控制命令类型：python 上报、node 静默丢弃

**现象**：同一条「类型不在封闭枚举里」的命令，python 走「能力缺口显式回报」，node 走
「协议闸失败 → return null → 丢弃 + warn，不回报」。中台的 command-result 因此只有 python 那边有行。

**逐字代码**（`apps/executor-node/src/commands.ts:99-100`）：

```ts
  const parsed = ControlCommandSchema.safeParse(raw);
  if (!parsed.success) return null;
```

消费端把它当「畸形条目」吞掉，**且注释明确写了不上报**（`apps/executor-node/src/pull.ts:189-195`）：

```ts
    const cmd = parseControlCommand(raw);
    if (!cmd) {
      // 畸形条目：中台侧 parseCommand 已拦一道，这里是第二道（队列被外部
      // 写入 / 版本错配）。丢弃 + warn，不上报（没有 commandId 可关联）。
      logger.warn('[command] Discarded malformed control command from pull response');
```

python 对照（`apps/executor-python/commands.py:158-173`）：`_LOCAL_ROUTES` 未命中 → **回报结果**：

```python
    route = _LOCAL_ROUTES.get(command_type)
    if route is None:
        logger.warning(...)
        return _result(False, error=(f'{command_type} 未在 python 执行器上实现' …))
```

**触发路径**：中台 `executor-pull.service.ts:503-521` RPOP 出命令 → 执行器 `runControlCommands`
（`pull.ts:185`）→ 命令 `type` 不在 `ControlCommandSchema` 枚举内（**中台已 bump 协议、
执行器是旧版**，或包体被外部写入队列）→ node 丢。中台侧的闸只有
`supportsControlPlane(protocolVersion) = version >= 2`（`executor.service.ts:1963`），
**没有 per-type 能力判据**，所以中台认为这条命令「已投递」。此后：该 commandId 永远
不会出现在 command-result 读面（该读面正是排障入口，见 `parseCommand` 的撤销留痕注释
`executor-pull.service.ts:648-669`），`deploy` 类命令还会一路撞到 stuck sweep 的 10min 判败
（与 data-2 无关注释，是另一套机制）。

**影响与量级**：每新增一种命令类型，所有未升级的 node 执行器都会**静默丢命令**——部署不会发生、
kill 不会生效，而中台侧看起来「投递成功」。这正是 `commands.py` 头注里点名要避免的
「运维无法区分『版本旧』与『中台发错了』」。触发需版本偏斜，故 P2；但偏差一旦发生，
后果是静默失效且难以定位。

**最小修法**：node 的 `parseControlCommand` 分成两段——`commandId` 形状校验失败仍 `null`
（无法关联），**type 不在枚举内则返回一个 `{commandId, type, ok:false, error:'未知命令类型（执行器
版本旧）'}` 的结果对象并照常 POST /executors/command-result**；同时把
`ControlCommandSchema` 的 `type` 从 enum 校验里摘出来单独判（否则 safeParse 拿不到 commandId 之外的信息）。
最好的形态是抽一个 `unsupportedResult()`，与 python 的 `_result(False, ...)` 同形。

**可借鉴的 OSS 做法**：Kubernetes 的 `Unknown` reason / agent 对未知 RPC 回
`UNIMPLEMENTED` 而不是断连——「不认识」必须能被对端观测到。

---

### F5（EXEC-05 · P3）子进程 env 转发白名单两端不同集，且守卫只比「保留名」

**现象**：两处「白名单」被混为一谈——**保留名集合**（secret 不得占用）两端一致且有守卫；
**实际转发给子进程的集合**两端不同集，且**没有任何守卫比对**。

**逐字代码**（`apps/executor-node/src/env-whitelist.ts:7-22`）：含 `npm_config_cache` /
`npm_config_prefix`，**不含** `PYTHONPATH` / `PYTHONHASHSEED` / `VIRTUAL_ENV`。

```ts
export const ENV_WHITELIST = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'NODE_PATH', 'npm_config_cache', 'npm_config_prefix',
  'TMPDIR', 'TEMP', 'TMP',
```

python 侧（`apps/executor-python/routers/execute.py:849-856`）：**含** `PYTHONPATH` /
`PYTHONHASHSEED` / `VIRTUAL_ENV`，**不含** `npm_config_*`。

```python
_ENV_WHITELIST = {
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'PYTHONPATH', 'PYTHONHASHSEED', 'VIRTUAL_ENV',
    'NODE_PATH', 'TMPDIR', 'TEMP', 'TMP',
```

**为什么没被发现**：`apps/admin-api/src/modules/task/dto/__tests__/secret-key-map.parity.spec.ts`
的「两个执行器的保留名集合内容相同」断言比对的是
`secret-env.ts RESERVED_SECRET_NAMES（含 ...ENV_WHITELIST）` vs `secret_env.py _RESERVED_SECRET_NAMES`，
**不比对 `env-whitelist.ts ENV_WHITELIST` vs `execute.py _ENV_WHITELIST`**。当前两边内容恰好
被人工对齐过，所以断言绿；改任何一侧的转发集合都不会转红。

**触发路径与后果**：python 执行器宿主的 `VIRTUAL_ENV`/`PYTHONPATH` 会被**每个任务子进程**继承
（`_build_child_env()` 是唯一来源，`execute.py:4227` 之后只做增量注入）。实际后果：
`VIRTUAL_ENV` 会让子进程里调用的 `uv`/`pip` 指向执行器自己的环境；`PYTHONPATH` 会插到任务
venv 的 `site-packages` **之前**，任务 `requirements` 里声明的版本被执行器自带版本静默遮蔽
（同一份任务代码在 node 执行器上没有这个前缀，在 python 执行器上 import 到的是另一份库）。
容器镜像里两者都没设（Dockerfile 无 `PYTHONPATH/VIRTUAL_ENV`），故生产容器形态下不可达；
裸机 venv 形态（`python main.py`）下必现。另一端 `npm_config_cache` 被 node 透传给任务，
等价地把执行器的共享 npm 缓存暴露成任务可写面。

**最小修法**：把「转发集合」也纳入既有对等守卫——在 `secret-key-map.parity.spec.ts` 旁边加一条
`env-forward.parity.spec.ts`（同样读源码文本抽集合，断言 `ENV_WHITELIST` 与 `_ENV_WHITELIST`
同集）；然后显式决定 `PYTHONPATH`/`VIRTUAL_ENV`/`npm_config_*` 的去留（建议：三者都**不**转发，
执行器自己的 `PYTHONPATH` 不应进入用户任务；`npm_config_*` 若要保留须在注释里写明缓存被共享）。

**可借鉴的 OSS 做法**：GitHub Actions runner 的 `SafeEnvironment` 与 Jenkins 的
`EnvWhitelist` 都把「允许透传」写成跨平台共享的单一清单，并由测试对清单本身做快照。
---

### F6（EXEC-06 · P3）同一份生成物，两端闸门严格度不同

**现象**：`CallbackPayload` 契约（`strictObject` / `extra=forbid`）两端都用，但 **pydantic 侧的
`model_validate` 没有 `strict=True`**，lax 模式会把 `"1"` 强转成 1、`1.0` 强转成 1 等；而
同一文件里对 `ExecuteRequest` 的闸**显式**开了 `strict=True`，并在生成器里用大段注释论证
「lax 模式会让协议闸形同虚设」（`scripts/generate-executor-protocol.mjs:404-421`）。

**逐字代码**：

```python
2522:        ProtocolCallbackPayload.model_validate(payload)          # ← lax
2363:        ProtocolExecuteRequest.model_validate(req.model_dump(), strict=True)   # ← strict
```

node 侧（`apps/executor-node/src/callback.ts:270`）是 zod 生成的严格对象（`z.number().int()`），
不做任何强转。

**触发路径**：任何构造回调 dict 的 5 处手拼点（`enqueue_callback` 是唯一入队口，
`execute.py:2532-2536`）→ 若某处把 `exitCode` 写成字符串、`durationMs` 写成浮点，
**python 的闸静默放过**（`"1"`→1），node 的闸会 warn。两端于是对「同一份漂移载荷」给出
不同结论：本闸的设计目的（`协议闸让"新增回调字段先落协议"成为自动红线`）在 python 侧对
**类型**漂移无牙，只剩键名漂移有牙。

**影响与量级**：闸门自身的可靠性缺口，不直接损坏数据（两端都是 warn-only，载荷照发）。
但它使「模型层对等」这条本就靠人工维持的纪律再退化一档；且 `strict=True` 在同一文件里出现
一次、缺席一次，读代码的人会以为两者等价。

**最小修法**：`ProtocolCallbackPayload.model_validate(payload, strict=True)`，与
`ExecuteRequest` 的闸同参数；若担心 `durationMs` 等既有实现产出 int 之外的形态，
先在两侧 `enqueue_callback` 出口做一次 `int()` 归一，再开 strict。反证：把 `strict=True` 去掉
后，新增的「`{"durationMs": "10"}` 必须 warn」用例应转红。

**可借鉴的 OSS 做法**：pydantic v2 官方迁移指南建议线缆边界一律 `strict=True`（lax 只用于
CLI 用户输入这类人写场景），与本仓 `ExecuteRequest` 的既有选择一致。

---

### F7（EXEC-07 · P3）`params` 键名大小写折叠后同名，静默覆盖

**现象**：键名规则大小写敏感（`^[A-Za-z0-9_]{1,64}$`），注入通道却统一大写；两个只在大小写上
不同的键都合法、都注入同一个 env 名，后者静默覆盖前者，无 warn、无协议向量。

**逐字代码**（`apps/executor-node/src/param-env.ts:84-86`、`:139-143`）：

```ts
export function paramEnvKey(key: string): string {
  return `AUTOFLOW_${key.toUpperCase()}`;
}
…
const SAFE_PARAM_ENV_KEY_RE = /^[A-Za-z0-9_]{1,64}$/;
export function isInjectableParamEnvKey(key: string): boolean {
  return SAFE_PARAM_ENV_KEY_RE.test(key);
}
```

python 对等（`apps/executor-python/routers/execute.py:1730-1735` 的 `_PARAM_KEY_RE` /
`_is_injectable_param_key`，与 `:4253` 的 `env[f'AUTOFLOW_{k.upper()}'] = …` 注入）。
`protocol.json` 的 `params` 段注释甚至讨论了「与平台键同名被覆盖是
既有语义」，但**没有讨论用户键之间折叠后同名**，`params.vectors` 里也没有这一形态。

**触发路径**：中台 `buildDispatchParams`（`dispatch-params-keys.util.ts`，同一正则，同样不查折叠）
→ 派发 → 执行器注入循环 `env[paramEnvKey(k)] = …`。用户把 `limit` 与小写/大写的 `LIMIT` 同时配上
（复制粘贴时最常见）→ 只有 JSON 键序最后那个生效，脚本静默读到另一个值。两个执行器因为接同一份
JSON、键序相同，所以**覆盖结果一致**（跨端一致），但**用户意图丢失**且无任何痕迹。

**最小修法**：三端在键名闸之后加一步「折叠去重」——同一 params 对象内 `k.toUpperCase()` 重复时
skip-and-warn（与既有 `onInvalidKey: skip-and-warn` 同策，保留先出现者），并把这一形态补进
`protocol.json.params.vectors`（`case-fold-collision` 一条），三端契约测试同时断言。

**可借鉴的 OSS 做法**：Windows 环境块本身大小写不敏感，`dotenv`/`direnv` 一类工具在加载时对
折叠键名给 explicit warning；`node-which`/`cross-env` 也在写入前查重。

## 5 建议实施顺序（收益 ÷ 风险）

| 顺序 | 项 | 理由 | 风险 | 验证 |
|---|---|---|---|---|
| 1 | **F1（EXEC-01）** 删 SDK 模型分支 | 收益最大（消除一条全量停摆路径）、改动最小（删 5 行 + 一条测试）、零运行时行为变化（当前环境本就走 fallback） | 极低 | `pytest apps/executor-python/tests/test_protocol_schemas.py -k runtime_model`；新增「模拟 SDK 存在」用例 |
| 2 | **F6（EXEC-06）** 回调闸开 strict | 一行参数 + 一处 `int()` 归一，把「模型对等」这条纪律补上；与 F1 同属「闸门自身的牙」 | 低（若既有载荷有 float 会转成 warn，warn-only 不阻断） | `pytest apps/executor-python/tests/test_execute.py -k callback`；反证：去掉 strict 后新用例红 |
| 3 | **F4（EXEC-04）** 未知命令类型回报 `ok:false` | 把「静默丢命令」变成可见结果，改动集中在 `commands.ts` + `pull.ts` 两处 | 低-中（要给 `ControlCommandSchema` 拆出 type 判定，避免 safeParse 吞掉 commandId） | `npm test -w apps/executor-node -- commands`；新增「未知 type 必上报」用例 |
| 4 | **F5（EXEC-05）** 加「转发集合」对等守卫 + 决定三者去留 | 先加守卫（不改行为）即可锁死漂移；随后单独提交「去掉 PYTHONPATH/VIRTUAL_ENV 转发」 | 低（守卫零行为变化）/ 中（去转发会改变裸机形态任务可见 env） | `npx jest secret-key-map.parity` + 新 `env-forward.parity.spec.ts`；python `test_execute.py -k whitelist` |
| 5 | **F3（EXEC-03）** zip 名 Windows 归一化 | 需要一个 Windows 宿主才能真验证，宜与 `bug07-windows-selftest` 一起做 | 中（会拒掉一批历史能解的包，需先在机队上扫一遍包名分布） | 两端各加 3 条夹具（`NUL` / `a.py.` / 重复条目）；`test_zip_safety.py`、`zip-safety.spec.ts` |
| 6 | **F2（EXEC-02）** 去掉 `preexec_fn` | 收益是消除长尾挂起 + 双端形态收敛，但触碰 spawn 与 rlimit 两条安全链，回归面最大 | 中-高（rlimit 语义必须逐条保持：NOFILE/CPU/FSIZE/NPROC/AS） | `pytest tests/test_sandbox*.py tests/test_execute.py`；反证：恢复 `preexec_fn` 后新增「spawn kwargs 无 preexec_fn」断言红；建议单独一轮做 |
| 7 | **F7（EXEC-07）** params 折叠去重 | 纯体验/一致性，三端各加 5 行 + 一条向量 | 极低 | 三端契约测试（`executor-protocol-contract.spec.ts` / `test_executor_protocol_contract.py`）同时绿 |

**不建议本轮做**：把「转发集合」真的去掉（F5 后半）与「F2」同批——两者都改变子进程环境的实际形态，
混在一起出问题无法归因。

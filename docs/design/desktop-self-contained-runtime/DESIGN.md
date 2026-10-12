# 桌面执行器「运行时自包含」改造 —— 实现方案设计（DESIGN v0.1）

> **状态**：第一期（P0）**已实施**（2026-10）。实施范围、偏离与残差见下方「实施回写」。
> 本文档**不改任何契约**；凡与已冻结契约冲突处，均单列「需显式决策」项。
> **上游**：`docs/design/python-task-upload-and-multiversion/CONTRACT.md`(FROZEN) / `REQUIREMENTS.md`(v0.3) / `apps/executor-desktop/README.md` / `docs/deployment.md`
> **触发来源**：生产实测——全新 Windows 电脑装客户端、中台部署 1 个应用后报
> `Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases.`
> **一句话结论**：桌面执行器**缺一层「运行时自包含」**。它当前依赖宿主机恰好装过 Python / Node / git，但能力上报却按「执行器进程自身的形态」推导，两者口径不一致 → 上报的能力**无法在本机兑现**。

---

## 实施回写（2026-10 第一期 P0 落地）

> ⚠️ **读 §0 前请先读本节**：§0 记录的是**修复前**的一手事实，其中的
> `file:line` 引用与"`grep -c uv routes/deploy.ts` = 0"等**描述性证据在修复后已
> 不再成立**（行号因改动位移；deploy.ts 现已接入解释器池）。§0 作为**故障取证**
> 保留原样，不回改——它记录的是当时的现场。

### 已落地（对应 §5 第一期，均带可证伪回归测试）

| 项 | 内容 | 关键文件 |
|---|---|---|
| T-1 | node 分支改用工具链解析；`source==='self'` 时注入 `ELECTRON_RUN_AS_NODE=1`；无可用 node 时**明确失败**（不再静默回落裸命令名） | `apps/executor-node/src/routes/execute.ts` |
| T-2 | 应用部署接入 uv 解释器池：`pool(declared) → pool(any) → 验真宿主 → 明确失败`；`startApp` 兜底不再落 Store stub | `apps/executor-node/src/routes/deploy.ts`、新建 `src/python-venv.ts` |
| T-3 | Store stub 验真：宿主解释器候选**采纳前实跑** `--version`；失败归类 `runtime_missing`/`interpreter_unavailable` 并点名 stub | `src/toolchain.ts`（新）、上述两处调用点 |
| T-4 | macOS 从 Dock 启动时解析登录 shell PATH（哨兵包裹、剥横幅）并前置合并 | `apps/executor-desktop/src/main/shell-path.ts`（新） |
| 额外 | `runtime-detection.ts`：node 能力由"自证"改为**实跑真值**（消除"没装 Node 仍上报 node"的虚报）；`main.ts` 探测兜底同步改为 **shell-only**（不再顺带虚报 node） | `apps/executor-node/src/runtime-detection.ts`、`src/main.ts` |

**架构核心落地**：新增 `apps/executor-node/src/toolchain.ts` 作为**单一真值源**
（§3.1 的设计），能力上报与任务执行**都**消费它——这是"口径分裂"不再复发的前提。

### 审查修复轮（独立对抗式审查发现 4 项缺陷后的修复）

> **背景**：第一期落地后，另起一个**独立对抗式审查**（不参与实现、只读代码 +
> 变异测试）复核全部改动。结论是：**node 那一半真的修好了；python 那一半只是把
> "令人困惑的失败"换成了"可读的失败"——它仍然上报了自己兑现不了的能力。** 即
> 原始事故的形态**镜像到了 python**。以下 4 项已修复并被独立反证验证：

| # | 缺陷（审查发现） | 修复 | 严重级 |
|---|---|---|---|
| **C-1** | 只带 uv、无宿主 Python 的机器**仍上报 `python`** 能力，而当时无版本 python 任务的执行路径**要求宿主解释器**并直接抛错；中台按 `capabilities` 派发 → 每台干净机器上的默认（无版本）python 任务必失败。**这正是本次事故的原始形态** | 新增 `DEFAULT_PYTHON_VERSION = '3.12'` 默认版本兜底：无声明版本 **且** 宿主解释器不可用 → 经 uv 池取 3.12 执行（复用既有 `ensureVersion`，下载/离线预填/失败分因/并发闸全不变）。于是 `hasUv ⇒ python 能力` 这个捷径**第一次真正成立** | Critical |
| **H-1** | `routes/deploy.ts` 的 **node** 分支仍硬编码 `cmd = 'node'`（该文件 `grep -c toolchain` = 0），干净机器上 `node` 应用部署必 ENOENT；且 `deploy.spec.ts` 有一条断言把这个行为**锁死**了 | node 分支改走工具链（`resolveStartNode()`），`source==='self'` 时注入 `ELECTRON_RUN_AS_NODE=1`；新增 `prewarmRuntimeResolution()` 预热同步缓存（实测未预热时 `cachedToolchain()` 为 null）；缓存有结论且不可用 → **明确抛错**，绝不 spawn 裸 `node` | High |
| **H-2** | `interpreters.ts` 的池回收只扫 `<workDir>/.venvs`（任务 venv），看不到部署 venv（`<workDir>/apps/<appId>/releases/<key>/.venv`）。uv 建的 venv 只是指向池的 shim → 定期回收会**删掉在跑部署应用赖以生存的池版本**，应用直接崩。这是接入解释器池**新引入**的暴露面（旧的宿主 `python -m venv` 自包含、免疫） | `venvDependencyHomes()` 增加对部署 venv 布局的扫描（**固定 4 层深度**、逐项 try/catch、复用 `readPyvenvCfgHome`）。`interpreters.ts` 的导出签名与既有语义**零变化**，只是"在用"集合变宽 | High |
| **H-3** | `python-venv.ts` 的 `resolveStartPython` "文件存在即采信" venv shim，无健康判定（`execute.ts` 有对应的 `venvReuseProblem`）。与 H-2 叠加 → 池版本被回收后 shim 仍在但必死：应用崩 → daemon 重启 → 同一个死解释器 → **崩溃循环**，且无任何指向池的诊断 | 新增 `venvStartProblem()`（镜像 `execute.ts` 的 `venvReuseProblem` 语义：shim 存在 + `pyvenv.cfg` 可读 + `home` 存在 + 版本匹配）；不健康则落到池/宿主链。因 `resolveStartPython` 是**同步**函数（`startApp` 由 `setImmediate` 与重启定时器调用，不能 await），采用**静态判定**——残余窗口（池目录被外部损坏而非被自己回收）已在代码注释中如实登记 | High |
| **M-1** | `python-venv.ts` 的 abort signal 未透传给 `ensureVersion` / `discoverInstalled`（`execute.ts` 的 NETOPT-E P3-1 已修过同类） | 透传 `opts.signal`。声明版本分支目前不可达（admin 不发 `runtimeVersion`），属防御性对等 | Medium |
| **C-1b** | C-1 只修了**任务**链路；**应用部署**链路（`resolveDeployInterpreter`）**漏了**同一个兜底——池空 + 宿主不可用时仍直接抛错。于是**用户实际报障的那个场景**（"中台部署 1 个应用"）**仍然失败**，只是失败可读了 | 在 `resolveDeployInterpreter` 的宿主判定之后补同一个默认版本兜底（版本取**同一个** `DEFAULT_PYTHON_VERSION`）。放在宿主之后使其成为**纯增量**：唯一被改变的是原本 100% 失败的分支 | Critical |
| **C-1c** | 光有 C-1b 还不够：**没有 `requirements.txt`** 的 python 应用不会走 `ensurePythonVenv`，于是部署期**任何一步都不会去获取解释器**；`startApp` 是同步函数、只能读池快照 → 干净机器上仍失败 | `prewarmRuntimeResolution` 对 python **显式解析一次**（best-effort，失败只告警）：触发获取与落池，`ensureVersion` 成功后会刷新探测缓存，同步的 `startApp` 随即命中。**best-effort 是刻意的**——`scheduled` 模式只部署不启动，不该因"当下取不到解释器"把"落盘成功"变成"部署失败" | Critical |
| **M-2** | 出现**第二套能力判定**与**已漂移的候选表**：`main.ts` 的兜底硬编码 `['shell','node']`；`runtime-detection.ts` 的 `PYTHON_CANDIDATES` 缺 win32 的 `py`（与 `toolchain.ts` 的 `pythonCandidates` 漂移），且其 python 探测只判退出码、不要求版本串 | ①`main.ts` 兜底改为 **shell-only** 并说明理由；②`PYTHON_CANDIDATES` 改为**派生**自 `toolchain.pythonCandidates(process.platform)`，并加**源码守卫**钉死"不得再出现硬编码字面量数组" | Medium |

> **常量归位（C-1b 落地时踩到的连带坑）**：`DEFAULT_PYTHON_VERSION` 最初定义在
> `interpreters.ts`。但那个模块是"解释器池的运行时实现"，**测试里常被整体
> `jest.mock`**——`routes/deploy.spec.ts` 的 mock 就漏了 re-export 它，导致路由级
> 回归用例断言到 `ensureVersion(undefined, …)`：常量静默变成 `undefined`，而它的
> 去路是 `uv python install undefined`。现挪到**零依赖**的 `python-defaults.ts`
> （`interpreters.ts` 与 `routes/execute.ts` 各留一行 re-export 兼容既有导入），
> 任何模块的 mock 都不再能波及它。**教训：被多条链路共用的"策略常量"不要寄居在
> 会被 mock 的重模块里。**

> **M-2 的一个方法论教训（值得记住）**：该守卫的第一版写成"断言常量等于派生函数"，
> 结果在 Linux CI 上**变异存活**——本机 `process.platform !== 'win32'`，硬编码值与
> 派生值恰好相同，同义反复。改为**源码守卫**（禁止字面量数组 + 要求出现
> `pythonCandidates(process.platform)`）后变异即红。**"测试通过"不等于"测试有齿"，
> 尤其当断言断言的是同一平台上的两个等价表达式时。**

### 与本文档原方案的偏离（如实登记）

1. **未抽出统一的 `ensurePythonVenv` 供两侧共用**：`execute.ts` 当时的私有实现仍在
   原处，新建的 `python-venv.ts` 目前**只被 `deploy.ts` 消费**。原因：两个工作流
   并行改同一批文件时强行合并会冲突；且 `execute.ts` 的 venv **复用健康检查**
   （`venvReuseProblem`）语义与 deploy 的一次性构建不同，迁移需单独评审。
   **→ 这是 R8（两处 venv 逻辑漂移）未关闭的残差**，见下方「遗留动作」。
   （注：H-3 已在 `python-venv.ts` 内**镜像**了该健康检查语义，但两份实现仍在。）
2. **`capabilityDetail` 细化上报（§4.4.4）未实施**：属第二期范围。C-1 的修复使
   "uv-only 机器"能真正兑现能力，故该字段的紧迫性下降；但"瞬时取不到解释器"
   这一状态仍无法表达给中台（见 C-1 修复的诚实边界说明）。
3. **应用部署仍不支持声明 `runtimeVersion`**：`DeployPayload` 已加**可选**字段，
   但 `Application` 实体无该字段、admin 侧不发——即决策点 D-3 选了 (b)。
4. **§3.2 的"预置 CPython 进安装包"（D-5/P1-1）未做**：属第二期。**注意**：C-1 的
   默认版本兜底使"无版本 python 任务"在**能联网**的干净机器上可跑；但**纯离线**
   干净机器仍需本期预置（池空 + 无宿主 → 兜底也会失败，只是失败可读）。
5. **`uvPaths` 的"基线 + 可写覆盖"双层模型（§4.4.2）未实施**：同上属第二期。

### 遗留动作（按优先级）

1. **`git` / `npm` 仍是宿主依赖**（同一根因的残差）：工具链**已探测**二者，但
   `execute.ts`（6 处 `runCommand('git', …)`、1 处 `npmCmd`）与 `deploy.ts`
   （2 处 git、1 处 `npmCmd`）的**调用点尚未消费解析结果**。全新机器上 git 渠道
   任务与需装 node 依赖的任务仍会失败。对应决策点 **D-4**。
   （node 的**任务**与**部署**两条路径都已接工具链；git/npm 是最后未接的一项。）
2. **`execute.ts` 迁移到 `python-venv.ts`**（关闭 R8），迁移时须保留其
   `venvReuseProblem` 复用健康检查语义（H-3 已在 deploy 侧镜像，但仍应统一）。
3. **`runtime-detection.ts` 的 `type` 展示局限**：`type` 枚举只有
   `node|python|universal`，**没有"仅 shell"档**——一台既无 node 又无 python 的
   执行器会上报 `capabilities:['shell']` 但 `type` 仍显示 `Node.js`。仅影响后台
   展示（派发只看 `capabilities`），但属"如实"原则的残留。
4. **C-1 的诚实边界**：uv 在但**当下**取不到解释器（无网/无镜像/池损坏）时仍上报
   `python`。这是**有意**的（能力 ≠ 瞬时可达：探测发生在注册期，网络可恢复；撤掉
   能力会让一台本可自愈的机器永久收不到任务、且**没有任何失败反馈**，比现状更难
   排查）。代价是那类机器上的无版本任务会以 `interpreter_unavailable` 失败——但
   该失败带完整结构化快照（FR-12/AC-12a），可据此改派或离线预填。若未来要收紧，
   须先补 §4.4.4 的 `capabilityDetail`。
5. **验证缺口**：本机为 Linux，Electron 宿主与 Windows Store stub 分支由**注入夹具**
   覆盖（`toolchain.ts` 的 `deps` 注入正是为此设计），**未在真机 Windows/macOS 上
   端到端验证**。§7.2 的 E-1~E-8 干净机器验收清单**仍未执行**——这是本次交付
   最重要的未闭合项。

---

## 0. 实测结论（本次排查的一手事实）

全部结论均来自本仓库源码逐行核对，**非推测**。行号以本文档撰写时的 HEAD 为准。

| # | 事实 | 证据 |
|---|---|---|
| 0-1 | 桌面安装包**只自带 uv，不含 Python 本体** | [electron-builder.yml:16-62](../../../apps/executor-desktop/electron-builder.yml) 的 `extraResources` 仅 `executor-node/`、`uv/`、`agent-worker/`、`playwright/`、`assets/`；[README.md:182](../../../apps/executor-desktop/README.md) 明文「自带 uv ≠ 自带 Python」 |
| 0-2 | **任务执行链**无版本 python 任务落到宿主 `python.exe` | [execute.ts:2014](../../../apps/executor-node/src/routes/execute.ts) `cmd = pythonBinFromVenv \|\| resolvedInterpreter \|\| (win32 ? 'python.exe' : 'python3')` |
| 0-3 | **应用部署链**完全没有 uv —— `grep -c uv routes/deploy.ts` = **0** | [deploy.ts:307](../../../apps/executor-node/src/routes/deploy.ts) `const pythonCmd = isWin ? 'python' : 'python3'` + [deploy.ts:308](../../../apps/executor-node/src/routes/deploy.ts) `python -m venv`；[deploy.ts:401](../../../apps/executor-node/src/routes/deploy.ts) 启动兜底同样硬编码 |
| 0-4 | **node 任务**同样落宿主 `node.exe` | [execute.ts:1992](../../../apps/executor-node/src/routes/execute.ts) `cmd = win32 ? 'node.exe' : 'node'` |
| 0-5 | **node 能力是「自证」的，从不探测** | [runtime-detection.ts:50-52](../../../apps/executor-node/src/runtime-detection.ts) 「`shell` 与 `node` **恒定存在，不探测**——本进程就运行在 Node.js 里，node 能力是自证的」；[runtime-detection.ts:67](../../../apps/executor-node/src/runtime-detection.ts) `['shell','node']` 恒定入列 |
| 0-6 | 桌面端 executor-node 跑在 **Electron** 上，不是系统 node | [executor-process.ts:221](../../../apps/executor-desktop/src/main/executor-process.ts) `ELECTRON_RUN_AS_NODE: '1'` + [:283](../../../apps/executor-desktop/src/main/executor-process.ts) `spawn(process.execPath, [entryPath])`——`process.execPath` 是 Electron exe |
| 0-7 | 打包内**没有** node.exe，且**无人**把 Electron 目录塞进子进程 PATH | desktop 全仓对 PATH 的写入只有 agent 链的 [trial-run.ts:106-108](../../../apps/executor-desktop/src/main/agent/trial-run.ts)；任务链 0 处 |
| 0-8 | **uv 不隐式下载**：`UV_PYTHON_DOWNLOADS=manual` 恒定下发 | [uv-paths.ts:101](../../../apps/executor-desktop/src/main/uv-paths.ts)；[interpreters.ts:1116-1122](../../../apps/executor-node/src/interpreters.ts) 说明该值语义（仅允许显式 `uv python install`） |
| 0-9 | 声明版本的 python 任务**首跑要联网下载**（池空时） | [interpreters.ts:1410](../../../apps/executor-node/src/interpreters.ts) `uv python install`；在线可下载区间 3.8~3.14 |
| 0-10 | **启动/心跳路径完全不预热解释器** | `grep -n "warmup\|prewarm\|ensureVersion" main.ts scheduler.ts` → 无 |
| 0-11 | `defaultRuntimeVersion` 是**死字段**：**无任何生产消费者**（仅类型定义、三项内置 runtime 的 `null` 字面量、测试 fixture 与 dist 声明），且三项内置 runtime 全是 `null` | [builtin-runtimes.ts:20,31,42](../../../apps/admin-api/src/modules/runtime/builtin-runtimes.ts)；[task-runtime.types.ts:39](../../../apps/admin-api/src/modules/runtime/task-runtime.types.ts)；`grep -rn defaultRuntimeVersion apps/{admin-api,admin-web}/src` 除上述外**零命中** |
| 0-12 | 「默认 3.12」只存在于**调度兜底常量**与**需求描述**，不产生任何安装行为 | [interpreter-match.util.ts:52](../../../apps/admin-api/src/modules/executor/interpreter-match.util.ts) `LEGACY_DEFAULT_INTERPRETERS = ["3.12"]`（仅 `interpreters===null` 时的过滤豁免）；[REQUIREMENTS.md:126](../../../docs/requirements/python-task-upload-and-multiversion/REQUIREMENTS.md) FR-10 括号内「现状语义：Python 3.12」指容器宿主 |
| 0-13 | **应用链没有 `runtimeVersion` 概念** | `grep -rn runtimeVersion apps/admin-api/src/modules/application/` → 无命中；[application.entity.ts:32](../../../apps/admin-api/src/modules/application/entities/application.entity.ts) 只有 `runtime: string` |
| 0-14 | 应用 runtime **缺省即 python** | [application.controller.ts:487](../../../apps/admin-api/src/modules/application/application.controller.ts) `runtime: runtime \|\| manifestRuntime \|\| "python"` |
| 0-15 | **git 也是宿主依赖** | [execute.ts:123](../../../apps/executor-node/src/routes/execute.ts) `runCommand('git', ...)` 等 5 处；[deploy.ts:1143](../../../apps/executor-node/src/routes/deploy.ts) 同 |
| 0-16 | **npm 也是宿主依赖** | [execute.ts:1684](../../../apps/executor-node/src/routes/execute.ts) `npm.cmd`/`npm`；[deploy.ts:295](../../../apps/executor-node/src/routes/deploy.ts) 同 |
| 0-17 | macOS GUI 启动**不继承登录 shell 的 PATH**，且全仓**无任何处理** | deskop 依赖仅 `auto-launch`/`electron-log`/`electron-store`/`electron-updater`（[package.json:25-31](../../../apps/executor-desktop/package.json)）；`grep fix-path\|shell-env` → 无 |
| 0-18 | 容器执行器**把运行时焊进镜像**，所以「宿主解释器」永远成立 | [executor-python/Dockerfile:2,8](../../../apps/executor-python/Dockerfile) `FROM python:3.12-slim`（builder + runtime 两段）；[executor-node/Dockerfile:3,11](../../../apps/executor-node/Dockerfile) `FROM node:24-alpine` |
| 0-19 | 仓库内**已有两处正确样板**：Electron 复用为 node | [trial-run.ts:97-98,162](../../../apps/executor-desktop/src/main/agent/trial-run.ts) `ELECTRON_RUN_AS_NODE` + `process.execPath`；[agent-worker-process.ts:97](../../../apps/executor-desktop/src/main/agent-worker-process.ts) `spawn(process.execPath, ...)` |
| 0-20 | **Store stub 验真函数已存在且有单测** | [runtime-detection.ts:104](../../../apps/executor-node/src/runtime-detection.ts) `probePythonExecutable()` 实跑 `--version` 判 `status===0`；[deploy.sh:305-311](../../../deploy.sh) 同款判定（注释明确记载该 stub 陷阱） |

---

## 1. 根因分析

### 1.1 一个「口径分裂」，不是若干独立 bug

本次暴露的 4 个症状（python 任务、python 应用、node 任务、macOS PATH）**同一个根因**：

```
┌─────────────────────────────┐        ┌─────────────────────────────┐
│  能力上报（探测口径）        │        │  任务执行（解析口径）        │
│  runtime-detection.ts        │        │  routes/execute.ts           │
│                              │        │  routes/deploy.ts            │
│  · node  = 自证（本进程在    │        │  · node  = 裸 node.exe       │
│             Node 里）        │   ≠    │  · python= 宿主 python.exe   │
│  · python= 系统 python       │        │  · npm   = 裸 npm            │
│             **或自带 uv**    │        │  · git   = 裸 git            │
└─────────────────────────────┘        └─────────────────────────────┘
        「这台能干什么」                      「实际用什么去干」
```

**两套代码，两个真值源。** 于是产生两个方向的错配：

- **虚报**（node）：上报「有 node」，实际 `spawn node.exe ENOENT`。中台会持续往这台机器派 node 任务，因为中台只信 `capabilities`（[executor.service.ts:2629](../../../apps/admin-api/src/modules/executor/executor.service.ts) `e.capabilities.includes(opts.runtime)`）。
- **可跑却报缺失 / 报可用却跑不了**（python）：`hasUv` 让 `python` 能力为真（[runtime-detection.ts:72-74](../../../apps/executor-node/src/runtime-detection.ts)），但**无版本任务的执行路径根本不消费 uv**（FR-10 硬约束），于是「能力为真」推导不出「能跑」。

### 1.2 为什么现在才发现：容器把前提「焊死」了

FR-10 原文要求「无版本 → 宿主默认解释器，**不触发解释器下载**」。这条在容器里**完全正确**——因为容器镜像就是 `FROM python:3.12-slim`（0-18），「宿主解释器」是**编译进镜像的**，永远存在。

桌面端是后来接上来的形态，**它的宿主不保证有 Python**，于是：

| | 容器执行器 | 桌面客户端 |
|---|---|---|
| 「宿主解释器」指什么 | 镜像内 `python:3.12-slim` | **操作系统的 Python**（可能不存在） |
| FR-10 前提成立？ | ✅ 成立 | ⛔ **不成立** |
| 「保持既有行为不变」 | 真有行为可保持 | **从来没有既有行为** → 退化为宿主 stub |

**结论**：FR-10 的适用域是「宿主解释器由部署方保证存在」，桌面端违反该前提。这是**需求层的前提缺口**，不是实现层的疏漏。同理，「node 自证」的假设（本进程在 Node 里 ⇒ 宿主有 node）在容器里也成立（镜像同一份 node），桌面端 Electron ≠ 宿主 node。

### 1.3 生产 3 台为什么正常

那 3 台是**装了全套工具链的服务器**（Python/Node/git 都在 PATH），恰好同时满足两套口径。**这不是验证过，是巧合覆盖**——横向扩容到「干净的办公机」时前提立刻崩塌。

---

## 2. 改造目标与原则

### 2.1 目标

| # | 目标 | 可验收判据 |
|---|---|---|
| G1 | **全新未装任何运行时的机器，装上客户端即可跑 python / node 任务** | 干净 Windows/macOS 快照装机 → 派无版本 python 任务 + node 任务 → 均成功 |
| G2 | **上报的能力必须可在本机兑现** | 上报 `capabilities` 前对每个 runtime 实跑冒烟；跑不通则不上报 |
| G3 | **断网可用**（至少无版本任务） | 断网 + 新装机 → 无版本 python 任务成功 |
| G4 | **横向扩容零配置**（N 台机器行为一致） | 同镜像/同安装包装到 N 台 → 能力集合一致、任务结果一致 |
| G5 | **容器执行器零行为变化** | executor-python/node 既有测试全绿，FR-10 逐字节不变 |

### 2.2 设计原则

- **P1 单一真值源**：能力探测与任务执行**共用同一个解析器**（消灭口径分裂，而非逐个打补丁）。
- **P2 只承诺能兑现的**：能力上报 = 冒烟实测结果，不是推断。
- **P3 桌面优先，容器不动**：所有改动走 `process.versions.electron` 分支，容器路径一字不改（保 G5）。
- **P4 显式失败优于静默降级**：解析不出可用解释器时**明确失败并给指引**，绝不把 stub 当解释器用。
- **P5 不推翻已冻结契约**：与 FR-10 的冲突以「桌面端例外」方式表达，不修改 FR-10 原文。

---

## 3. 目标架构

### 3.1 新增：运行时解析器（单一真值源）

新增 `apps/executor-node/src/toolchain.ts`（纯函数 + 可注入探测，便于 selftest）：

```ts
export type ToolSource =
  | 'venv'      // 任务 venv 内（最高优先级）
  | 'pool'      // uv 解释器池内（声明版本时）
  | 'bundled'   // 随包自带（桌面端新增）
  | 'self'      // 复用执行器自身：Electron 当 node 用
  | 'host'      // 宿主 PATH
  | 'none';

export interface ResolvedTool {
  name: 'python' | 'node' | 'npm' | 'git';
  /** 可执行文件绝对路径或命令名；source==='none' 时为 null。 */
  path: string | null;
  source: ToolSource;
  /** 冒烟实测是否通过（--version 实跑）。false 时**不得**计入能力上报。 */
  verified: boolean;
  /** 失败/降级原因，用于诊断面与失败归类。 */
  detail?: string;
  /** node 专用：是否需要 ELECTRON_RUN_AS_NODE=1。 */
  requiresElectronRunAsNode?: boolean;
}

export interface Toolchain {
  python: ResolvedTool;
  node: ResolvedTool;
  npm: ResolvedTool;
  git: ResolvedTool;
}

/** 探测本机工具链（带 TTL 缓存，注册/心跳/执行三处共用）。 */
export function probeToolchain(opts?: { timeoutMs?: number }): Promise<Toolchain>;
/** 同步取缓存（心跳路径零进程开销，对齐 NFR-10）。 */
export function cachedToolchain(): Toolchain | null;
export function invalidateToolchain(): void;
```

**关键约束**：`probeToolchain()` 与 `routes/execute.ts` / `routes/deploy.ts` 的解析**必须是同一个实现**。任何一方新增候选路径，另一方自动获得——这是 P1 的落地方式。

### 3.2 桌面端：补齐三个自带运行时

| 运行时 | 方案 | 依据 |
|---|---|---|
| **node** | 复用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` | 已有样板 [trial-run.ts:97,162](../../../apps/executor-desktop/src/main/agent/trial-run.ts)（0-19）；零新增体积 |
| **python** | 安装包**预置**一个 CPython 进解释器池（默认 3.12），并激活 `defaultRuntimeVersion` | 兑现 G1/G3；复用既有 `interpreters.ts` 池机制 |
| **npm / git** | 分两期：一期「如实探测 + 明确失败 + 安装指引」；二期评估自带 | 自带成本高，先止血（见 §5 分期） |

### 3.3 能力上报改造（消除虚报）

[runtime-detection.ts:63-77](../../../apps/executor-node/src/runtime-detection.ts) 的 `detectRuntimes` 签名扩展为「消费实测结果」：

```ts
// 现状（推断式）
export function detectRuntimes(input: {
  hasUv: boolean;
  isPythonExecutable: (c: string) => boolean;
}): ReportedRuntime[]

// 改造后（实测式；保留旧签名兼容既有单测）
export function detectRuntimes(input: {
  toolchain: Toolchain;      // 新增：实测结果
  hasUv?: boolean;           // 保留：uv 仍算 python 能力的来源之一
  isPythonExecutable?: (c: string) => boolean;  // 保留：旧调用方
}): ReportedRuntime[]
```

**判定规则（改造后）**：

```
python 能力 := (池内已有可用解释器)            // 可立即兑现
            ∨ (自带 uv 可用 ∧ 声明版本任务能下载到位)  // 声明版本路径可兑现
            ∨ (宿主 python 实跑通过)           // 无版本路径可兑现
node 能力   := (Electron 复用可用) ∨ (宿主 node 实跑通过)   // 不再"自证"
shell 能力  := 恒定（系统自带 cmd/sh，无需探测）
```

> **注意 python 的语义细化**：`hasUv` 单独为真**不再**足以声明 python 能力无版本可用——因为无版本路径不消费 uv。但**声明版本**的任务确实能跑，所以 uv 仍计入 python 能力（与现状一致，避免把「只能跑声明版本任务」的执行器误判为无 python 能力）。这个细微处必须在能力上报里**如实表达**，方案见 §4.4（新增 `capabilityDetail` 字段）。

---

## 4. 详细设计

### 4.1 P0-1：node 复用 Electron（`routes/execute.ts`）

**改动点**：[execute.ts:1991-1993](../../../apps/executor-node/src/routes/execute.ts)

```ts
// 改造前
if (actualRuntime === 'node') {
  cmd = process.platform === 'win32' ? 'node.exe' : 'node';
  args = [actualEntrypoint];
}

// 改造后（伪代码）
if (actualRuntime === 'node') {
  const node = cachedToolchain()?.node;
  if (node?.source === 'self') {
    // 桌面端：复用 Electron 自身当 node 跑
    cmd = node.path!;                       // process.execPath
    env['ELECTRON_RUN_AS_NODE'] = '1';      // 必须在 spawn 前落到 env
    args = [actualEntrypoint];
  } else if (node?.path) {
    cmd = node.path;                        // 池/自带/宿主
    args = [actualEntrypoint];
  } else {
    throw new Error(
      'node runtime unavailable on this executor (no Electron self-reuse, ' +
      'no bundled node, and no node on PATH) — install Node.js or use a ' +
      'capability-reporting executor',
    );
  }
}
```

**必须同时处理的两个配套点**：

1. **`ELECTRON_RUN_AS_NODE` 必须进白名单**：它**当前不在** [env-whitelist.ts:7-23](../../../apps/executor-node/src/env-whitelist.ts) 的 `ENV_WHITELIST` 里，而 `buildChildEnv()` 只放行白名单键。不加入则设了也**被子进程环境剥离**，Electron 会以 GUI 模式启动而挂死。**这是最容易漏的一步**（见 §6 风险 R1）。
   - 实现方式二选一：(a) 加入 `ENV_WHITELIST`；(b) 像 `NODE_PATH` 那样在 `execute.ts` 里**显式 `env['ELECTRON_RUN_AS_NODE']='1'` 注入**（推荐 (b)——它是执行器内部契约，不该由用户环境决定，且避免用户从环境里注入该键改变行为）。
2. **沙箱包装兼容性**：`buildTaskSandboxArgv`（[execute.ts:2574](../../../apps/executor-node/src/routes/execute.ts)）在 POSIX 下会 `--ro-bind / /` 后 exec `cmd`。Electron 绝对路径在 `--ro-bind / /` 下可见，**无需改动**；但 `process.execPath` 在 macOS 是 `<App>.app/Contents/MacOS/<name>`，需确认 bwrap 只在 Linux 生效（[execute.ts:2582](../../../apps/executor-node/src/routes/execute.ts) 已 `win32` 抛错，Linux 无 Electron 打包，故实际不冲突）。

**Node 版本语义**：Electron 内置的 Node 版本可能高于/低于任务期望。**本期不引入 node 多版本**（与 CONTRACT NG-02 一致）；诊断面如实显示「node 来自 Electron 内置（vX.Y.Z）」。

### 4.2 P0-2：应用部署链接上解释器池（`routes/deploy.ts`）

**现状问题**：`deploy.ts` 对 python 的三处硬编码（0-3），且 `installDeps` 与 `startApp` 是**两段独立逻辑**，都可能落宿主。

**改动点**：

| 位置 | 改造 |
|---|---|
| [deploy.ts:301-316](../../../apps/executor-node/src/routes/deploy.ts) `installDeps` python 分支 | `pythonCmd` 改为 `(await resolvePythonForDeploy()).path`；**优先**复用池内解释器 + `uv venv --python <池内绝对路径>`，与 [execute.ts:1148-1187](../../../apps/executor-node/src/routes/execute.ts) `ensurePythonVenv` **同实现** |
| [deploy.ts:398-403](../../../apps/executor-node/src/routes/deploy.ts) `startApp` python 分支 | `fallback` 改为工具链解析结果；解析不出 → **抛错并明确指引**，不落 stub |
| 部署载荷 | 支持 `runtimeVersion`（**可选**，见 §4.5 决策点 D-3） |

**语义对齐要求**：`installDeps` 建的 venv 与 `startApp` 找的 venv 必须是**同一个**（现状都硬编码 `.venv`，一致）。改造后 venv 目录键需带版本签名（与 `venvDirName` 同规则），否则「声明 3.9 部署、后续无声明启动」会串版本。

**失败归类**：与 execute.ts 对齐，走 `interpreter_unavailable`（`prepareFailureReason` 已有该规则），并把结构化快照带进 `reportStatus` 的 `message`。

### 4.3 P0-3：Store stub 验真（显式失败）

**问题**：Windows 的 `python.exe` / `python3.exe` 是 Microsoft Store 的 App Execution Alias 占位文件——`spawn` 能命中（文件真实存在），实跑必失败（exit 9009），并打印那句英文。当前 [execute.ts:2014](../../../apps/executor-node/src/routes/execute.ts) 与 [deploy.ts:401](../../../apps/executor-node/src/routes/deploy.ts) 都**直接把它当解释器用**。

**改动**：所有「宿主解释器」候选在**采纳前**必须过 [`probePythonExecutable()`](../../../apps/executor-node/src/runtime-detection.ts)（实跑 `--version` 判 `status===0`）。该函数已存在、已有单测、[deploy.sh:305-311](../../../deploy.sh) 已验证同款判据有效。

**语义**：这不解决「能不能跑」，但把**无声的错误结果**变成**有声的明确失败**：

```
改造前：spawn python.exe → exit 9009 → 用户看到 Store 的英文提示（不知道谁在调 python）
改造后：prepare 阶段明确失败
        failureReason = interpreter_unavailable
        message = "本机没有可用的 Python（检测到 Microsoft Store 占位程序，非真实解释器）；
                   请给任务声明 runtimeVersion，或在执行器安装 Python 3.8+"
```

**建议连带修复**（同源，成本极低）：[runtime-detection.ts:104](../../../apps/executor-node/src/runtime-detection.ts) 的 `probePythonExecutable` 目前只判 `status === 0`。Store stub 的 `status` 是 **9009**（非 0）→ 已被正确判为不可用。**但要补一条回归测试锁死该行为**（见 §7 T-3），防止未来有人把判据放宽成「文件存在即可」。

### 4.4 P1-1/P1-2：自带默认解释器 + 激活 `defaultRuntimeVersion`

这是兑现 **G1/G3**（全新机器、断网可用）的核心。

#### 4.4.1 打包预置解释器

在 [bundle-executor.sh](../../../apps/executor-desktop/scripts/bundle-executor.sh) 增加一段，与既有 uv 逻辑**同构**（含 `ACF_*_REQUIRED` 硬闸先例）：

```bash
# 新增开关（与 ACF_BUNDLE_UV 同构）
ACF_BUNDLE_PYTHON=1          # 是否预置解释器
ACF_PYTHON_VERSION=3.12      # 预置版本（默认 3.12）
ACF_PYTHON_REQUIRED=1        # 发布闸：缺即 exit 1
ACF_UV_SOURCE=/path/to/uv    # 复用既有：用自带 uv 下载
```

实现方式**推荐用自带 uv 现场下载**（而非手工搬运 pbs 资产）：

```bash
UV_PYTHON_INSTALL_DIR="${PYTHON_DEST}" \
  "${UV_DEST}/uv" python install "${ACF_PYTHON_VERSION}"
```

优势：**目录名/平台三元组由 uv 自己生成**，天然避开 [CONTRACT §0.2](../../../docs/design/python-task-upload-and-multiversion/CONTRACT.md) 记载的「pbs 三元组 vs uv 三元组」静默失效坑（那是实测踩过的坑，手工搬运极易复发）。

落点：`resources/interpreters/`，经 `electron-builder.yml` 的 `extraResources` 出包（照抄 uv 的写法）。运行期由桌面端把它作为 `UV_PYTHON_INSTALL_DIR` 的**只读基线**。

#### 4.4.2 池目录的「基线 + 可写覆盖」双层模型

**这是本节最关键的设计点。** 现状 `UV_PYTHON_INSTALL_DIR` 单一目录（[uv-paths.ts:75-82](../../../apps/executor-desktop/src/main/uv-paths.ts) 默认 `<userData>/interpreters`），有两个矛盾：

- 预置解释器在**安装目录**（只读，升级会覆盖/卸载会删除）；
- uv 后续下载的解释器必须在**可写目录**（[uv-paths.ts:70-73](../../../apps/executor-desktop/src/main/uv-paths.ts) 已论证 Program Files 不可写）。

uv 不支持多个 `UV_PYTHON_INSTALL_DIR`（单值）。三个可选方案：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 首次启动播种**（推荐） | 安装包含只读基线 `resources/interpreters`；首次启动时**复制**到 `<userData>/interpreters`（已存在则跳过） | 逻辑简单、uv 零改动；代价是首次启动多占 ~60MB 磁盘 + 复制耗时。**必须在后台异步做**，不阻塞注册 |
| **B. 符号链接/junction** | `<userData>/interpreters` 里为基线条目建链接，指向安装目录 | 省磁盘；但 Windows junction + 升级卸载的边界情况多（[deploy.ts:877-924](../../../apps/executor-node/src/routes/deploy.ts) 有 EPERM 前车之鉴），风险高 |
| **C. 只读基线优先 + 探测合并** | 不改 uv，改**申报逻辑**：池快照 = 基线 ∪ 可写 | 不改 uv 装下载目标；但 uv 的 `--only-installed` 看不到基线，需自写合并逻辑，且「基线里有 → uv 能否用它建 venv」不确定 |

**推荐 A**：语义最简单、与既有「userData 可写」论证一致、不碰 uv 与 junction 的坑。落地细节：

```
首启（main 进程）：
  if (!fs.existsSync(userInterpretersDir) ||
      !hasBaseline(userInterpretersDir)) {
      copyBaselineAsync(resourcesPath/interpreters → userInterpretersDir)
  }
  // 后台执行、失败仅 warn（降级为"池里只有宿主/无"，不阻断启动）
```

#### 4.4.3 激活 `defaultRuntimeVersion`（需显式决策，见 §4.5 D-1）

**现状**：无版本 → 宿主解释器（FR-10 冻结）。

**期望**：无版本 → **池内默认版本**（桌面端）。

**实现**：桌面端在「无 `declaredVersion` 且无可用宿主解释器」时，回退到 `defaultRuntimeVersion`（3.12）→ 走既有 `ensureInterpreter('3.12')` → 池内已有（4.4.1 预置）→ **零下载、离线可用**。

这与 FR-10 冲突，故必须以「桌面端例外」表达：

```
F-1（容器）：无版本 → 宿主解释器（FR-10 原文，**一字不动**）
F-2（桌面）：无版本 → 宿主解释器（实跑验真通过）
                    → 否则池内 defaultRuntimeVersion
                    → 否则明确失败（interpreter_unavailable + 指引）
```

**关键**：F-2 的第二级只在**宿主解释器验真失败**（含不存在、含 Store stub）时触发，因此**已装 Python 的机器行为不变**，符合 P5（不推翻契约）。

#### 4.4.4 新增字段：能力细化上报（消除 §3.3 的语义模糊）

为如实表达「这台能跑声明版本任务、但跑不了无版本任务」这种中间态，**增量**上报一个可选字段（旧字段全保留，向后兼容）：

```ts
// register / heartbeat 载荷，新增可选字段
capabilityDetail?: {
  python: {
    /** 无版本任务能否立即跑（不联网、不下载）。 */
    defaultRunnable: boolean;
    /** 无版本任务实际会用哪个解释器（诊断用）。 */
    defaultInterpreter: string | null;
    /** 声明版本任务是否有下载能力（uv 可用）。 */
    versionedCapable: boolean;
    /** 池内已就绪版本。 */
    pool: string[];
  };
  node: { source: 'electron' | 'bundled' | 'host' | 'none'; version: string | null };
  git: { available: boolean; version: string | null };
};
```

admin 侧**本期只需落库 + 展示**（不参与派发决策，避免扩大改动面）；派发决策仍只看 `capabilities`。这符合 [CONTRACT §4 红线 8](../../../docs/design/python-task-upload-and-multiversion/CONTRACT.md)「新增字段全为增量（可空/可缺省），旧客户端零破坏」。

### 4.5 需显式决策的点（**不决策不得实施**）

| # | 决策点 | 选项 | 影响 |
|---|---|---|---|
| **D-1** | 无版本任务的语义（与 FR-10 冲突） | (a) 桌面端例外 F-2（推荐）；(b) 全局改语义（推翻 AC-10a）；(c) 不改，仅出诊断 | (b) 会改变**所有存量容器任务**行为（首次不再零下载、离线从能跑变跑不了），风险大 |
| **D-2** | 默认版本从哪来 | (a) 激活 `defaultRuntimeVersion`（推荐，本来就是为此预留的死字段）；(b) 硬编码 3.12 | (b) 会让 [interpreter-match.util.ts:52](../../../apps/admin-api/src/modules/executor/interpreter-match.util.ts) 的调度兜底常量与真实能力永久漂移 |
| **D-3** | 应用部署是否支持 `runtimeVersion` | (a) 本期加字段 + 迁移 + 表单（完整）；(b) 本期只让 deploy 用池内默认版本，不加声明能力 | (b) 能让应用跑起来（解决本次事故），但用户无法声明版本；(a) 是独立工作流，工作量翻倍 |
| **D-4** | 是否自带 git | (a) 本期不做，只做「如实探测 + 明确失败 + 指引」；(b) 自带 git（体积 +30~50MB/平台，跨平台分发复杂） | (b) 成本高，且 git 有纯 JS 替代（isomorphic-git）可评估 |
| **D-5** | 预置解释器的磁盘与升级策略 | (a) 首次启动播种（方案 A）；(b) junction（方案 B） | 见 §4.4.2 表 |

> **建议**：D-1 选 (a)、D-2 选 (a)、D-3 选 (b)、D-4 选 (a)、D-5 选 (a)。这套组合能以最小风险兑现 G1/G3/G4。

---

## 5. 实施分期

### 第一期：止血（P0，无契约冲突，可立即实施）

| 编号 | 任务 | 涉及文件 | 验收 |
|---|---|---|---|
| T-1 | node 复用 Electron + env 注入 | `routes/execute.ts`、`env-whitelist.ts`(如选 (a)) | 干净机器 node 任务成功；selftest 载荷性验证 |
| T-2 | 应用部署接解释器池 | `routes/deploy.ts` | 干净机器 python 应用部署成功 |
| T-3 | 宿主解释器验真（Store stub 拦截） | `routes/execute.ts`、`routes/deploy.ts`、`runtime-detection.ts` | stub 被明确拒绝，非静默；回归测试锁死 |
| T-4 | macOS PATH 补齐 | `src/main/executor-process.ts`（或新增 `shell-path.ts`） | macOS 上装了 Python 能被发现 |

**第一期不改契约、不加打包体积、容器零影响**。做完即解决本次事故（新机部署 python 应用）与最隐蔽的 node 虚报。

### 第二期：自包含（P1，需先决策 D-1/D-2/D-5）

| 编号 | 任务 | 验收 |
|---|---|---|
| T-5 | `ACF_BUNDLE_PYTHON` 打包预置 3.12 + 发布硬闸 | 安装包内含 `resources/interpreters/cpython-3.12.*`；`ACF_PYTHON_REQUIRED=1` 缺则 exit 1 |
| T-6 | 首启播种到 userData | 首次启动后台完成；失败降级不阻断 |
| T-7 | 桌面端无版本回退池内默认版本 | 断网新机无版本 python 任务成功（G3） |
| T-8 | 激活 `defaultRuntimeVersion` | 死字段有消费者；与调度兜底常量对齐 |
| T-9 | `capabilityDetail` 增量上报 + admin 落库展示 | 旧字段不变；旧客户端零破坏 |

### 第三期：可横向扩展（P2）

| 编号 | 任务 | 验收 |
|---|---|---|
| T-10 | 注册前真实冒烟：每 runtime 实跑，只上报通过的 | 人为藏起某个工具 → 该能力不上报（G2） |
| T-11 | `toolchain.ts` 单一真值源落地（探测与执行统一） | 反证：改解析器任一处，探测与执行同时变 |
| T-12 | 桌面端「能力自检」面板 | 装机后 5 秒看清每个 runtime 绿灯/红灯 |
| T-13 | 中台「执行器能力矩阵」视图 | 扩容时一眼看出哪台是残的 |
| T-14 | 自带 git / npm 方案评估 | 决策文档 |

---

## 6. 风险与反证

| # | 风险 | 说明 | 缓解 |
|---|---|---|---|
| **R1** | `ELECTRON_RUN_AS_NODE` 被 env 白名单剥掉 | [env-whitelist.ts](../../../apps/executor-node/src/env-whitelist.ts) 只放行白名单；该键**不在**其中。漏了则 Electron 以 GUI 模式启动、任务挂死 | 在 `execute.ts` 显式注入（不走白名单）；selftest 断言「spawn 前 env 里确有该键」 |
| **R2** | Electron 当 node 跑的**版本语义**与任务期望不符 | Electron 内置 Node 版本固定，任务可能有 engines 要求 | 诊断面如实显示版本；本期不做 node 多版本（与 NG-02 一致） |
| **R3** | `UV_PYTHON_DOWNLOADS=manual` 下无版本回退**不能**触发下载 | [uv-paths.ts:101](../../../apps/executor-desktop/src/main/uv-paths.ts) 硬设为 manual；若池内没有默认版本，回退会**失败而非下载** | 这正是 §4.4.1 必须预置 3.12 的原因；未预置时明确失败并指引（**不**改成 automatic——那会破坏 D8 加固语义） |
| **R4** | 预置解释器与 pbs/uv 目录名不匹配 → 静默失效 | [CONTRACT §0.2](../../../docs/design/python-task-upload-and-multiversion/CONTRACT.md) 实测坑 | 用 uv 自己 `python install` 生成目录（§4.4.1）；CI 断言 `uv python list --only-installed` 能列出 |
| **R5** | mac 的 `.app` 内 Electron 路径 + bwrap | bwrap 仅 Linux；mac 无此路径 | 确认 `buildTaskSandboxArgv` 的 win32 抛错分支不覆盖 darwin（当前 Linux-only 使用） |
| **R6** | 首启播种阻塞启动 | 复制 ~60MB | 后台异步 + 失败降级；不阻塞注册（对齐 AC-14b 纪律） |
| **R7** | 打包体积增长 | +~60MB/平台（解释器） | 属必要成本（G1 的前提）；release 体积红线需重新评估 |
| **R8** | `deploy.ts` 与 `execute.ts` venv 逻辑分叉 | 两处独立实现，易漂移 | 抽出共享 `ensurePythonVenv`（T-2 的隐含要求） |

### 反证清单（每条修复必须能被证伪）

- T-1：删除 `env['ELECTRON_RUN_AS_NODE']='1'` → 测试**必须转红**。
- T-3：把验真判据放宽为 `fs.existsSync` → Store stub 用例**必须转红**。
- T-7：清空预置池 → 断网无版本任务**必须失败且归类 `interpreter_unavailable`**（而非静默落宿主）。
- T-10：`PATH` 里移除 node → node 能力**必须不上报**（当前会虚报）。

---

## 7. 测试与验证

### 7.1 单元 / 组件测试

| # | 测试 | 要点 |
|---|---|---|
| T-1 | `execute` node 分支：桌面形态走 `process.execPath` + env 注入 | 断言 `cmd === execPath`、`env.ELECTRON_RUN_AS_NODE === '1'`；反证见 §6 |
| T-2 | `deploy` python 分支：走池内解释器而非宿主 | 断言 argv 含 `--python <池内绝对路径>`；宿主被 stub 时不采纳 |
| T-3 | **Store stub 载荷性用例** | 注入 `status=9009` 的假 python → 判不可用 + 归类 `interpreter_unavailable` |
| T-4 | mac PATH 解析 | 注入空 PATH + 模拟 login shell 输出 → 解析成功 |
| T-5 | 预置池识别 | 假池目录 → `discoverInstalled()` 列出；`resolvePythonBin('3.12')` 命中 |
| T-6 | 无版本回退链 | 宿主不可用 → 池内 3.12 → 命中；池空 → 明确失败 |
| T-7 | `capabilityDetail` 增量与旧字段兼容 | 旧字段逐字节不变；旧客户端不受影响 |
| T-8 | 桌面/容器分支隔离 | 容器形态（无 `versions.electron`）走原路径，逐字节不变（保 G5） |

### 7.2 端到端验收（**必须在干净机器上**）

这是本次事故的教训——**不能再拿装了全套工具链的开发机验收**。

| # | 场景 | 判据 |
|---|---|---|
| E-1 | **干净 Windows 快照**（无 Python/Node/git）→ 装客户端 → 中台部署 python 应用 | 部署成功（覆盖本次事故） |
| E-2 | 同上 → 派**无版本** python 任务 | 成功（G1） |
| E-3 | 同上 → 派 node 任务 | 成功（G1） |
| E-4 | 同上 + **断网** → 派无版本 python 任务 | 成功（G3） |
| E-5 | 同上 + 断网 → 派声明 3.13 的任务（池内无） | **明确失败** + 可读指引（不静默） |
| E-6 | **干净 macOS**（Finder 启动）→ 派 python 任务 | 成功（T-4 验证） |
| E-7 | 两台干净机器同装 → 对比 `capabilities` 与 `capabilityDetail` | **完全一致**（G4） |
| E-8 | 既有容器执行器全量测试 | 全绿，**零行为变化**（G5） |

> **建议**：把 E-1~E-4 纳入 CI 的 `desktop-e2e` 或发布前人工清单；「干净机器」可通过容器/VM 快照固定，避免再次靠开发机掩盖。

### 7.3 守卫（防回归）

| # | 守卫 | 目的 |
|---|---|---|
| G-a | 源码守卫：`deploy.ts` 出现 `python -m venv` 字面量 → 失败 | 防有人改回宿主 venv |
| G-b | 源码守卫：`execute.ts` 的 node 分支出现裸 `'node.exe'` 且无工具链解析 → 失败 | 防 T-1 被重构掉 |
| G-c | 打包守卫：发布包含 `resources/interpreters/`（有非空断言） | 同 uv 的 `ACF_UV_REQUIRED` 先例 |
| G-d | 契约守卫：容器路径（无 electron）的 argv/目录键哈希不变 | 保 G5 |

---

## 8. 与既有契约的关系

| 契约条目 | 是否冲突 | 处理 |
|---|---|---|
| FR-10（无版本 → 宿主解释器，不下载） | ⚠️ **冲突**（桌面端） | 以 F-2 桌面端例外表达，**不改 FR-10 原文**；需决策 D-1 |
| CONTRACT §4 红线 1/6（无版本逐字节不变） | ⚠️ 同上 | 限定「**容器侧**逐字节不变」，桌面端新增分支 |
| CONTRACT §4 红线 5（`/api/deploy` 契约不变） | ✅ 不冲突 | deploy 改造只换内部解释器来源，载荷契约不变（除非采纳 D-3(a)） |
| CONTRACT §4 红线 8（新增字段增量） | ✅ 不冲突 | `capabilityDetail` 为可选增量字段 |
| NG-02（不做 node 多版本） | ✅ 不冲突 | 本期仍不做 |
| D8（venv 阶段绝不隐式下载） | ✅ **必须保留** | 无版本回退到池内默认版本**不触发下载**；池空即失败 |
| D14（明确失败，不回退宿主） | ✅ 强化 | 验真失败即明确失败，比现状更严 |

---

## 9. 交付门禁

1. 第一期全部测试通过 + 反证验证（§6）/ 端到端 E-1~E-3、E-8；
2. `npm run typecheck:all` + `lint:all` 通过；
3. 无 TODO / 无静默吞异常；
4. 容器执行器既有测试全绿（G5 硬门禁）；
5. 汇报格式：改动文件清单 + 测试命令与结果 + 未决风险；
6. **文档同步**：`apps/executor-desktop/README.md`（前置要求从「需要宿主 Python」改为「自带默认解释器」）、`docs/deployment.md` §解释器缓存、`docs/atlas/01-apps/executor-desktop/`、以及 [docs/windows-findings.md](../../../docs/windows-findings.md) 补本条（Store stub 在**任务/部署链**的复发）。

---

## 10. 附录：本次事故的完整因果链

```
用户操作：全新 Windows 电脑装客户端 → 中台部署 1 个应用（runtime 缺省 python）
        ↓
中台派发：/api/deploy → 应用 runtime = "python"（application.controller.ts:487 缺省）
        ↓
执行器：routes/deploy.ts installDeps()
        ├─ 包内无 requirements.txt → 跳过建 venv（deploy.ts:303）
        └─ startApp() → fallback = 'python'（deploy.ts:401）
        ↓
spawn('python') → 命中 WindowsApps 的 Store 占位 stub（非真实解释器）
        ↓
exit 9009 + 打印：
  "Python was not found; run without arguments to install from the Microsoft Store,
   or disable this shortcut from Settings > Apps > Advanced app settings >
   App execution aliases."
        ↓
用户看到：部署失败 + 一句看起来"应该去装 Python"的英文提示
        ↓
用户困惑：「不是内置 python3.12 吗？」——因为：
  · 「3.12」只是调度兜底常量（interpreter-match.util.ts:52），不产生安装行为
  · 安装包只自带 uv（README.md:182），不含 Python 本体
  · package 内的 uv 在**整条 deploy 链里一次都没被调用**（grep -c uv = 0）
```

**同源未爆点**（同一根因、尚未在新机触发）：node 任务虚报（0-5）、应用部署无 `runtimeVersion`（0-13）、git/npm 宿主依赖（0-15/0-16）、macOS GUI PATH（0-17）。

# 跨端契约单一事实源（contract-source）

> **角色**：Round 2 契约源域 —— 把「跨端契约」从**注释里的承诺**变成**可执行的单一事实源**。
> **受众**：主Agent（Round 2 决策）· **状态**：一次性记录
> **测量窗口**：2026-11-03 02:42 → 09:20（Asia/Shanghai）
> **写域**：`packages/executor-protocol/**`、`packages/contract-fixtures/**`、`scripts/check-*.mjs`（新建 2 个 + 改 2 个）、`scripts/generate-failure-classifiers.mjs`（新建）、`package.json`、`.github/workflows/ci.yml`、本文件。
> **未改动**：`apps/admin-api/**`、`apps/admin-web/**`、`apps/executor-*/**`（本轮一律**只读**）。

---

## §1 protocol.json 改造前后 diff 语义说明（码值集合不变证明）

### 1.1 改了什么

`failureReason` 段从「三个 `string[]`」变成「**一张元数据表 + 两个机械投影 + 一个分类器契约**」：

| | 改造前 | 改造后 |
|---|---|---|
| 码集合 | `all: string[]`（15 项） | `all: {code, zh, en, remediationKey, owner, reportable}[]`（15 项） |
| 可上报口径 | `executorReportable: string[]`（手写第二份） | `executorReportable` **降级为 `all` 的投影**（`reportable=true` 的子集） |
| 内部专用 | `adminInternalOnly: string[]`（手写第三份） | 同上（`reportable=false` 的子集） |
| 用户可见标签 | admin-web `FAILURE_REASON_T_KEYS`（手抄） | `all[].zh` / `all[].en`（**契约侧唯一**） |
| 处置提示 key | admin-web `locales` 里的 `…Hint`（手写） | `all[].remediationKey`（= `execDetail.failure.<camel(code)>Hint`，**可机械生成**） |
| 责任方 | **不存在** | `all[].owner`（`task-author` / `platform-ops`，取值域封闭） |
| 分类判据 | 三份手写正则（admin 7 条 / node 10 条 / python 9 条） | `failureReason.classifiers`（14 条规则 + 受控子集） |

### 1.2 码值集合不变证明（三重）

**证 1 —— 逐值逐序比对（`git show HEAD~1:packages/executor-protocol/protocol.json`）**

```text
旧 all[]: package_fetch_failed, script_error, timeout, executor_offline,
          executor_restart, stale_recovered, dependency_install_failed,
          git_fetch_failed, runtime_missing, sandbox_unavailable,
          interpreter_unavailable, killed, unknown, application_missing,
          never_dispatched
新 all[].code: （同上，顺序逐字相同，15/15）
```

**证 2 —— 机械判定（`scripts/check-protocol-breaking.mjs` 的基线 diff）**
基线是「上一版 protocol.json 的**快照**」，跑一次：

```text
变更 0 条：breaking 0 / 需人审 0 / 其余 0
protocol breaking-change check OK
```

⇒ 码值集合变化、码表形态变化、schema 变化，**一条都没有**。

**证 3 —— 既有守卫的四方比对**（`scripts/check-failure-reasons.mjs`，码集合抽取改成 `.code`）

```text
OK   protocol: all minus adminInternalOnly === executorReportable  (12)
OK   protocol: !reportable (per-entry) === adminInternalOnly  (3)
OK   protocol: all.owner ⊆ ownerValues  (2)
OK   protocol: remediationKey === `execDetail.failure.<camel(code)>Hint`  (15)
OK   protocol: all.code 唯一  (0)
OK   protocol: all.remediationKey 均存在于 admin-web locales/zh.ts  (0)
OK   protocol: all.zh === admin-web locales/zh.ts 标签  (15)
OK   protocol: all.remediationKey 均存在于 admin-web locales/en.ts  (0)
OK   protocol: all.en === admin-web locales/en.ts 标签  (15)
OK   admin ExecutionFailureReason === protocol.all  (15)
OK   autoflow-sdk VALID_FAILURE_REASONS === protocol.executorReportable  (12)
OK   executor-node CALLBACK_FAILURE_REASONS === protocol.executorReportable  (12)
```

### 1.3 为什么不 bump protocolVersion

`versioning.evolutionRules` 第 1/2 条约束的是**线缆/载荷形状与语义**：

> 第 1 条：新增**可选**字段且旧端可忽略时：仍需 bump protocolVersion
> 第 2 条：任何**不向后兼容**的改动（删字段/改语义/改枚举）：必须同时 bump $schemaVersion 与 protocolVersion

本轮改造是**文档侧元数据**：

* 执行器**不上报**它（线上载荷一个字节没变）；
* 中台**不校验**它（`ExecutionFailureReason` 枚举的取值集合逐字未变）；
* `adminInternalOnly` / `executorReportable` 的**值集合**也逐字未变（只是从「手写第三份」变成「机械投影」）。

⇒ 按规则**不该** bump。若码值增删，则 `check-protocol-breaking.mjs` 会自动产出 `protocol-version-not-bumped` 这条 breaking（实测：删一个码 + 不 bump → 三条 breaking 同时亮，见 §4.4）。

### 1.4 元数据来源（本轮新增的「事实」）

`zh` / `en` 不是新造的 —— 逐字取自 admin-web 已有的 i18n：

| code | zh | en | owner |
|---|---|---|---|
| package_fetch_failed | 包拉取失败 | Package fetch failed | task-author |
| script_error | 脚本错误 | Script error | task-author |
| timeout | 执行超时 | Execution timeout | task-author |
| executor_offline | 执行器离线 | Executor offline | platform-ops |
| executor_restart | 执行器重启 | Executor restarted | platform-ops |
| stale_recovered | 失联回收 | Stale recovered | platform-ops |
| dependency_install_failed | 依赖安装失败 | Dependency install failed | task-author |
| git_fetch_failed | Git 拉取失败 | Git fetch failed | task-author |
| runtime_missing | 运行时缺失 | Runtime missing | platform-ops |
| sandbox_unavailable | 沙箱不可用 | Sandbox unavailable | platform-ops |
| interpreter_unavailable | 解释器不可用 | Interpreter unavailable | platform-ops |
| killed | 手动终止 | Manually killed | platform-ops |
| unknown | 未知原因 | Unknown reason | platform-ops |
| application_missing | 引用的应用已删除 | Referenced application deleted | task-author |
| never_dispatched | 从未派发 | Never dispatched | platform-ops |

`owner` 的判据是「**处置动作落在谁的可控范围内**」：任务代码/仓库/依赖/参数 ⇒ `task-author`；执行器主机/运行时/沙箱/调度/网络 ⇒ `platform-ops`。⚠️ 它是**给用户看的「我该找谁」**，不是内部团队名。

---

## §2 生成器工作方式 + 三端落点（含他人写域的精确 patch 清单）

### 2.1 两个生成器，职责不重叠

| 生成器 | 输入 | 输出 | 纪律 |
|---|---|---|---|
| `scripts/generate-executor-protocol.mjs`（**既有**，未改） | `protocol.json` 的 `schemas` 段 | `apps/executor-node/src/generated/protocol.schemas.ts`（zod）<br>`apps/executor-python/generated/protocol_schemas.py`（pydantic） | 受控子集外关键字**报错退出**；CI `executor-protocol-drift` job 用 `git diff --exit-code` 兜底 |
| `scripts/generate-failure-classifiers.mjs`（**本轮新建**） | `protocol.json` 的 `failureReason.classifiers` 段 | `packages/contract-fixtures/generated/failure-classifier.{mjs,py,ts}` | 同款纪律：**碰子集外构造硬拒**；生成后**自校验**（两侧真跑向量） |

### 2.2 本轮生成器的工作方式（关键四点）

1. **受控子集硬拒**：契约的 `alternatives` 里若出现 `\b` / `$` / lookbehind / `\d\w\s` / `\p{}` / 裸句点 / 反斜杠转义 → **报错退出**，不静默放行。
   *为什么必须硬拒*：向量只覆盖**已知**文本；一个坏构造可能对全部向量都恰好等价，却对未见文本不等价。**结构禁令是唯一能覆盖未见输入的判据**。
2. **token 展开**：`{{WORD}}` → `[A-Za-z0-9_]`、`{{NONWORD}}` → `[^A-Za-z0-9_]`、`{{ANY_ONE_LINE}}` → `[^\n]`（**显式 ASCII 字符类**，不是 `\w`、不是 `\b`）。
3. **归一（两侧逐字同构）**：拼接 → **ASCII 小写化**（只 A-Z→a-z，**不用** `toLowerCase()`）→ **astral 折叠**（码点 > U+FFFF → U+FFFD）。
   *为什么 ASCII 小写*：JS `toLowerCase()` 与 Python `str.lower()` 都按 Unicode Default Case Conversion，但**不是**逐字同义（实测 `ſ`→`s`、`K`(U+212A)→`k` 在两侧不同），且 Unicode 小写化会**改变长度**——长度一变就与 `{n,m}` 计数耦合。
   *为什么 astral 折叠*：JS 的 `{n,m}` 按 **UTF-16 code unit** 计数、Python 按 **code point** 计数。实测 `a[^\n]{0,3}b` 对 `a😀😀b` 在 **JS 不命中 / Python 命中** ⇒ 同一 `{0,N}` 在两侧覆盖不同长度。折叠成单码点的 U+FFFD 后，两侧计数单位一致。
4. **sentinel 代替词边界**：匹配前在文本首尾各补一个 `U+0001`，于是 `{{NONWORD}}token{{NONWORD}}` 在串边界处也成立（等价于 JS 的 ASCII `\b`），Python 侧**不需要** `re.ASCII`。

### 2.3 三端落点（本轮**不落盘**，只产出生成逻辑）

**落点判断**：三份分类器是「同一个判据的三种语言实现」，必须**逐字等价**才有意义。若分别生成到 `apps/executor-node/src/`、`apps/executor-python/`、`apps/admin-api/src/`：

* 那三个路径**都是他人的写域**（本轮并行会话正在改 admin-api / admin-web）；
* 三份生成物各自漂移时，**没有任何一个地方能同时看到三份** ⇒ 跨语言一致性无法被机械验证。

⇒ **落点 = `packages/contract-fixtures/generated/`**（三端共同依赖、单一写域、契约包内）。各 app 的落地退化为「引入这份生成物」的一行 import。

### 2.4 【他人写域】精确 patch 清单

> ⚠️ **本轮不执行**（写域属他人 / 下一轮迁移范围）。以下精确到文件与行，供主Agent 协调。

**① `apps/executor-node/src/routes/execute.ts`**（替换 `prepareFailureReason`，第 855–971 行）

```ts
// ① 顶部加 import（该文件第 60 行附近已有 protocol.schemas 的 import 形态，照抄）
import {
  classify as classifyFailureText,
  FALLBACKS as CLASSIFIER_FALLBACKS,
} from "../../../../packages/contract-fixtures/generated/failure-classifier.mjs";
// ⚠️ 路径需按 executor-node 的 tsconfig rootDir 调整；packages/ 不在 executor-node 的
//    include 范围（tsconfig.json 的 include 是 ["src/**/*"]）⇒ **必须先解决跨包 import**
//    （方案：把生成物复制进 apps/executor-node/src/generated/，由生成器多产一份 ——
//     本轮刻意没做，因为那会让「单一生成物」变成两份，破坏跨语言可验证性）。
//
// ② 函数体（第 855 行的 export function prepareFailureReason ... 到第 971 行的 return 'unknown'）
//    整段替换为：
export function prepareFailureReason(message: string): CallbackFailureReason {
  // 单一事实源：packages/executor-protocol/protocol.json 的 failureReason.classifiers 段。
  // 顺序即规格（contract 的 order 升序），首个命中者给出码。
  // 与 python _refine_failure_reason 的等价性由 scripts/check-failure-classifiers.mjs
  // 在**两语言真跑**同一批向量后断言（不再是注释里的 parity 承诺）。
  return (
    classifyFailureText([message], "executor") ?? (CLASSIFIER_FALLBACKS.executor as CallbackFailureReason)
  );
}
```

**② `apps/executor-python/routers/execute.py`**（替换 `_refine_failure_reason`，第 570–716 行）

```python
# ① 顶部加 import（约第 20 行的 import 区）
from generated.failure_classifier import classify as classify_failure_text  # 路径按实际生成物位置调整
# ⚠️ 同 ① 的跨包问题：packages/contract-fixtures/generated/failure-classifier.py 不在
#    apps/executor-python 的 sys.path 上 ⇒ 需在打包配置里把它并进 generated 包，
#    或由生成器多产一份到 apps/executor-python/generated/（与 ① 同一个权衡）。
#
# ② 函数体（第 570 行 def _refine_failure_reason(message: str) -> Optional[str]: 到第 716 行 return None）
#    整段替换为：
def _refine_failure_reason(message: str) -> Optional[str]:
    """失败分类（单一事实源）。

    来源：packages/executor-protocol/protocol.json 的 failureReason.classifiers 段。
    与 node prepareFailureReason 的等价性由 scripts/check-failure-classifiers.mjs
    在两语言真跑同一批向量后断言。
    """
    if not message:
        return None
    return classify_failure_text([message], "executor")
```

**③ `apps/admin-api/src/common/failure-classification/failure-patterns.ts`**（**只读，不改**）

**本轮发现（必须如实报告）：生成物与 admin 现状**行为不等价**，共 5 处：

| # | admin 现状 | 契约目标态 | 差异性质 | 证据 |
|---|---|---|---|---|
| a | admin 的 `classifyFailure` 有 `exitCodeNonZero` 判据（非 0 即 `script_error`） | 契约 `criteria.exitCodeNonZero` **保留**该判据（admin 阶段） | 一致（生成物目前**未实现**该判据 ⇒ **落点时必须补**） | `failure-patterns.ts` 第 ⑧ 步 |
| b | admin 走 `classifyFailureByCode` 码化优先通道 | 契约**未建模**该通道 | **差异**：码化优先不依赖文本，契约的文本分类器管不到 | `failure-patterns.ts` `ERROR_CODE_FAILURE_REASON` |
| c | admin 的 `EXECUTOR_OFFLINE_PATTERN` 含 `\beconnrefused\b` / `\benotfound\b` | 契约用 sentinel + `{{NONWORD}}` | **等价**（本仓实测：sentinel 保留 ASCII 词边界语义，Python 侧不需要 `re.ASCII`） | — |
| d | admin 的 `SCRIPT_ERROR_PATTERN` 在**最后** | 契约 `script_error` order=99（最后） | 一致 | — |
| e | admin 的 `SANDBOX_UNAVAILABLE_PATTERN` **刻意不收**裸 `sandbox` / `\bsandbox\b` | 契约取 admin 集合为基线 | 一致（契约**收窄**了 node/python） | — |

⇒ **落点时 admin 侧必须补 (a) 与 (b)**：生成物只实现了**文本**分类，`exitCodeNonZero` 与码化优先两条通道需留在 admin 侧（或补进生成物）。**我在本轮没有改动 admin 侧任何文件**（写域属他人），也没有偷偷改生成物去迁就它。

**④ `apps/admin-web/src/utils/failure-reason-label.ts`**（生成 `FAILURE_REASON_T_KEYS`，第 22–44 行）

```ts
// 当前是 15 行手抄映射（码 → i18n key）。
// 目标：由 packages/executor-protocol/protocol.json 的 failureReason.all[].remediationKey
//       机械生成（标签 key = remediationKey 去掉尾部 "Hint"）。
// 生成逻辑已在本轮落地为 scripts/check-failure-reasons.mjs 的断言：
//   「protocol: remediationKey === `execDetail.failure.<camel(code)>Hint`」  —— 该判据已绿，
//   ⇒ 只要把 FAILURE_REASON_T_KEYS 改成从契约读（或用同一生成器产一份），
//      「码元数据改了但读面没改」会立刻变红（现有判据已能抓住）。
// ⚠️ admin-web 侧建议用 openapi-typescript 同款范式：单一源 → 生成 → git diff --exit-code 兜底。
```

**⑤ `apps/admin-web/src/locales/{zh,en}.ts`**（`execDetail.failure.*` 与 `…Hint`）

现状已与 `protocol.json` 的 `zh`/`en` **逐字一致**（守卫实测绿：`all.zh === locales/zh.ts 标签 (15)`、`all.en === locales/en.ts 标签 (15)`）⇒ **无需改动**。将来新增码时，守卫会同时抓住「契约加了但 locales 没加」。

---

## §3 共享向量与三端一致性验证

### 3.1 向量落点

`packages/contract-fixtures/contract.json` 新增 `failureClassification` 段（33 条向量，append-only）。该文件是仓内**既有的跨端共享向量**载体（QA-07 建立的，四个客户端包 + 两个执行器都加载同一份），故新向量沿用同一机制。

### 3.2 向量的语义

每条：`{ id, parts, expected: {executor, admin}, $note }`

* `executor` = 执行器阶段（node `prepareFailureReason` / python `_refine_failure_reason` 的未来落点）；返回 `null` = 「我不知道，交给中台」。
* `admin` = 中台阶段（admin `classifyFailure` 的未来落点）；永远返回一个码。

**核心不变量 = 重叠域一致（overlap agreement）**：
> ∀ text：executor 阶段答出的码（非 null）必须 == admin 阶段对同一 text 答出的码。

这条不变量**此前从未被验证过** —— 三端各有一份手写正则，只有注释互指（`见 node execute.ts:855 parity`）。它正是长期漂移的那一条。

### 3.3 向量**包含目标态**（尚未落地的差异也已钉住）

凡当前三端判据不一致的文本，`expected` 写的是**目标态**，并在 `$note` 里注明现状差异与登记 id。守卫以 **known-divergence 模式**运行：现状与目标不一致的那些**登记在案、不判红**，但**必须逐条登记**；其余向量必须逐条相等。

33 条向量的分类覆盖：

| 类别 | 条数 | 代表 |
|---|---|---|
| interpreter_unavailable | 6 | uv 原文案、**全角括号**（本仓自己抛的中文化异常）、语序反 |
| timeout | 2 | `任务执行超时（600s）`（执行器骨架） |
| git_fetch_failed | 3 | `git clone failed`、`'git' returned non-zero`、**阶段超时** |
| dependency_install_failed | 3 | `npm install failed`、`uv venv timed out`、中文 |
| runtime_missing | 3 | `spawn uv ENOENT`、**泛化的 No such file**（收窄判据）、中文 |
| package_fetch_failed | 3 | zip 渠道、**连写 `modulenotfounderror`**、`Invalid npm package name` |
| executor_restart | 2 | 英文 + 中文 |
| sandbox_unavailable | 5 | 结构化 token、二进制名、中文、**python 独有的 `task_launcher`** |
| application_missing | 1 | admin 内部专用码 ⇒ executor 必须返 `null` |
| executor_offline | 2 | 中文、**`ENOTFOUND` 词边界** |
| script_error | 2 | traceback、中文 |
| 兜底 | 2 | 无关文本、空串 |

### 3.4 三端一致性验证（原始输出）

**跨语言等价**（node 进程 vs python3 进程，两份生成物**真跑**）：

```text
向量 33 条，跨语言一致 33 条；现状判据 admin 7 / node 10 / python 9 条（未抽到 admin 0 / node 0 / python 1 条）
failure-classifier consistency OK
```

生成器自身的自校验（同一条判据，在**每次生成**时跑）：

```text
classifiers 生成完成：14 条规则（executor 11 / admin 12）
✔ 跨语言一致性自校验通过：33 条向量，node 与 python 逐条相等且符合契约期望
```

**现状三端的真值**（守卫的**模拟器**算出来的，不是人读注释）：

| 向量 | admin | node | python |
|---|---|---|---|
| `git-failed`（`git clone failed: exit 128`） | `package_fetch_failed` | `git_fetch_failed` | `git_fetch_failed` |
| `dep-npm-install-failed` | `package_fetch_failed` | `dependency_install_failed` | `null` |
| `runtime-spawn-enoent` | `unknown` | `runtime_missing` | `runtime_missing` |
| `pkg-invalid-npm-name` | `unknown` | `package_fetch_failed` | `null` |
| `app-missing` | `application_missing` | `package_fetch_failed` | `package_fetch_failed` |
| `offline-zh` | `executor_offline` | `unknown` | `null` |
| `restart-en` | `unknown` | `executor_restart` | `executor_restart` |
| `script-traceback` | `script_error` | `unknown` | `null` |
| `task-launcher-zh` | `unknown` | `unknown` | `sandbox_unavailable` |

⇒ **实测确认了三条历史差异**：① python 多一条 `task_launcher`（node 零命中）；② node 用 `\b` 而 python 不用（导致 `modulenotfounderror` 在两侧分因不同）；③ node 兜底 `unknown` / python 兜底 `null`（同义异形）。

**模拟器与真实 python 实现的一致性验证**（防止抽取器失真 ⇒ 假绿）：

```text
# 直接调 apps/executor-python/routers/execute.py::_refine_failure_reason
'npm install failed: exit 1'                      -> None
'pip install failed'                              -> dependency_install_failed
'uv pip install failed'                           -> dependency_install_failed
'dependency installation failed'                  -> dependency_install_failed
'依赖安装失败'                                     -> dependency_install_failed
'No interpreter found for Python 3.7 in managed…' -> interpreter_unavailable
'Traceback (most recent call last):'              -> None
```

⇒ 与模拟器输出**逐条一致**（`npm install failed` → python 侧 `null`，模拟器也是 `null`）。

---

## §4 两条守卫设计与读数

### 4.1 守卫一：协议破坏性变更（`scripts/check-protocol-breaking.mjs`）

**问题**：`versioning.evolutionRules` 有 4 条**文字规则**，**无机械执行**。

**判据语义**（借鉴 oasdiff / buf breaking，**零依赖自研**）：

* oasdiff（Apache-2.0）的三级严重度 ERR / WARN / INFO 与 `--fail-on` 闸；
* buf breaking（Apache-2.0）的规则名：`FIELD_NO_DELETE` / `FIELD_SAME_TYPE` / `ENUM_VALUE_NO_DELETE` / `MESSAGE_SAME_REQUIRED_FIELDS` / `FIELD_SAME_DEFAULT` / `FIELD_SAME_NAME`。
* **取 buf 的 `WIRE_JSON` 档**（不是 `WIRE`）：buf 的 `FIELD_WIRE_COMPATIBLE_TYPE` 与 `FIELD_WIRE_JSON_COMPATIBLE_TYPE` 是**并列**的两条规则（int→long 在 WIRE 兼容、在 JSON 破坏）⇒ 本仓是 JSON 线缆，选 WIRE 档会漏判。

**三级分类**：

| 级 | 含义 | 判红 | 覆盖 |
|---|---|---|---|
| `breaking` | 旧端产出的载荷在新契约下**不再合法** | **必红**（除非显式豁免） | 删顶层 schema / 删字段 / 删必填 / 加必填 / 类型收窄 / enum 删值 / enum 加值 / **enum 从无到有（值域收窄）** / `additionalProperties` true→false / minimum/maximum 收紧 / 码表删码 / 可上报口径收紧 / **码表变了却没 bump protocolVersion** |
| `needs-review` | 字节/形状不变但**语义**可能变 | 不自动红，列进 `--report` | `default` 变更（未提供时取什么变了）/ `pattern` 变更（正则等价性不可判定）/ `owner` 变更 |
| `compatible` | 纯增量或放宽 | 放行 | 新增可选字段 / 新增顶层 schema / 删必填（降为可选）/ 放宽 / enum 移除 / `description`/`$comment` 变更 |

**基线**：不是「当前 protocolVersion」，而是**上一版 protocol.json 的快照**（`scripts/protocol-breaking-baseline.json`）—— 版本号只说「动了几版」，快照说「**动了什么**」（后者才是破坏性判据需要的粒度）。`--update-baseline` 显式承认。

**豁免**：`--acknowledge <id>:<理由>` + `scripts/protocol-breaking-acknowledgements.json`（只增不删、**理由必填**）。借 oasdiff 的 `--err-ignore` 形态，但**要求理由**（本仓纪律：豁免必须可证）。

**读数（真实仓库上的一次实证）**：

```text
# 人为删一个 schema 字段 + 删一个码，不 bump 版本：
FAIL breaking：ENUM_VALUE_NO_DELETE @ failureReason.all
     actual  : failure-code-removed:killed — 失败原因码 killed 被删除 —— 旧执行器仍会上报它 ⇒ 回调被 @IsIn 拒（整批丢失）。
FAIL breaking：ENUM_VALUE_NO_DELETE @ failureReason.executorReportable
     actual  : failure-reportable-removed:killed — killed 从可上报集合移除 —— 仍在上报的旧执行器会被拒。
FAIL breaking：MESSAGE_SAME_PROTOCOL_VERSION @ versioning.currentProtocolVersion
     actual  : protocol-version-not-bumped — 失败原因码表的值集合变了但 protocolVersion 未变（仍 9）—— 违反 evolutionRules 第 2 条。

变更 3 条：breaking 3 / 需人审 0 / 其余 0
```

**自检 12/12**：① 无变更绿｜② 删字段红｜③ enum 删值红｜④ enum 加值红｜⑤ 新增必填红｜⑥ 删顶层 schema 红｜⑦ 类型收窄红｜⑦b enum 从无到有红｜⑧ 码表删码红｜⑨ 码表变未 bump 红｜⑩ default 变更不红｜⑪ 豁免形态。

### 4.2 守卫二：knownDivergence 登记完整性（`scripts/check-failure-classifiers.mjs`）

**判据不是朴素的「防增长」**。朴素判据（条目数不得增加）会**逼人把差异藏起来**（不登记 ⇒ 算作「没差异」）。真实判据是 **Pact 的形态**：

> **消费者声明的差异必须被显式登记，且登记必须被证明仍然存在。**

四层判据：

1. **跨语言等价**：两份生成物**真跑**（node 进程 + python3 进程），逐条比对 + 比对契约 `expected`。
2. **现状差异必须登记**：从三端**现状**判据（admin `classifyFailure` / node `prepareFailureReason` / python `_refine_failure_reason`）**静态抽出正则与分支顺序**，在 node 里**模拟** ⇒ 「同一段文本三端给出什么码」是**可计算**的（不是靠人读注释）。测出的差异若没在 `divergenceRegistry` 里 ⇒ 红。
3. **登记必须可证**（按 `kind` 分流）：
   * `kind: "classifier"` —— 带 `probe`（文本 + 各端期望码）。probe 的模拟结果 ≠ 期望 ⇒ **僵尸登记** ⇒ 红（逼人清理登记与基线）。
   * `kind: "capability"` —— 带 `verify`（`file` + `mustContain`）。守卫**真读该文件**并断言标记串仍在 ⇒ 证据被改掉 ⇒ 红。
4. **棘轮**：`scripts/failure-classifier-divergence-baseline.json` 记着登记 id 集合。
   * 新增登记 ⇒ 必须显式更新基线 ⇒ 否则红（**增长也要报**）；
   * 基线里有、登记里没有 ⇒ 红（**消失也要报**）—— 差异被修掉必须**显式**地减少（改代码 + 改基线两步走），不能靠「忘了登记」蒙混。

**三字段必填**：`reason`（这条差异**为什么存在**）/ `owner`（**谁负责修**）/ `status`（`open` 待修 / `accepted-by-design` 有意如此）。缺任一 ⇒ **结构红**。

**为什么用「静态抽出 + 模拟」而不是「直接 import 三端实现」**：admin 侧的 `classifyFailure` 依赖 `task-execution.entity.ts`（TypeORM 装饰器），实测 ts-node 直接加载会因装饰器签名解析失败 ⇒ 引入编译期依赖会让守卫跑不起来（守卫必须零依赖、秒级、CI 可跑）。抽取的已知边界写在脚本头的 `EXTRACTION_LIMITS` 里（**不假装覆盖**）：admin 的 `exitCodeNonZero` 判据、admin 的码化优先通道、运行期 bwrap 启动失败（独立入口）、以变量拼出的正则。

**读数**：

```text
OK   生成物无漂移（generate-failure-classifiers --check）
OK   生成物 …/failure-classifier.mjs 的规则体不含禁用构造 \b
OK   生成物 …/failure-classifier.mjs 的规则体不含禁用构造 \A/\Z
OK   生成物 …/failure-classifier.mjs 的规则体不含禁用构造 lookbehind
OK   生成物 …/failure-classifier.mjs 的规则体不含禁用构造 \d/\w/\s
OK   生成物 …/failure-classifier.mjs 的规则体不含禁用构造 \p{…}
OK   生成物 …/failure-classifier.py 的规则体不含禁用构造 \b
（… py 侧同样 5 条全绿）
OK   登记可证（probe 仍复现该差异）：CLS-01@sandbox_unavailable@node
OK   登记可证（probe 确实制造差异）：CLS-01@sandbox_unavailable@node
（… 21 条登记 × 2 条判据全绿）
OK   现状差异已登记（code=git_fetch_failed，向量 git-failed）：{"admin":"package_fetch_failed","node":"git_fetch_failed","python":"git_fetch_failed"}
OK   现状差异已登记（code=dependency_install_failed，向量 dep-npm-install-failed）：{"admin":"package_fetch_failed","node":"dependency_install_failed","python":null}
OK   现状差异已登记（code=runtime_missing，向量 runtime-spawn-enoent）：{"admin":"unknown","node":"runtime_missing","python":"runtime_missing"}
OK   现状差异已登记（code=package_fetch_failed，向量 pkg-download-failed）：{"admin":"unknown","node":"package_fetch_failed","python":"package_fetch_failed"}
OK   现状差异已登记（code=executor_restart，向量 restart-en）：{"admin":"unknown","node":"executor_restart","python":"executor_restart"}
OK   现状差异已登记（code=application_missing，向量 app-missing）：{"admin":"application_missing","node":"package_fetch_failed","python":"package_fetch_failed"}
OK   现状差异已登记（code=executor_offline，向量 offline-zh）：{"admin":"executor_offline","node":"unknown","python":null}
OK   现状差异已登记（code=script_error，向量 script-traceback）：{"admin":"script_error","node":"unknown","python":null}
OK   现状差异已登记（code=unknown，向量 fallback-unknown-text）：{"admin":"unknown","node":"unknown","python":null}
OK   棘轮：登记条数不超基线（只减不增）
OK   棘轮：基线里的登记不得消失（差异被修掉 ⇒ 同步更新基线）

向量 33 条，跨语言一致 33 条；现状判据 admin 7 / node 10 / python 9 条（未抽到 admin 0 / node 0 / python 1 条）
failure-classifier consistency OK
```

**自检 9/9**：① 一致树绿｜② 差异未登记红｜③ 登记缺 owner 红｜④ 登记缺 probe 红｜⑤ 僵尸登记红｜⑥ 棘轮消失红｜⑦ 棘轮增长红｜⑧ 能力登记缺 verify 红｜⑨ 能力登记僵尸红。

### 4.3 与既有守卫的同批修改

| 守卫 | 改了什么 | 为什么 |
|---|---|---|
| `check-failure-reasons.mjs` | 码集合抽取改成 `.code`；新增 6 条元数据判据（reportable 投影、owner 域、remediationKey 形态、code 唯一、zh/en 与 locales 逐字、Hint 存在）；**形态回退结构红**（不接受 `string[]`） | P1-a 改了事实源形态，守卫不跟 ⇒ CI 红 |
| `check-enum-drift.mjs` | `ExecutionFailureReason` 豁免理由补上「它的三面一致性由 `check-failure-reasons` + `check-failure-classifiers` 两道守卫覆盖」 | 豁免必须可证；点名依赖关系，防止那两道守卫被摘掉后豁免静默腐烂 |
| `check-metric-docs.mjs` | **未改**（本轮不涉及指标名） | — |

### 4.4 接线（`check-guards-wired.mjs` 的判据）

三个守卫全部接入**两面**（本地 `test:guards:repo` + CI `.github/workflows/ci.yml`）**且自检也被真的执行**：

* `package.json`：`check:failure-classifiers` / `check:protocol-breaking`（`--selftest && 主跑` 形态），并挂进 `test:guards:repo`；
* `ci.yml`：两个新 step（各自 `--selftest` + 主跑）；
* `check-guards-wired.mjs` 实测**通过**。

---

## §5 knownDivergence 补登记清单与判定标准

### 5.1 判定标准（为什么这么分）

**问题**：真实差异全在源码注释里、**没进契约**（B4 / B5 / 健康端点）；而 `knownDivergence` 段本身是**另一件事**（信封拆包的 client 侧差异，已于 2026-09-14 关闭）⇒ **位置不统一**。

**判定标准**：

| | `versioning.compatibilityMatrix` | `contract.json#divergenceRegistry`（本轮统一位置） |
|---|---|---|
| 管什么 | **协议版本 → 能力/字段的历史**（v7 引入什么、v8 引入什么） | **同一协议版本下，两端行为不同 + 谁负责修** |
| 随什么变 | 随版本演进**追加** | 随差异收敛**减少** |
| 必填字段 | `protocolVersion` / `adminSupported` / `executorImplementedBy` | `reason` / `owner` / `status` / `evidence` |
| 判据 | 文档 | **机械守卫**（`check-failure-classifiers.mjs`） |

⇒ 同一件事**在两处各写一半**（B5 就是：compatibilityMatrix 的 v7/v8 条目里散着「python 两键上报为后续工作」）是**位置不统一**的根源。本轮把「两端行为不同 + 谁负责」这半**迁到统一位置**，compatibilityMatrix 保留版本事实（那是它该管的）。

### 5.2 补登记清单

**21 条登记**（18 条分类器差异 `CLS-01..16` + 3 条能力差异 `KD-*`）：

| id | code | 端 | status | 差异（一句话） |
|---|---|---|---|---|
| CLS-01 | sandbox_unavailable | node | open | node 用 `\bsandbox\b`，admin 刻意不收（admin 输入含 `err.stack`，会命中 `.../sandbox.ts:12`） |
| CLS-01 | sandbox_unavailable | python | open | python 是**裸子串** `sandbox`（比 admin 更宽） |
| CLS-02 | sandbox_unavailable | node | open | python 独有的 `task_launcher\|资源限制启动器` 支，node **零命中** |
| CLS-03 | unknown | python | accepted-by-design | node 兜底返 `unknown`、python 返 `None`（同义异形）—— **阶段语义**，不是缺陷 |
| CLS-04 | executor_offline | python | open | 裸子串 `enotfound` 会把 `modulenotfounderror` 误吞（admin 已加 `\b`） |
| CLS-05 | package_fetch_failed | python | open | node 有 `Invalid npm package name`，python 缺 |
| CLS-06 | git_fetch_failed | python | open | python 的 git 判据**不要求 failed**（成功日志也判成失败） |
| CLS-07 | runtime_missing | node | open | node 的裸 `No such file or directory` 过宽（用户脚本的 ENOENT 被判成环境问题） |
| CLS-08 | git_fetch_failed | admin | open | admin 无 git 规则 ⇒ git 失败被 package_fetch 的裸 `git clone` 接走 |
| CLS-08 | dependency_install_failed | admin | open | admin 无 dependency 规则 ⇒ 同上 |
| CLS-09 | application_missing | python | open | python 若命中裸 `packageurl` 会报 package_fetch（笼统），而 admin 归 application_missing（精确）—— 但该码是 **admin 内部专用**，执行器应**让位** |
| CLS-10 | unknown | python | accepted-by-design | astral + `{n,m}` 计数单位差异（JS code unit / Python code point） |
| CLS-11 | sandbox_unavailable | node | accepted-by-design | 运行期 bwrap 启动失败是**独立入口**（输入是任务输出、需 `TASK_SANDBOX=bwrap` 前置） |
| CLS-12 | executor_restart | admin | open | admin 无该规则（自己的停机失败走码化通道） |
| CLS-13 | package_fetch_failed | admin | open | admin 无 `Invalid npm package name` 支 |
| CLS-14 | executor_offline | node | accepted-by-design | executor_offline 是**中台侧观测**的事实，执行器不该自证 ⇒ 契约**刻意不挂**到 executor 阶段 |
| CLS-15 | application_missing | node | open | node 阶段无 application_missing 精确规则 ⇒ 落 package_fetch（笼统） |
| CLS-16 | script_error | node | open | admin 认得出 traceback，node/python 认不出 ⇒ 执行器上报的信息量少于它本来能给的 |
| **KD-B4** | （字段） | python | accepted-by-design | `adminApiUrls` **只有 node 实现**；python 收到后列入 `ignored_fields` 并回报（畸形类型仍必须 400） |
| **KD-B5** | （字段） | python | accepted-by-design | `deployedApps` / `installedPackages` / `registrationConflict` 三键在 python **恒省略**（无事实源可报）；**省略即协议合法**，且与 node 的「恒发 false」是**两种语义** |
| **KD-HEALTH** | （端点） | python | open | 健康端点**全集不同**：node 有 `/health/live` + `/health/admin-status`，python 只有 `/health/readiness` —— liveness 与 readiness 在运维探针上是两件事 |

### 5.3 「已关闭」的那条差异不动

`contract.json` 原有的 `knownDivergence`（PK-06/PK-07，`$comment` 自述 "Divergence is closed"）是**信封拆包的 client 侧差异**，与本轮的「跨端分类器/能力差异」是**两件事** ⇒ **原样保留、不迁移**（迁移它会让那条已关闭的记录失去上下文）。

---

## §6 孙Agent 结论

### 6.1 【Firefox 开源调研专项】（孙Agent `ba24ba1b-3be9-40b0-9f16-853756046274`）

**前置核对**：`01-priority-register.md` 与另三份 ⇒ openapi-typescript / TypeSpec / oasdiff / buf / Pact / Smithy / Spectral **全部 0 命中**（无重复劳动）；`/home/yongsheng/project/open_sourse/` 下**无**这七个项目的本地副本 ⇒ 结论取自上游一手源。

| 对象 | 来源 | License | 亮点 | 可复用点（本仓落点） | 缺陷 | 成本 |
|---|---|---|---|---|---|---|
| openapi-typescript | github.com/openapi-ts/openapi-typescript | **MIT** | 单一源 → 多目标类型生成 | **范式已在用**：`gen:api-types` + CI `executor-protocol-drift` 的 `git diff --exit-code`（ci.yml:1344-1355）。要补的是把该纪律从 zod/pydantic 扩到 **TS const + python Literal** | 纯类型生成器，无 diff/破坏性判据；会丢弃 `$comment` 等元数据 | **S** |
| TypeSpec | github.com/microsoft/typespec | **MIT** | `@error model X { code: "NOT_FOUND"; message: string }` —— code 是**字符串字面量类型**，码集 = 字面量并集，增删码 = 增删 model，编译器机械检查 | **搬语义**：`failureReason.all[].code` 当字面量联合，其余五字段当 model 字段 ⇒ 「错误是有结构的声明而非字符串」成立 | 完整 IDL + 编译器 + emitter 链；`@error` **只给形状不给判据**（owner/reportable 只是普通字段）；无 divergence、无棘轮 | **L** → 只借语义 |
| oasdiff | github.com/oasdiff/oasdiff | **Apache-2.0** | 判据三级 ERR/WARN/INFO；`breaking` 只报 ERR+WARN；`--fail-on` 给 CI 退出码 | **已落地**：`check-protocol-breaking.mjs` 直接照三级分类（breaking 必红 / needs-review 只列 / compatible 放行） | 只吃 OpenAPI（paths/components），不认裸 JSON Schema 的自有 `schemas` 段；Go 二进制；`pattern` 只能 WARN | **S**（抄判据不装工具） |
| buf breaking | github.com/bufbuild/buf | **Apache-2.0** | 四档严格度 FILE/PACKAGE/WIRE/WIRE_JSON；规则名即判据 | **最有价值的洞见**：`FIELD_WIRE_COMPATIBLE_TYPE` 与 `FIELD_WIRE_JSON_COMPATIBLE_TYPE` **并列存在** ⇒ 二进制兼容 ≠ JSON 兼容。本仓是 JSON 线缆，**必须选 WIRE_JSON 档**（否则 int→long 这类漏判）⇒ 本守卫已按此实现 | 绑 protobuf IDL，无 JSON Schema 输入；需外部二进制 | **S**（抄分档） |
| Pact | github.com/pact-foundation/pact-specification | **MIT**（spec/reference；pact-jvm=Apache-2.0；**pact-js GitHub 标 NOASSERTION，勿复制其代码**） | consumer-declared divergence 的**棘轮**：pending pact 失败不让构建失败；一旦验证成功即 `pending:false`，「对 main 的后续验证恒为 false」⇒ 只减不增 | **已落地**：`divergenceRegistry` 的「三字段必填 + probe 可证 + 条目数棘轮只减不增」 | Broker + 发布/验证流水线，与「契约入仓可 diff」是两套模型；pending 判定依赖 broker 的 branch/version 元数据 | **S**（抄棘轮）；真接 Broker 则 **L** |
| Buf/protobuf 全量迁移 | github.com/bufbuild/buf | Apache-2.0 | — | **明确不推荐**（见 §6.3） | — | **L** |
| Smithy | github.com/smithy-lang/smithy | **Apache-2.0** | protocol-agnostic IDL + 多目标 codegen + model validation | 无可直接复用段（本仓受控子集 + 双端生成器已等价） | **过度设计**：需 JVM/Gradle、trait 体系与 build 插件，为 1897 行 JSON 养整套 IDL 生态 | **L** |
| Spectral | github.com/stoplightio/spectral | **Apache-2.0** | JSONPath + functions 通用 linter | 无。内置 ruleset 的 `formats` 钉死于 oas2/oas3/asyncapi/arazzo ⇒ **对裸 JSON Schema 规则集不生效** | 只能 lint **文档**，管不到「文档对了实现分叉」 | **M**（自写 ruleset 才勉强可用，收益为负） |

**【破坏性变更判据三分类表】（21 条）** —— 完整版见 §4.1 的实现表；孙Agent 原文的要点：

* oasdiff 明文：*"A default is a server-side fallback value; it does not make an omitted required property valid"* ⇒ **有 default 也不豁免新增必填**。
* oasdiff 的 `breaking` 口径：*"A change that makes a previously valid request invalid is breaking"* ⇒ 本守卫的方向取「旧端产出的载荷在新契约下是否仍合法」。
* `enum` **从无到有** = 值域收窄 = breaking（孙Agent 未列，本守卫已补，且自检 ⑦b 钉住）。
* `description` / `$comment` 变更：oasdiff 的 changelog 不含（*"Documentation-only edits… are not included"*）⇒ 归 compatible；但本仓的 `$comment` 是 v2–v9 的**决策档案**（唯一不可再生的知识载体）⇒ 建议只追加不重写。

**【正则安全子集清单】**（孙Agent **在本轮 node 24 / CPython 3.12.3 上真跑**的反例，不是转述文档）：

*白名单（可安全共用）：ASCII 字面量 + 中文（已小写化）｜交替 `a|b`｜非捕获组 `(?:…)`｜显式 ASCII 字符类 `[A-Za-z0-9_]` / `[^\n]`｜`* + ?`｜`{1}`（仅主体保证 ASCII 时）。
*黑名单（含反例）：
  * `\b` / `\B` —— `/\bfailed\b/` 对 `任务failed了`：**JS MATCH / Py no**（Py 加 `re.ASCII` 才 MATCH）。
  * `$` —— `/abc$/` 对 `"abc\n"`：**JS no / Py MATCH**（Py 的 `$` 还匹配末尾换行之前）。
  * `\A \Z \z` —— JS `/\Z/` 对 `"Z"`：**MATCH（当字面量）**；Py 3.12 `\z`：`bad escape`；RE2：`\Z … NOT SUPPORTED`。三方言三套语义。
  * lookbehind —— `(?<=a+)b` 对 `aaab`：**JS MATCH / Py ERROR**；连 `(?<=a|bb)c` 在 Py 也 ERROR（各支不等宽）。
  * `\d \w \s` —— `\d` 对 `٣`(U+0663)：**JS no / Py MATCH**；`\w` 对 `中`：**JS no / Py MATCH**。
  * `.` —— `a.b` 对 `a\rb`：**JS no / Py MATCH**；对 `a\u2028b`：**JS no / Py MATCH**。
  * **`{n,m}` 计数单位** —— `^.{2}$` 对 `😀`：**JS MATCH / Py no**；`^[😀]{1}$`：**JS no / Py MATCH**。⚠️ 孙Agent 实测**本仓自己的受控子集就踩中它**：`a[^\n]{0,3}b` 对 `a😀😀b`：**JS no / Py MATCH** ⇒ **本轮已修**（normalize 阶段 astral → U+FFFD）。
  * 标志位 —— `s` vs `ſ`：**JS no / Py MATCH**；`k` vs `K`(U+212A)：**JS no / Py MATCH**（`i` 下）⇒ 生成物一律不带 flag。

⇒ **本轮的 matcherSubset 与孙Agent 的黑名单逐条对齐**（`\b`/`$`/`\A\Z\z`/lookbehind/前瞻/`\d\w\s`/`\p{}`/句点/反向引用/标志位/astral），且**每一条都有对应的硬拒检查**。

**【明确不推荐的路线】**

1. **Buf/protobuf 全量迁移（L 拆解）**：① 1897 行 / 6 个语义段重写为 `.proto`，其中 `schemaVectors`（30+ JSON 向量）与 `$comment`（v2–v9 决策史约 8000 字）**在 proto 无对应物** —— 而 `$comment` 是本仓唯一不可再生的决策档案；② `params` 的 `additionalProperties:true` 必须显式建模为 `map<string,X>`，「任意 JSON」被收窄；③ 双端生成从 200 行零依赖脚本换成 `protoc`/`buf generate` + 两套 plugin，**引入 ≥3 个外部二进制**，违反零新依赖硬倾向；④ 既有 zod/pydantic 产物与全部 schemaVectors 重写，P1-a/P1-b 成果作废；⑤ 收益仅 `buf breaking` 现成规则集，而该收益 §4.1 用 ~200 行 JS 即可自建。⇒ **收益不可移植（注释/向量/受控子集三样全丢），成本不可逆**。
2. **TypeSpec / Smithy 引入**：需 IDL 工具链承载一份 JSON；`@error` 只给**形状**，不给 owner/reportable/divergence/棘轮 —— 正是真正缺的四样。为 1897 行文件养 emitter 链 = 用编译器解决命名问题。
3. **Spectral 托管校验（边界论证）**：`spectral:oas` 的 `formats` 钉死于 oas2/oas3/asyncapi/arazzo，对裸 JSON Schema **规则集不生效**；即便自写 ruleset，lint 语义是「文档内部自洽 + 合风格」（`given` 用 JSONPath 取节点、`then` 比对），**输入只有文档本身，永远看不到实现**。本仓四处病灶（三份手写正则、failureReason 三处手抄、evolutionRules 无执行、knownDivergence 无守卫）全是「文档对了、实现分叉」，**原理上 lint 管不到** ⇒ 引入 Spectral = 多一条**永不报警的绿灯**。
4. **oasdiff / buf 作为 CI 二进制**：判据可抄、工具不可装（Go/Rust 二进制 + 只吃 OpenAPI/protobuf）。
5. **Pact Broker 化**：本仓契约的核心资产是「入仓、可 diff、有守卫」（`check:protocol-sync`）；外置会让契约脱离 code review 视野且需新服务。**只抄 pending → 永久非 pending 的棘轮语义**（已落地）。

### 6.2 【CodeGraph 深度探查专项】（孙Agent `6dd66c53-846e-4800-9c76-46e4b7b58a44`）

**清单 1（已由契约源统一）—— 最重要的发现**：

> **`schemas` 段是唯一被运行时真正消费的契约段**；其余 7 段（`envForward`/`secrets`/`params`/`timeout`/`readiness`/`executorNodeOnly`/`versioning`）**运行时零消费** —— 非测试代码里 `readFileSync`/import `protocol.json` **0 命中**，全仓只见注释与 spec。

* `schemas` → 两份生成物 → **node 8 处 `safeParse`**（`execute.ts:740` / `:2886`、`callback.ts:270`、`commands.ts:157`、`config.ts:77`/`:147`、`health.ts:32`、`logs.ts:121`）+ **python 6 处 `model_validate`**（`execute.py:2780`/`:2939`/`:88`、`config.py:98`/`:157`、`health.py:91`、`logs.py:60`）。漂移闸 `check:protocol-sync` + CI `executor-protocol-drift`（实测 EXIT=0）。
* `envForward` / `secrets` / `params` / `timeout` / `readiness` / `executorNodeOnly` / `versioning`：**只被 spec 读**；运行时的白名单/正则/状态值都是**手抄**（`env-whitelist.ts:16` ↔ `execute.py:1111`；`secret-env.ts:40` ↔ `secret_env.py:45`；`param-env.ts:139` ↔ `execute.py:1960`；`health.ts:30,236` ↔ `routers/health.py:122` ↔ `health.service.ts:737` 三份）。
* 本轮新增的 `failureReason.all` / `failureReason.classifiers`：**只被生成器与守卫读**，三端运行时尚未切换（**这是本轮有意的双轨**）。
* 本轮三份生成物：`.mjs`/`.py` 被守卫**真跑**消费 ✅；**`.ts` 目前零消费**（死物 —— 它是「为下一轮落地预留的类型/常量出口」）。

**清单 2（仍两端各写一份）—— 最高价值的 (c) 类（仅注释互指的 parity）**：

| 语义 | node | python | 已进契约 | 风险 |
|---|---|---|---|---|
| 分类器规则集（**注释自称「同一份分类契约」**） | `routes/execute.ts:855` | `routers/execute.py:613` | ✅ 本轮新增 `classifiers` 段（**但运行时零消费**） | **高** |
| params 键名正则（**三份**字面量同源） | `param-env.ts:139` | `execute.py:1960` | ✅ `params.keyPattern`（仅 spec） | 中 |
| secret 保留名集合（**三份**：admin-web 也抄了） | `secret-env.ts:64` | `secret_env.py:55` | ❌ | **高** |
| ENV 转发白名单（两份） | `env-whitelist.ts:16` | `execute.py:1111` | ✅ `envForward`（仅 spec） | 中 |
| 沙箱 argv 构造（**注释自称「逐字同构」**） | `execute.ts:3240` | `sandbox.py:251` | ❌ | 中 |
| 解释器安装失败分因（**注释自认「模式表是 python 正则的超集」**） | `interpreters.ts:1545` | `interpreters.py:1294` | ❌ | 中 |
| callback 重试退避（**注释自认「同量级」而非同值**：node 5s vs python 1s） | `callback.ts:178-181` | `execute.py:3087-3097` | ❌ | 中 |
| zip 限额（100/10000/512MiB/1GiB/depth 1） | `zip-guard.ts:49-57` | `zip_safety.py:119-129` | ❌ | 中 |
| readiness 状态值（**三份**手写） | `health.ts:30,236` | `routers/health.py:122` | ✅ `readiness`（仅 spec） | 中 |
| JSON 字节一致性（`js_json.py` 是 JS 语义**手写复刻**） | `param-env.ts:77` | `js_json.py:199` | ✅ V2 向量 | **高** |

**清单 3（尚未收敛的残留）**：除已登记的 CLS-01..16 + KD-B4/B5/HEALTH 外，孙Agent 另发现 **R8**：`可重试候选集三份`（admin-web `retry-policy.ts:35` 的 12 项 vs admin-api `task.processor.ts:546` 的 `inherentNonRetryable` **只 1 项** vs protocol 的 `reportable` 12/3）—— **三者无守卫互校**，未登记（本轮范围外，已列入 §9）。

**守卫覆盖矩阵**（关键三行）：

| 重复实现项 | 现有守卫 | 判据能红吗 |
|---|---|---|
| `schemas` → 生成物 | `check:protocol-sync` + CI drift job | ✅ 能红 |
| protocol.json **其他段** | 各端 spec | ⚠️ **半真空**：spec 断言「实现 == protocol.json」，但 **protocol.json 自身与实现的一致性靠手改对账** |
| 分类器正则结构禁令 | `check-failure-classifiers.mjs`（本轮新建） | ✅ 能红（只扫生成物规则体） |

**最容易漂移的 3 个点**：① 三端分类器规则集（**本轮已把目标态契约化，但运行时零消费** ⇒ 下一轮必须先切运行时）；② params/env 注入三份正则 + `js_json.py:199` 手写复刻；③ secret 保留名三份 + ENV 白名单两份（node↔python 之间**无直接比对**）。

### 6.3 两个孙Agent 的交叉验证结论

孙Agent 独立发现的两件事，与本轮的实现**互相印证**：

1. 孙Agent 独立算出「**受控子集自身踩中 `{n,m}` 计数单位差异**」⇒ 与本轮 normalize 阶段的 `astralFold` 修法一致（孙Agent 建议 normalize 阶段 astral → U+FFFD，**两语言同法** ⇒ 采纳）。
2. 孙Agent 独立算出「**buf 的 WIRE 档会漏判 JSON 破坏**」⇒ 与本轮守卫取 WIRE_JSON 档一致。

---

## §7 验证原始输出

```
$ node scripts/check-failure-reasons.mjs
OK   protocol: all minus adminInternalOnly === executorReportable  (12)
OK   protocol: !reportable (per-entry) === adminInternalOnly  (3)
OK   protocol: all.owner ⊆ ownerValues  (2)
OK   protocol: remediationKey === `execDetail.failure.<camel(code)>Hint`  (15)
OK   protocol: all.code 唯一  (0)
OK   protocol: all.remediationKey 均存在于 admin-web locales/zh.ts  (0)
OK   protocol: all.zh === admin-web locales/zh.ts 标签  (15)
OK   protocol: all.remediationKey 均存在于 admin-web locales/en.ts  (0)
OK   protocol: all.en === admin-web locales/en.ts 标签  (15)
OK   admin ExecutionFailureReason === protocol.all  (15)
OK   autoflow-sdk VALID_FAILURE_REASONS === protocol.executorReportable  (12)
OK   executor-node CALLBACK_FAILURE_REASONS === protocol.executorReportable  (12)

failure-reason alignment OK: all=15, reportable=12

$ node scripts/check-failure-reasons.mjs --selftest
✔ check-failure-reasons selftest 通过：18/18 条用例

$ node scripts/check-enum-drift.mjs
PK-26 enum drift guard OK: 36 个枚举声明（16 映射 / 20 豁免）全部 ⊆ 对应 PG enum，覆盖自检通过

$ node scripts/check-guards-wired.mjs
✔ 守卫接线自检通过：63 个 check-*.mjs 全部被 CI 执行（另有 1 个显式豁免）。
✔ 自检面：64 个守卫有自检，其中 63 个在本地 test:guards 与 CI 都真的执行了自检（另有 1 个自检豁免，0 个只接一面）。

$ node scripts/check-metric-docs.mjs
✓ 指标文档守卫全绿：注册表 52 个（counter 23 / gauge 4 / service 25）；文档提及 52 个；基线欠账 0 个（未增未减）；allowlisted 50 处（external 0 / 非指标标识 50 / 锚点 0）；前缀引用 6 处；告警名引用 32 处；行内豁免 4 处。

$ node scripts/check-openapi-response-schema.mjs
  ● 响应 schema 覆盖 242/255（94.9%），与基线一致且无倒退
响应 schema 覆盖率守卫通过（覆盖 242/255，无倒退）。

$ node scripts/check-failure-classifiers.mjs
…（§4.2 全量输出）…
向量 33 条，跨语言一致 33 条；现状判据 admin 7 / node 10 / python 9 条（未抽到 admin 0 / node 0 / python 1 条）
failure-classifier consistency OK

$ node scripts/check-failure-classifiers.mjs --selftest
✔ check-failure-classifiers selftest 通过：9/9 条用例

$ node scripts/check-protocol-breaking.mjs
变更 0 条：breaking 0 / 需人审 0 / 其余 0
protocol breaking-change check OK

$ node scripts/check-protocol-breaking.mjs --selftest
✔ check-protocol-breaking selftest 通过：12/12 条用例

$ node scripts/generate-failure-classifiers.mjs --check --no-selfcheck
classifiers 生成物无漂移（3 个文件）
```

**包级测试**：`packages/contract-fixtures` 与 `packages/executor-protocol` **均无 `package.json`** ⇒ 无 `npm test` 入口（实测确认）。仓内的跨端向量消费方测试（`packages/acf-cli` / `packages/mcp-server` / `packages/autocodeflow-node-sdk` / `packages/autoflow-sdk` / `apps/executor-node` / `apps/executor-python` 的 contract spec）**未跑**（不属本写域，且 executor-python 正在被另一路会话改动）。

---

## §8 风险 + 回滚

### 8.1 风险

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| R1 | **三端运行时仍是旧判据**（本轮**有意**不改）⇒ 契约的「目标态」与线上「现状」并存 | 中 | 已用 `divergenceRegistry`（21 条）+ probe 逐条登记；下一轮切运行时后 probe 会自动验证「差异已消失」⇒ 清理登记 |
| R2 | **`failure-classifier.ts` 目前是死物**（零消费） | 低 | 它是下一轮落地的类型出口；已由生成器保证不漂移 |
| R3 | **生成物跨包 import 的落地障碍**：`packages/contract-fixtures/generated/` 不在 `apps/executor-node` 的 tsconfig `include`（`["src/**/*"]`）内，也不在 `apps/executor-python` 的 `sys.path` 上 ⇒ §2.4 的落地清单里必须先解决这件事 | **高**（阻塞下一轮） | 已在 §2.4 的 ①② 里显式标注并给出两个方案（复制一份 / 改打包配置），**但复制一份会破坏「单一生成物」**⇒ **需主Agent 拍板**（见 §9 的拍板项） |
| R4 | **模拟器的抽取边界**：`EXTRACTION_LIMITS` 列了 4 类未覆盖（admin 的 `exitCodeNonZero`、admin 的码化优先、运行期 bwrap 入口、变量拼出的正则）⇒ 这些路径的漂移**看不见** | 中 | 已在脚本头显式列出（不假装覆盖）；admin 的 `exitCodeNonZero` 已在契约的 `criteria` 段建模（落点时补进生成物） |
| R5 | **`divergenceRegistry` 里 21 条登记的 `owner` 值域**沿用 `failureReason.ownerValues`（`task-author`/`platform-ops`）—— 它是**用户视角**的责任方，不是**团队**责任方 ⇒ 「谁负责修」在工程意义上仍然模糊 | 中 | `reason` + `evidence` 给了足够上下文；下一轮可引入工程团队维度（但那会让取值域再扩一维） |
| R6 | **protocol.json 的 `$comment` 是 v2–v9 的决策档案**（约 8000 字）—— 若后续有人重写它，历史不可再生 | 中 | `check-protocol-breaking` 把 `$comment` 变更归 `compatible`（不阻塞）；**建议**后续加一条「$comment 只追加不重写」的约定（本轮未做，见 §9） |
| R7 | **`contract.json` 被 Python `json.dump` 重序列化**（`1e-7` → `0.000001` 形态变化） | 低 | **已验证零值级变更**：逐段 JSON 比对，既有 10 个段的值全部相同，仅新增 2 个段（append-only 纪律守住） |

### 8.2 回滚

| 场景 | 回滚方式 | 影响面 |
|---|---|---|
| 码表元数据化要退回 | `git revert 0be07473`（或只 revert `protocol.json` + `check-failure-reasons.mjs`） | `check-failure-reasons.mjs` 会因 `all` 形态不符而**结构红** ⇒ 必须**成对**回滚 |
| 分类器契约要退回 | 只 revert `protocol.json` 的 `classifiers` 段 + `contract.json` 的 `failureClassification`/`divergenceRegistry` 段 + 三份生成物 + 两个新脚本 + `package.json`/CI 接线 | 生成物消失会让 `check-failure-classifiers` 结构红 ⇒ 同上必须成对 |
| 破坏性变更守卫太吵（误报多） | `--acknowledge <id>:<理由>` 逐条豁免（进账本，只增不删）；或 `--report` 模式先观察 | 账本会积累，需定期清理 |
| 已知差异守卫太吵 | 把该条登记从 `divergenceRegistry` 删掉 **且** 从基线删掉（**两步走**，否则棘轮判红） | 基线与登记必须同步 |
| 生成器产出坏文件（不可能，但假设） | `git checkout packages/contract-fixtures/generated/` + `node scripts/generate-failure-classifiers.mjs` 重生成 | 生成器有硬拒 ⇒ 坏文件**产不出来** |

### 8.3 ⚠️ 一次 git 索引竞态事故（必须留档）

本轮首次提交时，`git add` 之后的**索引是跨会话共享资源** —— 另一并发会话的 `git commit` 把我的 staged 内容一并带走（我的提交 `cf996d78` 里混入了主Agent 的 14 个路径，而提交信息只描述 protocol 契约工作）。主Agent 已以 `f5aad080` 留档并把「**并发写仓库时提交必须用 `git commit --only <path...>`**」升为纪律。

⇒ 本轮最终提交 `0be07473` 用 `git commit --only <15 个路径>` 重做，提交后 `git show --stat --name-only HEAD` **核对 HEAD 恰为我的 15 个文件**（已核对）。我的工作内容**全程未丢失**（全程在 working tree，守卫实测始终绿）。

---

## §9 未做项

### 9.1 本轮**有意**不做（下一轮的迁移范围）

1. **三端运行时切到契约生成物**（admin-api / executor-node / executor-python）—— 写域属他人；本轮只把目标态固定并**可验证**。
2. **`FAILURE_REASON_T_KEYS` 改为生成**（admin-web）—— 写域属他人；守卫已就位（改了契约没改读面会立刻红）。
3. **admin 侧的 `exitCodeNonZero` 与码化优先通道补进生成物**（§2.4 的 (a)(b)）—— 写域属他人。
4. **生成物跨包 import 的落地**（§8.1 的 R3）—— 需主Agent 拍板。

### 9.2 本轮**超范围但相邻**的未做项（记录在案）

1. **R8：可重试候选集三份无守卫互校**（admin-web `retry-policy.ts:35` 12 项 vs admin-api `task.processor.ts:546` 1 项 vs protocol `reportable` 12/3）—— **未登记**（不在分类器差异面内）。建议下一轮纳入 `divergenceRegistry` 的 `kind: "capability"`。
2. **secret 保留名三份 + ENV 白名单两份的跨端比对**（孙Agent 清单 2 的 ③④）—— 本轮未做（属「生成化」的下一批）。
3. **`js_json.py` 的 JS 语义手写复刻**（孙Agent 列为高风险）—— 本轮未做。
4. **callback 重试退避两端不同值**（node 5s vs python 1s，注释自认「同量级」）—— 未登记。
5. **`$comment` 只追加不重写的机械约束**（§8.1 的 R6）—— 未做（需要一份「注释段指纹」的基线，本轮未及）。
6. **「四个 python 库降级为仓内私有包」**（主Agent 裁决 (C)）—— **不在本轮范围**（属独立小任务，要改 4 个 pyproject + release-please 配置 + `check-publishable-wiring.mjs` 判据）。**我未做**：余力已全部投入三条主线，且该任务要求「增强守卫能力（区分有意不发布 vs 忘了发布）」而非绕过 —— 与本轮两条守卫的「区分即价值」思路同源，宜由**同一轮**统一设计，不宜顺手插入。

---

## 附：交付物清单

| 类型 | 路径 | 说明 |
|---|---|---|
| 契约源 | `packages/executor-protocol/protocol.json` | `failureReason` 段改造 + 新增 `classifiers` 段 |
| 共享向量 | `packages/contract-fixtures/contract.json` | 新增 `failureClassification`（33 条）+ `divergenceRegistry`（21 条） |
| 生成物 | `packages/contract-fixtures/generated/failure-classifier.{mjs,py,ts}` | 由生成器产出，drift 检测保护 |
| 生成器 | `scripts/generate-failure-classifiers.mjs` | 新建（零依赖，生成后自校验） |
| 守卫 | `scripts/check-failure-classifiers.mjs` | 新建（跨语言等价 + 登记完整性 + 结构禁令） |
| 守卫 | `scripts/check-protocol-breaking.mjs` | 新建（破坏性变更，21 条判据） |
| 守卫（改） | `scripts/check-failure-reasons.mjs` | 元数据化后同批改（6 条新判据 + 形态回退结构红） |
| 守卫（改） | `scripts/check-enum-drift.mjs` | 豁免理由点名依赖关系 |
| 基线/账本 | `scripts/failure-classifier-divergence-baseline.json`、`scripts/protocol-breaking-baseline.json`、`scripts/protocol-breaking-acknowledgements.json` | 棘轮基线 + 豁免账 |
| 接线 | `package.json`、`.github/workflows/ci.yml` | 3 个 script + 2 个 CI step |
| 提交 | `0be07473` | 15 个文件（`git commit --only`，已核对） |

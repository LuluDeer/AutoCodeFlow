# 跨端契约单一事实源（contract-source）

> **角色**：Round 2 契约源域 —— 把「跨端契约」从**注释里的承诺**变成**可执行的单一事实源**。
> **受众**：主Agent（Round 2 决策）· **状态**：一次性记录
> **测量窗口**：2026-11-03 02:42 → 09:20（Asia/Shanghai）
> **写域**：`packages/executor-protocol/**`、`packages/contract-fixtures/**`、`scripts/check-*.mjs`（新建 2 个 + 改 2 个）、`scripts/generate-failure-classifiers.mjs`（新建）、`package.json`、`.github/workflows/ci.yml`、本文件。
> **未改动**：`apps/admin-api/**`、`apps/admin-web/**`（本轮一律**只读**）。
> **D-13 后新增写域**：`apps/executor-node/src/generated/failure-classifier.ts`、`apps/executor-python/generated/failure_classifier.py`（**都是生成物**，非手写；主Agent 裁决 D-13 明确授权）。

---

## ⚠️ 结论定性（主Agent 裁决，本报告全程适用）

> **当前形态是「契约 + 守卫（drift 可检测）」，不是「运行时消费契约（drift 不可能）」。**
> 两者都能防漂移但**强度不同**：前者在「代码与 spec 被同一次改动一起改」时**会漏**。
> ⇒ **不得再笼统宣称「单一事实源」。**

这条定性是本报告的**总纲**，它的证据是 D-16 的实测结果（§4.5）：`protocol.json` 的 **10 个顶层段里，只有 `schemas` 一段真被运行时消费**（7 个非 spec 消费者），其余 9 段**运行时零消费** —— 它们的对应实现在 app 里都是**手抄副本**，契约段只被 spec / 测试 / 注释引用。

**这意味着**：

| | 现状 | 强度 |
|---|---|---|
| `schemas` 段 | 生成物 + 运行时 import + drift 闸 | **强**（改了契约不改实现 ⇒ 红） |
| 其余 9 段 | 契约里的**文档 + 向量**，实现是手抄 | **弱**（代码与 spec 同批改 ⇒ 漏） |

⇒ 本轮把 `xConsumption` 显式写进契约（D-16），就是让这个强弱**在契约里可见、可审计**，而不是靠读者自行推断。

### ⭐ 「声明不是注释，是待兑现的承诺」

`xConsumption` 的 `runtime` **不是一句描述**，而是**守卫会核对的事实声明**：

* 声明 `runtime` 但找不到非 spec 消费者 ⇒ **红**（声明是假的）；
* 声明 `guard-only` 但存在消费者 ⇒ **红**（声明漏了 —— 而「漏了」正是要消灭的那类失真）；
* 至少一个段声明 `runtime` ⇒ **红**（否则声明机制本身是死的）。

**下一轮把三端分类器切到生成物后**，`failureReason` 段会从 `guard-only` 变成 `runtime` —— **那时这条判据会强制它真的有消费者**。这就是 D-16 的价值：它把「我们要切过去」这个意图，变成了一条**会变红的待办**。

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

### 2.3 三端落点（D-13 裁定 (a)：各 app 各产一份 + 字节一致 drift 守卫）

**主Agent 裁定 (a)**，理由（不是权衡，是**架构前提**）：

* 本仓 `package.json` 的 description 明写 **「ARCH-20: per-app installs remain independent; no workspace hoisting by design」**。
  跨 app 的**编译期 import** 与该前提直接冲突 —— `packages/contract-fixtures/generated/` 既不在 executor-node 的 tsconfig include 段内、也不在 executor-python 的 `sys.path`，正是因为**架构上本就不该跨包 import**。
* 「多份生成物 ⇒ 跨语言可验证性受损」的担心**由守卫消除**：单一来源仍是 `protocol.json`，多份是**派生产物**；新增判据「每个 app 内的生成物 ≡ 一次全新生成的字节」（drift 即红）。**这正是 protobuf 的标准做法**（单 `.proto`，多语言各生成一份）。

**落点（四处，角色不同）**：

| 路径 | 角色 | 判据 |
|---|---|---|
| `apps/executor-node/src/generated/failure-classifier.ts` | **node 运行时**（在 tsconfig include 段内 ⇒ tsc 会编译它并随包发布，与既有 `protocol.schemas.ts` 同款） | 行为等价探针 |
| `apps/executor-python/generated/failure_classifier.py` | **python 运行时**（`generated/` 在 sys.path 上 ⇒ `from generated.failure_classifier import classify` 可达） | 逐字节一致 |
| `packages/contract-fixtures/generated/failure-classifier.mjs` | **守卫对照**（node 侧守卫要能 `await import()` 一份纯 .mjs） | 与 app 侧行为等价 |
| `packages/contract-fixtures/generated/failure-classifier.py` | **守卫对照**（python 侧守卫要能 `python3` 跑一份独立 .py） | 与 app 侧逐字节一致 |

⚠️ **D-14**：原 `packages/contract-fixtures/generated/failure-classifier.ts`（只导出类型与常量表、**零消费**）**本轮删除** —— 仓内有先例（`auth-cookie.util` 作为「死代码假安心」被删）。**不预留投机性出口**，需要时再生成。其在生成器里的 emit 与守卫里的引用**一并清理**（本轮已做：生成器不再 emit 它；node 侧的运行时产出改为**带完整实现**的 `.ts`，见下）。

⚠️ **node 侧为什么是 `.ts` 而不是 `.mjs`**：executor-node 的整个源码树是 TypeScript，`src/generated/` 下的 `.ts` 会被 tsc 编译；放一个 `.mjs` 进去会让「src 下都是 `.ts`」这个不变式破掉（且 tsc 不会检查它 ⇒ 类型错误不会被发现）。

**两份 node 产物的关系**（重要）：

* **契约数据同源**：`TOKENS` / `RULES` / `NORMALIZE` / `FALLBACKS` / `SENTINEL_PAD` 全部由 `protocol.json` 注入；
* **逻辑各自写全**：`.ts` 与 `.mjs` 是**各自手写**的发射器（不是一份派生 —— 派生会让「替换规则」本身成为新的第二份实现）；
* **等价性靠真执行证明**：守卫用 **61 条探针 × 2 阶段**在两份产物上跑，比对答案（§4.3）。

⚠️ **为什么不比文本**：本轮实测，把 `.ts` 与 `.mjs` 规范化后比文本，先后误判了 **5 次**（内联对象类型 `Readonly<{…}>`、形参类型、返回类型、`?? 0` 的 TS/JS 差异、成员顺序）。每一条都要加规则 ⇒ 是一条**永远在维护**的脆弱规则。**行为等价是直接可比的**，且比文本比对**更强**（文本相同是行为相同的充分条件，但不是必要条件）。

#### 已接受的债 ①：**emit 逻辑本身是两份**（主Agent 附加条件，写进报告而非「设计如此」）

> **数据同源 ≠ 逻辑同源。**

必须显式承认：`failure-classifier.ts` 与 `failure-classifier.mjs` 是**两份各自手写的 emitter**。契约**数据**（`TOKENS` / `RULES` / `NORMALIZE` / `FALLBACKS` / `SENTINEL_PAD`）全部由 `protocol.json` 注入 ⇒ **数据不可能分叉**；但**判定逻辑**（归一顺序、排序、兜底、`test` 的调用方式）是两段独立代码。

**这意味着「新增一条分类规则」时要改两处 emit + 契约**：

| 改动 | 要动的地方 |
|---|---|
| 新增一条规则的 **alternatives** | 只改 `protocol.json`（数据注入 ⇒ 两份产物都变） |
| 新增一条规则的 **判定逻辑形态**（例如需要新的归一步骤、新的阶段语义） | **两处 emitter**（`.ts` 与 `.mjs`）+ 契约 |

**这是有意识的重复，不是疏漏** —— 但它带一个**已知的发现机制缺口**：

> ⚠️ **61（今 69）条探针只覆盖「已想到」的行为面。**
> 若新增规则时**两份 emitter 都漏了**同一处逻辑，探针**也未必抓到** —— 因为探针验的是「两份产物**是否一致**」，不是「两份产物**是否对**」。
> **「是否对」由另一条判据负责**：`failureClassification` 的共享向量断言 `expected`（契约语义）；而**契约语义本身是否正确**，最终只能靠人审 + 生产反馈。

⇒ 这条债的**准确表述**是：**「两份 emit 的『一致性』有机械证据；『正确性』只有向量覆盖的部分有机械证据」**。不得写成「单一实现」。

#### 已接受的债 ②：探针集必须覆盖「规则对的重叠面」（反向实证的副产物）

本轮反向实证（§4.6）踩到一个**重要的负例**：

最初选的「顺序类型破坏」是 `terminal_timeout` × `git_fetch_failed` 的相对 order 对调 —— 实测这两条规则**零重叠**（没有任何探针文本同时命中它们）⇒ 相对顺序**在任何探针上都不可观测** ⇒ 人为对调后守卫**正确地**保持绿。

那不是探针的缺陷，是**破坏本身不产生可观测差异**。但它暴露了真问题：**顺序即规格 ⇒ 顺序差异必须可观测**，否则「规则顺序错了」这类缺陷**永远测不出来**（而顺序错乱的后果恰是「同一段文本被归到另一个码」—— 跨端分因的经典形态）。

⇒ 已补 **8 条「重叠面探针」**（对每对**在共享向量上同时命中**的规则，造一条同时命中两者的文本）⇒ 探针从 61 条增到 **69 条**。实测有重叠的规则对共 **8 对**（`git_fetch_failed`×`package_fetch_failed`、`dependency_install_failed`×`package_fetch_failed`、`terminal_timeout`×`terminal_timeout_admin_broad` 等）。

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
| a | admin 的 `classifyFailure` 有 `exitCodeNonZero` 判据（非 0 即 `script_error`） | 契约 `criteria.exitCodeNonZero` **保留**该判据（admin 阶段） | 一致（生成物目前**未实现**该判据） | `failure-patterns.ts` 第 ⑧ 步 |
| b | admin 走 `classifyFailureByCode` 码化优先通道 | 契约**未建模**该通道 | **差异**：码化优先不依赖文本，契约的文本分类器管不到 | `failure-patterns.ts` `ERROR_CODE_FAILURE_REASON` |
| c | admin 的 `EXECUTOR_OFFLINE_PATTERN` 含 `\beconnrefused\b` / `\benotfound\b` | 契约用 sentinel + `{{NONWORD}}` | **等价**（本仓实测：sentinel 保留 ASCII 词边界语义，Python 侧不需要 `re.ASCII`） | — |
| d | admin 的 `SCRIPT_ERROR_PATTERN` 在**最后** | 契约 `script_error` order=99（最后） | 一致 | — |
| e | admin 的 `SANDBOX_UNAVAILABLE_PATTERN` **刻意不收**裸 `sandbox` / `\bsandbox\b` | 契约取 admin 集合为基线 | 一致（契约**收窄**了 node/python） | — |

#### 🔴【落点必须补，否则切换后 admin 行为回退】

> 这两条**不是「差异清单」**，是**切换时的真风险**：契约的生成物只实现了**文本**分类；
> 若 admin 侧在切换时直接改成「只调生成物」，而**不**把下面两条通道接回去，
> **admin 的归因行为会回退**（不是「变差一点」，是**丢掉两条现有的判据**）。

**(a) `exitCodeNonZero`（非文本判据）**

* 现状：`failure-patterns.ts` 的 `classifyFailure` 第 ⑧ 步 —— `typeof input.exitCode === "number" && input.exitCode !== 0` ⇒ `script_error`，且**先于**文本 `SCRIPT_ERROR_PATTERN`。
* 契约位置：`protocol.json` 的 `failureReason.classifiers.criteria.exitCodeNonZero`（已登记，`appliesTo: ["admin"]`）。
* **生成物未实现它**（生成物只有文本分类器，没有 exitCode 入参）。
* ⇒ **落点必须补**：要么把 `exitCode` 作为**第二个入参**加进生成物（`classify(parts, stage, { exitCode })`），要么在 admin 侧**保留**这条判据、不交给生成物。
* **回退的后果**：非零退出码的任务不再被归 `script_error` ⇒ 落到 `unknown` ⇒ **`script_error` 在默认重试集里** ⇒ 该归因丢失会让重试门禁误判（用户看到「未知原因」，运维失去「脚本错误」这一可行动信号）。

**(b) 码化优先通道（`classifyFailureByCode`）**

* 现状：`failure-patterns.ts` 从 `common/errors/error-code-failure-reason.ts` 读 `ERROR_CODE_FAILURE_REASON`，中台自产的失败**直接映射**、**完全跳过文案正则**。
* 契约位置：**未建模**（契约的分类器是**文本**契约，码化通道不是文本判据）。
* ⇒ **落点必须补**：码化优先**必须留在 admin 侧**（它依赖 admin 自己的错误码目录，契约的 `failureReason` 段管不到）；切换时**不能**让生成物挡在它前面。
* **回退的后果**：中台自产的失败（如 `ERROR_CODE_*` 映射到 `application_missing`）会先被文本正则判走 ⇒ **码化优先失效** ⇒ 这正是「文案改写导致分类静默失效」那类缺陷的根因复发。

⇒ **我在本轮没有改动 admin 侧任何文件**（写域属他人），也**没有偷偷改生成物去迁就它**。这两条是**切换时的 checklist 项**，不是「可以之后再想」的事。

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

### 4.6 D-13 附加条件②：**探针的反向实证**（`scripts/check-failure-classifiers-reverse-proof.mjs`）

**为什么需要**：「探针能发现两份 emit 的分歧」这句话本身需要**证据**，否则它就是一句断言。而本轮的方法论纪律是：

> **凡「保护机制」必须有一段「构造违反 ⇒ 必须报警」的证据。** 若保护机制在人为制造违反时仍然绿，那它就只是装饰。

**做法**：在 `/tmp` 造一棵最小 fixture 树（拷入**真实**的契约、向量、生成物、三端现状判据），把「生成器的 `--check`」**桩掉**（`process.exit(0)`）—— 这样 drift 那一层不会先红，**只有行为等价探针能红**。

**四种破坏 + 一条负例，实测原始输出**：

```text
=== 步骤 1：未破坏时的基线（应绿）===
exit=0
  OK   D-13：node 两份生成物都在（app 运行时 .ts + 守卫 .mjs）
  OK   D-13：node 两份生成物行为等价（61 条探针 × 2 阶段）

=== break-1-missing-rule：从 .ts 的 RULES 里删掉 sandbox_unavailable 那一条（.mjs 保留） ===
  .ts 的 RULES 条数： 13 ；.mjs 的 RULES 条数： 14
  守卫 exit=1
    FAIL D-13：node 两份生成物行为等价（61 条探针 × 2 阶段）
  ⇒ 探针**变红**（符合预期）
    红灯内容（首行）： actual  : vec:sandbox-task-sandbox@executor: .ts=null .mjs=sandbox_unavailable

=== break-2-changed-body：把 .ts 里 sandbox_unavailable 规则的 body 改窄（少一个 alternative） ===
  .ts 的 RULES 条数： 14 ；.mjs 的 RULES 条数： 14
  守卫 exit=1
    FAIL D-13：node 两份生成物行为等价（61 条探针 × 2 阶段）
  ⇒ 探针**变红**（符合预期）
    红灯内容（首行）： actual  : vec:pkg-download-failed@executor: .ts=sandbox_unavailable .mjs=package_fetch_failed

=== break-3-relative-order-flip：git_fetch_failed(32) 与 package_fetch_failed(80) 的相对 order 对调 ===
  守卫 exit=1
    FAIL D-13：node 两份生成物行为等价（61 条探针 × 2 阶段）
  ⇒ 探针**变红**（符合预期）
    红灯内容（首行）： actual  : vec:git-failed@executor: .ts=package_fetch_failed .mjs=git_fetch_failed

=== break-4-swapped-body-order：dependency_install_failed(34) 与 package_fetch_failed(80) 对调 ===
  守卫 exit=1
    FAIL D-13：node 两份生成物行为等价（61 条探针 × 2 阶段）
  ⇒ 探针**变红**（符合预期）

=== break-5-unobservable-order-flip（负例：必须保持绿）：terminal_timeout(30) 与 git_fetch_failed(32) 对调 ===
  ⇒ 探针保持绿（符合预期：这两条规则零重叠 ⇒ 顺序不可观测）

=== 结论 ===
✔ 反向实证成立：四种人为分歧（少一条规则 / 判据体变窄 / 相对顺序对调 ×2）
  **全部**让「行为等价探针」变红（exit=1）⇒ 探针不是装饰。
```

**两个方向的证据都给了**：

| 方向 | 断言 | 结果 |
|---|---|---|
| **该红时红** | 4 种**产生可观测差异**的破坏 | 全部 `exit=1` + `FAIL D-13` ✔ |
| **该绿时绿** | 1 种**不产生可观测差异**的破坏（零重叠规则对调） | 保持绿 ✔（探针**不误报**） |

⇒ 第二条同样重要：探针若在「破坏不产生差异」时也报警，那不是更严，是**噪音** —— 而噪音会让人养成忽略红灯的习惯（本仓反复记录过的失效模式）。

**这次实证的副产物**：它发现了「探针集未覆盖规则对重叠面」这个真缺口 ⇒ 已补 8 条重叠面探针（详见 §2.3 债②）。

### 4.5 D-16：`xConsumption` 显式声明 + 逐段消费面审计

**问题**（主Agent 独立复核确认）：`protocol.json` 的 10 个顶层段里，**只有 `schemas` 一段真被运行时消费**；其余 9 段的实现都是 app 里的**手抄副本**，契约段只被 spec / 测试 / 注释引用。

**做法**（对齐 OpenAPI 的 `x-` 扩展惯例）：

* `protocol.json` 的**每个顶层段**加 `xConsumption: "runtime" | "guard-only"` + `xConsumptionNote`（写明「为什么是这个消费面」+ 证据）。
* 守卫 `check-failure-classifiers.mjs` 逐段核对声明与**实际**消费面。

**「算不算消费」的判据**（本轮的关键设计点）：

| | 算消费 | **不算**消费 |
|---|---|---|
| 形态 | ① 运行时**直接**读 `protocol.json`（`readFileSync` / `require`）；② 运行时 **import** 一份**由契约生成的产物** | app 里有一份**同名本地常量**（`ENV_WHITELIST` / `SAFE_SECRET_NAME_RE` / `resolveTaskTimeoutRaw`）—— 那是**手抄副本**，恰是本轮要消灭的对象 |
| 判据实现 | `SEGMENT_DERIVED_ARTIFACTS`（段 → 派生产物路径）+ `DIRECT_PROTOCOL_READ_PATTERNS` | 排除 `DERIVED_ARTIFACT_FILES`（产物自身）、`NON_RUNTIME_FILES`（package.json / 向量载体）、spec 文件 |

⚠️ 实测踩过的坑：最初用「段名 / 常量名」当锚点 ⇒ `timeout` 命中 ci.yml、`params` 命中 openapi.json、`secrets` 命中 release.yml —— **全是噪音**。判据必须锚在「**指向契约的那一处**」。

**实测读数**（`auditSegmentConsumption` 的输出）：

| 段 | `xConsumption` | 实际非 spec 消费者 |
|---|---|---|
| versioning | guard-only | 0 |
| executorNodeOnly | guard-only | 0 |
| readiness | guard-only | 0 |
| timeout | guard-only | 0 |
| failureReason | guard-only | 0 |
| secrets | guard-only | 0 |
| params | guard-only | 0 |
| envForward | guard-only | 0 |
| **schemas** | **runtime** | **7 个**：`executor-node/src/callback.ts`、`commands.ts`、`routes/config.ts`、`routes/execute.ts`、`routes/health.ts`、`routes/logs.ts`、`executor-python/routers/execute.py` 等 |
| schemaVectors | guard-only | 0 |

⇒ **零漂移**：声明与事实**逐段一致**（守卫输出 `OK D-16：段 … 的 xConsumption 声明与实际一致`）。

**这条判据的元价值**：

* 声明 `runtime` 但找不到消费者 ⇒ **红**（声明是假的）；
* 声明 `guard-only` 但存在消费者 ⇒ **红**（声明漏了 —— 而「漏了」正是要消灭的那类失真）；
* 至少一个段声明 `runtime` ⇒ **红**（否则声明机制本身是死的）。

⇒ 下一轮若把 admin / node / python 的分类器切到生成物，`failureReason` 段的声明会从 `guard-only` 变成 `runtime` —— **那时这条判据会强制它真的有消费者**。声明不是注释，是**待兑现的承诺**。

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
  * **`{n,m}` 计数单位** —— `^.{2}$` 对 `😀`：**JS MATCH / Py no**；`^[😀]{1}$`：**JS no / Py MATCH**。

> #### ⭐ 本轮三层委派的**直接收益**：这条是**孙Agent 独立发现**、**由实现吸收**的
>
> **发现方**：开源调研专项孙Agent（`ba24ba1b-3be9-40b0-9f16-853756046274`）——
> 它在核实「跨语言正则安全子集」时**实测**出：JS 的 `{n,m}` 按 **UTF-16 code unit**
> 计数、Python 按 **code point** 计数，于是同一个 `{0,N}` 在两侧覆盖不同长度；
> 更进一步，它**实测发现本仓自己刚写下的受控子集就踩中了这个洞**：
> `a[^\n]{0,3}b` 对 `a😀😀b` 在 **JS 不命中、在 Python 命中**。
>
> **吸收方**：本轮实现 —— 契约的 `failureReason.classifiers.normalize.astralFold`
> 字段（值 `replace-with-U+FFFD`）+ 生成物两侧的 `foldAstral()`：
> 归一阶段把码点 > U+FFFF 的字符折叠成 **U+FFFD**（单码点 = 单 UTF-16 code unit）
> ⇒ 两侧的计数单位一致 ⇒ `{n,m}` 覆盖同一段长度。
>
> **为什么这条值得留痕**：它是「**孙Agent 发现的、不是主Agent 想到的**」的典型 ——
> 若没有这次委派，这个洞会被**写进契约**（本轮的受控子集是本轮新写的），
> 然后成为**新的跨端不等价来源**，而且是那种「向量全绿、只有未见文本才会炸」的
> 静默缺陷（向量只覆盖已知文本；astral 字符在真实错误文案里极罕见）。
>
> **两处独立印证**：孙Agent 的实测结论与我在实现时的独立观察**指向同一处**
> （我也在归一设计时想到 `{n,m}` 与 code point 的耦合，但**没有**实测反例、
> 也没有发现「本仓自己的子集踩中」——那是孙Agent 的增量）。
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

### 7.1 一个「被 catch 吞掉的清理失败」（静默腐烂的典型）

本轮修掉的一个**不是契约问题、但值得留痕**的缺陷：

```js
// 旧实现（生成器的自校验里删探针文件）
try {
  require("node:fs").unlinkSync(pyFile);
} catch {
  /* ignore */
}
```

**问题**：本文件是 **ESM**（`require` 未定义）⇒ `require(...)` 抛 `ReferenceError` ⇒ 被**裸 `catch` 吞掉** ⇒ **清理从未发生**。后果：

* **每次生成都在契约包目录里留一个 `.__probe_<pid>.py`**（实测跑了 9 次，积了 9 个）；
* 这些文件会进 `git status`（曾差点被 `git add` 带进提交）；
* 更糟：它们会让 `drift` 闸**误报**「生成物漂移」（目录里有不该在的文件）。

**为什么它是「最典型的静默腐烂」**：

> **错误被兜住 ⇒ 无人知道清理没做。**
> `catch { /* ignore */ }` 的语义是「不让它失败」，但它**同时也抹掉了「它失败了」这个事实** —— 于是失败会**每天重复**，而没有任何信号。

**纪律（写进本报告，供后来人引）**：

> **`catch` 里如果只是「不让它失败」，必须至少留一条可被发现的痕迹** ——
> `console.warn` / 计数器 / 断言 / 或者干脆**不 catch**（让它在测试里炸出来）。
> 「安静地失败」比「响亮地失败」贵得多：后者修一次，前者修很多次 —— 而且你不知道要修。

本轮的修法：改用已 `import` 的 `unlinkSync`（不再有 `require`）；`catch` 保留但范围**收窄到「文件不存在」这一种预期情况**（其它错误仍会抛）。

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
6. **「四个 python 库降级为仓内私有包」**（主Agent 裁决 (C)，**D-15 裁定延期下一轮**）—— **不在本轮范围**（属独立小任务，要改 4 个 pyproject + release-please 配置 + `check-publishable-wiring.mjs` 判据）。**我未做**：余力已全部投入三条主线 + D-13/D-14/D-16 收尾，且该任务要求「增强守卫能力（区分有意不发布 vs 忘了发布）」而非绕过 —— 与本轮两条守卫的「区分即价值」思路同源，宜由**同一轮**统一设计，不宜顺手插入。
   **跟踪项（带 owner）**：`autocodeflow-{ai,http,notify,db}` 四个包的发布口径降级 —— owner = 平台（主Agent 裁决 (C)）；下一轮处理，要求：① 改 `check-publishable-wiring.mjs` 的 `publishableState()` 判据，让「**有意不发布**」与「**忘了发布**」可区分（前者进白名单并写明理由，后者红）；② 同步 release-please 配置；③ 零消费者已三重取证（CodeGraph import 图 + 全仓 grep + venv site-packages），但**不是死代码**（重试/熔断契约被 `autoflow-sdk` 与 `node-sdk` 逐字抄走并注释互指）⇒ 降级不等于删除。

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
| 生成物（node 运行时） | `apps/executor-node/src/generated/failure-classifier.ts` | D-13：带完整实现（tsc 零错误，CommonJS 下实测可跑） |
| 生成物（python 运行时） | `apps/executor-python/generated/failure_classifier.py` | D-13：`from generated.failure_classifier import classify` 实测可用 |
| 契约声明 | `protocol.json` 各段的 `xConsumption` + `xConsumptionNote` | D-16：10 段逐段声明 + 守卫审计 |
| 反向实证 | `scripts/check-failure-classifiers-reverse-proof.mjs` | D-13 附加条件②：构造 4 种违反断言探针**必红** + 1 条负例断言**不误报**；已接 CI |
| 提交 | `0be07473`（首版 15 文件）+ `746e35f6`（D-13/D-14/D-16）+ 本报告 | 均用 `git commit --only <path...>`，提交后 `git show --stat HEAD` 核对归属 |

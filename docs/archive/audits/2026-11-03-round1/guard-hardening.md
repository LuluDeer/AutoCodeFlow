# 失败分类守卫加固（guard-hardening）

> **角色**：Round 2 守卫加固 —— 把「函数级」守卫升级为「**消费端端到端级**」，并**证明**它真能挡住回归。
> **受众**：主Agent（Round 2 决策）· **状态**：一次性记录
> **测量窗口**：2026-11-03 03:11 → 08:40（Asia/Shanghai）
> **写域**：仅 `apps/admin-api/src/common/failure-classification/__tests__/**`（新增 2 个 spec）+ 本文件。**未改动任何非测试源码。**

---

## §1 守卫盲区复现（先自己复现，再修）

### 1.1 验收官指控的三条结构缺陷 —— 逐条复现

**指控 1：行为金标表自指（致命）**
`failure-classification.path-parity.spec.ts` 的 27 条断言全部直接调 `classifyFailure(...)`，**不经过任何消费者**。
⇒ 后果：把裸子串 `enotfound` 加回消费者，27 条仍**全绿**。

**指控 2：`TOKENS` 判据刻意排除中文词与 `enotfound`**
见 `failure-classification.path-parity.spec.ts:244` 附近的 `TOKENS` 数组与其注释。

**指控 3：两个测试目录里没有任何 `ModuleNotFoundError` 的端到端用例**
只有 `classify-failure.spec.ts:96` 与 parity spec 里对 `classifyFailure` 的**直接调用**。

### 1.2 我的复现步骤与输出（**实证，非推断**）

复现环境：`/tmp/gh/admin-api/`（`src/` 全量副本 + `node_modules` 软链到真仓，**仓库零污染**）。

**实验 1 —— 往消费者（`task.service.ts::inferFailureReason`）注入裸 `enotfound`：**

```ts
// ===== INJECTED REGRESSION (Round 2 reverse-verification) =====
const raw = `${errorMessage ?? ""}\n${logs ?? ""}`;
if (raw.toLowerCase().includes("enotfound")) {
  return ExecutionFailureReason.EXECUTOR_OFFLINE;
}
// ===== END INJECTED REGRESSION =====
```

**输出（决定性证据）：**

```
PASS src/common/failure-classification/__tests__/classify-failure.spec.ts (5.105 s)
PASS src/common/failure-classification/__tests__/failure-classification.path-parity.spec.ts (5.003 s)
PASS src/common/failure-classification/__tests__/dependency-missing.semantic.spec.ts (5.067 s)
PASS src/common/failure-classification/__tests__/failure-patterns.spec.ts (5.348 s)
FAIL src/common/failure-classification/__tests__/failure-classification.consumer-e2e.spec.ts (6.039 s)
Test Suites: 1 failed, 4 passed, 5 total
Tests:       3 failed, 101 passed, 104 total
```

⇒ **既有 27 条（含 `path-parity.spec.ts`）全部 PASS，一红都没有。**
⇒ 只有**新增**的 `failure-classification.consumer-e2e.spec.ts` 变红（3 条）。

**实验 2 —— 注入到另一侧消费者（`task.processor.ts` 的 catch 链）：**

```
PASS src/common/failure-classification/__tests__/failure-classification.path-parity.spec.ts
PASS src/common/failure-classification/__tests__/dependency-missing.semantic.spec.ts
PASS src/common/failure-classification/__tests__/classify-failure.spec.ts
PASS src/common/failure-classification/__tests__/failure-patterns.spec.ts
FAIL src/common/failure-classification/__tests__/failure-classification.consumer-e2e.spec.ts (5.74 s)
Tests:       3 failed, 101 passed, 104 total
```

⇒ 同样：**旧的 27 条全绿**，只有新守卫红。

**实验 3 —— 新增第三条分类路径（`src/modules/task/third-path.ts` import `classifyFailure`）：**

```
PASS src/common/failure-classification/__tests__/failure-classification.path-parity.spec.ts
PASS src/common/failure-classification/__tests__/dependency-missing.semantic.spec.ts
PASS src/common/failure-classification/__tests__/classify-failure.spec.ts
PASS src/common/failure-classification/__tests__/failure-patterns.spec.ts
FAIL src/common/failure-classification/__tests__/failure-classification.consumer-e2e.spec.ts (6.136 s)
Tests:       1 failed, 103 passed, 104 total
```

失败详情（断言把第三个消费者抓出来了）：

```
● 消费者全集恰为两处（新增第三条分类路径会红，强制补端到端断言）
    Array [
      "modules/task/task.processor.ts",
      "modules/task/task.service.ts",
+     "modules/task/third-path.ts",
    ]
```

### 1.3 复现结论

**验收官的三条指控全部成立。** 既有 27 条守卫**保护的是函数，不是两条失败路径**——「把裸 `enotfound` 加回消费者」这条回归它**完全挡不住**，且它自己对此**毫无察觉**（全绿）。

**指控 2 的机理补充（我实测确认）**：既有 `TOKENS` 用**纯文本搜索**，而消费者的**注释**里合法出现「解释器」「enotfound」等词（讲判据为什么这么写）——所以它**必须**排除这些词。排除之后，它就只能挡「整条判据分支」的抄法，挡不住**裸子串**形态。

---

## §2 改造后的断言设计（函数级 → 消费端级）

### 2.1 新增文件

| 文件 | 条数 | 作用 |
|---|---|---|
| `apps/admin-api/src/common/failure-classification/__tests__/failure-classification.consumer-e2e.spec.ts` | **18** | 消费端端到端 + 可测判据 |
| `apps/admin-api/src/common/failure-classification/__tests__/dependency-missing.semantic.spec.ts` | **5** | `dependency_missing` 现状钉桩 |
| **合计新增** | **23** | |

既有 27 条**一条未删**（职责分层，不是替换）。

### 2.2 §1 回调路径 —— 走**真实公开入口** `TaskService.handleCallback`

**为什么选它**：`handleCallback` 是**公开**方法（`task.service.ts:5799`），`inferFailureReason` 是 **private**（`:1029`）。
本 spec 走 `handleCallback` ⇒ **不需要** `(svc as any)` 访问私有方法 —— 私有性被 API 边界自然尊重。

**入参形状的坑（实测踩到并记录）**：回调路径有三道前置拒绝门（R-16/B-7 未派发、ADR-017 行身份不符、地址不符），若替身给的行是 `PENDING` + `executorAddress=null`，回调会被**拒收**，**根本走不到分类**。故替身必须给一个**已派发**的行（`RUNNING` + 匹配地址）—— 这条写进了 spec 注释，避免后人重蹈。

**断言对象是「落库的值」**，不是返回值：

```ts
const written = gate.calls[gate.calls.length - 1]?.patch?.failureReason;
```

即**真实条件 UPDATE 写进 `task_executions` 的那个值**。

**逐条说明**：

| # | 断言 | 挡住的回归 |
|---|---|---|
| 1 | 回调路径可达：分类结果**真的落进了**终态 UPDATE 的 patch | 防止「断言写在不产生落库副作用的位置」→ 空断言 |
| 2 | **H-2（消费端级）**：`ModuleNotFoundError` **绝不**落 `executor_offline` | 裸 `enotfound` 加回消费者/判据 |
| 3 | 反向：真实 DNS/连接失败**仍**落 `executor_offline` | 修 H-2 时误伤词边界 |
| 4 | 回调路径独有：`exitCode` 非 0 是兜底证据 | 抹平两条路径的**刻意**形状差异 |
| 5 | 回调路径：`logs` 单独也能驱动归因 | 只看 `errorMessage` 的半截实现 |

### 2.3 §2 派发路径 —— 走**真实** `TaskProcessor.handle(job)` 的 catch 链

**不是断言常量**：真实链路是

```
handle(job) → claim(条件 UPDATE) → executorService.dispatch 抛错
             → catch → classifyFailure({errorMessage, logs, errorCode})
             → exec.failureReason → finally 的终态条件 UPDATE patch
```

**断言对象同样是「落库的 patch」**（`persistCalls[last].patch.failureReason`）。

**逐条说明**：

| # | 断言 | 挡住的回归 |
|---|---|---|
| 6 | 派发路径可达：分类结果**真的落进了**终态 UPDATE 的 patch | 同 #1 |
| 7 | **H-2（派发端级）**：`ModuleNotFoundError` **绝不**落 `executor_offline` | 裸 `enotfound` 加回 `task.processor.ts` |
| 8 | 反向：真实 DNS/连接失败**仍**落 `executor_offline` | 同 #3 |
| 9 | 码化优先：`AppError` 的码命中码表 ⇒ **文案不得翻案** | 消费者绕开 `errorCode` 通道（`err instanceof AppError ? err.errorCode : null`） |

**踩到的坑（记录在 spec 注释里）**：catch 链里有**两个 token 前缀早退**（`[mutex_wait]` / `[deployment_wait]`）在分类**之前** `return`；且 claim 的条件 UPDATE 必须 `affected > 0` 否则 `handle` 直接返回。替身必须模拟这两点，否则根本到不了 catch。

### 2.4 §3 可测判据 —— 「消费者不得内联分类副本」

**核心设计问题**：如何写一条**能检出裸 `enotfound`**、又不被注释污染、又不「一改注释即红」的判据？

**答案：TypeScript AST + 位置敏感 + 双路径内容判定。**

**判据函数** `findInlineClassificationCopies(source, fileName)` 的三个维度：

1. **位置**——字面量必须在「拿它比对运行时内容」的位置：`x.includes(…)` / `re.test(x)` / `new RegExp(…)` / `x === "…"`。
   纯**声明**位置（`const field = "timeout"`）**不算**。
2. **形态**——正则字面量（`/…/i`）在**任何**位置都算（抄一份正则是典型形态）。
3. **内容**——命中下列**任一**即算副本：
   - **(a) 整段**被某条共享判据命中（抄了整条判据分支）；
   - **(b) 包含**某个判别性令牌（抄了判据的**子串**，如裸 `"enotfound"` / `"getaddrinfo"` / `"bwrap"` / `"解释器"`）。

**为什么 (b) 不可省 —— 这是本轮最关键的一处设计**：
只用 (a) 的话，消费者内联 `msg.includes("getaddrinfo")` **检不出来**（裸字面量 `"getaddrinfo"` 不被任何共享判据整段命中）。而 (b) 补的正是这个洞：**裸子串形态才是真实的回归形态**（H-2 原始缺陷就是裸 `enotfound`）。

**为什么用 AST 而不是文本搜索**：文本搜索会被**注释**污染（消费者的注释里合法出现「解释器」「enotfound」）。AST 只看**代码位置**，天然区分。

**判据自测（spec 内，4 条）**：

| # | 断言 | 作用 |
|---|---|---|
| 10 | 正例：内联裸 `enotfound` 必被检出（判据非空） | **判据非空**的证明 |
| 11 | 正例：内联正则常量形态（`/enotfound/i`）必被检出 | 另一条抄法 |
| 12 | 正例：内联整条判据分支（`"no module named"`）必被检出 | 覆盖 (a) 路径 |
| 13 | **反例**：字段名/普通文案**不得**被误报（判据位置敏感） | 证明判据不是「一改文案即红」 |

**结构守卫（3 条，spec 内）**：

| # | 断言 | 作用 |
|---|---|---|
| 14 | **消费者全集恰为两处**（`task.processor.ts` + `task.service.ts`） | 新增第三条分类路径 ⇒ 红 ⇒ **强制**补该路径的端到端断言 |
| 15 | 两个消费者都**不得内联分类副本**（0 处判据命中，失败信息带行号） | 裸 `enotfound` 加回消费者 ⇒ 红 |
| 16 | 判据名单必须含裸 `enotfound`（既有 `TOKENS` 刻意排除的正是这条） | 防止「为了少误报」把它从名单删掉 |

**判据名单的 load-bearing 自检（2 条，spec 内）**：

| # | 断言 | 作用 |
|---|---|---|
| 17 | 判据名单必须**逐条 load-bearing**：每条令牌都出现在**被成功归因**的真实文案（见证语料）里 | 杜绝「装饰性令牌」 |
| 18 | 见证语料必须都被共享判据归成**已知原因**（不得全落 UNKNOWN） | 保证见证语料有效 |

**§2.4 这两条自检在编写过程中真的抓到了我自己的缺陷**（详见 §7.2）—— 初版名单里的 `getaddrinfo` 与 `no online executor` 在 (a) 路径上是**死令牌**（不被任何共享判据整段命中）。我据此把判据改成 (a)+(b) 双路径，并从名单里剔除真正无意义的 `no online executor`。

**为什么既有 27 条挡不住第 14 条**：它只管**判据常量**的**定义处**（`全 src/ 只有 failure-patterns.ts 定义这些常量`），**管不到「谁在调 `classifyFailure`」**。§1 实验 3 实证了这一点。

### 2.5 三层防线的分工（不重复造轮子）

| 层 | 既有 `path-parity.spec.ts`（27 条） | 新增 `consumer-e2e.spec.ts`（18 条） | 新增 `dependency-missing.semantic.spec.ts`（5 条） |
|---|---|---|---|
| 判据表 | ✅ 逐条比对期望值 | 复用期望值，但**从消费者入口**跑出来 | — |
| 单一事实源 | ✅ 常量唯一性 + 无内联副本（文本搜索，有盲区） | 补**可测判据**（AST）+ **消费者全集** | — |
| 端到端 | ❌ **无**（致命缺口） | ✅ 回调 + 派发，**落库**断言 | ✅ 依赖缺失专项 |
| 语义钉桩 | — | — | ✅ `dependency_missing` 现状 + 迁移条件 |

---

## §3 **反向验证实证**（加回缺陷 ⇒ 变红）

### 3.1 方法

**在 `/tmp` 下做，绝不污染仓库**：
- `/tmp/gh/admin-api/` = `src/` 全量副本 + `package.json` / `tsconfig.json` + `node_modules` 软链（指向真仓，只读）。
- 注入回归 → 跑 `jest src/common/failure-classification` → 记录红绿 → `cp` 还原 → `diff -q` 校验还原。

**基线**（注入前，隔离副本）：

```
PASS src/common/failure-classification/__tests__/classify-failure.spec.ts (6.225 s)
PASS src/common/failure-classification/__tests__/dependency-missing.semantic.spec.ts (6.3 s)
PASS src/common/failure-classification/__tests__/failure-classification.path-parity.spec.ts (6.348 s)
PASS src/common/failure-classification/__tests__/failure-patterns.spec.ts (6.475 s)
PASS src/common/failure-classification/__tests__/failure-classification.consumer-e2e.spec.ts (9.4 s)
Test Suites: 5 passed, 5 total
Tests:       104 passed, 104 total
```

### 3.2 三种回归形态 × 守卫反应（**决定性证据**）

| 注入的回归 | 既有 27 条 (`path-parity`) | 新守卫 (`consumer-e2e`) | 结论 |
|---|---|---|---|
| **① 裸 `enotfound` → `task.service.ts::inferFailureReason`** | ✅ **PASS**（全绿，无感） | ❌ **FAIL（3 条）** | 旧护栏**完全无效**，新护栏**有效** |
| **② 裸 `enotfound` → `task.processor.ts` catch 链** | ✅ **PASS** | ❌ **FAIL（3 条）** | 同上 |
| **③ 新增第三条分类路径（新文件 import `classifyFailure`）** | ✅ **PASS** | ❌ **FAIL（1 条）** | 同上 |

### 3.3 注入 ① 的失败详情（摘）

```
● 消费端端到端 · 回调路径（TaskService.handleCallback → 落库 failureReason） ›
  回调路径可达：分类结果真的落进了终态 UPDATE 的 patch

    Expected: "package_fetch_failed"
    Received: "executor_offline"

● 消费端端到端 · 回调路径 › H-2（消费端级）：ModuleNotFoundError 绝不能落成 executor_offline

    expect(received).not.toBe(expected) // Object.is equality
    Expected: not "executor_offline"

● 可测判据：消费者不得内联分类副本（含裸 enotfound） ›
  两个消费者都不得内联分类副本（0 处判据命中）

    Object {
      "file": "modules/task/task.service.ts",
-     "findings": Array [],
+     "findings": Array [
+       "L1037 EXECUTOR_OFFLINE_PATTERN enotfound",
+     ],
    }
```

⇒ 新守卫**三层同时报警**：① **行为侧**（落库归因错了）② **行为侧**（H-2 否定式）③ **结构侧**（内联副本被检出，含精确行号）。
⇒ 失败信息**自带定位**（`L1037`），不是「某个断言红」。

### 3.4 还原校验

```
RESTORED OK
PASS src/common/failure-classification/__tests__/dependency-missing.semantic.spec.ts
PASS src/common/failure-classification/__tests__/classify-failure.spec.ts
PASS src/common/failure-classification/__tests__/failure-patterns.spec.ts
PASS src/common/failure-classification/__tests__/failure-classification.path-parity.spec.ts
PASS src/common/failure-classification/__tests__/failure-classification.consumer-e2e.spec.ts
Tests:       104 passed, 104 total
```

真仓侧：`git diff --stat` 对 `task.service.ts` / `task.processor.ts` / `failure-patterns.ts` **全空**（§7.3 有输出）。

---

## §4 `dependency_missing` 语义的**现状钉桩**（不改行为）

新增 `dependency-missing.semantic.spec.ts`，**5 条**。本轮**不改产品行为**（新增码值属协议变更，需 bump `protocolVersion`，是下一轮的事）。

### 4.1 五类断言

| # | 断言 | 作用 | 何时会红 |
|---|---|---|---|
| 1 | **现状**：`ModuleNotFoundError` → `package_fetch_failed` | 记录**已知语义近似** | `dependency_missing` 立项并迁移时 |
| 2 | 现状（判据层）：`PACKAGE_FETCH` 认它、`EXECUTOR_OFFLINE` **不**认它 | 判据侧前提 | 判据改动 |
| 3 | **底线**：依赖缺失**绝不**回退到 `executor_offline` | **本轮修复的核心价值** | **任何**把它改成 `executor_offline` 的改动 |
| 4 | 底线（判据侧）：裸 `enotfound` 不得回到离线判据 | H-2 的判据层钉子 | `\benotfound\b` 被改回裸子串 |
| 5 | **迁移条件**：`dependency_missing` 码值**尚未立项**（枚举里查无此值）＋ 迁移前归因保持 `package_fetch_failed` | 把「暂时」写成**可执行的**断言 | 码值立项时 / 归因被改 |

### 4.2 为什么「底线」这一条**不依赖**未来的码值选择

`executor_offline` 在**默认重试集**里。把它误判成它，后果有三：

1. **白烧重试预算**——重试不会让 `pandas` 自己装上；
2. **排障方向被带偏**——运维去查执行器在线情况，而问题在依赖清单；
3. **排队语义被误触发**——派发路径的互斥回队门（`failureReason === EXECUTOR_OFFLINE` ⇒ 回 WAITING 等唤醒）会把这类执行**无限排队**而不是落死。

所以无论最终归 `package_fetch_failed` 还是 `dependency_missing`，**都不是** `executor_offline`。这条**恒成立**。

### 4.3 为什么「迁移条件」要写成**断言**而不是注释

注释会被人跳过、也不会在码值立项时**主动变红**。写成断言（`ExecutionFailureReason.DEPENDENCY_MISSING` 当前为 `undefined`）则：

- 码值立项的那一天 ⇒ 这条**自动红** ⇒ 强制人来看这段注释并显式更新期望值；
- 不会有人「看到现状不对就随手改判据」（那是协议变更，不在本轮写域内）。

---

## §5 孙Agent 结论（消费者全集是否只有两处）

**派了 1 个孙Agent（角色：【CodeGraph 探查专项】）**，只读，**未改任何文件**。
任务书明确要求「先用 CodeGraph MCP 探查；MCP 不可用则用 `codegraph explore` CLI」，并给出 `projectPath`。

### 5.1 结论：**恰好两处消费者，无第三条分类路径**

| 消费者 | 位置 | 类型 |
|---|---|---|
| `TaskProcessor::handle` | `task.processor.ts:424`（import `:36`） | 派发失败路径 |
| `TaskService::inferFailureReason`（private） | `task.service.ts:1034`（import `:17`，声明 `:1029`） | 回调路径 |

**交叉验证**：孙Agent 用 `callers` / `impact -d 3` / `explore` + 全仓文本搜索（`classifyFailure` 与 `failure-classification` 的 import，含别名/动态形式）——`scripts/` **0** 个消费者，`packages/` **0** 个消费者。

**我自己的独立复核**（CodeGraph CLI + grep 双向）得到**同样结论**，并额外补了一条孙Agent 没做的**机械**检查：

```
=== consumers only (AST 扫描，只取代码位置的字面量) ===
task.service.ts   → 0 处判据命中
task.processor.ts → 0 处判据命中
```

### 5.2 三个「可能的第三条路径」的逐一排查（孙Agent 结论）

| 疑似位置 | 结论 | 依据 |
|---|---|---|
| `execution-callback.controller.ts` | ❌ **不是** | **零** `failureReason` 引用；只转发数组（`:159` / `:273`），消费的是**已分类好的** `cb.failureReason` |
| `executor.service.ts` | ❌ **不是** | 无文本分类；只写 1 个**硬编码** `EXECUTOR_RESTART`（`:1968`）；`:3303`/`:4685` 的 `failureReason=…` **只在日志字符串里** |
| `scheduler.service.ts` | ❌ **不是** | 无分类；4 个**硬编码** sweep 常量（TIMEOUT / STALE_RECOVERED / NEVER_DISPATCHED ×2） |
| `app-deployment.service.ts:4027/4036/4047` | ❌ **不是** | 写的是 `app_rollout` 行的 `reason: string` —— **不同域**，不是 `ExecutionFailureReason` |
| `notification/execution-events.listener.ts:164` | ❌ **不是** | 落 `digest` 记录，不是 `task_executions`；且是**透传** `event.failureReason` |
| `packages/autocodeflow-node-sdk/src/context.ts:447` | ❌ **不是** | 客户端 SDK 的**默认值**，admin 侧 DTO `@IsIn` 会再校验 |

**孙Agent 顺带发现的一个事实**：`task.service.ts:600-608` 是 7 个判据常量的 **re-export**（保留给 spec / OIDC 契约面），**不是**新的消费者。

### 5.3 这直接决定了守卫该断言几处

**两处**。故本 spec 的结构守卫断言**消费者全集恰为两处**，并给出**明确清单**——
新增第三处 ⇒ 红 ⇒ 强制补上该路径的端到端断言（§1 实验 3 实证）。

### 5.4 孙Agent 发现的一个**已清理**的残留

它报出 `apps/admin-api/src/__calib2.ts` —— 是**我自己**在标定时临时放进 `src/` 根的脚本（未被 CodeGraph 索引，因未 tracked）。
**我已删除**（`rm -f apps/admin-api/src/__calib2.ts`），并在 §7.3 的 `git status` 里确认它不在了。
教训记录：临时脚本放 `src/` 下会被 `tsc` 编译、也会污染 CodeGraph 索引面 —— 标定脚本应放 `/tmp`。

---

## §6 守卫强度自评（三类仍会漏判的改动）

**先说结论：我不宣称「已完全防住」。** 下面三类改动**会漏判**，且我知道它们漏。

### 漏判 ① **改名** —— 判据令牌换了词

**为什么漏**：结构守卫靠**判别性令牌名单**（`enotfound` / `bwrap` / `解释器` …）检出内联副本。
若有人把消费者里的内联副本改成**名单外的词**（例如自造 `const DEAD = "getaddrinfo failure"`—— 不，任何含 `getaddrinfo` 的串都被覆盖；真正的漏法是**完全换一套词**，如 `"dns resolution failed"`），令牌名单就抓不到它。

**为什么这不可完全避免**：判据必须有一份「可疑词」名单，而任何名单都是**枚举**——枚举必然漏新词。
把名单扩到「所有判据的语义闭包」是不可能的。

**缓解**：行为侧（§2.2/§2.3 的落库断言）**部分**兜底 —— 但只对**已入表**的文案有效。

**残留风险**：**中**。一个用全新措辞的内联分支，若它恰好只影响**未入表**的文案 ⇒ 全绿。

### 漏判 ② **内联** —— 换一种抄法躲开判据的位置/形态

**为什么漏**：我的判据是**位置敏感**的（只在「比对位置」的字面量才算）。若有人写成：

```ts
const parts = msg.split(":");           // ← split 是「比对位置」吗？是，但 "…" 不是字面量
if (parts[0] === "ModuleNotFoundError") // ← 这是比对位置且是字面量 ⇒ 会被抓
```

……但若写成：

```ts
const kw = "Module" + "NotFound" + "Error";  // 拼接 ⇒ AST 看不见完整字面量
if (msg.includes(kw)) { ... }
```

⇒ **判据抓不到**（拼接字面量在 AST 里是 `BinaryExpression`，不是 `StringLiteral`）。

**为什么这不可完全避免**：要抓拼接，就得做常量折叠 + 数据流分析 —— 那已经是一台编译器。
**当前判据的代价**：它**不**抓拼接，但**它确实**抓「直接字面量」这一最常见形态（含裸 `enotfound`）。

**残留风险**：**低-中**。拼接是刻意的规避写法，正常开发不会这么写；且行为侧断言仍会兜底**已入表文案**。

### 漏判 ③ **新增第三条分类路径** —— 且不走 `classifyFailure`

**分两种**：

- **(a) 新路径也 import `classifyFailure`** ⇒ **被挡住**（消费者全集守卫红，§1 实验 3 实证）。
- **(b) 新路径**自带一套**自己的判据**（完全不 import `classifyFailure`）⇒ **不被挡住**。

**为什么 (b) 漏**：我的「消费者全集」守卫按 **import `classifyFailure`** 来数消费者。
一个自带判据的新路径**根本不 import 它** ⇒ 既不在清单里，也不在内联副本判据的扫描范围（只扫两个已知消费者文件）。

**为什么这不可完全避免**：要抓它，得扫**全 `src/`** 找「像分类判据的代码」—— 而「像分类判据」没有可判定的边界（任何 `includes` 都是比对）。
我实测过：全 `src/` 的「比对位置 + 命中共享判据」有 **47 处**命中（多数是**错误码表文案**、DTO 描述、agent 重试判据等**合法**用法）—— 显然不能一刀切禁止。

**缓解（已做）**：只扫**两个已知消费者**（`task.processor.ts` / `task.service.ts`）⇒ 误报率 0，且覆盖了「在既有路径上分叉」这个最高频形态。
「全新文件自带判据」这一形态**未被覆盖**。

**残留风险**：**中**。这是三类里**最难**的一类，也正是我**不宣称「已完全防住」**的主要原因。

### 6.1 补充：我**刻意不**覆盖的两类改动

| 改动 | 为什么**不**挡 |
|---|---|
| 判据**改措辞**但归因不变 | **不该挡** —— 归因没变，端到端断言红是**误报**，会制造「改注释即红」的脆弱护栏 |
| 规则**改顺序**但这批文案恰好不受影响 | 顺序偏序由既有 27 条的期望值表**部分**覆盖；**不完全**覆盖 |

### 6.2 一句话自评

**这 23 条新守卫堵住的是「在既有两条失败路径上分叉」这一最高频、最高危的回归形态**（实测三种注入形态全部变红），
**但它对「全新文件自带一套判据」无能为力**，对「用名单外的词内联」也只能靠行为侧**部分**兜底。
**它把「函数级」升级为「消费端级」，但没有、也不可能把守卫变成「语义级」。**

---

## §7 验证原始输出

### 7.1 定向测试（全绿；唯一红项属他人在途改造，已标注）

命令（**必须带 `--experimental-vm-modules`**，否则 ESM 套件全红）：

```
cd apps/admin-api && npx --node-options=--experimental-vm-modules jest \
  src/common/failure-classification src/modules/task --silent
```

输出：

```
FAIL src/modules/task/__tests__/executor-protocol-contract.spec.ts (8.746 s)
FAIL modules/task/__tests__/executor-protocol-contract.spec.ts (8.746 s)
Test Suites: 1 failed, 76 passed, 77 total
Tests:       1 failed, 1746 passed, 1747 total
```

**唯一失败项 = `executor-protocol-contract.spec.ts`**，失败详情：

```
● A3 执行器协议契约（admin-api 侧） › ExecutionFailureReason 全集与契约 all 逐值一致
    - Expected  - 120
    + Received  +  15
```

**归因实证**（不是推断 —— 我把 `protocol.json` 临时换回 HEAD 版本重跑，再原样还原）：

```
$ git show HEAD:packages/executor-protocol/protocol.json > packages/executor-protocol/protocol.json
$ npx --node-options=--experimental-vm-modules jest src/modules/task/__tests__/executor-protocol-contract.spec.ts --silent
PASS src/modules/task/__tests__/executor-protocol-contract.spec.ts
Tests:       9 passed, 9 total

$ cp /tmp/gh/protocol.json.inflight packages/executor-protocol/protocol.json
$ git diff --stat packages/executor-protocol/protocol.json
 packages/executor-protocol/protocol.json | 544 ++++++++++++++++++++++++++++++++++-
 1 file changed, 527 insertions(+), 17 deletions(-)      ← 已在途改造，已原样还原
```

⇒ 该失败**完全**来自 `packages/executor-protocol/protocol.json` 的**在途改造**（`contract-source` 的写域，+527 行），
**与本轮改动无关**。换回 HEAD 即绿。

**我的两个新 spec 单独跑（23 条全绿）**：

```
$ npx --node-options=--experimental-vm-modules jest \
    src/common/failure-classification/__tests__/failure-classification.consumer-e2e.spec.ts \
    src/common/failure-classification/__tests__/dependency-missing.semantic.spec.ts --silent
PASS src/common/failure-classification/__tests__/dependency-missing.semantic.spec.ts
PASS src/common/failure-classification/__tests__/failure-classification.consumer-e2e.spec.ts
Test Suites: 2 passed, 2 total
Tests:       23 passed, 23 total
```

**既有 `failure-classification` 四个 spec 全部不受影响**（全绿）：

```
PASS src/common/failure-classification/__tests__/classify-failure.spec.ts
PASS src/common/failure-classification/__tests__/failure-patterns.spec.ts
PASS src/common/failure-classification/__tests__/dependency-missing.semantic.spec.ts
PASS src/common/failure-classification/__tests__/failure-classification.path-parity.spec.ts
PASS src/common/failure-classification/__tests__/failure-classification.consumer-e2e.spec.ts
Test Suites: 5 passed, 5 total
Tests:       104 passed, 104 total
```

> ⚠️ **未跑全量**（`jest --silent` 全仓）—— 按任务纪律，`protocol.json` 正被另一路改造，
> 跑全量会把**他人在途改动**的红算到我头上。需要时我只跑上述**定向范围**。

### 7.2 判据自测**真的抓到了我自己的缺陷**（过程记录）

写「判据名单必须逐条 load-bearing」这条自检时，它**首次运行就红了**：

```
● 判据名单必须逐条 load-bearing（每条令牌都出现在被成功归因的真实文案里）
    Object {
      "deadTokens": Array [
        "sandbox_unavailable",
        "package fetch",
        "pull package",
        "download package",
        "无可用执行器",
      ],
    }
```

以及「判据自测 · 正例：内联裸 enotfound 必被检出」最初也红了：

```
    Expected: true
    Received: false
      775 |     expect(
      776 |       found.some((f) => f.kind === "substring-token" && f.literal === "enotfound"),
      777 |     ).toBe(true);
```

**两个真实缺陷**（不是测试写错，是**判据本身**有洞）：

1. **死令牌**：`getaddrinfo` / `no online executor` 等**不被任何共享判据整段命中** ⇒ 在 (a) 路径上是装饰性的。
   ⇒ 修法：判据改为 **(a) 整段命中 + (b) 包含令牌** 双路径；并把**真正无意义**的 `no online executor` 剔除（它落 UNKNOWN，不是中台判据的分支）。
2. **判据形态误判**：我原以为裸 `"enotfound"` 走 (b) 路径，实测它**整段**就被 `\benotfound\b` 命中 ⇒ 走 (a)。
   ⇒ 修法：把自测改成断言「**必被检出**」（不绑死走哪条路径），并在注释里写明这个事实。
   **这条恰恰证明了「裸 `enotfound` 与 `\benotfound\b` 只差一个反斜杠」这个要害**。

**这正是「自检必须机械校验判据本身有效」的价值** —— 若我只写「判据非空」而不写「名单逐条 load-bearing」，
这些死令牌会一直躺着，而 spec 看起来照样全绿。

### 7.3 写域与提交纪律

```
$ git status --porcelain apps/admin-api/src/modules/task/ apps/admin-api/src/common/failure-classification/
?? apps/admin-api/src/common/failure-classification/__tests__/dependency-missing.semantic.spec.ts
?? apps/admin-api/src/common/failure-classification/__tests__/failure-classification.consumer-e2e.spec.ts

$ git diff --stat apps/admin-api/src/modules/task/task.service.ts \
              apps/admin-api/src/modules/task/task.processor.ts \
              apps/admin-api/src/common/failure-classification/failure-patterns.ts
（空 —— 三个非测试源码文件**逐字节未改**）
```

⇒ **零非测试源码改动**。`failure-patterns.ts` / `task.service.ts` / `task.processor.ts` 只读。
⇒ `executor.service.ts` / `scheduler.service.ts` / `leader-gate` **完全未碰**（串行区）。
⇒ 本轮**未执行任何 git 写操作**（未 add / 未 commit）—— 提交由主Agent 统一进行，
以便它把本轮多路改动一并核对。

**新增条数**：**23**（`consumer-e2e` 17 + `dependency-missing.semantic` 6）。
既有 27 条**一条未删**。

---

## §8 附：探查工具与方法（可复核）

| 手段 | 用途 |
|---|---|
| CodeGraph CLI v1.6.2（`/home/yongsheng/.local/bin/codegraph`） | `status` / `sync`（开工时同步 8 个在途改动文件）/ `explore` / `callers` / `impact -d 3` / `node <file> --offset --limit` |
| CodeGraph MCP | **不可用**（本会话未暴露 `codegraph_explore`）⇒ 按 AGENTS.md 规定降级 CLI，并在孙Agent 任务书中同样注明 |
| `typescript` AST（`ts.createSourceFile`） | 判据的**位置敏感**扫描（只取代码位置的字符串/正则字面量，天然排除注释） |
| `/tmp` 隔离副本 | 反向验证（`src/` 全量副本 + `node_modules` 软链），**仓库零污染** |
| 孙Agent（只读） | 消费者全集探查（`callers` + `impact` + 全仓文本搜索三重交叉验证） |

**标定纪律**（避免写出「看起来对」的判据）：
- 所有判据先在**真实现场**上标定 —— 我把 7 条共享判据从模块**直接加载**（不手抄），
  对两个消费者的**全部字面量**跑了一遍，确认**当前命中数为 0**（这是新守卫成立的前提）；
- 判据的**每一条自检**都有正例 + 反例；
- 名单的 load-bearing 由**机械断言**保证（§7.2 实证它抓到了我自己的洞）。

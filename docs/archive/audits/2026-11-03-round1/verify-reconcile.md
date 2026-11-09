# 独立验收与双会话对账（verify-reconcile）

> **角色**：只读审计 / 对抗式验收 —— 证明「他们说做到的事，是否真的做到了」。
> **受众**：主Agent（Round 2 决策）· **状态**：一次性验收记录（不承诺持续更新）
> **测量窗口**：2026-11-03 02:42 → 03:12（Asia/Shanghai）
> **本文件是唯一被本 Agent 写入的文件**；未执行任何 git 写操作，未改动任何源文件。

---

## §1 验收方法与环境

### 1.1 方法

| 手段 | 用途 | 说明 |
|---|---|---|
| `git show <sha> -- <file>` | 读提交内容，**不看提交信息** | 提交信息仅作「待证命题」清单 |
| CodeGraph v1.6.2 CLI | 定位/符号/影响面 | `codegraph status` 开工即 `Index is up to date`，无需 sync |
| 复刻判据做**反向实验** | 验证守卫强度 | 正则与守卫判据在 `/tmp/vr/` 复刻后喂入假想分叉，**不触碰仓库** |
| 全量 `jest` 实测 | 测试基线 | `npx --node-options=--experimental-vm-modules jest --silent`（必须带该 flag） |
| python3 解析 | 类型重复度 | 解析 `components.schemas` 文本（codegraph 数不到嵌套键） |

### 1.2 ⚠️ 并发写入干扰（**本次验收最重要的环境事实**）

验收期间**另一个会话在持续提交与改写**，`HEAD` 在我眼皮底下前进了两次：

```
02:42  开工，HEAD = b5a73734
02:48  HEAD → 09d69dab  refactor(executor): 调度决策日志收敛为单一 schema
02:52  HEAD → 77eacda5  docs(audit): Round 1 台账收口——两会话口径合并
```

`reflog` 还显示 **`b5a73734` 本身是 amend 出来的**（`HEAD@{2}: commit (amend)`，原为 `bc80a68b`）：

```
77eacda5 HEAD@{0}: commit: 台账收口
09d69dab HEAD@{1}: commit: 决策日志 schema 化
b5a73734 HEAD@{2}: commit (amend): 派发过滤链收拢      ← amend
bc80a68b HEAD@{3}: commit: 派发过滤链收拢
09b5d3c0 HEAD@{4}: commit: 修存量 P1
```

**这直接改变了被验收对象的内容**：同一个 ref `b5a73734`，02:44 读到 `executor.service.ts` = 8,454 行，02:52 读到 = 8,489 行。**「对某个 commit 验收」在当前工作流下是不稳定操作** —— 见 §8 D-1。

**工作区 dirty 面在验收期间发生迁移**：

| 时刻 | dirty 文件 |
|---|---|
| 02:42 | `leader-gate/*`、`executor.service.ts`、`scheduler/*`、`00-round1-ledger.md`、`dispatch-decision-log.schema.ts`(新) |
| 02:56 | `app-deployment.service.ts`(+60/−4)、2 个 app-deployment spec、`scheduler/*`、`leader-gate/*`（executor 与 ledger 已提交） |
| 03:08 | 上述 + `app-deployment.trigger-operator.spec.ts`、**`packages/executor-protocol/protocol.json`(+300/−35)**、`scripts/check-failure-reasons.mjs` |

**结论**：写入面**宽于任务书列的 4 个文件**，`app-deployment.service.ts`、`protocol.json`、`check-failure-reasons.mjs` 均已进入 dirty。

### 1.3 全量测试：**验收触发时点是红的**，且非 flaky

我于 03:0x 独立跑全量（`/tmp/vr/adminapi-jest.log`）：

```
Test Suites: 2 failed, 420 passed, 422 total
Tests:       3 failed, 7451 passed, 7454 total
```

失败集中在 **`executor-protocol-contract.spec.ts`**（`modules/task` 与 `modules/health` 两份）。

**归因（已定位，不是被验收 commit 的问题）**：`packages/executor-protocol/protocol.json` 正在被 `contract-source` 队友从 `all: string[]` 改造为 `all: {code,zh,en,remediationKey,owner,reportable}[]`，而契约 spec 仍按「字符串数组」比对 ⇒ `expect(sortStr(protocol.failureReason.executorReportable)).toEqual(sortStr(derived))` 失败。

**重跑确认非 flaky**：单跑该 spec 复现同样失败（`1 failed, 8 passed, 9 total`），确定性红。**如实标注：本次全量红灯系并发写入在途工作所致，不作为 `09b5d3c0` / `b5a73734` 的否决依据**；但也说明**「当前主干全绿」这一断言在今天任何时刻都可能不成立**。

---

## §2 commit `09b5d3c0` 逐项验收（失败分类单一事实源 + 存量 P1）

### 2.1 结论表

| # | 待证命题 | 判定 | 证据 |
|---|---|---|---|
| A1 | `enotfound` → `\benotfound\b` 未引入新漏判，真实 `ENOTFOUND`/`getaddrinfo` 仍命中 | ✅ **成立** | 复刻新旧正则跑 12 条真实文案，**漏判数 = 0**（§2.2） |
| A2 | 修好后 `ModuleNotFoundError` 不再被离线判据吞 | ✅ **成立** | 旧 `true` → 新 `false`，3 条模块缺失文案全部翻转（§2.2） |
| A3 | 补 `modulenotfounderror|no module named` 到 `PACKAGE_FETCH_PATTERN` 是**语义正确**的 | ⚠️ **存疑（新误判）** | 用户脚本 `import pandas` 失败 ≠ 平台拉包失败（§2.3） |
| A4 | 新增 27 条守卫**真能挡住回归** | ❌ **仅部分成立，存在致命盲区** | 三类真实分叉全部漏过，含「把 `enotfound` 补回去」本身（§2.4） |
| A5 | 回调路径新增 `APPLICATION_MISSING` / `SANDBOX_UNAVAILABLE` 是「修正缺陷」还是「引入行为变化」 | ✅ **是真行为变更，方向正确，且风险低于预期** | 回调路径为终态路径，无 BullMQ 重试 ⇒ **仅改标签**（§2.5） |
| A6 | 提交信息 `420 套件 / 7409 用例全绿` | ❌ **不可复现** | 实测 422/7454（且当时红 3 例） |
| A7 | `tsc --noEmit` 0 错、4 个守卫全绿 | ⏸ **未独立复核**（本轮未跑 tsc；守卫脚本当时正被另一队友修改） | 如实标注 |

### 2.2 A1/A2 反向实验（硬证据）

在 `/tmp/vr/regex-test.mjs` 复刻新旧 `EXECUTOR_OFFLINE_PATTERN` 对比：

- **12 条真实「离线/DNS/连接」文案**（`getaddrinfo ENOTFOUND host`、`connect ECONNREFUSED 127.0.0.1:8000`、裸 `ENOTFOUND`、带引号 `'ENOTFOUND'`、`指定的固定执行器 "…" (uuid) 已离线`、`executor node-1 is offline`、`socket hang up` …）→ **新旧结果完全一致，漏判 0**。
- **3 条模块缺失文案** → 旧 `true` / 新 `false`，全部正确翻转。

提交信息称「8 例矩阵中仅目标一例改变」——我的 15 例矩阵结论一致（无遗漏翻转）。**A1/A2 可放行。**

### 2.3 A3：`ModuleNotFoundError → PACKAGE_FETCH_FAILED` 是**新的误判**（本条为实质发现）

语义拆解：

| 输入 | 实际发生的事 | 判成 `package_fetch_failed` 是否贴切 |
|---|---|---|
| `ModuleNotFoundError: No module named 'pandas'`（用户脚本 `import pandas`） | 脚本**跑起来了**，`requirements` 装完了，只是用户没声明 `pandas` | ❌ **不贴切**：拉包阶段从未尝试 `pandas` |
| `pip install failed` / `uv pip install` 非零 | 拉包阶段真的失败 | ✅ 贴切 |
| `Cannot find module 'x'`（Node 源文件缺失） | 运行期 resolve 失败 | ⚠️ 勉强 |

**判断**：本提交把「依赖没装上」从**更错的**桶（`executor_offline`：让用户去查执行器在线状态，并会触发互斥回等待）挪到了**次错的**桶。相对原状态是**净改善**，但 `PACKAGE_FETCH_FAILED` 的语义是「拉包失败」，而用户需要读到的是「**你的脚本 import 了一个未声明的依赖**」。

**加重情节**：提交把这条语义**钉进了金标表**（`failure-classification.path-parity.spec.ts` 断言 `ModuleNotFoundError: No module named 'pandas'` → `PACKAGE_FETCH_FAILED`）。从此它不再是「待议的实现细节」，而是**受守卫保护的既定语义** —— 将来要纠正得先推翻守卫。**把一个存疑语义冻结成金标，是需要产品/设计确认的动作，不应由修复提交单方决定。**

**建议**（Round 2b，不阻塞）：新增 `dependency_missing`（或 `dependency_declaration_missing`）作为 `PACKAGE_FETCH_FAILED` 的兄弟类，`owner = task-author`，处置指向「在 requirements/package.json 声明依赖」。判据：`\bmodulenotfounderror\b` / `no module named` → 新类；仅 `pip install`/`npm install`/`git clone` 失败 → 保留 `PACKAGE_FETCH_FAILED`。

### 2.4 A4：27 条守卫的强度 —— **能挡「原样重抄」，挡不住「换个写法」**

先确认条数：17 条行为表 + 4 条专项（DNS 反向 / H-2 直接否定 / exitCode 不对称 / 码化优先）+ 6 条结构（2 消费者 × 2 + 全局唯一 + 判据完整性）= **27 条，与提交信息一致** ✅。

我用 `/tmp/vr/guard-blindspot.mjs` 复刻守卫的三条判据（`PATTERN_NAMES` 的 `\bconst NAME\b`、`TOKENS` 子串、`import classifyFailure`），喂入 4 份假想 consumer 源码：

| 假想分叉 | 守卫判定 |
|---|---|
| **A. HEAD 旧版形态**（`export const EXECUTOR_OFFLINE_PATTERN` + `module not found`） | 🔴 红（**能挡住**）→ 提交信息「对 HEAD 旧版实测可命中」**成立** |
| **B. 改名 + 纯中文判据内联**（`const LOCAL_OFFLINE_RE = /无可用执行器\|执行器[^\n]{0,20}?(?:离线\|不可用)/`） | 🟢 **绿（漏过）** |
| **C. 把 `enotfound` 裸子串补回消费者**（`const extraOffline = /enotfound\|econnrefused/i`） | 🟢 **绿（漏过）** ⚠️ |
| **D. 改名 + `bwrap` / `pip install` / `git clone` 内联** | 🟢 **绿（漏过）** |

**C 是最严重的一条：本提交修复的缺陷本身（裸子串 `enotfound`），可以在消费者里原样加回来，而 27 条守卫全绿。**

原因有三，且都是**设计选择**而非疏忽：

1. `TOKENS` **刻意排除**了 `git clone` / `pip install` / `bwrap` / `requirements` / `超时`，**且完全没有中文词**，也没有 `enotfound`。注释的理由（避免「改注释即红」的脆弱断言）是合理的，但代价是**中文支路与 DNS 分支的回归完全无守卫**。
2. `\bconst NAME\b` 只认**同名**常量 ⇒ 改名即绕过。
3. **最关键**：行为金标表里的 `dispatchVerdict` / `callbackVerdict` **直接调 `classifyFailure`，根本不经过 `task.processor.ts` / `task.service.ts`**。spec 自己已承认这点（「等值断言本身会退化成同一个函数调两次」）。于是**行为层对「消费者分叉」零覆盖**。
4. 我另行确认：`apps/admin-api/src/modules/task/__tests__/` 与 `modules/executor/__tests__/` 下**没有任何** `ModuleNotFound` / `No module named` 端到端用例（grep 空），即**没有 e2e 兜底**。

**结论**：守卫挡住了「原样重抄」，但**没有挡住「分叉这个动作本身」**——而这正是结构守卫自述要挡的东西（「②挡『起个新名字再抄一份』，③挡『匿名正则直接内联』」）。②③两条在实测中对 B/C/D 全部失效。

**判据**：这属于**守卫宣称强度 > 实际强度**，与项目反复强调的「文档/宣称 vs 事实漂移」同构，只是发生在测试里。**不阻塞放行，但必须记账。**

### 2.5 A5：回调路径新增两条规则 —— 是行为变更，但风险比想像的低

**事实**：旧 `inferFailureReason` 规则集 = `INTERPRETER → TIMEOUT → EXECUTOR_OFFLINE → PACKAGE_FETCH → exitCode→SCRIPT_ERROR → SCRIPT_ERROR → UNKNOWN`；新 `classifyFailure` = `errorCode优先 → INTERPRETER → **APPLICATION_MISSING** → TIMEOUT → **SANDBOX_UNAVAILABLE** → EXECUTOR_OFFLINE → PACKAGE_FETCH → exitCode → SCRIPT_ERROR → UNKNOWN`。**两条是新插入的，所以是语义增量，不是等价重构。**

**但影响面被我核实为「仅标签」**：回调路径（`handleCallback`，`task.service.ts:6060+`）直接把终态写成 `TIMEOUT` 或 `FAILED`：

```ts
patch.status = failureReason === ExecutionFailureReason.TIMEOUT
  ? ExecutionStatus.TIMEOUT : ExecutionStatus.FAILED;
```

**回调路径没有任何 BullMQ 重试**（执行器已经把任务跑完了）。因此：
- 不存在「新增 `SANDBOX_UNAVAILABLE` 后回调路径漏过不可重试门禁」的风险 —— 因为它本来就不重试。
- 两条新规则的收益 = **修正两条路径的标签不一致**（用户看到的文案、Dashboard 聚合、按 `failureReason` 的筛选）。

**但请注意一处不对称，须记账**：派发路径对 `SANDBOX_UNAVAILABLE` / `APPLICATION_MISSING` 有 `UnrecoverableError` 门禁（`task.processor.ts:519 / :554`），**回调路径没有、也不需要**（终态）。这不是缺陷，但如果将来有人照抄「回调路径也补上门禁」就会引入无效代码。值得在代码注释里点明（当前 `failure-patterns.ts` 头注未说明这点）。

**判定：这是「修正了原有缺陷」（两路径归因不一致），不是「引入有害行为变化」。** 唯一的语义风险来自 §2.3。

### 2.6 `09b5d3c0` 总判定：**有条件放行**

**放行条件（不阻塞 Round 2，须入账）**：
1. §2.3 的 `dependency_missing` 分类独立立项（当前语义可接受但会误导排障方向）。
2. §2.4 的守卫盲区必须记账；**建议补一条「消费者级」行为钉子**：在 `task.processor.spec.ts` / 回调 spec 里各加一条 `ModuleNotFoundError` 端到端用例（走真实 `handle` / `handleCallback`），把 C 类分叉堵死。这是**低成本、高收益**的一条。
3. 提交信息里的 `420 套件 / 7409 用例` 应更正（见 §5）。

---

## §3 commit `b5a73734` 逐项验收（派发过滤链收拢）

### 3.1 结论表

| # | 待证命题 | 判定 | 证据 |
|---|---|---|---|
| B1 | 三处调用点语义等价于原实现（逐维度） | ✅ **集合等价成立**（5 维逐一核对）；⚠️ **一处文档写错顺序** | §3.2 |
| B2 | 新 env `EXECUTOR_SELECTION_AFFINITY_ENABLED` 默认 false ⇒ 缺陷实际未修 | ⚠️ **确认：默认关闭，且开关在当前代码下是「双保险的无效开关」** | §3.3 |
| B3 | 提交信息自陈的残留（选机入参不含 affinity）是否真实 | ✅ **真实，且比自陈更严重** | §3.3 |
| B4 | 是否「过度宣称修复」 | ✅ **提交信息没有过度宣称**（诚实披露残留）；❌ **但 `configuration.ts` 的注释过度宣称** | §3.3 |
| B5 | 提交信息 `484 套件 / 8196 例全绿` | ❌ **不可能成立**（`apps/admin-api` 只有 **422** 个 `*.spec.ts`） | §3.4 |
| B6 | 新增 25 例 util spec 语义正确 | ✅ 与 util 实现一致（我逐条读了 util 的 5 个 helper） | §3.2 |

### 3.2 B1：逐维度语义等价核对（**这是本 commit 唯一真正的价值**）

| 维度 | 原 `selectLeastLoaded` | 原 `dispatch` / `broadcast` | 新共享实现 | 等价? |
|---|---|---|---|---|
| `group` | `if (opts.group)` `===` | `if (task.executorGroup)` `===` | `if (criteria.group) ===` | ✅ |
| `tags`（AND 子集） | `!e.tags ⇒ false`，`every` | 同左 | `hasAllRequiredTags`：`!e.tags ⇒ false`，`every` | ✅ |
| `affinity`（OR） | **缺失** ❌ | `!e.tags ⇒ false`，`some` | `hasAnyAffinityTag`：同左 | ✅（对 dispatch/broadcast） |
| `anti-affinity`（排除） | **缺失** ❌ | `!e.tags ⇒ true`，`!some` | `hasNoAntiAffinityTag`：同左 | ✅ |
| `runtime`（空 caps=万能） | `!caps\|\|len===0 ? true : includes` | 同左 | `satisfiesRuntime`：同左 | ✅ |
| `interpreter` | 未动（仍留 `applyInterpreterFilter`，三路共用） | 同左 | 同左 | ✅ 未变 |

**集合等价结论**：三条路径的**最终候选集与原实现逐字一致**（`dispatch`/`broadcast` 五维全命中；`selection` 的 affinity 在开关关闭/dead 时不施加，等价于原行为）。

⚠️ **但新文件自己写了一处文档错**：`executor-filters.util.ts` 的 `filterExecutorCandidates` 头注声称顺序是
`group → tags → affinity → anti-affinity → runtime`，并说「过滤顺序是规格的一部分……故固化」；
而实际实现是 `applyBasicFilters`（**group → tags → runtime**）**再** `applyAffinityFilters`（affinity → anti-affinity）
⇒ 真实顺序 = `group → tags → runtime → affinity → anti-affinity`。**注释与代码不符。**
因各维度独立，**结果集无差异**（注释自己也说「顺序对结果无影响」），属**低危文档错**，但它出现在一份「单一事实源」文件的规格描述里，性质上与本项目一直清理的漂移同类。

### 3.3 B2/B3/B4：开关是**无效开关**，缺陷**确实未修**

`selectLeastLoaded` 的签名（`executor.service.ts:4615`）：

```ts
async selectLeastLoaded(opts?: {
  group?: string | null; tags?: string[] | null; runtime?: string | null;
  runtimeVersion?: string | null;
}): Promise<Executor>
```

**没有 `affinityTags` / `antiAffinityTags`。** 因此传给 `filterExecutorCandidates` 的
`criteria.affinityTags` 恒为 `undefined` ⇒ `applyAffinityFilters` 里：

```ts
const hasAffinityDim = affinity.length > 0 || antiAffinity.length > 0;   // 恒 false
if (!hasAffinityDim) return candidates;                                   // 恒提前返回
```

**双重失效**：即使有人把 `EXECUTOR_SELECTION_AFFINITY_ENABLED=true`，也**没有任何亲和条件可施加** —— 不是「默认关闭所以没修」，而是「**打开也没用**」。

生产调用方已核实为零参数：

```
app-deployment.service.ts:1398  executor = await this.executorService.selectLeastLoaded();
app-deployment.service.ts:1401  executor = await this.executorService.selectLeastLoaded();
```

**提交信息 vs 代码注释：一个诚实、一个不诚实**

| 出处 | 表述 | 判定 |
|---|---|---|
| commit message「已知残留」段 | 「选机路径的入参**目前不含** affinity 字段……即使开关开启，此处也无亲和条件可施加」 | ✅ **完全诚实，与代码事实一致，值得肯定** |
| `configuration.ts:462`（**运维真正会读的地方**） | 「置 `true` 后选机路径与派发路径的亲和语义**逐字一致**」 | ❌ **这句是假的**：置 true 后什么都不会发生 |

⇒ **「过度宣称」不在 commit message 里，而在被同步新增的配置项文档里。** 这比 commit message 撒谎更危险，因为配置文档是运维的行动依据：一个「看起来能修、实际不生效」的开关，会让团队误以为 F-07 已修复并停止追踪。

### 3.4 B5：`484 套件 / 8196 例` 不可能成立

- `find . -name "*.spec.ts"`（排除 `node_modules`）在 `apps/admin-api` 下 = **422** 个文件。
- **套件数上限就是 422**（jest 每个 spec 文件 = 1 个套件），而提交称 484。
- 我实测：`422 total / 7454 tests`。

**结论**：`484 / 8196` 无法由 admin-api 任何 jest 配置产生，属**错误的验证记录**。同批提交里出现两套互斥数字（`09b5d3c0` 说 420/7409，`b5a73734` 说 484/8196，台账说 421/7434 → 422/7451，我实测 422/7454）—— **「全绿」这类验证声明必须附可复现命令与时刻**，否则不可审计。

### 3.5 `b5a73734` 总判定：**有条件放行**

- **结构收拢本身是净收益**：三条路径现在调同一段纯函数，`selectLeastLoaded` 的「缺两维」再也不可能**悄悄**演化。
- **但 F-07 缺陷（选机路径不实施亲和）100% 未修**，且新增的开关是**无效开关**。
- 放行条件：
  1. **要么**给 `selectLeastLoaded` 补 `affinityTags`/`antiAffinityTags` 入参并让 `app-deployment` 真的传值（**开关才有意义**）；
  2. **要么**删掉该 env 开关（不留「假旋钮」），把 F-07 明确挪到 Round 2b 立项；
  3. 必须**修正 `configuration.ts` 那句「置 true 后逐字一致」**（改文档由主Agent 安排，我不改）。

---

## §4 文档 vs 代码漂移（H-7）

> **只诊断不修改**。以下「代码事实」均本轮独立核对（CodeGraph + 直读 + 跑守卫脚本）。

| # | 文档声称 | 代码事实 | 差异性质 | 建议动作 |
|---|---|---|---|---|
| **T-1** | `ARCH-MULTI-INSTANCE-MATRIX.md:73-76`：「`scheduler.service.ts:184-338`，Redis 锁 `lock:scheduler:leader`，**TTL 30s**，watchdog 以 TTL/3 续期，另设 **TTL/2** 校验定时器」 | `SCHEDULER_LEADER_TTL_MS = 90_000`（`:98`）、`SCHEDULER_LEADER_VERIFY_MS = 15_000`（`:112`，**固定值，不再是 TTL/2**）；锁 key `scheduler:leader`（`RedisLockService` 内部拼 `lock:` 前缀 ⇒ `lock:scheduler:leader` **正确**）；行号 184–338 已漂移 | **硬漂移**（TTL 30s→90s、校验口径 TTL/2→固定 15s） | 改 3 处：TTL、校验口径、行号。**另**：`scheduler.service.ts:699-700` 的**代码注释**同样写着「TTL: 30s / TTL/3（10s）续期 / TTL/2（15s）校验」—— **同一处漂移也存在于源码注释**，建议一并改（否则文档改完代码注释仍在撒谎） |
| **T-2** | `:257 §3.8`：`app-deployment.detectStuckDeployments`「并发 `save` 同一 stuck 行（幂等但非原子）」 | 现为**两条带守卫的批量条件 UPDATE**（`status = :expectedStatus` + `approvalStatus` 条件 + `RETURNING id`），非 `save` | **硬漂移**（文档滞后于代码改进） | 文档改述为「条件 UPDATE，原子」 |
| **T-3** | `:145 §3.4`：「重启后 `onModuleInit` 把 pending/probing 行**全部**标记 failed（人工重发）」 | `markInterruptedRolloutsFailed` **跳过租约新鲜行**（`ROLLOUT_LEASE_GRACE_MS = 60_000`，`:105`，用于 `:4556`），UPDATE 带 `rolloutState IN (pending,probing)` + `RETURNING` 精确计数 | **硬漂移** | 文档补「租约 60s 内视为他实例在推进，跳过」 |
| **T-4** | `:59 总表 #9`、`:83-84 §3.1 注`：fail-open 期间每个实例都是 Leader | **属实**（`scheduler` catch 置 `isLeader=true`、`LeaderGateService` catch 置 `leader=true`） | 属实 | — |
| **T-5** | `:60 总表 #10`：「无 Leader 门禁的 `@Cron`（**原 8 个**）已由 `LeaderGateService` 收口」 | 全仓 **26 个** `@Cron`；`check-cron-leader-gate.mjs` 报 26/26 有门禁、allowlist 0；但 `check-cron-guard.mjs` **排除 `modules/agent/**` 4 个**；文档 §3.8 表只列 10 个站点 | **表述过强 + 数量漂移** | 数字改 26，并披露 `agent/**` 4 个的排除事实 |
| **T-6** | `:266-284 §3.8`：「cron Leader 与调度 Leader 可能落在不同实例，**有意为之：两类任务均为幂等清扫**」 | **「均为幂等清扫」不成立**：`agent-trigger.scheduledWatch` 会**创建 Agent 会话并消耗 LLM 配额**，且它走的是 scheduler leader（`isSchedulerLeader()`），不是 cron:leader | **表述过强（安全性断言不成立）** | 删除「均为幂等清扫」，改为按站点分级；`scheduledWatch` 非幂等需显式点名 |
| **T-7** | `:147-172 §3.4` / 总表 #5：「并发批次互斥：`upgradeAllWithRollout` 启动前查在途灰度行，命中返回 `ok:false`」⇒ 暗示「不会两实例同时开灰度」 | 守卫存在且返回 `blockedReason`，但是**读后判（read-then-act）**，与 `markRolloutState(PENDING)` **之间无原子占坑** ⇒ 两实例可同时通过检查。`app-deployment.service.ts:3362` 查 → `:3445` 标记 → `:3453` upgrade | **表述过强（安全性质结构上不成立）** | **最高价值一条**：文档降级 + 代码补 claim（Round 2b 立项） |
| **T-8** | `rollback-semantics.md` 全文：应用侧只列 3 个端点（`set-current-version` / `deploy-version` / deprecated `rollback` alias） | **存在第 4 条未记载的回滚路径**：`rollbackDeploymentToPrevious`（`app-deployment.service.ts:3878`），由 `failBatch` 在**灰度批次失败时自动触发** | **文档缺项（遗漏）** | 补第 4 列：自动回滚（批次失败时对已升级台回退到上一 released 版本） |
| **T-9** | 域报告称 `rollbackDeploymentToPrevious`「只切版本指针、不回滚数据」「连 `applications` 表都不写」 | **核实为真**：`upgradeWithSnapshot`（`:3969`）注释明写「只恢复本台 push 载荷所需字段，**不写 applications 表**」，实现上也只构造内存 `pushApp` 后走上设备 upgrade 链；但**会写** `app_deployments`（经 `pushDeployToExecutor`）与 `writeTransitionAudit("deployment.rollback")` | **核实为真**（需精确表述） | 表述应为「**不回写 `applications` 主记录，但会改写该部署行并把上一版本真的推到设备**」——「只切版本指针」偏低，会让人误以为设备没变 |
| **T-10** | `OPEN-DECISIONS.md` A1：FIRE_ONCE 补偿「要不要把窗口内存在任何执行当成已覆盖」，选项 ①保持现状 ②补偿前查窗口内有无执行 | 与代码一致：该条目仍是**未决**状态，描述的是「手动触发不推进 `lastTriggerTime`」这一真实行为 | **属实（仍开放）** | 无需改；但域报告 1-F 建议「更新 A1 为『已决（选项②）』」**与事实不符** —— 当前无证据显示已选②，A1 应保持开放。⚠️ 建议主Agent 不要采纳该条 1-F 建议 |
| **T-11** | `executor-filters.util.ts` 头注：「过滤顺序……`group → tags → affinity → anti-affinity → runtime`，故固化」 | 实际 `group → tags → runtime → affinity → anti-affinity` | **新增文档错**（本 commit 自带） | 改注释或改实现，使一致 |

**§4 计数**：硬漂移 **3**（T-1/T-2/T-3，独立复核成立，与域报告 D-2/D-3/D-4 对应 ✅）；表述过强 **4**（T-5/T-6/T-7 + T-1 的「同款」对比）；文档缺项 **2**（T-8、T-11）；核实为真 **2**（T-4、T-9）。域报告的「7 条（3 硬 + 4 过强）」**大体成立**，但**遗漏了 T-8 与 T-11**，且 **T-9 的措辞需要更精确**。

⚠️ **域报告一条建议必须驳回**：`deploy-multiinstance.md` §1-F 建议「更新 `docs/OPEN-DECISIONS.md` A1 为『已决（选项②）』」——**A1 目前仍是未决**，无任何代码或决策记录显示已选选项②（「补偿前查窗口内有无执行」的实现并不存在）。照此修改会制造一条**新的**文档漂移。

---

## §5 量化数字复算结果

### 5.1 一致 / 不一致表

| 指标 | 台账声称 | 我的实测 | 结论 |
|---|---|---|---|
| `executor.service.ts` 行数 | 8,488 | **8,489** | ❌ 差 1（但见注：`b5a73734` 提交态 8,454，02:52 后 8,489） |
| `executor.service.ts` 符号 | 184 | **184** | ✅ |
| 被引用文件数 | 69 | **69** | ✅ |
| `impact executor.service -d 3` | 150 | **150** | ✅ |
| `task.service.ts` 行数 | 6,990 | **6,903** | ❌ **差 87 —— 台账引用了「修自己缺陷之前」的旧值**（见 5.2） |
| `task.service.ts` 符号 | 149 | **147** | ❌ 差 2 |
| `task.service.ts` 被引用 | 39 | **39** | ✅ |
| `app-deployment.service.ts` 行数 | 4,544 | **4,544**（HEAD 提交态） | ✅（工作区已被并发写到 4,600） |
| `app-deployment.service.ts` 符号/引用 | 136 / 20 | **136 / 20** | ✅ |
| **路径** | `modules/deployment/app-deployment.service.ts` | 实为 **`modules/application/`**（`modules/deployment/` 不存在） | ❌ **路径错** |
| `execute.py` 行/符号/引用 | 5,339 / 220 / 34 | **5,339 / 220 / 34** | ✅ **三项全对** |
| admin-api 测试基线（起点） | 417 / 7,328 | 未独立复核起点（历史值） | ⏸ |
| admin-api 我触发时刻 | 主Agent 称 421 / 7,434 | **422 套件 / 7,454 用例**（且 2 套件 3 例**红**，见 §1.3） | ❌ +1 套件 / +20 用例 |
| admin-web 用例 | 2,162 | **2,233**（274 文件，全过） | ❌ 差 71（见 5.3） |
| 页面数 / 行数 | 31 / 24,738 | **31 / 24,738** | ✅ **精确一致**（口径 `src/pages/**/*.tsx`） |
| 手写 ↔ 生成物 **严格同名** | 6 | **6** ✅ | ✅ 可复现（需含 `export type`，不能只数 `interface`；`src/types/` 下**只有** `generated/`，手写类型在 `src/api/*.ts`） |
| 语义重复 | **173** | **不可复现** | ⚠️ 口径未定义（见 5.4） |
| `Executor` 漂移 | 6 字段 | **6 字段** | ✅ 可复现（见 5.4） |

### 5.2 最严重的不一致：`task.service.ts` 6,990 → 实为 6,903（**台账引用的是自己的修复前快照**）

这不是笔误，可以精确归因：

```
git show 09b5d3c0^:…/task.service.ts | wc -l  →  6,990   ← 台账引用的就是这个
git show 09b5d3c0:…/task.service.ts  | wc -l  →  6,903   ← 修复提交净删 87 行
HEAD                                 | wc -l  →  6,903
```

**`09b5d3c0` 把 91 行内联正则链换成了 32 行 `classifyFailure` 委托，净减 87 行。台账在「规模倒挂」论证里引用的 `6,990` 是修复**前**的旧值，测量发生在提交落地之前，之后从未更新。**

**后果**：数字本身不致命，但它是**台账可信度的证据点** —— 一份「用来防我自己出错」的量化表，其中一项是被自己的修复提交改过的，却没同步。建议台账所有行数标注**测量时刻 + commit**。

同源问题：`executor.service.ts` 的 8,488 也无法复现（提交态 8,454 / 现 8,489），说明台账里若干数字来自**不同时刻的混合快照**。

### 5.3 测试基线：四套互斥数字，只有一套可复现

| 出处 | 声称 |
|---|---|
| `09b5d3c0` 提交信息 | 420 套件 / 7,409 用例 |
| **`b5a73734` 提交信息** | **484 套件 / 8,196 用例** ← **物理不可能**（admin-api 只有 422 个 spec 文件） |
| 台账（02:5x） | 421 / 7,434 → 422 / 7,451 |
| **我的实测（03:0x）** | **422 套件 / 7,454 用例（3 例红，见 §1.3）** |

**方向判断**：相对起点 417 / 7,328 ⇒ 我的 422 / 7,454 是 **+5 套件 / +126 用例，单调递增、无回退**，符合「只增不减」。但**绝对数**与主Agent 的 421/7,434 差 +1/+20 —— 原因是期间合并了 `09d69dab`（决策日志 schema，新增 1 spec）与 `b5a73734` 的 25 例 util spec。**「只增不减」成立；「数字等于 421/7,434」不成立。**

### 5.4 类型重复度：`173` 不可复现，`6 字段` 可复现

**（a）严格同名 = 6：可复现 ✅**（判据：手写 `export interface|type` 名与 `components.schemas` 顶层键**字符串全等**；名单 `CreateDeploymentDto / CreateEventSubscriptionDto / CreateProjectDto / CreateUserDto / UpdateProjectDto / UpdateUserDto`）

**（b）语义重复 173：不可复现 —— 口径未定义 ⚠️**。我扫了 20 种判据组合，无一命中 173：

| 判据 | 值 |
|---|---|
| 重叠/max ≥ 0.5 | 252 |
| **重叠/max ≥ 0.6** | **138** |
| 重叠/max ≥ 0.7 | 99 |
| 重叠/max ≥ 0.8 | 83 |
| 重叠/max ≥ 0.9 | 58 |
| 重叠/min ≥ 0.9 | 361 |
| 重叠/(生成物) ≥ 0.9 | 231 |
| 重叠/(手写) ≥ 0.8 | 224 |
| 与任一 schema **至少共享 1 个字段名**（独立孙Agent口径） | 176 |
| 同上但仅 `.ts`（排除 tsx） | 157 |

173 落在 176 与 157 之间，最可能是「任意 1 个同名字段」口径在**略不同的语料/提交快照**下的值（差 3）。**结论：该数字依赖一个未写出的判据，属不可审计数字。** 建议改写为「语义重复 **138**（判据：字段重叠 ≥ max(两侧字段数) 的 60%）」或**明写判据**。方法见 `/tmp/vr/types-dup2.py`（未入库）。

**（c）`Executor` 漂移 = 6 字段：可复现 ✅**（我独立解析，**修正了孙Agent 的 7 字段结论**）：
- 手写 `Executor`（`src/api/executors.ts:3`）= **33 字段**；生成 `ExecutorResponseDto` = **39 字段**；
- 手写 ⊆ 生成（**手写独有 0**）；
- **生成物独有 6 = 漂移集**：`capabilities`、`consecutiveHeartbeatMisses`、`createdAt`、`executorStartedAt`、`executorStartupId`、`updatedAt`。
- ⚠️ 台账附带表述「重叠 **30/33**」**不准**：实际重叠 **33/33**（手写全被包含）。「6 字段漂移」的结论对，支撑数字错。

**（d）台账两处前提错**：① 路径 `modules/deployment/` 不存在；②「手写类型在 `src/types/*.ts`」不成立 —— 该目录**只有 `generated/`**，手写在 `src/api/*.ts` 与组件里。

### 5.5 admin-web `2,162` 的来源

静态 `it(`/`test(` 声明数 ≈ **2,169**，运行时 **2,233**（`.each` 展开）。
**2,162 与静态计数只差 7、与运行时差 71 ⇒ 它不是运行结果**，更像更早提交上的静态 grep 或含 `.only/.skip` 过滤的读数。**「只增不减」若用 2,162 当基线会失真**，建议改为实测 **2,233**。

---

## §6 伪修复识别

| 项 | 是不是伪修复 | 判定依据 |
|---|---|---|
| **`b5a73734` 的「选机路径补齐 affinity」** | **是（结构性伪修复）** | 缺陷 = 选机不实施亲和。收拢结构 ✅，但 `selectLeastLoaded` **没有 affinity 入参**，`hasAffinityDim` 恒 false ⇒ **开关开与不开行为完全相同**，缺陷 0% 修复。**唯一危害**：`configuration.ts` 宣称「置 true 后逐字一致」，制造「已修」错觉 |
| **`b5a73734` 的「派发/广播语义不变」** | **不是**（诚实） | 五维逐一核对等价，`-204/+119` 是真实搬迁，无行为变更 |
| **`09b5d3c0` 的「ModuleNotFoundError 误吞」修复** | **不是**（真修复） | 12 条真实离线文案零漏判、3 条模块缺失正确翻转，**是我本轮唯一验证出「缺陷确实被修掉」的一项** |
| **`09b5d3c0` 的「补 PACKAGE_FETCH 判据」** | **半个真修复** | 命中了，但**归错类**（`dependency_missing` 被塞进 `package_fetch_failed`），并**被金标冻结**（§2.3） |
| **`09b5d3c0` 的「27 条守卫防回归」** | **部分失效** | 挡住「原样重抄」（A），挡不住改名/内联/中文/DNS 裸子串（B/C/D）。**C = 把本提交修的缺陷加回去，27 条全绿** |
| **`EXECUTOR_SELECTION_AFFINITY_ENABLED`** | **是（假旋钮）** | 配置了但无任何可观测效果。比「没这个开关」更糟：它占用了运维的注意力并暗示修复已完成 |

**一句话**：**«结构变了» 与 «行为缺陷没了» 是两件事。本轮两个提交各命中一半：`09b5d3c0` 真的修掉了 H-2，`b5a73734` 只是把三份实现改成一份，F-07 缺陷原样留着。**

---

## §7 Round 2 放行建议 + 写域划分建议

### 7.1 可以进入 Round 2b（结构性重构）

| 项 | 理由 |
|---|---|
| 失败分类单一事实源（`common/failure-classification`） | 两路径已共用一份，30 行扩一个规则只改一处，结构债已还 |
| 候选过滤链单一事实源（`executor-filters.util.ts`） | 纯函数、可表驱动、三路共用；再加维度不会再分叉 |
| 码化优先通道（`ERROR_CODE_FAILURE_REASON`） | **方向正确且是根治手段**：文案正则 vs 结构化码，业界共识就是走码（见 7.5）。当前只收 1 条，稳健但成效有限——**建议 Round 2b 扩表** |
| `admin-web` 页面域、`execute.py` 拆分 | 本轮无异议证据；`execute.py` 5,339/220/34 三项与台账完全一致，数据可信 |

### 7.2 必须先返工 / 补验收

| 项 | 要求 |
|---|---|
| **F-07 选机路径亲和** | 二选一：① 补 `affinityTags`/`antiAffinityTags` 入参 + `app-deployment` 真传值 + 开灰度；② **删掉 env 开关**，把一个「假旋钮」留在生产配置里是最坏选项。**无论哪条，都必须先改 `configuration.ts:462` 那句「置 true 后逐字一致」** |
| **守卫盲区（§2.4）** | 补 2 条**消费者级**端到端用例（`task.processor` 派发路径 + `handleCallback` 回调路径各一条 `ModuleNotFoundError`）。这是本轮**性价比最高**的一条 remediation：现在改回裸 `enotfound` 全绿 |
| **`b5a73734` 的 `484/8196`** | 更正为可复现数字 + 命令 + 时刻。**验证记录不可复现 = 不可审计** |
| **台账 §5.1 各项数字** | 每项补「测量时刻 + commit sha」；改正 `6,990→6,903`、`149→147`、`modules/application/`、`30/33→33/33`、`173→138（或明写判据）`、`2,162→2,233` |
| **T-7（灰度互斥 read-then-act）** | 文档降级为「部分成立」；代码补原子占坑属 Round 2b |

### 7.3 需驳回 / 高风险建议

- **驳回** 域报告 1-F「把 `OPEN-DECISIONS.md` A1 更新为『已决（选项②）』」—— A1 仍开放，无实现证据（§4 T-10）。照做会**新增**一条漂移。

### 7.4 双会话并发协调风险 + 写域划分建议

**已观察到的真实风险（全部在本轮 30 分钟内发生）**：

| 风险 | 实例 |
|---|---|
| **提交被 amend，验收对象漂移** | `b5a73734` 经 `commit (amend)`；同一 ref 在 02:44 / 02:52 读出 **8,454 / 8,489** 两个内容 |
| **HEAD 中途前进** | 02:48 `09d69dab`、02:52 `77eacda5` 在验收窗口内落地 |
| **台账被一方改写** | `00-round1-ledger.md` 由主Agent 在 02:52 以 `77eacda5` 改写（「两会话口径合并」），我 task 书里的「421/7434」验收基准当刻已失效 |
| **在途工作把主干打红** | `contract-source` 队改 `protocol.json`（`string[]`→`object[]`）⇒ `executor-protocol-contract.spec.ts` **确定性红 3 例**；此时任何人跑全量都会得出「主干红」 |
| **同一文件两方改** | `scheduler.service.ts`、`leader-gate.service.ts`、`app-deployment.service.ts` 在窗口内先后 dirty；`executor.service.ts` 被 `b5a73734` + `09d69dab` 两次改 |
| **结论可能互相矛盾** | 「全绿」有 4 个互斥版本；`Executor` 漂移在我的测量与孙Agent 之间出现 6 vs 7 |

**写域划分建议（按「文件 owner 唯一」原则）**：

| 写域 | 归属 | 约束 |
|---|---|---|
| `common/failure-classification/**` + `common/errors/error-code-failure-reason.ts` + `modules/task/task.{service,processor}.ts` | **会话 A（分类链）** | 会话 B **只读**；B 若需改 `inferFailureReason` 必须先移交 |
| `modules/executor/executor.service.ts`、`executor-filters.util.ts`、`executor-score.util.ts`、`dispatch-decision-log.schema.ts` | **会话 B（派发链）** | ⚠️ `executor.service.ts` 是**双会话热点**（`09b5d3c0` 与 `b5a73734`、`09d69dab` 都碰它）——**建议把它单独列为「串行区」，任何改动前先在台账登记「取号」** |
| `modules/application/app-deployment.service.ts` | 会话 B | 与 `rollbackDeploymentToPrevious` / `failBatch` 相关，A 只读 |
| `modules/scheduler/**`、`common/leader-gate/**` | 会话 B | — |
| `packages/executor-protocol/protocol.json` + `scripts/check-*.mjs` | **契约专项（`contract-source`）** | ⚠️ **改动期间主干必红** ⇒ 应开 feature 分支，或至少**先在台账公告「契约改造中，全量红不代表回归」** |
| `apps/admin-web/**` | `web-hardening` | — |
| `docs/**`、`00-round1-ledger.md` | **仅主Agent** | 本轮台账被改写是合理的（它确实是主Agent 的产出），但**必须公告版本号**，否则下游验收者的基准会静默失效 |
| `docs/archive/audits/**`（各域报告） | 各域作者 | 不得由他人改写结论段 |
| **验收报告（本文件）** | **verify-reconcile 独占** | 其他会话不得改写 |

**流程建议（低成本、立刻可做）**：
1. **验收必须钉 sha**：所有「放行/返工」结论写明 `commit sha` + 时刻；**禁止对可变 ref 验收**（本次 `b5a73734` 就是被 amend 过的）。
2. **「全绿」必须附命令 + 时刻 + sha**：本轮 4 套互斥数字的直接原因就是没有这个约束。
3. **禁止 amend / 禁止 rebase 已推送待验的提交**；修正走新提交。
4. **契约类改造（`protocol.json`）走独立分支**，合入前不污染主干全量基线。
5. **台账数字表加两列：`测量时刻`、`commit sha`**。

### 7.5 外部参照：失败原因分类的业界做法（补充 §2.3 的判据）

> ⚠️ **本轮无网络检索能力**（`web_search` 因缺 API key 不可用），以下为**基于既有知识的定性判断，未附实时链接**，如需引用请主Agent 自行取证。

1. **主流是结构化错误码，不是文案正则。** Kubernetes 用 `reason` 字段（`OOMKilled` / `CrashLoopBackOff` / `Evicted`）与进程退出码；workflow 引擎（Temporal/Airflow）用 `ApplicationFailure` 类型 + `nonRetryable` 标记；gRPC 用 status code。**共同点：分类是「上报方结构化声明」，消费方不做文本猜测。**
2. **`ModuleNotFoundError` 与「拉包失败」是两个语义层。** Python 的 `ModuleNotFoundError` 是**解释器运行期**的 import 失败（`ImportError` 子类）；包管理器失败是**安装期**。二者在标准库层面就是不同异常/不同阶段。**在沙箱里，用户脚本 `import pandas` 失败，业界归因是「用户代码/依赖声明问题」（`task-author`），不是「平台拉包失败」。** ⇒ 支持 §2.3 的判断：`PACKAGE_FETCH_FAILED` 是错向桶。
3. **本项目已有正确的升级路径**：`error-code-failure-reason.ts` 的「码化优先」正是业界做法。**建议 Round 2b 的核心不是继续调正则，而是扩大码表覆盖面**，把「文案正则」降级为真正的兜底（当前它仍是主路径，码表只有 1 条）。这与 §2.4 的守卫盲区是同一问题的两面：**只要判据还是正文字符串，就永远需要「猜文案」，而猜是挡不住回归的。**

---

## §8 待主Agent 决策项

| # | 决策项 | 选项 | 我的建议 |
|---|---|---|---|
| **D-1** | **验收基准不稳定**：`b5a73734` 被 amend，同一 ref 两次读出不同内容 | ① 接受「对 sha+时刻」验收；② 冻结分支 | ①：**立即生效**，并把本轮结论标注为「基于 02:42–03:12 窗口的 sha 快照」 |
| **D-2** | **F-07 选机亲和**：补入参 + 开灰度，还是删开关 | ① 补入参（真正修复，需部署域契约配合）；② 删开关（诚实，但缺陷留着） | **②先做（删假旋钮 + 改 configuration.ts 那句假话）**，①随后立项。留假旋钮是三个选项里最差 |
| **D-3** | **`dependency_missing` 是否新设枚举** | ① 新设（需三端 + 契约同步，成本中）；② 保持现状（`package_fetch_failed`） | ①：但要**先解除金标冻结**（金标表里那条断言需改成新枚举），否则改不动 |
| **D-4** | **守卫补强**：是否要求「消费者级」行为钉子 | ① 补 2 条 e2e（低本高收益）；② 仅修 `TOKENS`（含中文 + `enotfound`）；③ 都做 | **③**。单修 `TOKENS` 挡不住改名内联；单加 e2e 挡不住中文支 |
| **D-5** | **契约改造期主干全红**如何对外表述 | ① 公告「改造中，非回归」；② 要求分支隔离 | **②**为长期解，**①**为当下必须做（否则任何并发验收者都会误判） |
| **D-6** | 台账数字表的**可信度**已受损（`6,990` 是修复前值、`484/8196` 不可能、`173` 不可复现、`2,162` 非运行时值） | ① 逐项订正 + 加「时刻/sha」两列；② 维持现状并附免责 | ①。这正属于项目反复强调的「文档/宣称 vs 代码事实」漂移，**不能因为「只是审计文档」就豁免** |
| **D-7** | 是否采纳域报告 1-F 的「A1 改为已决」 | 采纳 / 驳回 | **驳回**（A1 仍开放，无实现证据，照做会新增漂移） |

---

## 附：本报告的自我限定

- **未做**：跑 `tsc --noEmit`（`09b5d3c0` / `b5a73734` 的「0 错」未独立复核）；跑 4 个 `check-*` 守卫脚本（当时正被 `contract-source` 修改）；跑 admin-web 全量（数据取自孙Agent 的独立实测，已标注）。
- **红测说明**：§1.3 的 3 例红**归因于并发在途工作**，不构成对两个被验收 commit 的否决；但「主干此刻是红的」是事实。
- **未修改任何源文件**；未执行 `git add/commit/checkout/restore/stash`。实验脚本仅落在 `/tmp/vr/`。

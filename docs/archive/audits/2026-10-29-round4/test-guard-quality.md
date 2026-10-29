# 测试与守卫质量审计（2026-10-29 · 第 4 轮）

只读审计。**未修改任何源码/脚本/测试/CI**；所有实证均在 `/tmp/r4/` 下重建最小树或用仓库脚本的只读入口完成。
唯一写入物 = 本文件。

---

## 1 方法与覆盖（明确未覆盖）

### 1.1 手段

| 手段 | 做法 | 产出 |
| --- | --- | --- |
| 读判据 | 逐个打开 10 个 `scripts/check-*.mjs`，引判断函数与关键行 | §2 |
| 单跑守卫（只读、每个 ≤90s） | 10 个守卫全跑一次，记录真实数字与退出码 | §2「实测」列 |
| 形态探针 | `import` 守卫的导出函数，直接喂 6 类缺陷形态（不改仓库文件） | §2、§4.2 |
| 临时树实证 | `check-metric-docs --root <tmp>`、`check-guards-wired` 在 `/tmp/fakeroot` 跑（它用 `process.cwd()` 当根） | §2.4、§2.6 |
| 静态计数 | 自写脚本扫 387 个 admin-api spec / 258 个 admin-web test，按 6 类弱断言形态分类 | §3 |
| 重复度分析 | 归一化每条 `expect(...)` 行，统计「出现在 ≥4 个文件」的断言组 | §4.1 |

### 1.2 规模（实测，非引用）

- 守卫：`scripts/check-*.mjs` 共 **47** 个，其中 `.selftest.mjs` **5** 个（root 40 个真正守卫 + 子项目 `apps/admin-api/scripts/check-route-authz-matrix.mjs` 1 个）；`check-guards-wired` 实测输出「42 个 check-\*.mjs 全部被 CI 执行（另有 2 个显式豁免）」。
  ⚠️ **数字在漂**：本轮期间（14:00→14:06）`scripts/` 被并发 agent 新增了 `check-infra-doc-counts.mjs`、`check-workflow-actions-pinned.mjs` 两个未跟踪文件，非 selftest 数从 41 变 43。凡「守卫个数」类数字请以当场 `ls` 为准，别引用本文。
- admin-api：**387** 个 `*.spec.ts`；admin-web：**258** 个 `*.test.ts(x)`。
- 迁移：**122** 个迁移文件，迁移 spec **54** 个，其中**只有 3 个真正执行 `down()`**。
- 语言守卫基线：`scripts/user-facing-language-baseline.json` 已是 `known: [] / maxKnown: 0`（真实全绿，非空转，见 §2.9）。

### 1.3 明确**未覆盖**（本轮没做的事，别当成已核对）

1. **没跑全量测试**（纪律要求）。所以「某断言一定通过」这类结论一个都没有；本文只谈**断言形态能否抓到缺陷**，不谈当前是否通过。
2. **题面里的 `scripts/check-docs.mjs` 不存在**（`ls scripts/check-docs*` 无匹配）。本仓的「文档面」拆成 4 个守卫：`check-metric-docs`、`check-cli-doc`、`check-audit-actions-doc`、`check-sdk-docs-truthfulness`。抽样里我用 **`check-sdk-docs-truthfulness`** 顶上第 10 条，并说明这个替换。
3. **未覆盖 admin-web 的 e2e/视觉面**，也未核 `.github/workflows/**` 的 job 级 `needs/if` 语义（有并发 agent 在改该目录；本轮只做了只读 grep，见 §2.6）。
4. **没验证 68 个无 spec 的迁移是否被后续迁移/集成测试间接覆盖**——只报告「没有专属 spec」这一事实。
5. 探针里凡是「需要改动仓库内文件才能证明」的（如真的把 CI 步骤注释掉），一律标 **未实证**，见 §6。

### 1.4 先更正第 3 轮的两个假设（省下下一轮的工作量）

第 3 轮 INDEX 与本轮题目都把下面两条当成「零覆盖」候选，**实测是已覆盖的**，不该再派活：

| 假设 | 实测 | 证据 |
| --- | --- | --- |
| 错误码 i18n 的运行时回退零覆盖 | **已覆盖且相当扎实**：码→中文、码→英文、切回中文、params 插值、未知码回落服务端 message、无码、非字符串码、防裸码渲染 | `apps/admin-web/src/__tests__/error-code-i18n.test.ts:36,41,44,49,95,101,113,120,125,131` |
| SSE 断开重连零覆盖 | **已覆盖**：`onopen`→`live`、`onerror`→`reconnecting`、退避 3s→6s 用**实例计数**断言真的重建、卸载清理 | `apps/admin-web/src/__tests__/use-executions-stream.test.tsx:291,309,325`；`queries-sse-refetch-interval.test.tsx:84` |

两条仍在的真空白是别的形态，见 §4.2。

---

## 2 守卫牙齿评分表（10 条）

评分口径（0–5）：
- **5** = 判据打到语义（取值/触发面），且 selftest **用子进程断言退出码**，且有「扫描面失效即红」的下界；
- **3** = 判据打到结构但只看形状/名字，或 selftest 只测判据函数不测退出路径；
- **1** = 判据恒真/可被注释绕过/只做字符串存在性。

先用一句话给结论：**10 条里只有 1 条（`check-metric-docs`）做到了「判据 + 退出码自检 + 扫描面下界」三件齐全；其余 9 条的绿都不足以支撑「该域没问题」。**

| # | 守卫 | 评分 | 判据打在哪一层 | 最要命的失效形态 | selftest 质量 |
| --- | --- | --- | --- | --- | --- |
| 1 | `check-alerts-rules` | **2** | 结构 + 指标名存在性（`validateAlertsDocument` :416） | **从不判断规则会不会触发**：非法 PromQL / 恒不成立规则全绿（实测 5/5 绿） | 只比对**报错关键词**，不跑子进程、不断言退出码（:1010,:1147） |
| 2 | `check-index-drift` | **3** | 名称/表/列序/唯一性四元组（`check` :168） | 部分索引 `WHERE` 谓词不参与比对；`DROP INDEX` 不解析；`@Entity()` 无表名静默跳过（:177） | 自检**测的是 `check()` 的手抄副本** `assertSubset`（:278-299，:270 注释自认） |
| 3 | `check-cron-guard` | **4** | `@Cron` 方法体内是否有 `try {`/`guardedCron(`/`guardTick(`（:42-43） | 只认「try 存在」，不认 catch 是否**重抛**；`modules/agent/**` 4 个 `@Cron` 永久豁免且只因注释承诺回收（:55-62） | 直接调 `findUnguardedCrons`，断言用例数，**不断言退出码**（:321,:535） |
| 4 | `check-metric-docs` | **5** | 注册表 42 指标 ↔ 文档 39 个 token 双向 + 基线棘轮 + allowlist 陈旧回收 + 下界 `FLOORS`（:130） | 只剩「文档说对了但指标没接进 `/api/metrics` 渲染」这一层不在面内 | **金标准**：`mkdtemp` + `spawnSync` 断言退出码 + 关键文本（:1120-1165），**17 条**用例（文件头注释仍自称 15 条——连守卫的文档也漂了） |
| 5 | `check-enum-drift` | **2** | TS 枚举值 ⊆ PG 枚举值，映射表**手工维护 13 条**（:26-40） | 新枚举只要不进映射就零覆盖；`export const X = {...} as const` 完全扫不到；`[^}]*` 会在第一个 `}` 处截断（实测丢值） | 自检**绕过两个 scanner**，直接构造 `Set` 喂 `check()`（:261-283）——regex 坏了照样绿 |
| 6 | `check-guards-wired` | **2** | 文件名/脚本名 **子串**是否出现在 workflow 文本里（:100,:106） | ① YAML **注释**里出现即算接线（实测）；② `npm run check` 前缀命中 `npm run check:all`（实测）；③ ALLOWLIST 无回收；④ **无 `--selftest`** | 无 selftest（132 行无该分支） |
| 7 | `check-conditional-writes` | **3** | 只抓 `.update({ id: … })` 单键形态，基线 0（:49,:149） | 6 类真实无条件写形态**零命中**（实测）；`stripNonCode` 把模板串抹空 ⇒ 裸 SQL `UPDATE … WHERE id` **永久不可见** | 断言「函数返回值个数」，**不断言退出码**（:222-253） |
| 8 | `check-ssrf-deny-parity` | **3** | admin-api 18 条 addr 的**字符串**必须出现在两个镜像文件里（:48,:61） | 只做 `includes`：写进注释/写进「已知放行」列表都算命中；**条目数无下界**（只挡 0 条，:52） | 无 selftest（84 行） |
| 9 | `check-user-facing-language` | **3** | 「含任一 CJK 字符即合规」（`isNonChineseUserText` :162-167） | 半英半中直接放行（实测 23 处命中）；`apps/admin-web/**` 用户界面**完全不在扫描面**；Python 只扫 `raise *Error(`，不扫 `HTTPException(detail=…)`（:398） | 断言布尔判定，**不断言退出码**（:532-662） |
| 10 | `check-sdk-docs-truthfulness`（代 `check-docs`） | **2** | 2 篇文档里 `ctx.` 围栏必须出现 SDK 字符串 + 一行同时含 glue 与"不安装"（:77-84,:100-120） | 「同围栏出现字符串」可被注释满足；`hasGlueCaveat` 是**任意一行**共现即可，可被一句不相关的行满足 | 断言**问题个数**，不断言退出码；`good/glueOnly/noImport/noCaveat/wrongClaim` 5 例（:152-193） |

### 2.1 `check-alerts-rules.mjs` —— 结构真齿，语义零齿

**判据**（`validateAlertsDocument` :416）：alert 名合法且唯一、`expr` 非空、`for` 匹配 `^\d+(ms|s|m|h|d)$`、`severity ∈ {critical,warning}`、`summary/description` 非空、`runbook_url` 是绝对 URL 且锚点存在于两篇文档（`collectDocAnchors` :405），`expr` 里的指标名必须来自源码字面量清单（`buildMetricInventory` :373）。有探针兜底：清单必须仍含 2 个已知指标（:720），runbook 锚点必须仍含 2 个（:727）。

**失效模式（实证）**：它验证的是「名字拼对了」，不是「表达式是对的」。在 `/tmp` 副本上直接调判据（`/tmp/r4/probe7.mjs`），把 `expr` 换掉，其余字段保持合法：

| 表达式 | 期望 | 实测 |
| --- | --- | --- |
| `up ==` | 红（语法截断） | **绿** |
| `up{job="a"` | 红（括号不配对） | **绿** |
| `rate(up[5m]) > 0` | 红（对 gauge 用 rate） | **绿** |
| `0 == 0` | 红（永不触发） | **绿** |
| `vector(1) > 2` | 红（恒不成立） | **绿** |

这正好打在它自己文件头写的动机上（:4-8「一条 expr 拼错…要等部署到真机才暴露」）——**拼错不会被抓，被抓的只是指标名不存在**。第 3 轮 observability 已记「看不见 label 取值」，本轮补一条：**连 expr 的语法与可触发性都不判**。

**可否机械补强**：可。①括号/引号/方括号配平 + 不许以运算符结尾（纯字符级）；②`expr` 必须至少引用 1 个指标名且有比较运算符或 `absent()`；③对 `_total` 用 `rate/increase`、对 gauge 用裸比较的白名单式判断；④把「判据函数不可 import」修掉（`process.exit(scanReal())` 在 :1307，import 即跑实扫并退出），否则任何新自检都写不了。

**selftest 质量**：13 alerts + 3 提取 + 5 dashboard + 11 阅读版 fixture，全绿；但每条只断言「报错数组里含某关键词」（:1010-1014、:1147-1151），**不 spawn 子进程、不断言退出码**。判据函数整体失效→`errors` 变空→fixture 的 `expected` 命中失败→仍会红，这点比纯「不抛」强；但「实扫路径 / 退出码 / runbook 文档解析」三处自检覆盖为 0。

### 2.2 `check-index-drift.mjs` —— 四元组真比，三处结构盲区

**判据**（`check` :168）：实体 `@Index("name", [cols])` 必须在迁移 DDL 里找到同名 `CREATE [UNIQUE] INDEX` 或 `CONSTRAINT … UNIQUE`，且表名（:186）、列序（:192）、唯一性（:201）全一致。实跑：65 个命名声明比对通过、24 个未命名不比对。

**失效模式（实证，调导出 scanner）**：

1. **部分索引谓词不比**（文件头 :20-21 自认）：`@Index("idx_a", ["a"])` vs `CREATE INDEX "idx_a" ON "t" ("a") WHERE deleted_at IS NULL` → 判据认为一致（`scanMigrationIndexesFromFiles` 只留 `{table,columns,unique}`）。真实缺陷形态：实体声明全量索引，DDL 只建了 partial，某些查询永远走不到索引，守卫绿。
2. **`DROP INDEX` 不解析**：迁移 001 建 `idx_a`、迁移 002 删 `idx_a` → `ddl.has("idx_a") === true`（实测），线上无索引而守卫绿。
3. **`@Entity()` 不带表名 → 静默跳过**：`scanEntityIndexesFromFiles` 返回 `table: null`，`check()` 的 `if (!decl.table) continue`（:177）直接跳过。也就是说**新实体只要不显式写表名，它所有 `@Index` 都不受护**，且只在汇总行里以 `checked` 计数变化体现，没有下界。第 3 轮只记到「只比命名声明」，本轮补：命名了但表名缺省，同样零覆盖。

另有一处噪声（非盲区）：`stripComments`（:212-216）只剥 `/* */` 与行首 `//`，**行尾** `// @Index("dead", ["a"])` 会被当成真声明 → 假红。

**可否机械补强**：可。①在 DDL 侧记录 `WHERE` 谓词文本，实体侧有 `where:` 时比对（无 `where` 而 DDL 有谓词 → 红）；②按文件名时间戳排序应用 `CREATE/DROP INDEX`，得到「最终态」而不是并集；③`@Entity()` 无表名时红（或至少 `checked` 下界 + 未命名/未比对数上报为 configError）。

**selftest 质量**：问题最大的一条。selftest 明确写「`check()` 走 FromFiles 组合…故这里用 `scan*` + 手工比对**复刻** check 的断言面」（:270-272），然后把四元组比较在 `assertSubset`（:278-299）里又实现了一遍。因此**改坏 `check()` 本体，selftest 全绿**——这恰好是「断言的是副本，不是被测对象」。退出码方面：selftest 内部 `process.exit(1)`，但没有子进程退出码断言。

### 2.3 `check-cron-guard.mjs` —— 最诚实的一条，扣分在「永久豁免」

**判据**（`findUnguardedCrons` :248）：对每个 `@Cron(` 花括号配对到方法体，体内须出现 `try {`、`guardedCron(` 或 `guardTick(`（:42-43）；另有 `guardTickDelegatesToGuardedCron`（:312）防止 `guardTick` 沦为摆设；规模下界 20（:46）；排除面每次打印（:586-604）。词法掩码 `maskNonCode`（:71）做得比同类守卫好（注释/字符串/模板串里 `{`/`}` 不参与配对）。

**失效模式**：

1. **`modules/agent/**` 的 4 个 `@Cron` 被排除**（:55-62），实跑输出「21 个方法体全部有闸（排除面 4 个）」。排除理由自己写着「该目录 4 个 @Cron 中 sweepAggregator 仍无闸，审计 rt-5 已记」——即**已知真缺陷被写在豁免里，而守卫结论仍然是「齐备」**。回收机制只有注释承诺（"解锁后必须删掉本条"），没有任何机器判据在盯它。
2. **只认 `try` 存在，不认 catch 语义**：`try { … } catch (e) { throw e; }` 会重抛 → 一样触发 `unhandledRejection` → 一样 `exit(1)`，但守卫判定为「有闸」。实测仓库内 5 个文件存在 `catch { … throw }` 形态（`agent-session.service.ts`、`app-deployment.service.ts`、`auth.service.ts`、`config.service.ts`、`executor.service.ts`），是否落在 `@Cron` 体内未逐一核对（标 **未验证**），但这形态对判据是透明的。

**可否机械补强**：可。①判据升级为「catch 块内不得出现**裸** `throw`」（正则：`catch\s*\([^)]*\)\s*\{(?![^}]*logger)[^}]*throw`）；②`EXCLUDED_PREFIXES` 增加**过期字段**（`until`/`issue`），到期未删则红；③把排除面数目也纳入下界（例如「排除面 > 0 且连续 3 轮无变化 → 提示」）。

**selftest 质量**：好于平均——用例全是「反证打出来」的形态（注释、邻方法、模板串），用例数不足即 `process.exit(1)`（:535）。缺陷是**没有子进程退出码断言**，也没有覆盖「排除面」分支。

### 2.4 `check-metric-docs.mjs` —— 唯一三件齐全的一条（本轮的金标准）

**判据**（`analyze` :409，纯数据返回、main 负责打印与退出码）：注册表 42 指标（counter 15 / gauge 4 / service 23）↔ `docs/**` 里 39 个 `autoflow_*` token 双向；`FLOORS`（:130）给 counter/gauge/service/total 四个下界，解析不到就红；基线棘轮**双向**（新增未文档化红 :532 反向、基线陈旧红）；`allowlist` 陈旧也红（:545）；行内豁免 `metric-docs:ignore-unknown` **缺理由即红**（:503-510）。

**失效模式**：面内只剩一类——文档里写对了指标名，但该指标没真正注册进 `/api/metrics` 渲染（静态源字面量 ≠ 运行时暴露）。这不是假绿，是守卫刻意的判据边界。

**可否机械补强**：已经很好。唯一建议：把「不可读/被挪走」的 configError 归到单独小节（目前统一打成「守卫自身失效」，导致「marker 缺理由」这类**内容错误**也显示成自失效，实测 B 用例文案会误导修复者）。

**实证（本轮真的跑出了红）**：在 `/tmp/r4/tree` 造 16 指标的最小树，`node scripts/check-metric-docs.mjs --root /tmp/r4/tree`：

| 用例 | 期望 | 实测 |
| --- | --- | --- |
| 干净树 | exit 0 | **exit 0**（`✓ …注册表 16 个；基线欠账 0 个`） |
| 文档多写 `autoflow_ghost_total` | 红 | **exit 1**「文档引用了注册表里**不存在**的指标名 1 处」 |
| `metric-docs:ignore-unknown` 无理由 | 红 | **exit 1** |
| allowlist 陈旧条目 | 红 | **exit 1**「守卫自身失效」 |
| 基线里有已文档化条目 | 红 | **exit 1**「基线**陈旧** 1 条」 |
| 注册表新增未文档化 gauge | 红 | **exit 1**「新增了未文档化 1 个」 |

**selftest 质量（全仓最好）**：`mkdtemp` 造 17 棵树，`spawnSync(process.execPath, [SELF, "--root", dir, …])`，**断言退出码 + 关键报错文本 + `expectAbsent`**（:1120-1165），实跑 `17/17 通过`；注释明写「只断言不抛的 selftest 会在判据整体失效时照样全绿」（:893-895）。这是其余 9 条应该抄的模板。

### 2.5 `check-enum-drift.mjs` —— 判据本身对，覆盖面靠一张手维护的表

**判据**（`check` :115）：对 `TS_TO_PG`（:26-40，13 条）里的每个映射，`tsVals ⊆ pgVals`；取不到任一侧都算错。PG 侧扫 `CREATE TYPE … AS ENUM`（:53）与 `ALTER TYPE … ADD VALUE`（:63），TS 侧扫 `export enum X { A = "…" }`（:89,:96）。另有前端字面量扫描（:148-157），**只有 1 条锚点**（`ExecutorListPage` 的 status select）。

**失效模式（实证）**：

1. **映射表是唯一覆盖边界**：一个新增的 `export enum Foo {…}` 若不写进 `TS_TO_PG`，完全不受护，且没有任何判据要求「所有字符串枚举都必须登记或被显式豁免」。实跑输出「13 个 TS enum 全部 ⊆ 对应 PG enum」——「13 个」这个数字本身没被任何下界校验。
2. **const-object 枚举扫不到**：`export const TaskStatus = { PENDING: "pending", GHOST: "ghost" } as const` → `scanTsEnums` 返回空（实测：只识别出同文件里的 `export enum Real`）。若把某个已映射的枚举改成 const object → 会因 `!tsVals` 红（fail-safe，可接受）；但**新**枚举用 const object 则无感。
3. **正则截断会静默丢值**：`/export\s+enum\s+(\w+)\s*\{([^}]*)\}/` 遇 `}` 即收，实测 `export enum Weird { A = "a", B = fn({ k: 1 }), C = "c" }` 只提取到 `["a"]`，**`"c"` 丢失**——这正是「TS 值 ⊆ PG 值」判据最怕的形态（漏进去的值永远不比对）。

**可否机械补强**：可。①反向覆盖：扫出所有 `export enum`/`export const X = {…} as const`，凡不在映射且不在豁免清单 → 红；②枚举体解析改成括号深度配对（照抄 `check-conditional-writes.readBraced`）；③`FRONTEND_STATUS_SCANS` 从 1 条扩到「所有 `options={[` + `value: '…'` 的筛选块」，并把锚点缺失当前已能红（:190-195，值得保留）。

**selftest 质量**：`selftest()`（:261-283）直接构造 `fixturePg`/`fixtureTs` 两个 `Set` 喂 `check()`，**从不调用 `scanPgEnums`/`scanTsEnums`**——也就是说，上面第 3 条的正则截断、第 2 条的 const-object，都是自检视野之外。`selftestFrontend`（:206-259）反而做了「锚点丢失」的反证，质量明显更高。退出码：内部 `process.exit(1)`，无子进程断言。

### 2.6 `check-guards-wired.mjs` —— 判据是「子串在不在文本里」，两处误绿已实证

**判据**（131 行）：对每个 `check-*.mjs`，`workflows.includes(文件名)`（:100）**或** 某个 package.json script 的命令包含该文件名、且 `workflows.includes("npm run " + scriptName)`（:106）。有扫描面下界 20（:75-83），有 ALLOWLIST 且要求写理由（:33-41）。

**失效模式（实证）**：`ROOT = process.cwd()`，所以可以直接在 `/tmp/fakeroot` 造一个假根来跑它（**未动仓库内任何文件**）：

- 假根造 25 个 `scripts/check-fakeNN.mjs`，`ci.yml` 里只写一行**注释** `#   node scripts/check-fake00.mjs` → 实跑结果：`check-fake00` **未被报红**（判为已接线），其余 24 个报红（exit 1）。即：**把 CI 步骤注释掉，这个守卫依旧认为那条守卫在跑**。
- 第二个假根：`scripts: { "check": "node scripts/check-fake01.mjs", "check:all": "…" }`，workflow 只写 `npm run check:all` → 实跑：`check-fake01` **被判为已接线**（`"npm run check"` 是 `"npm run check:all"` 的子串），exit 1 只因为其余 23 个没接线。

其余：`ALLOWLIST` 无回收（`apps/admin-api/scripts/check-route-authz-matrix.mjs` 的理由是「判据本体已被 jest 收集」——这条假设本身没有任何机器校验）；**全文件无 `--selftest`**，上面两个洞在仓库里没有任何反证用例。

顺带核了一条常见怀疑（结论：**不成立**）：CI 里只有一个 `continue-on-error: true`，在 `.github/workflows/ci.yml:2140`（micro-benchmark 阈值告警，刻意非阻塞），**没有任何 `check-*.mjs` 挂在非阻塞步骤上**；`check-conditional-writes` 在 `ci.yml:906-907` 是 selftest + 实扫两步都跑。

**可否机械补强**：可。①先剥 YAML 注释再匹配（或只认 `run:` / `uses:` 行）；②`npm run X` 匹配改成「`npm run X` 后必须紧跟空白/行尾」而不是 `includes`；③ALLOWLIST 加 `mustProve` 字段（该豁免依赖的文件/测试名），并校验其存在；④补 `--selftest`（本项目已有 metric-docs 模板）。

### 2.7 `check-conditional-writes.mjs` —— 「基线 0」制造了最强的假安全感

**判据**（`findUnconditionalUpdates` :137）：扫 `apps/admin-api/src/modules/**`（:41），`stripNonCode`（:69）抹注释与字符串，匹配 `.update(` 且**首个实参是对象字面量、顶层键恰为 `['id']`**（:149）。`BASELINE = 0`（:49）意味着「一处都不许有」。豁免：调用前 5 行内出现 `adr-026-exempt`（:200-205）。实跑：`0 处（基线 0，扫了 307 个文件）`。

**失效模式（实证，调导出函数，6/6 全零命中）**：

| 形态 | 是不是真缺陷 | 判据结果 |
| --- | --- | --- |
| `repo.createQueryBuilder().update().set({…}).where("id = :id",{id})` | 是（无状态谓词） | **0 命中** |
| ``q.query(`UPDATE tasks SET status='x' WHERE id='1'`)`` | 是 | **0 命中**（模板串被 `stripNonCode` 抹空，:82,:90-93） |
| `repo.update({ id, name }, patch)` | 是（多键无状态谓词，文件头自认盲区②） | **0 命中** |
| `repo.update(a.id, patch)` | 视实现 | **0 命中**（首参非对象即 `continue`，:145） |
| `repo.update({ where: { id } }, patch)` | 视实现 | **0 命中** |
| `repo.save(entity)` 整行回写 | 是（盲区①，R32-C3/A4 两起真实事故） | **0 命中** |

规模对照：仓库里 `createQueryBuilder()` 站点 **46**、`.update()` 站点 **4**、`.save(` 站点 **68**（非 spec）。也就是说**守卫的强制面是 0 形态，而旁边躺着 118 个它看不见的写站点**。

盲区①的「报告模式」`--report-saves`（:258-260）确实存在，但：①永不失败；②`package.json:153` 有 `check:conditional-writes:saves`，而 `.github/workflows/*.yml` 里**没有任何地方调用它**（`grep -rn "report-saves" .github/workflows/` 为空）。于是「已知盲区」连报告都不跑。

**可否机械补强**：可。①把 `--report-saves` 接进 CI（哪怕只打印，也要有历史可比）；②`createQueryBuilder().update()…where(` 链路纳入判据（要求 `where` 参数里出现 `status/version/attempt/leaseUntil/dispatchedAt` 等状态键或 `IS NULL` 谓词）；③把「裸 SQL `UPDATE …`」从 `stripNonCode` 里单独保真提取（正则直接扫原文 `/\bUPDATE\s+\w+\s+SET\b/`），要求同语句出现状态谓词；④`EXEMPT` 窗口从 5 行改为「紧邻上一行」，并要求 `adr-026-exempt: <reason>` 非空（现在只 `includes` 标记）。

**selftest 质量**：7 + 5 条反证用例，覆盖注释/字符串/嵌套/shorthand，质量中上；但**断言的是函数返回值个数**，不是进程退出码，因此「主流程 `process.exit(1)` 被删掉」或「`BASELINE` 被改成 999」都测不出来（后者连用例都不会挂）。另注：该脚本在被 `import` 时会**执行实扫并打印**（无 `isMain` 判断，:255-274；对比 `check-index-drift.mjs:335` 有）。这直接堵死了「照 metric-docs 的样子给它写 `--root` 自检」这条路。

### 2.8 `check-ssrf-deny-parity.mjs` —— 有 0 条守卫，但只有「字符串存在性」

**判据**（:48）：从 `apps/admin-api/src/common/utils/__tests__/ssrf-deny-matrix.spec.ts` 用正则抽 `{ name, addr, risk }` 三键对象；每个 `addr` 必须以 `addr: "<addr>"`（executor-node，:35）或 `"<addr>"`（executor-python，:40）出现在镜像文件文本中。0 条即红（:52-56，这条自检写得对）。实跑：18 条 addr 全部对齐。

**失效模式**：

1. **只比字符串出现**：executor-python 侧 needle 是**裸引号字符串**，写进注释、写进一个「已知放行/待修」列表、或写在一个 `pytest.mark.skip` 的用例里，都算「已对齐」。executor-node 侧同理（`addr: "…"` 也可能出现在被注释掉的表项里——该文件是 spec，`in` 判断不看上下文）。
2. **矩阵条目数没有下界**：文件头自称「18 条」，判据只挡 `=== 0`（:52）。从 admin-api 矩阵里**删掉** 15 条危险地址（比如 `198.18.0.0/15` 那条），守卫依旧全绿——而这条缺失正是文件头自己记录的 R77 实战发现。对照 `check-guards-wired` 的 `guards.length < 20` 与 metric-docs 的 `FLOORS`，这里缺同款下界。
3. **反向不校验**（:14 自认，合理），因此「镜像里有、实现里没拦」不报警——但实现侧的拒绝行为本身没有任何守卫在跑，只靠两个 spec 各自的断言（那些断言不在本守卫视野）。

**可否机械补强**：可。①`entries.length < 18` 即红（或从基线文件读下界）；②将 needle 限定在「危险地址表常量」的语法范围内（如 node 侧的 `DANGER_ADDRESSES` 数组切片、python 侧的 `DANGER_ADDRESSES = [...]` 字面量）；③在 CI 里同时跑两侧的 spec（现在只跑守卫，spec 是否被 jest/pytest 收集不在本守卫判据内）。

**selftest**：**无 `--selftest`**（84 行全文）。唯一自检是那句 0 条判定。

### 2.9 `check-user-facing-language.mjs` —— 现在是真绿，但判据是「有没有一个汉字」

**判据**（三面）：A `openapi.json` 的 schema 字段 description + paths summary/description（外加 parameters/requestBody/responses，:169-235，注释里记录了「曾经漏扫 responses」的事故）；B `apps/admin-api/src/**` 的 `throw new *Exception(<字面量>)`（:326）；C 执行器侧（:400）——node 用 `collectThrownMessages`，**python 只用 `PY_RAISE_RE = /raise\s+\w*(?:Error|Exception)\(…/`**（:398）。合规判定：`isNonChineseUserText`（:162-167）→ **文本里出现任一 CJK 字符即返回 false（合规）**；无 CJK 时才走 `hasSubstantiveEnglish`（:151，≥2 残留英文词或 1 个首字母大写词）。

**实测绿是真绿**：独立核算 `apps/admin-api/openapi.json`：schema description **888** 条、paths summary/description **338** 条，**无 CJK 的 0 条**；守卫报「面向用户英文 0 处，全部在基线内（上限 0）」，基线 `known: [] / maxKnown: 0`。也就是说中文化确实做完了，棘轮已收到 0——这一点第 3 轮若记作欠账应更正。

**失效模式**：

1. **CJK 存在即合规 ⇒ 半英半中永久免检**。实测 `apps/admin-api/src` 里「含 CJK 且残留 ≥2 个英文词」的用户面/启动面消息 **23 处**，例如 `apps/admin-api/src/common/utils/secret-crypto.util.ts`「SEC-02 密钥必须为 32 字节（AES-256），实际为 ${key.length}」、`apps/admin-api/src/config/configuration.ts`「[AutoFlow] 生产环境 ${name} 必须使用 https://（仅 localhost/127.0.0.1 允许 http…）」、`apps/admin-api/src/modules/application/app-deployment.service.ts`「AppDeploymentEvent 仓储未接线（应为 application.module 的 …」。多数属开发者/运维面（可争），但判据**结构上无法区分**「中英混排的用户文案」与「带技术标识的中文文案」，所以这条不会给任何信号。
2. **`apps/admin-web/**` 完全不在扫描面**（全文件 grep `admin-web` 无命中）。产品面向用户的主界面是 React，`src/locales/{zh,en}.ts` + 各页面硬编码字符串才是真正的用户面；i18n 双语文案合法，但「绕过 i18n 硬编码英文」这一形态无人守。
3. **Python 的 `detail=` 不在面内**：`apps/executor-python/routers/*.py` 里 `HTTPException(..., detail='…')` 是真正回给用户的 HTTP 文案（实测 `logs.py:32,37,40`、`config.py:126,133`），判据只认 `raise *Error(`。当前这些文案恰好是中文，但**新增英文 detail 不会被抓**。
4. **`info.description` 不在面内**：`openapi.json` 的 `info.description` 是纯英文（`"AutoCodeFlow Admin API — exported by test/openapi-export.e2e-spec.ts …"`），判据只扫 `components.schemas` 与 `paths`。

**可否机械补强**：可。①判据从「有 CJK」升级为「`residualEnglish()` 结果为空」——即把 `hasSubstantiveEnglish` 应用到**所有**面向用户文本（含 CJK 的也要过），这样中英混排会红；②扫描面加 `apps/admin-web/src/{pages,components}/**`，判据为「JSX 文本节点里出现 ≥2 个英文词且不在 `t(...)` 内」；③python 加 `detail=` 与 `HTTPException(` 分支；④openapi 补 `info.*`、`tags[].description`。

**selftest 质量**：`selftest`（:532-662）断言的是**布尔判定**（`isNonChineseUserText(...) === true/false`），不是退出码，也不是实扫路径。它有一批好用例（品牌名、env 名、主机:端口、路径），但**没有一条用例覆盖「中英混排」**——所以上面第 1 条盲区在自检里也看不见。

### 2.10 `check-sdk-docs-truthfulness.mjs`（代 `check-docs`）—— 关键词共现式判据

**判据**（:100 `auditDoc`）：A. `TARGETS`（:33，只有 `README.md` 与 `docs/sdk-guide.md`）里每个 js/ts/py 围栏，若出现 `ctx.` 则同围栏必须出现 `@autocodeflow/sdk` / `autoflow_sdk`；B. 文档里**任意一行**必须同时含 `glue` 与「忽略/不安装/do not install…」（`hasGlueCaveat` :77-84）；C. 不得出现「ctx 无需引入」的错误口径（:88）。

**失效模式**：

1. 判据 A 是「同围栏出现字符串」——注释里写一行 `// 需要 @autocodeflow/sdk` 即可满足；且只认 `\bctx\s*\.`，`context.`、`ctx\n.`、`await ctx?.http` 不触发。
2. 判据 B 是纯共现，不要求那句话与 Glue 有任何语义关系（任意一行含 glue + “不安装” 即通过），且不排除这句话本身在代码围栏里。
3. 覆盖面 2 篇文档；`docs/guide/**`、`docs/observability/**` 里的示例不受护。
4. 文件不存在也算 problem（:203），这点是对的。

**可否机械补强**：可。①判据 A 改为「围栏内出现 `ctx.` 时，**首个非注释非空行**必须是 SDK 引入」；②判据 B 要求「与 Glue 同一段落（±2 行）内」；③把文档清单从一个手写数组改成 glob（`docs/**/*.md` 中带 ` ```js ` 的）。

**selftest 质量**：5 个夹具（good / glueOnly / noImport / noCaveat / wrongClaim），断言**问题个数**（`=== 0` / `>= 1`），不断言退出码；有 `invokedDirectly` 判断（:200），可被 import，是这 10 条里第二个能做进程内自检的（第一个是 index-drift）。

---

## 3 弱断言清单

### 3.1 口径与计数

用脚本扫全部 spec，按 6 类形态分类（`/tmp/r4/weak.mjs`）：

| 形态 | admin-api（387 spec） | admin-web（258 test） |
| --- | --- | --- |
| `expect(true).toBe(true)` / `expect(1).toBe(1)` 类永真 | **4**（另 1 处是注释里的历史记录，不算） | **1** |
| 用例体内**完全没有** `expect` | 22（抽查后 **20 是"断言在本地 helper 里"**，合法但不可 grep；0 是真无断言） | 12（同类：断言在 helper 或循环里） |
| 只 `toHaveBeenCalled()` 不看参数 | **1209** 处 | **192** 处 |
| snapshot-only（只有 snapshot 无取值断言） | **0** | **0** |
| 把被测对象 mock 掉再断言「它被调用」（spec 文件名 = 被 mock 模块名） | **0** | **0** |
| `try/catch` 吞异常 | 41 处（逐条抽查 3 处：`JSON.parse` 保护、assert-in-catch、模拟事务 ROLLBACK——**均合法**） | 2 处（合法） |
| 收集了 `unhandledRejection` 却从不断言（死仪表） | 0（2 处命中是测试名里的词，误报） | **4 个数组 / 3 文件** |

两条口径说明（防下一轮重复劳动）：`snapshot-only` 与「mock 被测对象」在**本仓确实不存在**；`try/catch` 也不是本仓的弱断言来源。真正的大头是「只看调用发生、不看调用内容」和「环境不满足时用永真断言冒充通过」。

### 3.2 admin-api（10 条，含 file:line）

| # | 形态 | 证据 | 为什么它能假绿 | 建议改法 |
| --- | --- | --- | --- | --- |
| A1 | **跳过伪装成通过** | `apps/admin-api/src/common/utils/__tests__/async-stdout.util.spec.ts:91`、`:190`、`:219`；`apps/admin-api/src/modules/task-template/__tests__/task-template.runnable.spec.ts:356` | `if (!cond) { expect(true).toBe(true); return; }` —— 环境一变（CI 无 python / stdout 是文件）用例照样"通过"，实际一条断言都没跑 | 改成 `it.skip`（报告里可见）+ 一个独立的「环境探测」用例断言能力矩阵；或 `expect(cond, "…原因").toBe(true)` 让它真红 |
| A2 | **写路径只断言"被调用"** | `apps/admin-api/src/modules/task/__tests__/task.service.spec.ts:438`、`:652`、`:3973`；`task.service.broadcast-mutex.spec.ts:191`、`:205`；`python-multiversion-write-path.spec.ts:295`；`config/__tests__/config.service.spec.ts:98` | `expect(taskRepo.save).toHaveBeenCalled()` 与 `check-conditional-writes` 的盲区①**完全重合**：整行回写把并发结果覆盖成旧值，测试断言"写了"却从不看"写了哪些字段" | 断言 payload：`expect(taskRepo.save.mock.calls[0][0]).toMatchObject({ status: 'RUNNING', sessionVersion: <新值> })`；对 CAS 路径断言 `update` 的 where 含 `status/version` |
| A3 | **迁移 down() 只断言"是个函数"** | 53 个文件，例：`apps/admin-api/src/migrations/__tests__/add-api-key-task-trigger-scope.migration.spec.ts:28` | `expect(typeof migration.down).toBe("function")` 对「down 删错列/漏删索引/顺序错」全无感；53 个文件里 53 次重复同一形状断言 | 见 §4.2 D1：把 down 纳入「up∘down 对称」判据，或至少断言 down 的 SQL 文本覆盖 up 提到的每个 DDL 对象 |
| A4 | **迁移只断言 SQL 文本** | 同上 `:31-42`；`42` 个 spec 使用 `upPart`/`downPart` + `toContain` | 文本 `toContain` 与真实 DDL 执行无关：`IF NOT EXISTS` 语义、列类型宽窄、`SET LOCAL` 在事务外无效… 都测不出 | 保留文本断言作静态层，另加 3~5 个「fake QueryRunner 记录 SQL 序列」的执行层用例（仓库已有先例，见 §4.2 D1） |
| A5 | **幂等性用计数断言** | 13 个文件，例：`add-api-key-task-trigger-scope.migration.spec.ts:41-42`（`expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(1)`） | 任何注释/字符串里出现该短语就改数；且计数正确 ≠ 语义正确 | 改为对 `up()` 执行两次（fake runner）断言第二次为 no-op |
| A6 | **时间戳登记断言重复且已有机械守卫** | 10 个文件 `expect(registry).toContain("\| <ts> \|")`，例：`add-api-key-task-trigger-scope.migration.spec.ts:50` | `scripts/check-migrations.mjs` 规则 2 已全量覆盖，spec 里再写一遍属纯噪声（改一次要改 10 处） | 从 spec 删除，只保留守卫 |
| A7 | **断言在本地 helper 里（不可 grep、不可单独跑）** | `apps/admin-api/src/common/utils/__tests__/keyset-cursor.util.spec.ts:124,132,138,154,159,165,172,179,187`；`config/configuration.spec.ts:68,72,78`；`modules/sop/__tests__/sop-media.service.spec.ts:308,319`；`modules/task/__tests__/tasks-keyset-pagination.spec.ts:830,837`（22 处） | 不是缺陷，但 `--testNamePattern` / CI 失败行号都指不到具体断言；helper 里若 `return` 早退，用例静默通过 | helper 至少 `expect.assertions(n)` 或返回断言结果并在 `it` 里 `expect(...)` |
| A8 | **只断言"没有发生"作为唯一判据** | 13 文件 37 处 `expect(repo.save).not.toHaveBeenCalled()`（例：`modules/ai/__tests__/ai-media.spec.ts:86`）；7 文件 12 处 `expect(repo.createQueryBuilder).not.toHaveBeenCalled()` | 反证成本低，但"没写"≠"做对了"；实现整段删空也绿 | 每个 `not.toHaveBeenCalled` 配一条正向断言（返回体/状态机/audit 事件） |
| A9 | **mock 参数部分匹配** | 20 文件 59 处 `expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(...))`（例：`modules/ai/__tests__/ai.service.spec.ts:304`） | `stringContaining` 只钉住一个子串，日志内容退化/字段丢失不影响 | 对关键告警改成 `toHaveBeenCalledWith(expect.stringContaining("a"), expect.objectContaining({code:"X"}))` 或解析 JSON 日志后断言结构 |
| A10 | **计数断言当语义断言** | 7 文件 17 处 `toHaveBeenCalledTimes(N)`（例：`common/services/__tests__/domain-event-bus.service.spec.ts:119`） | 次数对但参数错（发给了错的 listener）照样绿 | 与 A2 同法：断言调用参数 |

正面样本（**不要**改，作为验收参照）：`apps/admin-api/src/modules/event-subscriptions/__tests__/outbox-dispatcher.spec.ts:262-290`（CAS 谓词逐条断言 + `affected=0 → false` 的失败分支）、`apps/admin-api/src/modules/agent/trigger/__tests__/agent-trigger.service.spec.ts:344-360`（注释里留了"原用例只有 `expect(true).toBe(true)`"的修复记录，并改成正反两态）。

### 3.3 admin-web（10 条，含 file:line）

| # | 形态 | 证据 | 为什么它能假绿 | 建议改法 |
| --- | --- | --- | --- | --- |
| W1 | **探针文件当测试提交，末尾永真** | `apps/admin-web/src/__tests__/zz-probe.test.tsx:82` | 前面 20+ 行 `console.log` 手工观察，最后 `expect(true).toBe(true)`：`Escape` 关不掉弹窗它也绿 | 要么删掉，要么改成 `expect(document.querySelector('.ant-modal')).toBeNull()` |
| W2 | **死仪表：收集了 rejection 从不断言** | `apps/admin-web/src/__tests__/api-keys-deep.test.tsx:108,125`、`registry-page.test.tsx:131`、`event-subscriptions-settings.test.tsx:160`（4 个数组 / 3 文件） | `const swallowed = []; process.on('unhandledRejection', r => swallowed.push(r))` 之后**从未** `expect(swallowed)`：拦截器被拆掉、promise 真漏都不会红 | 补 `expect(swallowed).toHaveLength(0)`（或至少断言每条是预期的 axios 取消错误） |
| W3 | **创建接口只断言"被调用"，不看请求体** | `apps/admin-web/src/__tests__/api-keys-settings.test.tsx:114` | 表单校验通过后 `expect(mocked.create).toHaveBeenCalled()`：字段名写错、scope 传错都绿 | `expect(mocked.create).toHaveBeenCalledWith(expect.objectContaining({name:'ci-deploy', scope:'task:read'}))` |
| W4 | **"没调用"作为唯一判据** | `api-keys-deep.test.tsx:115,134`、`agent-sessions-page-b14.test.tsx:217`、`app-deployment-delete-record.test.tsx:178`、`application-list-name-max.test.tsx:123,141` | 校验不通过 → `not.toHaveBeenCalled()`；但**错误提示文案**只断言了"存在某个 `.ant-form-item-explain-error`"，提示内容可以是任意串 | 加断言：`expect(screen.getByText('名称不能超过 100 个字符')).toBeTruthy()` |
| W5 | **DOM 存在性当行为断言** | `design-audit-shard-a-dag.test.tsx:54,78`（`expect(nodeEl).toBeTruthy()`）、`execution-detail-log-level.test.tsx:149`（`expect(select).toBeTruthy()`）、`audit-keyset-paging.test.tsx:192,215` | `querySelector('.x')` 命中任意节点即真：节点渲染了但内容/选项/禁用态全错也绿 | 断言文本/选项集合/`aria-*`/`disabled`，例如 `expect(select?.textContent).toContain('ERROR')` |
| W6 | **只断言"没有 console.error"** | `antd-deprecation-clean.test.tsx:391,403,425,438` | 反证型断言：渲染崩掉之前的告警数也满足；且 antd 版本升级后可能改为 `console.warn` 而守卫继续绿 | 同时断言关键 DOM 内容（"无告警"是附加条件不是主判据） |
| W7 | **断言在 helper 里（同 A7）** | `task-form-glue-backfill.test.tsx:212,220,230`、`template-category-label.ux10.test.ts:104`（12 处） | 见 A7 | 见 A7 |
| W8 | **全仓正则扫描式"守卫测试"** | `apps/admin-web/src/__tests__/error-message-normalization.ux11.test.ts:101`、`design-audit-shard-a.ux.test.ts:69` | 这类测试断言的是**源码文本**（`toContain('getErrMsg(')`），实现改语义仍绿；但它们是有效补充（本仓惯例），不应删除 | 保留，但要配一条真实行为用例（构造 axios 错误断言最终渲染文本） |
| W9 | **`toBeTruthy` 包住 `waitFor` 的等待断言** | `api-keys-deep.test.tsx:106`、多处 `await waitFor(() => expect(document.body.querySelector('.ant-modal-title')).toBeTruthy())` | 等待条件宽松 → 后续断言在"还没渲染好"的状态上跑，可能偶然通过 | 改成 `await screen.findByRole('dialog', {name:'创建 API Key'})` |
| W10 | **用例名承诺的行为多于断言** | `api-keys-deep.test.tsx:120`（"名称超 100 字符 → max 校验拦截，不调 create"）里只断言了"存在错误提示 + 没调用" | 名称长度规则（100 vs 64）没被钉住：上限改成 64 也绿 | 断言边界：100 通过、101 拦截（两态都测） |

> 说明：`log-json.test.ts:49` 被我的扫描器误报为「无 expect」（实为多行嵌套对象导致块解析偏差），**不是缺陷**——列在这里是为了说明 §3.1 的 22/12 需要人工复核，不能当指标用。

---

## 4 重复覆盖与零覆盖

### 4.1 重复断言（噪声，≥4 个文件写同一句）

| 断言签名 | 文件数 / 站点数 | 判断 |
| --- | --- | --- |
| `expect(typeof migration.up).toBe("function")` | **53 / 53** | 纯形状，零语义（§3.2 A3） |
| `expect(typeof migration.down).toBe("function")` | **53 / 53** | 同上 |
| `expect(upPart).toContain(` | **42 / 84** | 文本级，可接受但冗余 |
| `expect(downPart).toContain(` | **12 / 18** | 唯一触及 down 语义的断言，仍是文本级 |
| `expect(repo.save).not.toHaveBeenCalled()` | 13 / 37 | 反证型，需配正向断言 |
| `expect(audit.log).toHaveBeenCalledWith(` | 13 / 48 | 有效（审计面），可接受 |
| `expect(res.status).toBe(N)` | 12 / 71 | 宽泛，作为冒烟层可接受 |
| `expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(N)` | 13 / 13 | **脆**：注释里出现即崩 |
| `expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(N)` | 13 / 13 | 同上 |
| `expect(registry).toContain("\| <ts> \|")` | 10 / 10 | **与 `check-migrations.mjs` 完全重复** |
| `expect(warnSpy).toHaveBeenCalledWith(` | 20 / 59 | 部分匹配，弱 |
| `expect(repo.create).toHaveBeenCalledWith(` | 8 / 15 | 好样本（有参数断言） |

一句话：**迁移域是重复度最高的区域**（54 个 spec 里 53 个共享同一对形状断言），而它们的**共同盲区（down 的执行语义）恰好零覆盖**——重复与空白叠在同一处，这是第 3 轮「同一个病在三个域各复发一次」的结构性原因之一。

### 4.2 零覆盖 / 近零覆盖（本轮真正的新发现）

| # | 不变量 | 覆盖现状 | 证据 |
| --- | --- | --- | --- |
| **D1** | **迁移 `down()` 的执行语义（回滚能否真的撤销 up）** | 122 个迁移；**68 个没有任何 spec**；54 个有 spec 的里 **51 个只做文本断言**，**只有 3 个真的执行 `down()`**（用 fake QueryRunner，不是真 PG） | 无 spec：`1717473142678-InitialSchema.ts` 等 68 个；执行 down：`backfill-app-deployment-events.migration.spec.ts:262`、`flip-task-dependency-map.migration.spec.ts:129`、`make-official-task-templates-runnable.migration.spec.ts:41`；执行 up 同样只有 3 个 |
| **D2** | **并发条件写的竞争窗口** | 有「CAS 谓词存在」的 mock 级断言（好），**没有**任何「两个写者真并发」的用例；`grep testcontainers\|pg-mem\|new DataSource` 在 `migrations/__tests__` 与 `test/` 下 **0 命中** | `outbox-dispatcher.spec.ts:262-290`（谓词断言，值得保留）；`check-conditional-writes` 在 `ci.yml:906-907` 只跑静态 |
| **D3** | **条件写的静态覆盖面** | 守卫强制面覆盖率 ≈ 0：6 类真实形态全零命中（§2.7 实证），旁边有 **46** 个 queryBuilder 站点、**4** 个 `.update()`、**68** 个 `.save(` | `/tmp/r4/probe4.mjs`；`grep -rn "createQueryBuilder()" --include=*.ts \| grep -v spec \| wc -l` = 46 |
| **D4** | **`.save(裸标识符)` 盲区的巡检** | `--report-saves` 存在但**不在 CI**（`package.json:153` 定义，workflow 0 引用） | `grep -rn "report-saves" .github/workflows/` → 空 |
| **D5** | **`down()` 删索引 / `DROP INDEX` 的对称性** | 双向都无守卫：迁移侧不解析 `DROP INDEX`（§2.2 实证②），测试侧不执行 down（D1） | `/tmp/r4/probe.mjs` 输出「CREATE then DROP INDEX：ddl 仍然认为索引存在 = true」 |
| **D6** | **admin-web 用户面的中文化/硬编码英文** | **零覆盖**（语言守卫扫描面不含 `apps/admin-web`） | `grep -rn "admin-web" scripts/check-user-facing-language.mjs` → 空 |
| **D7** | **Python 的 `HTTPException(detail=…)` 用户文案** | 不在判据内（只认 `raise *Error(`） | `check-user-facing-language.mjs:398`；实物 `apps/executor-python/routers/logs.py:32,37,40`、`config.py:126,133` |
| **D8** | **`openapi.json` 的 `info.description` / `tags[].description`** | 不在判据内；`info.description` 目前是**纯英文**（生存实例） | `check-user-facing-language.mjs:169-235`；`openapi.json` 的 `info.description` |
| **D9** | **「守卫自身在不该绿的时候不绿」** | 40+ 个守卫里**只有 5 个**有独立 `.selftest.mjs` 文件（`check-dependency-review`、`check-desktop-update-chain`、`check-migrations`、`check-no-hoisting`、`check-openapi-response-schema`），其余自检写在主文件里或没有；`check-guards-wired` 一个都没有 | `ls scripts/check-*.selftest.mjs` = 5；§2.6 |

### 4.3 第 3 轮三条判断的加码（结论不变，现在有实证）

1. `check-alerts-rules` 只比指标名 → 现在有 5/5 非法表达式全绿的实证（§2.1）。
2. `check-index-drift` 只比命名声明 → 现在补出「表名缺省即跳过」「DROP INDEX 不可见」「partial 谓词不可见」三条（§2.2）。
3. `check-guards-wired` 只看文件名 → 现在有「YAML 注释即接线」「`npm run check` 前缀误绿」两条实证（§2.6）。

---

## 5 建议：下一轮最值得补的 5 条守卫/测试

排序依据 = 「能抓到的真实缺陷形态 × 现在完全抓不到 × 补起来是机械的」。

**T1（P0）`check-alerts-rules` 加 expr 语法与可触发性判据**
- 做什么：括号/引号配平；`expr` 不得以运算符结尾；必须引用 ≥1 个指标且含比较/`absent()`；`_total` 必须出现在 `rate/increase` 内，gauge 不得套 `rate`；显式拒绝 `0 == 0`、`vector(1) > 2` 这类恒不成立形态（或要求写 `# never-fires: <理由>`）。
- 能抓到什么真实缺陷：告警规则写错 → **pager 永远不响**，而那正是这份文件存在的唯一目的。现有判据已经证明对 5 种错法完全无感（§2.1 表）。
- 验收：把 `expr: up == 0` 改成 `up ==`，`node scripts/check-alerts-rules.mjs` 必须 exit 1。

**T2（P0）`check-conditional-writes` 扩到 queryBuilder/裸 SQL，并把 `--report-saves` 接进 CI**
- 做什么：①`createQueryBuilder().update()…where(...)` 链路要求 where 含状态键；②原文正则抓 `UPDATE <t> SET`（绕过 `stripNonCode` 的模板串抹除）；③`--report-saves` 进 CI 且与基线数字比对（只许降）。
- 能抓到什么真实缺陷：ADR-026 记录的那类「已吊销 token 复活/禁用失效/部署回滚」——现在 6 种形态 0 命中，而代码里躺着 118 个写站点（§2.7）。
- 验收：新增一处 `repo.createQueryBuilder().update().set({status:'x'}).where("id = :id")` 必须红；把 `--report-saves` 的候选数从 N 变成 N+5 必须红。

**T3（P1）迁移 up/down 对称守卫 + 3 条真执行用例模板**
- 做什么：静态判据——`up()` 创建的每个索引/唯一约束/列，必须在同一迁移的 `down()` 里被撤销，或 `down()` 整表 `DROP TABLE`（本轮用该口径扫 122 个迁移，违规 0，说明可作为**棘轮**上线）；另把已有 3 个「fake QueryRunner 执行 up/down」的写法抽成模板，给 5 个最高风险迁移（改列类型/加唯一约束/分区）补执行级用例。
- 能抓到什么真实缺陷：回滚残留索引 → 重跑迁移 `IF NOT EXISTS` 命中残留 → **索引永远建不起来**（`check-migrations.mjs` 文件头记的 0050 事故同族）；down 删错列 → 回滚后数据错位。当前 68 个迁移连 spec 都没有，51 个只做文本比对（§4.2 D1）。
- 验收：把某个迁移的 `DROP INDEX` 删掉，新守卫必须红。

**T4（P1）把所有守卫的自检统一成 `check-metric-docs` 模板（`--root` + 子进程断言退出码）**
- 做什么：①每个 `check-*.mjs` 必须有 `--root <dir>`（或 `isMain` + 可注入 `read`）；②每个 `--selftest` 必须至少 1 条用例 spawn 自己并断言 `status` 与关键文本；③`check-guards-wired` 增加判据：「每个 `check-*.mjs` 必须有 `--selftest` 且 CI 调用它」；④ALLOWLIST/EXCLUDED 增加 `mustProve` + 过期字段。
- 能抓到什么真实缺陷：现在 10 条里 9 条的自检**不断言退出码**，`check-index-drift` 甚至断言一个手抄副本（§2.2），`check-enum-drift` 绕过自己的 scanner（§2.5）——**判据本体被改坏时自检依然全绿**。这是「守卫假绿」的元层原因。
- 验收：故意删掉 `check-guards-wired` 里的 `wiredViaNpm` 分支，其新 selftest 必须红。

**T5（P2）`check-enum-drift` 覆盖自检 + `check-user-facing-language` 判据升级**
- 做什么：①扫出全部 `export enum` / `export const X = {…} as const`，凡不在 `TS_TO_PG` 且不在豁免清单 → 红（把「手维护 13 条」变成「必须显式豁免」）；②语言守卫判据从「含 CJK 即合规」改为「`residualEnglish(text) === ''`」，扫描面加 `apps/admin-web/src/{pages,components}` 与 python `detail=`。
- 能抓到什么真实缺陷：①新枚举静默不受护 + `[^}]*` 截断丢值（实测 `"c"` 丢失）；②中英混排用户文案永久免检（实测 23 处命中）与前端硬编码英文零覆盖。
- 验收：①加一个 `export enum NewThing { X = "x" }` 不登记 → 必须红；②把某条 400 文案改成「任务「x」不存在（Task not found）」→ 必须红。

---

## 6 未实证清单

| # | 想证明的 | 为什么没实证 | 现有依据 |
| --- | --- | --- | --- |
| U1 | 把 `.github/workflows/ci.yml` 里的某个守卫步骤**注释掉**后 `check-guards-wired` 仍绿 | 工作区有并发 agent 在改 `.github/workflows/**`，纪律禁止写 | 在 `/tmp/fakeroot` 用同款守卫代码实证了「YAML 注释即算接线」（§2.6），机制相同 |
| U2 | 从 admin-api 矩阵里删条目后 `check-ssrf-deny-parity` 仍绿 | 该守卫无 `--root`、三处路径硬编码 `process.cwd()`，删条目必须改仓库文件 | 代码依据：`entries.length === 0` 才红（`check-ssrf-deny-parity.mjs:52`），条目数无下界 |
| U3 | `try { } catch (e) { throw e }` 形态在 `@Cron` 体内时守卫仍绿 | 需要在真实源文件里构造；5 个含 rethrow 的文件是否落在 cron 体内未逐一核对 | `TRY = /\btry\s*\{/`（`check-cron-guard.mjs:42`）为纯存在性判据 |
| U4 | `modules/agent/**` 里 `sweepAggregator` 仍无闸（守卫豁免面里写着） | 只做了静态确认（该文件 `agent-trigger.service.ts:424` 在排除前缀内、无 `guardedCron`/`guardTick`），未逐行确认体内无 `try` | 守卫自己打印的排除理由（`check-cron-guard.mjs:55-62`） |
| U5 | admin-web 里有多少硬编码英文（新增守卫的基线数字） | 需要建扫描器并跑全量 258 个文件 + 页面源码；本轮时间/纪律内未做 | 仅证明「扫描面不含 admin-web」（grep 无命中） |
| U6 | 68 个无 spec 的迁移是否被后续迁移/集成测试间接覆盖 | 需要逐个人工核对依赖关系 | 仅报告「无专属 spec」的机械事实（§4.2 D1） |
| U7 | admin-api / admin-web 全量测试是否通过 | 纪律禁止跑全量（>90s 且会与并发 agent 争资源） | 本轮只单跑了 7 个守卫 + 2 个 `--selftest`（均 <10s） |
| U8 | `check-metric-docs` 的「不可读/自失效」与「内容错误」错误分类混用会导致误导修复 | 已观察到现象（B 用例：marker 缺理由 → 打印「守卫自身失效」），未评估修复成本 | `/tmp/r4/o.txt` 实测输出 |

### 附：本轮所有实证脚本与产物（都在 `/tmp`，可复跑）

- `/tmp/r4/weak.mjs`、`/tmp/r4/dupe.mjs`、`/tmp/r4/mocksubject.mjs`（弱断言/重复度/自 mock 统计）
- `/tmp/r4/probe.mjs`（index-drift 三处盲区）、`probe3/probe5.mjs`（enum-drift const-object 与正则截断）、`probe4.mjs`（conditional-writes 6 形态）
- `/tmp/r4/alerts-probe.mjs` + `probe7.mjs`（alerts-rules expr 5 例）
- `/tmp/r4/fr`、`/tmp/r4/fr2`（guards-wired 假根，两处误绿）
- `/tmp/r4/tree`（metric-docs 16 指标最小树，6 个红/绿用例）

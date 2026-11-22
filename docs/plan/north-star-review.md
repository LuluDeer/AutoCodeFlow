# R324 北极星判据独立验收报告（A/B 切片）

> **受众**：lead / PM / 实施方 agent。
> **状态**：内部 · **最后核对**：2026-11-21
> **验收级别**：静态复核 + 脚本 selftest 反证（未连真库、未改 A/B 任何文件、未改生产代码/baseline）。

---

## 0. 冻结基线与结论

| 交付物 | sha256（冻结） | 结论 |
|---|---|---|
| `docs/plan/north-star-business-confirmed.md`（A） | `37078fce209328c9571484eb3193a5b4d3f9fcba74b00001c3f9706ab395b264` | 裁决六项逐字准确；§5 SQL 数学注释有误 |
| `scripts/north-star-weekly.mjs`（B） | `e0770d0b1ca132d9a2b7cbb7d7fc61a6a8235d51d149c9144823386e5d2428c0` | 严格/代理分离、selftest 有牙；§5 SQL 与 A 实质分叉、哨针虚绿 |

**总建议：暂不进入生产实现。** 先由 lead 裁决 §1 的 P0（唯一权威 SQL 口径 + 漂移哨针加固），否则后续实施会按两份互相矛盾的规格落地。

> 过程注记：A/B 首次落盘后各有一次修订（B `b1d2a9f8…` → `e0770d0b…`，A `26c7d511…` → `37078fce…`），两位作者均确认上表为最终冻结版；本报告全部结论基于冻结版。

---

## 1. 缺口（按严重度）

### P0 — 文档 §5 SQL 与脚本 `BUSINESS_CONFIRMED_SQL` 语义分叉，漂移哨针却报绿

证据（实跑 `checkDrift()` 打印两侧 SQL，exit 0）：

| 维度 | A 文档 §5（`north-star-business-confirmed.md:70-82`） | B 脚本（`:58-69`） |
|---|---|---|
| GROUP BY | `1, 2`（周 × install_id 明细） | `1`（仅周） |
| 输出列 | `week, install_id, confirmed_installs` | `week_start, active_installs, confirmed_events` |
| 确认计数 | `COUNT(DISTINCT install_id)` | `COUNT(DISTINCT dedupe_key)` |
| 时间上界 | 无 | `AND ts <= :as_of` |

后果三条：

1. PM 裁决「按周 × install_id 聚合」在文档 SQL 落地、在脚本里被改成「按周聚合 + distinct install 计数」——同一术语两种口径。
2. 脚本 §6 步骤 4 自称「按 §5 SQL 做周聚合」为假；哨针只校验 4 个公共 token（`business_confirmed`、`date_trunc('week'`、`COUNT(DISTINCT install_id)`、`confirmed:`），对 GROUP BY / 输出列 / as_of 差异完全失明。实测把文档 §5 SQL 整段替换成脚本 SQL（token 全保留）后哨针仍 `4/4 命中 ✓` exit 0；只改一个 token 才 exit 2。
3. 文档 §5 注释「每行 `confirmed_installs = 1`；按 week 求和 = 该周确认执行数」数学错误：`GROUP BY week, install_id` 下同 install 多次确认塌成一行，求和得到的是**活跃实例数**而非确认执行数。脚本夹具「同 install 多次确认」期望 `[1,3]` 正好反证这一点。

裁决建议：① 明确唯一权威口径（建议脚本口径为产出口径：周 × `COUNT(DISTINCT install_id)` + `COUNT(DISTINCT dedupe_key)`；文档 §5 改为同一 SQL，或把明细 SQL 标注为「诊断明细，非产出口径」）；② `checkDrift` 升级为规范化全串比对（或至少增补 `GROUP BY 1, 2` / `as_of` / `confirmed_events` 等判别 token，并把代理 SQL 纳入哨针）；③ 补「同 install 多确认」的文档—脚本对账夹具。

### P1 — 周桶时区未钉死，脚本内存模型与真实 SQL 可能分叉

`computeWeekly.weekStartUtc`（脚本 `:138-146`）按 UTC 周一分桶；`BUSINESS_CONFIRMED_SQL` / `BUSINESS_RESULTS_PROXY_SQL` 用 `date_trunc('week', ts)` / `date_trunc('week', e."endTime")`，PG 对 `timestamptz` 按 session `TimeZone` 取周界。脚本全文无 `SET TIME ZONE 'UTC'`、无 `AT TIME ZONE 'UTC'`（已 grep 确认 `(none)`）。当 DB session 非 UTC 时，真库报表与 selftest 夹具口径不一致，且跨环境不可复算。建议连接后显式 `SET TIME ZONE 'UTC'` 或 SQL 改为 `date_trunc('week', ts AT TIME ZONE 'UTC')`，并把哨针/夹具覆盖到时区。

### P1 — §6 步骤 1 的「幂等」验收级别偏低

`north-star-business-confirmed.md:92`：端点约束写「幂等」，验收级别「单测 / 内存替身」。内存替身无法证明并发重复 POST 下只有一条领域事件/一条漏斗行；DB 层唯一约束或进程内集成才能证明。建议升级为真实进程内集成（重复 POST + 断言副作用行数），或把「幂等」从该步骤硬约束降级为待定并注明证明手段。

### P2 — 代理值 SQL 的 `jsonb_array_length` 依赖 AND 求值顺序

`BUSINESS_RESULTS_PROXY_SQL:81` 先 `jsonb_typeof(...)='array'` 再 `jsonb_array_length(...)>0`；SQL 不保证短路，若 `artifacts` 为 jsonb `'null'`（非 SQL NULL）会抛错。TypeORM 写 SQL NULL 时无实害，建议改 `CASE WHEN jsonb_typeof(e."artifacts")='array' THEN jsonb_array_length(e."artifacts")>0 ELSE false END` 固化。

### P2 — 文档 §6 第 98 行指向错误

「`checkDrift()` 从**本节标题后的**第一个 `sql` 代码块抽取」——§6 无 SQL 块，脚本实际抽 §5（脚本 `:103-111` 显式匹配 `§5`）。建议改为「从 §5 标题后的第一个 sql 块抽取」。

### P2 — 「有证据」在近似值中被收窄

PM 措辞含「有产物 / 有证据」两要件；脚本与文档 §8 都只以 `artifacts` 非空作近似（未含 `result` 等）。文档 §8 已自洽收窄，但需 lead 确认接受此口径收窄，避免日后被解读为漏计「有证据」。

### P3 — file:line 引用小瑕疵

`north-star-business-confirmed.md:62` 引 `funnel-events.service.ts:46-70`，`record` 方法实际延伸到 `:84`（execute/return/duplicate 语义在 `:74-84`）。语义不误导，可补区间到 `:46-84`。

---

## 2. 逐条清单结论

| # | 项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 裁决一致性 | **通过（文档侧）**；脚本侧在「周 × install_id 聚合」上偏离 PM 原文 | A:11/66/68/104 六项逐字吻合；B 严格 SQL `GROUP BY 1` 无 install 明细（见 §1 P0） |
| 2 | 事实准确性 | **通过**（抽查 11 处全吻合） | 见 §3 |
| 3 | SQL 正确性 | **不通过** | §1 P0 + P1；代理值本身正确且分字段不混算（脚本 `:72-86`） |
| 4 | selftest 有效性 | **通过（有牙）** | 2 条自主反证见 §4 |
| 5 | 漂移哨针 | **不通过（虚绿）** | P0 第 2 条：结构分叉仍 4/4 绿 |
| 6 | 隐私合规 | **通过** | A:64/102/104；脚本 SQL 只聚合哈希 ID 与计数，无身份字段 |
| 7 | 可落地性 | **基本通过，1 处级别偏低** | §6 覆盖端点→事件→listener→脚本→看板；步骤 1 见 P1 |
| 8 | 守卫兼容 | **通过** | check-docs 7/7、check-doc-style 3/3、script-main-guard 均 exit 0（见 §5） |

---

## 3. file:line 抽查（CodeGraph CLI v1.6.2 + Read 交叉核实，11/11 吻合）

| 文档引用 | 实际内容 | 吻合 |
|---|---|---|
| `task-execution.entity.ts:263` | `status` 列 `@Column({ type:"enum", enum:ExecutionStatus… })`（`:263-268`） | ✓ |
| `task-execution.entity.ts:327` | `result: Record<string, any>` jsonb 列 | ✓ |
| `task-execution.entity.ts:411-412` | `artifacts: ExecutionArtifact[] \| null` jsonb 列 | ✓ |
| `task-execution.entity.ts:28` | `SUCCESS = "success"`（代理 SQL 用小写字面量正确） | ✓ |
| `task-execution.entity.ts:441-445` | `depsFiredAt` 注释+列（否决 F） | ✓ |
| `artifacts.controller.ts:255-263` | 下载审计 `username` / `action="artifact.download"` / `resourceId` | ✓ |
| `artifacts.controller.ts:59` | 注释「A-2 起收紧 @Roles(ADMIN)」（否决 C 理由 1） | ✓ |
| `audit.service.ts:153` | 「clean up audit logs older than 180 days」（否决 C 理由 2） | ✓ |
| `funnel-event.entity.ts:20-62` / `:31-32` | `@Entity("funnel_events")` 类 / `event_name varchar(64)` 列 | ✓ |
| `funnel-events.service.ts:52-60` / `:34-36` / `:58-60` | 双闸 fail-closed / 唯一索引注释 / `not_opted_in` 返回 | ✓ |
| `funnel-success.listener.ts:66-102` | 回查 execution → fingerprint → `deriveAnonymousId` 链 | ✓ |

补充：`deriveAnonymousId(executionId, "ttfv-execution")` 确为代码既有用途（`funnel-success.listener.ts:92`、`funnel-attempt.listener.ts:103`）；`apps/admin-api/test/funnel-listener.e2e-spec.ts` 存在。

---

## 4. selftest 反证（临时副本，未写原文件）

脚本冻结 sha256 在全部反证前后均为 `e0770d0b…`。

| 反证 | 篡改（仅 `/tmp/opencode/r324/*.mjs`） | 转红夹具 | exit |
|---|---|---|---|
| 1 | 删除 `if (seenDedupe.has(key)) continue;`（`computeWeekly`） | 「dedupeKey 幂等」：期望 `[2,2]` 实得 `[2,3]` | 1 |
| 2 | 删除 `row.synthetic !== true` 条件（代理分支） | 「代理过滤」：期望 `1` 实得 `2` | 1 |

基线 `node scripts/north-star-weekly.mjs --selftest`（真实文档）：8/8 通过、哨针 4/4、exit 0。8 例覆盖跨周分桶 / 多确认 / dedupe 幂等 / 双口径分离 / 空样本 / as_of 边界 / 代理过滤 / 警告常驻。**边界**：全部为内存替身，仅证明 `computeWeekly` 分支逻辑，未证明真实 PG 执行同一 SQL 得到同一数字（验收级别 = 单测/内存替身，文档 §6 步骤 4 标注「静态/哨针对账」是诚实的）。

---

## 5. 跑过的命令与 exit code

| 命令 | exit |
|---|---|
| `node scripts/north-star-weekly.mjs --selftest`（真实文档） | 0 |
| `node scripts/north-star-weekly.mjs --selftest`（文档缺失，结构红） | 2 |
| `node scripts/north-star-weekly.mjs --report`（无连接参数 SKIP） | 0 |
| `NORTH_STAR_DOC_PATH=…doc-token-mutated.md … --selftest`（token 篡改反证） | 2 |
| `NORTH_STAR_DOC_PATH=…doc-aligned-to-script.md … --selftest`（结构分叉仍绿） | 0 |
| 两条临时副本篡改 selftest（§4） | 1 / 1 |
| `node scripts/docs/check-docs.mjs` | 0（7/7） |
| `node scripts/docs/check-doc-style.mjs` | 0（3/3） |
| `npm run test:docs` | 0 |
| `node scripts/check-script-main-guard.mjs` | 0（扫描 210 个 .mjs，76 个已有 guard；脚本有 export + main-guard，无需豁免登记） |

---

## 6. 交接

本报告为独立验收产物，未修改 A/B 任何文件、生产代码或 baseline/json。挂链已由 lead 落在 `docs/README.md:98`；本报告通过 `check-doc-style` 结构/新鲜度/围栏检查，`check-docs` 7/7 复跑确认绿。

---

## 7. 修复后复验（lead 集成 + verify 闭环）

> 本节记录 P0 修复后的针对性复验，正文 §0–§6 保留为验收时点快照，不回溯改写。

**冻结基线**：A `docs/plan/north-star-business-confirmed.md` = `db6453f09d5f98920fadf3d61bd4d8aa3dbc468a4bb1e6b3710f5f18c04cdd02`；B `scripts/north-star-weekly.mjs` = `f55571ee18be081567e1a52a4b83c55c78582e87c0f216cd7bb74800e49dee5e`。

| 复验项 | 手法 / 证据 | exit |
|---|---|---|
| ① P0 哨针闭环反证 | 临时副本把 A §5 的 `GROUP BY 1` 改为 `GROUP BY 1, 2`（4 token 全保留），经 `NORTH_STAR_DOC_PATH` 覆盖后跑 `--selftest`：新 `checkDrift` 转红并点名「文档 §5 SQL 与内置 BUSINESS_CONFIRMED_SQL 规范化后不一致（口径语义漂移）@字符 259」，同时打印两侧上下文。旧哨针在同样输入下为 4/4 绿（见 §1 P0）。另做列别名 `active_installs → active_installs_v2` 反证：@字符 90 转红。 | **2** |
| ② SQL 全串相等 + 时区钉死 | 直接抽取 A §5 首个 sql 块与 `BUSINESS_CONFIRMED_SQL` 各自剥 `--` 注释、归一空白比较：`SQL_EQUAL=true`；`checkDrift()` 返回 tokens=4、proxyInvariants=7、utcPin=`SET LOCAL TIME ZONE 'UTC'`。运行时确认 `BEGIN READ ONLY`（`:611`）→ `client.query(UTC_PIN_SQL)`（`:614`）→ 两条权威 SQL（`:615-616`），SQL 主体未加 `AT TIME ZONE`。 | **0** |
| ③ 挂链与守卫 | `node scripts/docs/check-docs.mjs` 判据全过 7/7（含 orphan，README:98 已挂本报告）；`check-doc-style` 3/3、`script-main-guard`、`--selftest` 8/8 均绿。 | **0** |

补充：跨 `TZ=UTC / America/New_York / Asia/Shanghai` 三次 `--selftest` 输出 sha256 一致且均 exit 0；原 A/B 文件 sha256 在全部反证前后未变。

**P0 关闭结论**：口径分叉已消除（§5 SQL 与脚本全串相等），漂移哨针由「4-token 存在性」升级为「规范化全串逐字相等为主判据 + token 快速定位 + 代理 SQL 7 条约束 + UTC pin 自检」，原虚绿路径已被实测堵死。**P0 正式关闭**；P1（时区、步骤 1 验收级别）与 P2（代理 SQL 求值顺序、§6 指向、「有证据」收窄）亦经 lead 派修/裁决覆盖。建议进入生产实现。

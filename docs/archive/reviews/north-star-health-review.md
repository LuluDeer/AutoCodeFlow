# R432 独立验收复核 —— 北极星全链路自检脚本（不是假绿）

> **受众**：lead / 接手维护者 · **状态**：独立验收结论（工作树，未发布） · **最后核对**：2026-11-21
> 本文只复核 R432 切片产物 `scripts/north-star-health.mjs`（6 项自检），不改任何实现、脚本、spec、baseline 或既有 docs。
> 验收环境：测试库 `autoflow_ttfv_e2e` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->（干净）；口令不落日志已实测。
> 最高验收级别：静态探查 + 内存夹具证伪 + 真 PG 进程内连库（表结构项）+ 反证镜像篡改。

## 0. 结论摘要

- **6 项清单全部 PASS；无 P0、无 P1、无 P2。** 未发现假绿：静态项真读源码、真能抓缺口；真库项真执行 `to_regclass`/`information_schema`；判据哨针核对 SQL 语义（不是只查 token）；看板查 warnings 渲染而非只 import；selftest 夹具真能证伪。
- 建议**关闭 R432 验收**。
- 唯一交接项：本报告自身是孤儿文档，`check-docs` 的 orphan 守卫会转红；**需 lead 在 `docs/README.md` §2.6 挂链**（我的写域不含 README，未挂）。挂链后 check-docs 应恢复 7/7。

## 1. 静态检查有判别力（PASS）

在 `/tmp/opencode/r432-mirror` 镜像副本逐项删源码片段，主脚本经 `--root` 指向镜像，逐一确认对应项转红（非恒 PASS）。镜像基线先验证为 5/5 PASS + 表项 SKIP（exit 0），保证反证可信。

| 反证 | 篡改（镜像内） | 结果 |
|---|---|---|
| A | 删 `funnel-confirmation.listener.ts` 的 `eventName:"business_confirmed"` | ② listeners = **FAIL**（点名该文件缺 eventName），exit 1 |
| B | 删 controller 的 `@Get("north-star/metrics")` | ④ api = **FAIL**（缺 GET 路由 + 响应声明），exit 1 |
| C | 删 `NorthStarCard.tsx` 的 `warnings.map(` | ⑤ dashboard = **FAIL**（缺 warnings 原文渲染），exit 1 |
| I | 删 cardTest 的 `getNorthStar` 第一参 `undefined` 断言 | ⑤ dashboard = **FAIL**（反证锚点缺失），exit 1 |
| J | 删 DTO 的 `warnings: string[]` 字段 | ④ api = **FAIL**（缺字段 warnings），exit 1 |
| （对照） | 全部还原 | exit 0，fails=0 |

结论：②④⑤ 三项静态检查均真读被查 root 的源码字面，删片段即转红，不是恒 PASS。

## 2. 真库项真连库（PASS）

`--from-env`（读 `.env DB_*` + 默认 `autoflow_ttfv_e2e` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->）实测输出：
`[PASS] to_regclass 两表在；关键列 funnel_events[event_name,dedupe_key,ts,install_id] / telemetry_optin[opt_in,install_id] 全在（真库 autoflow_ttfv_e2e <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->）`，模式 `with-live-db`，exit 0。

- **真执行 SQL（非伪造 PASS）**：`checkTables()` 源码 `:178-188` 先 `SELECT to_regclass('public.funnel_events'), to_regclass('public.telemetry_optin')`，再 `information_schema.columns` 查关键列；`to_regclass=null` 或缺列即 FAIL。反证 H：指向含 `e2e` 但连不上的端口 → `连库失败：connect ECONNREFUSED …` + `structural=true` + exit 2，证明真发起连接。
- **无 DSN 正确 SKIP 而非 FAIL**：纯静态模式 `① tables = SKIP`，`NORTH_STAR_HEALTH: 5/5 PASS（…1 SKIP，SKIP 不计入分母）`，exit 0；selftest 夹具④亦断言 `tables=SKIP && !structural`。
- **防误生产守卫**：反证 G 用 `--dsn=…/autoflow_prod` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 数据库名，不是指标名 --> → `FAIL`（库名不含 test|e2e，拒绝连库）+ `structural=true` + exit 2，不连生产库。
- **口令不落日志**：`redact()`（`:87-91`）清 DSN + `//user:pass@` 模式；`maskDsn()` 只显示主机/库/用户 + 「口令已提供/缺」。哨兵口令 `SUPERSECRET_SENTINEL_9f3a` 注入 DSN 后扫描 text/JSON 全输出**未出现明文**，仅显示 `（口令已提供）`。

## 3. 假绿反证（PASS —— 最关键项）

### 3.1 判据哨针核对 SQL 语义，非只查字符串存在

主路径 `checkCaliber()`（`injected=false`，`:309-331`）优先 `import` 复用 `north-star-weekly.mjs` 的 `checkDrift()`。核实 `checkDrift()`（weekly `:172-212`）：**主判据是「文档 §5 首个 sql 块与内置 `BUSINESS_CONFIRMED_SQL` 规范化（去注释+归一空白）后全串逐字相等」**（`:189-196`），4 个 token 只是附加快速定位层，代理 7 条约束 + UTC 钉死另检。注入 root 时退化的 `caliberTokenCheck()`（`:280-303`）保留同一条全串比对。

反证（镜像内篡改文档 §5 SQL，其余不动）：

| 反证 | 篡改（4 个基础 token 均未受影响） | 结果 |
|---|---|---|
| D | `COUNT(DISTINCT install_id)` → `COUNT(DISTINCT task_id_hash)` | ③ caliber = **FAIL**（全串不一致 + 缺 token），exit 1 |
| E | `GROUP BY 1` → `GROUP BY 2` | ③ caliber = **FAIL**（全串不一致 @字符 258），exit 1 |
| F | `ts <= :as_of` → `ts >= :as_of`（方向反转） | ③ caliber = **FAIL**（全串不一致 @字符 239），exit 1 |

E/F 专门挑 token 表未覆盖的语义点：若脚本只查 token 存在，这两项会假绿。实测均转红 ⇒ **R324 P0「口径分叉假绿」教训已落实，非假绿**。

### 3.2 看板检查查 warnings 渲染，非只查 import

`checkDashboard()`（`:360-377`）除 import/渲染 `<NorthStarCard/>` 外，显式查：严格区 `north-star-strict`、代理区 `north-star-proxy`、`warnings.map(` + `north-star-warning` 原文渲染、以及反证锚点 `getNorthStar` 第一参 `undefined`。反证 C（删 warnings.map）、反证 I（删反证锚点）均转红 ⇒ 非只查 import。

**判断**：6 项中 5 项静态检查的本质边界是「证明代码在、字面一致」，这是其声明职责（见 §5），不构成假绿；唯一可能被误读为「运行时健康」的是表结构项，但它带 `scope:"live"` 且仅验表/列存在，不验数据出数——脚本已诚实标注（见 §5）。**未发现「全部 PASS 但体系实际有问题」的假绿情形。**

## 4. selftest 有效性（PASS —— 夹具能证伪）

`--selftest` 用内存夹具（`makeFixtureSources()` `:467-498`）测 checker 判定逻辑，不连库、不依赖真实仓库。基线 6/6、exit 0。

为排除「夹具是摆设」，在镜像副本篡改 **checker 本体**后重跑 selftest：

- 篡改①：把 `checkListeners` 的 `evRe.test(text)` 改为 `true`（恒真）→ 「篡改 listener eventName → ②FAIL」夹具转红（`listeners=PASS, api=PASS`），SELFTEST 5/6，exit 1。
- 篡改②：把 `caliberTokenCheck()` 强制返回 PASS → 「篡改 §5 SQL → ③FAIL」夹具转红，SELFTEST 5/6，exit 1。
- 还原后 6/6、exit 0。

结论：夹具真能证伪 checker 逻辑，篡改判定即转红，非摆设。（所有篡改在镜像副本，生产脚本 sha256 `f85882ffe54870f9b158ea70f1408d03a9845ac0cc6b7995f941a4065d3041cb` 全程未变。）

## 5. 边界诚实性（PASS）

- 固定横幅 `BOUNDARY_TEXT`（`:60-61`）随每次输出展示：「②–⑥ 为静态项（只证明代码存在/字面一致，不能证明运行时正确）；① 为唯一真库项，仅给 DSN 时执行」；`--help` 亦重复「静态项 PASS 只表示代码在/字面一致，不代表运行时健康」。
- JSON 每项带 `scope`：`tables=live`，其余 `static`；`summary` 明确 `denominator = total - skip`，SKIP 不计入分母。
- 汇总口径分离：纯静态 `5/5 PASS（1 SKIP）` vs 真库 `6/6 PASS`，不把「代码在」说成「运行时健康」。

## 6. 守卫（PASS，1 项交接）

- `node scripts/check-script-main-guard.mjs`：扫描 213 个 .mjs，全过，exit 0（脚本有 main-guard，`:604-613` 的 `invokedDirectly` 守卫，import 不触发副作用）。
- `node scripts/north-star-health.mjs --selftest`：exit 0；非法参数 exit 2；`--help` exit 0。
- `node scripts/docs/check-docs.mjs` / `check-doc-style.mjs`：写报告**前**基线 7/7 + 风格全过，exit 0。
- **交接项（非缺陷）**：本报告落盘后成为孤儿文档，`check-docs` 的 orphan 守卫将转红；需 lead 在 `docs/README.md` §2.6 挂链（写域外）。挂链后恢复绿。

## 7. 缺口分级与建议

| 级别 | 条目 |
|---|---|
| P0 | 无（无恒 PASS、无真库伪造、无口径分叉假绿） |
| P1 | 无 |
| P2 | 无 |
| 交接项 | 本报告 README 挂链（lead 处理，非脚本缺陷） |

**建议：关闭 R432 验收。** 脚本达成设计目标：一条命令区分静态健康与真库表结构健康，且各检查项经镜像反证具备判别力，selftest 经篡改证伪有效。

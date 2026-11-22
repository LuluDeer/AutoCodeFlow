# R326 独立验收复核 —— 真库数据对账脚本（north-star-pg-reconcile.mjs）

> 验收方：r326-reconcile-verify（独立子 agent）· 时间：2026-11-21 · 分支：develop
> 被验对象：`scripts/north-star-pg-reconcile.mjs`（A 切片 r326-pg-reconcile 产出，sha256 `4877c3dce670b17e2eb7739ffa60927eb24d5dbed5894bf42df887fed08cc949`）
> 验收级别：**真实进程内集成级 + 独立静态复核**（真 PG `autoflow_ttfv_e2e` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->、真 `north-star-weekly.mjs --report` 子进程、独立 psql 等价残留复查、三个独立反证）。
> 边界：本复核未修改 A 脚本、`north-star-weekly.mjs`、任何生产代码/baseline/README；所有反证在 `/tmp/opencode/r326-reverse*` 镜像副本中进行，真文件 sha256 前后不变。

## 0. 一句话结论

**7 项清单全部通过，未发现假绿路径。建议关闭本轮 A 切片验收。** A 报的代理 `endTime` 时区漂移是 `north-star-weekly.mjs` 的既有口径缺口（已由 lead 另派 r326-tz-fix），不影响 A 对账脚本自身质量：A 钉 `TZ=UTC` 子进程并加时区一致断言，缺口被正确隔离、未被误判为绿。

---

## 1. 真连库非假绿 —— 通过

- **静态**：`runReport()`（`:335-342`）用 `execFileSync(process.execPath, [join(ROOT, "scripts/north-star-weekly.mjs"), "--report", "--json", "--dsn=<真DSN>", "--as-of=..."]`，`cwd=ROOT`、`env.TZ="UTC"`、`stdio` 管道捕获 stdout 后 `JSON.parse`。这是真进程、真 DSN、真 `--report`，非伪造 payload。
- **子进程门控**：`main()`（`:434-446`）在 `reconcile()` 之前先判 `raw.status !== "OK" ⇒ structural=2`；JSON 解析异常 ⇒ `structural=2`（`:442-445`）。SKIP/非 OK 一律转结构红，不会假绿。
- **实测**：真跑返回 `status=OK`，`business_confirmed` 周 B 1/1、周 A 2/3、totals 3/4；`business_results_proxy` 周 A=2；日志见 `/tmp/opencode/r326-realrun.log`，exit 0。

## 2. 种子设计的判别力 —— 通过

`buildSeedPlan()`（`:74-106`）+ `EXPECTED`（`:109-122`，独立字面常量，不从行推导）：

| 种子 | 实际落库效果 | 能区分什么 |
|---|---|---|
| 周 A：install-1 两条确认（dedupe 1、2）+ install-2 一条确认（dedupe 3） | active=2 / confirmed=3 | **`COUNT(DISTINCT install_id)` vs `COUNT(DISTINCT dedupe_key)` 差异被捕获**——若两口径混算或 dedupe 不去重，必与期望 2/3 不符 |
| 周 B：install-3 单确认 | active=1 / confirmed=1 | 跨周分桶正确性 |
| 干扰行①`task_first_success` + 干扰行② `business_confirmed` 但 dedupe 前缀为 `first-` | 均不计入严格值 | `event_name` 过滤 + `LIKE 'confirmed:%'` 物理隔离 |
| as_of 之后行（install-4 `2026-11-21T18:00:00Z`、proxy_future `2026-11-21 20:00:00`） | 不计入 | `ts <= :as_of` / `endTime <= :as_of` 上界；失效则周 A 变 3/4、proxy 变 3，立即转红 |
| proxy 过滤：空 artifacts / synthetic=true / failed | 仅 2 条有效 | 代理 SQL 三条关键约束 |

`--selftest` 8/8 覆盖种子形状、in-window 行数、期望独立性、对账正例（18/18），exit 0。

## 3. 对账是否逐字段 —— 通过

`reconcile()`（`:225-281`）逐项 `applyAssert`，实测 21 项门控全过，绝非只比 status：

- `status=OK`、`as_of` 回显；
- 严格值每周 `week_start` 存在 + `active_installs` + `confirmed_events`（周 A 2/3、周 B 1/1）；严格周数=2（干扰行未泄漏）；
- 代理每周 `week_start` + `executions`，代理周数=1（过滤生效）；
- 三项 totals：`active_install_weeks=3` / `confirmed_events=4` / `executions=2`；
- 两条 warnings **逐字** `includes`；
- 时区一致性：TZ=UTC 下周 A strict/proxy 的 `week_start` 完全相等。

## 4. 清理彻底性 —— 通过

- **finally 无条件清理**：`:467-482`——`connected && seeded` 时无条件调 `cleanup()`；前缀冲突/连接前失败时 `seeded=false`，不触碰他人行（防误删，正确）。
- **只删自己前缀**：`:323-333` 按 `PREFIX=r326_rec_v1_` 对 `task_executions."taskName"` / `funnel_events.install_id` / `tasks.name` 三表 DELETE；种子所有行标识列均带该前缀（dedupe_key 虽为 `confirmed:<hash>`，但随 install_id 行整行删除，实测无孤儿）。
- **清理后复查残留=0**：`cleanup()` 内 `prefixResidual()` 三表计数均断言 =0（`:328-331`）。
- **独立复查**：真跑结束后我用自写工具 `/tmp/opencode/r326-residue-check.mjs`（pg Client 直连 e2e 库，非 A 工具）扫三表全部 varchar/text 列 + 三个反证后再扫，`TOTAL_R326_RESIDUE=0`；基线（跑前）亦为 0。

## 5. 防误生产 —— 通过

- **静态**：`isTestDatabase()`（`:143-145`）正则 `/(^|_)(test|e2e)(_|$)/i`；`main()`（`:400-404`）连库前判库名，不符合 ⇒ `report(...false) ⇒ return 2`。`resolveDsn()`（`:161-180`）从 .env 拼 DSN 时显式拒绝 `DB_DATABASE=autoflow`（生产名），仅采纳 test/e2e 覆盖，否则固定 `autoflow_ttfv_e2e` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->。
- **独立复现**：`node scripts/north-star-pg-reconcile.mjs --dsn='postgresql://autoflow:***@127.0.0.1:5432/autoflow'` → 输出「✘ 库名防误：目标库须含 test|e2e — 目标库=autoflow」，**exit 2**（未连库）。

## 6. 反证有牙 —— 通过（三个独立反证，手法均不同于 A）

A 自证：改种子使周 A confirmed 3→4 ⇒ exit 1。我另做三个：

| # | 手法（仅镜像副本，真文件不动） | 结果 | 证明 |
|---|---|---|---|
| 1 | 改 A 脚本副本期望 `EXPECTED.strict[WEEK_A].confirmed_events` 3→4 | **exit 1**：`✘ 严格 2026-11-16… confirmed_events=4 — 期望 4 实得 3`，清理残留 0 | 对账器真的把期望与实际逐字段比，不是摆设 |
| 2 | 改 `north-star-weekly.mjs` 副本 `BUSINESS_CONFIRMED_SQL`：`COUNT(DISTINCT dedupe_key)`→`COUNT(*)` | **exit 2**：子进程 `checkDrift` 红（文档 §5 分叉 @字符 98），A 报「调用 --report / 解析 JSON」失败 | A 能捕获子进程非 OK/不可解析，不假绿 |
| 3 | 改 `north-star-weekly.mjs` 副本 `buildPayload`：`totals.confirmed_events` 误 sum `active_installs`（哨针覆盖外，子进程仍 status=OK） | **exit 1**：子进程 status=OK，但 `✘ 严格合计 confirmed_events — 期望 4 实得 3`，清理残留 0 | **A 真拿到脚本输出字段并对账**，脚本口径漂移会转红（最有力一证） |

三个反证后真 A 与 `north-star-weekly.mjs` sha256 均与基线一致（`4877c3dc…` / `f55571ee…`）。

## 7. 守卫兼容 —— 通过

`node scripts/check-script-main-guard.mjs` → `✔ main-guard 守卫通过：扫描 211 个 .mjs，77 个已有 guard`, exit 0；A 脚本 `export` + `invokedDirectly` guard 齐备，未改 exempt.json。

---

## 8. 跑过的命令与 exit code

| 命令 | exit |
|---|---|
| `node scripts/north-star-weekly.mjs --selftest`（基线，哨针 4/4 + 8/8） | 0 |
| `node scripts/north-star-weekly.mjs --report --json`（无连接参数 SKIP 基线） | 0 |
| `node scripts/north-star-pg-reconcile.mjs --selftest`（8/8） | 0 |
| `node scripts/north-star-pg-reconcile.mjs`（无 DSN SKIP） | 0 |
| `node scripts/north-star-pg-reconcile.mjs --dsn=<e2e>`（真跑，21 项门控全过） | 0 |
| `node scripts/north-star-pg-reconcile.mjs --dsn=.../autoflow`（生产库名防误） | 2 |
| 反证 1：镜像副本改期望 3→4 | 1 |
| 反证 2：镜像副本改 SQL 口径常量 | 2 |
| 反证 3：镜像副本改 buildPayload 字段映射 | 1 |
| `node scripts/check-script-main-guard.mjs` | 0 |
| `node /tmp/opencode/r326-residue-check.mjs autoflow_ttfv_e2e` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->（独立残留复查，多次） | 0（残留=0） |

## 9. 发现的缺口 / 备注（按严重度）

- **P2（非本脚本、已另派修复）**：`north-star-weekly.mjs` 代理 SQL 的 `endTime` 是 `timestamp without time zone`，ambient TZ 非 UTC 时 proxy `week_start` 漂移 -8h。A 用子进程钉 `TZ=UTC` + 时区一致断言隔离了它，未掩盖；lead 已派 r326-tz-fix。不阻塞本轮 A 切片关闭。
- **P3（设计取舍，不判缺陷）**：A 的 `--tz-probe` 诊断项以 `process.env.TZ || "Asia/Shanghai"` 观察漂移，措辞为「非门控项」，正确；但 A 仅在钉 `TZ=UTC` 下做门控，若未来调用方 ambient TZ 污染子进程 env（`env: {...process.env, TZ: tz}` 中 tz 固定 "UTC"，实际不会被污染），无风险。
- **P3（清理谓词）**：清理按行标识列前缀 DELETE，未单独校验 `dedupe_key`/`task_id_hash` 列残留；实测三表所有文本列扫描残留=0，且种子行随行删除无孤儿，当前无实际风险。若追求极致，可把 `prefixResidual` 扩展到 dedupe_key（但 dedupe_key 本身不带前缀，需改种子设计，收益低）。

## 10. 交接

- 本报告为独立验收产物，写入域严格限定本文件；未挂链 README（按任务由 lead 挂链）。
- 建议：**关闭 R326 A 切片验收**（7/7 通过、无假绿、无生产写域、守卫绿）。

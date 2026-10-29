# 第 5 轮实施汇总（2026-10-29 · 守卫自己也要有牙）

> 承接 [第 4 轮 INDEX](../2026-10-29-round4/INDEX.md) §5 的排序。本轮三件事：T4 共享
> 自检模板、5 条迁移的并发回滚、SOP 弹窗可见标签。全部带反证，验证以整链为准。

## 1. T4：共享 harness + 三条最弱守卫迁移（`ca51804c`）

新增 `scripts/lib/guard-selftest.mjs`（零依赖）：`runGuard` 用 `spawnSync` 跑**真脚本**、
`expectExit` 断言**退出码 / 包含 / 缺席 / 耗时**且失败抛错（`code` 缺省直接拒绝——空断言 =
没断言）、`makeFixtureRepo` 造最小树、`reportCases` 汇总。harness 自己有 11 条 selftest，
每条断言配正反控制组（连「永不抛」「永远抛」两种退化都能抓）。

三条守卫迁移后各自抓到的**假绿**：

| 守卫 | 迁移前 | 迁移后 | 迁移中发现的真问题 |
|---|---|---|---|
| `check-guards-wired` | 纯内存 + `ok:` 布尔，不断言退出码/文本 | 7 条真子进程用例 | 仓库 ALLOWLIST 会套到 `--root` fixture 上 → `--root` 实际不可用（已修） |
| `check-ssrf-deny-parity` | **完全没有 selftest** | 6 条 + 三侧条目数下界 18 | `includes()` 把**注释掉的镜像条目**当已同步；剥注释后才是真比对 |
| `check-index-drift` | 手抄 `assertSubset` 当 oracle、只数 `errors.length`、`exit(1)` 内联 | 8 条驱动真扫描器 | 删掉 CLI 的 `process.exit(1)` 旧 selftest 仍全绿；partial WHERE 盲区已钉成显式契约用例 |

接线：三条 `check:*` 补 `--selftest &&`，harness selftest 进 `test:guards:repo`。反证 12 个变异
（删 `exit(1)`、不剥 YAML 注释、去掉名字边界、去掉下界、退回 `includes`、删列序/唯一性比对、
补上 WHERE 比对…）逐个让至少一条用例转红。

## 2. 5 条并发索引的回滚锁表（`d2d2364c`）

T3 守卫首跑抓到的真实缺陷：`up()` 用 `CREATE INDEX CONCURRENTLY`、`down()` 用普通
`DROP INDEX`——回滚时持 ACCESS EXCLUSIVE 锁直到删完，而回滚恰好发生在事故/发布窗口。
三文件 5 个索引的 down 改 `DROP INDEX CONCURRENTLY IF EXISTS`，并补 down 侧
`SET statement_timeout = 0` + `finally RESET`（先例 0061/0075）；`transaction = false` 原本就有。
反断言最初 `/DROP INDEX (?!CONCURRENTLY)/` 被中文注释散文误命中，收紧为只匹配真语句。
基线 `violations` 5 → `[]`。

## 3. SOP 弹窗可见标签 + Scope 文案（`01d5b09c`）

`SopsPage` 4 个弹窗 **12 个控件**此前只有 placeholder（2 个 Select 连 placeholder 都没有）——
输入后字段名消失。统一 `Form layout="vertical" component={false}` + `Form.Item label htmlFor`
+ 控件 `id`（同一个 `SOPS_FIELD_ID` 常量表，测试另有 id 唯一性不变式）；提交载荷零变化、
间距与顺序不变。`ApiKeysSettings` 的硬编码 `Scope：` 改走 i18n（zh「权限范围：」/ en「Scope: 」），
语言守卫基线随之 10 → 9（是守卫自己提示的「修好要删基线」）。

## 4. 验证基线

- `npm run test:guards:repo` → **exit 0**
- admin-api **388 套件 / 6703 例**全绿
- admin-web **261 文件 / 2167 例**全绿
- desktop 未改动，沿用上一轮（`test:main` 61 selftest + `test:renderer`）

## 5. 下一轮

1. A 档剩余 8 条守卫迁 harness（`check-migrations` 有伴生 selftest，需先定归属）。
2. rt-2 止血：`gzipSync` → 异步 gzip（结构性 append-in-place 另立项）。
3. 之后：SEC-R3-4（webhook 重放）、CIR-05 残差（镜像 digest / pip hash）、OSS G10（触发幂等键）。

---

## 6. 追加：第 6–7 轮（同日，继续推进）

| 项 | 内容 | commit | 验证 |
|---|---|---|---|
| rt-2 止血 | S3 写面 `gzipSync` → 异步 gzip：实测 19.3MB 压缩下事件循环阻塞 **+401ms → +0ms**（该请求仍等，wall +7%）；字节一致性 4 例实测 + 单测锁死 | `d4a1319a` | task 66 套件 1549 例；反证改回同步 → 3 例红 |
| T4 第二批 | atlas-counts / cli-doc / constant-time / enum-consumers 迁 harness，42 条用例；修掉 12 处假绿（`includes` 前缀误配、零下界、只认一行第一处比较、捕获组只留最后一个成员…） | `74c2a943` | 四条 selftest 全绿；14 个变异逐个转红 |
| T4 第三批 | audit-actions-doc / publishable-wiring / release-hygiene，32 条用例；修掉 6 处假绿（整篇命中即算、注释算接线、「0 个 Release = OK」、`Bearer undefined`） | `a135c60a` | 三条 selftest 全绿；11 个变异转红 |
| 恒定时间守卫 | 识别**裸** `token`/`password`/`secret`；真仓 12 处逐条分类 → **真凭据比较 0 处**（全在同源检测/掩码/哈希/重试计数），6 文件只加声明注释；豁免理由必填；修 python `#` 注释假绿 | `51553a95` | selftest 17 条；python 1481 例、api sop 269 例、双端 tsc 绿；反证改回 `===` → 点名 |

验证基线（本轮末）：`test:guards:repo` **exit 0**（44 个守卫全接线）；admin-api 388/6703、
admin-web 261/2167、desktop 未改动。

### 仍未做（下轮入口）

1. **A 档剩余 4 条**：`check-interface-maps`、`check-failure-reasons`、`check-desktop-selftests-wired`、
   `check-migrations`（有伴生 `check-migrations.selftest.mjs`，需先定归属）。
2. **audit action 正则只认小写**：`event-subscription.service.ts:341` 的
   `action: "subscription.deadLetter.delete"` 扫不到——放宽会立即打红主跑，需同步补 audit.md 表。
3. **`!=`/`!==` 的恒定时间面**：当前判据不覆盖（18 处全是同源变更检测，纳入=批量豁免），
   边界已写进脚本头注。
4. **结构化残差**：rt-2 的 O(P²)/峰值内存（需「每页独立对象 + manifest」）、rt-4 的跨连接快照
   （并发会话已落单飞 + 2s TTL）、db 的 keyset 分页。

---

## 7. 追加：第 8 轮（T4 收官 + 文档计数判据 + e2e 文档重写）

| 项 | 内容 | commit |
|---|---|---|
| T4 收官 | A 档最后 4 条（interface-maps / failure-reasons / desktop-selftests-wired / migrations）迁 harness，58 条用例；修掉 15 处假绿（前缀误配、注释算数、`[] === []` 永真、schedule-only job 被当成随 push 跑、注释里的注册行算登记…）；伴生 `check-migrations.selftest.mjs` 收编后删除 | `a3ff6db8` |
| audit.md 计数 | 头部「N 个 action / M 个域」纳入判据（表格为事实源）；上线即抓到 73 vs **74**——差额是 `auditHighRisk("executor.rotate_token")` 透传盲区，不是历史动作 | `5c12f281` |
| e2e 文档 | 整篇重写：真实入口 3 份 spec = **51 例 / 9 组**（旧文 45 例、漏 3 条用例与 1 份 spec、两个 describe 组编号错位、把 ui09 自带编号当全局编号）；明确标注顶层 `e2e-full.spec.js` 是 16 例的孤儿副本 | `8227d920` |

验证：`test:guards:repo` **exit 0**；四条 selftest 58 例全绿；check-docs / atlas-counts / audit-doc 绿。

### 下一轮入口（更新）

1. **e2e 例数没有守卫**：把 `check-atlas-counts` 加第 5 项判据（51 = 三份 spec 的 `test(` 之和），
   已用一行静态核对脚本验证过口径。
2. **`auditHighRisk("…")` 透传盲区**：扩 `ACTION_RE` 识别该形态后，代码数会从 73 → 74，与表格
   对齐（本轮只把头部改成 74 并注明）。
3. **B1 档 18 条守卫**仍有「纯进程内、不断言退出码」的 selftest，可按 T4 模板分批迁移。
4. 结构化残差：rt-2 的 O(P²)、db keyset 深分页、CIR-05 残差（镜像 digest / pip hash）、OSS G10。

---

## 8. 追加：第 9 轮（守卫补两处真盲区 + B1 批）

| 项 | 内容 | commit |
|---|---|---|
| e2e 例数判据 | `check-atlas-counts` 第 ⑤ 项：三份 legacy spec 行首 `test(` 之和（51）/ 9 组，两列都核；解析不到即结构红。踩坑：`e2e-full.spec.js:5` 注释里的 `*.spec.ts` 会被朴素块注释识别吞掉 42 个用例，已修并钉 fixture | `b7cf8d36` |
| auditHighRisk 透传 | `ACTION_RE` 加第二入口后**真值 76**：除 `executor.rotate_token`，还暴露 `executor.delete` / `executor.install_cmd_viewed`（这两条连表格都没进过），已补表、头部 74→76 | `b7cf8d36` |
| B1 批 | cron-guard / cron-leader-gate / env-drift 迁 harness，37 条用例；新增共享 `scripts/lib/cron-source.mjs`（此前两份「找 @Cron」实现，leader-gate 那份的 40 行窗口会**借邻居门禁**）；env-drift 补 3 个「动态键 helper 实参」盲区 | `5c4bdf7c` |

验证：`test:guards:repo` **exit 0**；五条 selftest 全绿；三条主跑全绿（21 个 cron 有闸 / 25 个有门禁 / 226 个 env 键）。

### 下轮入口

1. **B1 剩余 16 条**（compose-sandbox / desktop-agent-packaging / error-migration 最易）与「已自 spawn 未接 harness」的 10 条（alerts-rules / migration-symmetry / openapi-response-schema…）。
2. `check-no-hoisting` 有伴生 `.selftest.mjs`，需按 `check-migrations` 前例先定归属。
3. 结构化残差：db keyset 深分页、CIR-05 残差（镜像 digest / pip hash）、OSS G10（触发幂等键）。

---

## 9. 追加：第 10 轮（B1 批 2 + 收编批）

| 项 | 内容 | commit |
|---|---|---|
| B1 批 2 | compose-sandbox / desktop-agent-packaging / error-migration 迁 harness，32 条用例；修掉「整篇 includes = 注释也算接线」「键缺失时 `undefined !== 'bwrap'` 恒真」「`--report` 吞结构错」等假绿 | `468f424e` |
| 收编批 | alerts-rules / migration-symmetry / openapi-response-schema 接上 harness（用例语义不变，耗时 +7.4%）；修 openapi 的「`--report` 在扫描面坍缩时仍 100% 且 exit 0」与「`--update` 写坍缩基线」——并修掉一处**现状红**：openapi 基线 237 vs 实际 240（CI api-types-drift 当时红），已 `--update` 到 240 | `c5b48e9e` |

验证：`test:guards:repo` **exit 0**；六条 selftest 全绿；三条主跑绿；check-guards-wired 44 个全接线。
已接 harness 的守卫累计 **22 个**（`grep -l lib/guard-selftest.mjs scripts/check-*.mjs`）。

### 下轮入口

1. **B1 剩余 13 条**：compose-service-env / consumer-routes / desktop-bundle-drift / enum-drift /
   error-i18n / lint-gates / password-policy-sync / release-config / sdk-docs-truthfulness /
   shell-multibyte-var / throttler-whitelist / user-facing-language / workflow-actions-pinned。
2. **伴生 selftest 三条需先定归属**：dependency-review / desktop-update-chain / no-hoisting
   （按 check-migrations 前例：收编进主文件 or 保留伴生）。
3. 结构化残差：db keyset 深分页、CIR-05 残差（镜像 digest / pip hash）、OSS G10（触发幂等键）。

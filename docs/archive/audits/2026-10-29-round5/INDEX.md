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

---

## 10. 追加：第 11 轮（B1 批 3 + 伴生 selftest 收编）

| 项 | 内容 | commit |
|---|---|---|
| B1 批 3 | compose-service-env / consumer-routes / desktop-bundle-drift 迁 harness，30 条用例；修掉「兄弟服务 env 顶包」「空值算注入」「注释里的 call() 当真调用」「`--print` 吞结构错」等假绿 | `390aadcd` |
| 伴生收编 | no-hoisting / dependency-review / desktop-update-chain 三条的 `.selftest.mjs` **全部收编并删除**（读码推翻「需要 registry/产物」的预设）；17/15/15 条用例；docs 四处路径同步 | `06efdf12` |

验证：`test:guards:repo` **exit 0**；六条 selftest 全绿；真实配置输出与改前逐字一致。

已接 harness：**25 个** `check-*.mjs`。剩余未接：B1 档 10 条（enum-drift / error-i18n /
lint-gates / password-policy-sync / release-config / sdk-docs-truthfulness / shell-multibyte-var /
throttler-whitelist / user-facing-language / workflow-actions-pinned）+ 已自 spawn 5 条
（conditional-writes / infra-doc-counts / metric-docs / npm-audit-exemptions / openapi-response-schema）。

### 下轮入口

1. B1 剩余 10 条按同模板迁（其中 `enum-drift` / `user-facing-language` 体量大，留到最后）。
2. 已自 spawn 的 5 条收编（`openapi-response-schema` 的伴生文件已在第 10 轮处理）。
3. 结构化残差：db keyset 深分页、CIR-05 残差（镜像 digest / pip hash）、OSS G10（触发幂等键）。

---

## 11. 追加：第 12 轮（B1 批 4 + 收编批 2）

| 项 | 内容 | commit |
|---|---|---|
| B1 批 4 | error-i18n / password-policy-sync / shell-multibyte-var 迁 harness，35 条用例；修掉「`--report` 绕结构关」「`readdirSync` 静默 catch」「`--fix` 绕下界」「规则字符集为空两侧一样死就绿」等假绿 | `4cb5e093` |
| 收编批 2 | conditional-writes / infra-doc-counts / metric-docs 接 harness（40→43 / 15→16 / 17→19 条）；修「`--report-saves` 吞结构错（CI 真在跑）」「缺省根跟 cwd → 子目录跑 0 文件假绿」「metric 的『没有基线时 --update』用例名不副实」 | `99d53e41` |
| 文档同步 | 迁移 78（G4 会话发起人列）→ atlas 123 / infra 123；`--report-saves` 文案从「不失败」改为「不判据红，结构错仍红」 | `e3fc48c4` |

验证：`test:guards:repo` **exit 0**；三条 selftest 43/43、16/16、19/19；35 个 `check-*.mjs` 已接 harness（剩 9 个）。

### 下轮入口

1. **仍只测函数的 7 条**：enum-drift / lint-gates / release-config / sdk-docs-truthfulness /
   throttler-whitelist / user-facing-language / workflow-actions-pinned。
2. **已自 spawn 2 条**：npm-audit-exemptions（联网）、openapi-response-schema（主文件是 CLI 外壳，归属未定）。
3. `scripts/docs/check-docs.mjs` 的 selftest 在独立文件，但 CI 未调 `npm run test:docs` —— 它在 CI 里其实没跑。
4. 结构化残差：db keyset 深分页、CIR-05 残差（镜像 digest / pip hash）。

---

## 12. 追加：第 13 轮（自检接线缺口 + T4 批 5）

| 项 | 内容 | commit |
|---|---|---|
| T4 批 5 | release-config / throttler-whitelist / sdk-docs-truthfulness 迁 harness（30/9/10 条）；修掉「④a 在生产路径上是死的」「无锚点正则把人操作面划进机器面」「围栏塌方使判据 A 永真」 | `97640a6b` |
| 接线缺口 | 机械审计 47 个守卫的「本地/CI 是否真跑自检」，修掉 **13 处**（10 本地 + 3 CI）：docs / alerts / enum-drift / lint-gates / no-hoisting / dependency-review / desktop-update-chain / user-facing-language / release-config / docs-site-sync + ssrf / npm-audit / admin-web i18n-key-check；`check:docs` 收敛为 `test:docs` | `16cbd661` |

**根因**：`check-guards-wired` 只判「脚本名出现在 workflow」，不判「自检是否被执行」——所以这类缺口能长期存活且它一直是绿的。反证用隔离 worktree 做 A/B：往 docs selftest 塞必红用例，修复前门禁**看不见**（绿），修复后立刻红。

验证：`test:docs` 23 通过；`test:guards:repo` **exit 0**（57 个 script）；`check-guards-wired` 44 个全接线。

### 下轮入口

1. **给 `check-guards-wired` 加「有自检 ⇒ 自检被调用」判据**（把本轮这类缺口变成机械可拦）。
2. 仍只测函数的 4 条：enum-drift / lint-gates / user-facing-language / workflow-actions-pinned
   （npm-audit-exemptions 需联网，openapi-response-schema 归属未定）。
3. 结构化残差：db keyset 深分页、CIR-05 残差。

---

## 13. 追加：第 14 轮（守卫的守卫补判据 + T4 真收官）

| 项 | 内容 | commit |
|---|---|---|
| 第三判据 | `check-guards-wired` 现在检查「有自检 ⇒ 自检必须真被跑」（本地 `test:guards` 递归展开 + CI 10 个 workflow 的 211 个 `run:` 块，剥注释、按缩进 dedent、合并同文件 flag）；selftest 7→20 条；豁免分两张表，`one-side` 要求 wired 那面做事实核对 | `f42b419d` |
| T4 收官 | enum-drift / lint-gates / user-facing-language / workflow-actions-pinned 接 harness（27/13/24/13 条）；修掉「`--update` 把空扫描面写成合法空基线」「`--report` 吞结构错」「捕获组只留最后成员」等假绿 | `b2d466bc` |
| 文档 | 迁移 123→124（G6 `runOnUpstreamFailure`） | `f626c70b` |

验证：`test:guards:repo` **exit 0**；`check-guards-wired` 报「45 个守卫有自检 / 44 个两面都跑 / 0 个只接一面」；
**42/44 个 `check-*.mjs` 已接共享 harness**（剩 2 个：npm-audit-exemptions 需联网、openapi-response-schema 是 CLI 外壳）。

### 下轮入口

1. 剩 2 条：`check-npm-audit-exemptions`（判据本体需 registry，可只收编自检执行层）、
   `check-openapi-response-schema`（主文件是外壳、伴生 selftest 已接，决定归并方式）。
2. 结构化残差：db keyset 深分页、CIR-05 残差（镜像 digest / pip hash）、OSS G8（工具注册表插件化）。
3. 建议给 `test:guards:repo` 记录一次基线耗时（57 个 script），避免后续再加守卫时无感膨胀。

---

## 14. 追加：第 15 轮（T4 达 100% + 基线耗时）

| 项 | 内容 | commit |
|---|---|---|
| 最后两条 | npm-audit-exemptions（只换自检执行层，仍全离线）与 openapi-response-schema（伴生 25 条并入主文件 26 条，删伴生）；两条各加一条**元用例**：把「自检判红 ⇒ 退出码必须是 1」钉住——此前删掉 `process.exit(1)` 也全绿 | `7dcfdbfe` |

**T4 完成度：43 / 43 个 `check-*.mjs` 全部接 `scripts/lib/guard-selftest.mjs`（100%）。**
`check-guards-wired` 现在同时报两面：「45 个守卫有自检，44 个在本地与 CI 都真的执行了自检（1 个显式豁免，0 个只接一面）」。

### 基线耗时（本轮实测，供后续防膨胀）

`npm run test:guards:repo`：**40.3–41.3s**（57 个 npm script、44 个守卫主跑 + 自检、含 docs 23 条自检）。
建议后续新增守卫时以 45s 为上限；超过就说明有守卫的自检在跑真栈或 sleep。

### 后续入口

1. 结构化残差：db keyset 深分页、CIR-05 残差（镜像 digest / pip hash）、OSS G8（工具注册表插件化）。
2. 「守卫自检」这条主线已收口，后续新守卫的模板即 `scripts/lib/guard-selftest.mjs` + 任一已迁移脚本。

---

## 15. 追加：第 16 轮（镜像固定 + CIR-05 收尾）

| 项 | 内容 | commit |
|---|---|---|
| 镜像 digest | `docker-compose.yml` 的 **12 个镜像 / 14 行**固定到 manifest list digest（`<repo>:<tag>@sha256:…`），每个都经 Docker Hub API + `docker manifest inspect` 双向确认是多架构 index；新增 `check-image-pinned`（10 条 selftest，块级 build 豁免 + `ALLOW_UNPINNED: 理由`） | `53a17842` |

验证：`check-image-pinned` 主跑扫 5 份 compose / 15 条镜像 → 固定 14、豁免 1、未固定 0；
`docker compose config -q` 渲染出的 image 全带 @sha256；`test:guards:repo` **exit 0**（45 个守卫）。

### 未收口（需决策）

1. **`apps/*/Dockerfile` 的 10 条 `FROM` 未固定**（node:24-alpine ×5、nginx:1.27-alpine、
   python:3.12-slim ×4）——属 `apps/**`，本轮纪律未动；守卫的 Dockerfile 扫描面刻意只含仓库根
   （头注写明边界，不假装它们已固定）。收口=扩扫描面 + 同轮固定，否则会立刻红。
2. **`minio/minio:RELEASE.2024-10-13T13-34-11Z` 解析不到**：Docker Hub 仓库已下线
   （hub API 404 / registry 401 / manifest inspect denied）。已加 `ALLOW_UNPINNED` 豁免（复查
   2026-12-31）；要根治需迁 quay.io 或换实现。

---

## 16. 追加：第 17 轮（Dockerfile FROM 固定 + 守卫扩面）

| 项 | 内容 | commit |
|---|---|---|
| FROM 固定 | `apps/*/Dockerfile` 的 **10 条 FROM** 固定到 manifest list digest（node:24-alpine ×5 / nginx:1.27-alpine / python:3.12-slim ×4）；双路交叉验证（hub API + `docker manifest inspect`，amd64 子 digest 与 hub `images[]` 逐位吻合）；5 个 Dockerfile 全部 `docker build --check` 无警告 | `64323598` |
| 守卫扩面 | `check-image-pinned` 扫描面从「仓库根」扩到「根 + `apps/<app>/Dockerfile*`」，加下界（文件 ≥4 / FROM ≥8），selftest 10→12（新增「apps 下未固定 → 红」「apps 目录不存在 → 结构红」） | `64323598` |
| 文档 | 迁移 124→125（sop_clarifications 待处理部分索引） | `ec620d00` |

验证：`check-image-pinned` 主跑 25 条镜像引用 → 固定 24 / 豁免 1（minio）/ 未固定 0；
`test:guards:repo` **exit 0**（842 个 ✔）；`check-guards-wired`：45 个守卫全接线、46 个有自检、
45 个两面都跑、0 个只接一面。

**CIR-05 到此收口**：action（106 处）+ compose 镜像（14 行）+ Dockerfile FROM（10 行）三层都已固定，
各有一道机械守卫。唯一遗留是 `minio/minio`——Docker Hub 仓库已下线，`ALLOW_UNPINNED` 带理由豁免，
根治需迁 quay.io 或换实现（复查日期 2026-12-31）。

---

## 17. 第 18 轮：全量回归认证（HEAD `0c490079` 之后）

| 面 | 结果 | 命令 |
|---|---|---|
| admin-api | **391 套件 / 6775 例全绿** | `jest --silent --maxWorkers=3` |
| admin-web | **262 文件 / 2176 例全绿** | `npx vitest run` |
| executor-desktop | **test:main 全绿**（61 个 selftest） | `npm run test:main` |
| 守卫链 | **exit 0**（45 个守卫 / 46 个自检面 / 0 个只接一面，约 40s） | `npm run test:guards:repo` |

过程记录（如实）：首轮 admin-web 有 **1 例红**（`artifacts-list.test.tsx` 的「自取数失败 → 渲染错误态」），
落在并发会话未提交的 `ArtifactsList.tsx` 改动上；其提交 `0c490079` 落地后该文件 8/8 绿、全量复跑 2176/2176 绿。
**没有发现属于本会话提交的回归。**

> 至此这条主线（守卫会咬人 → 接线 → 供应链）的收口状态：三端全绿、45 个守卫全接线、
> 46 个自检面全部在本地与 CI 真跑、CIR-05 三层（action / compose / Dockerfile）固定完成。

---

## 18. 追加：第 19 轮（executor-python 两条跨端 P2）

| 项 | 内容 | commit |
|---|---|---|
| 超时整树杀 | `_run_with_limits` 从 `subprocess.run(timeout)` 改 `Popen + communicate(timeout)`；超时 `killpg(SIGKILL)` 整树（含「killpg 前比对执行器自己的 pgid」安全底线），win32 退化 `taskkill /T /F`；重新抛 `TimeoutExpired(cmd, timeout)` 与分类规则对齐 | `025e8817` |
| 重定向复检 | 新增 `_package_url_host_denied(host)`：302 复检此前只调 `_host_is_restricted`、不看 `allow_private_network`，导致内网同主机 302 在 python 必失败、node 成功；现在两处统一判定（开关下放行私网**与 169.254**——与 node 一致：node 的 ssrf-guard 没有元数据特判，`if (allow) return` 在受限判定之前；**loopback 恒拒**是 SEC-NEW-2 的刻意收紧；首跳闸与复检走同一判据，根因消除） | `025e8817` |

测试：新增/改写覆盖「孙进程被杀（`ProcessLookupError` 判死）」「超时异常文本仍是真实命令而非
launcher argv」「开关关：302→内网拒 / 开关开：302→内网放行 / 开关开：302→169.254.169.254 仍拒」。
全量 `pytest tests -q` **exit 0**（覆盖率 88.06% ≥ 86）；`test:guards:repo` **exit 0**。
反证：两处各还原 → 对应用例红。

> **更正（22:20）**：提交 `025e8817` 的信息里写「开关打开时云元数据/回环仍然拒绝」，**其中「云元数据仍拒」是错的**——
> 按 node 的真实语义（ssrf-guard 无元数据特判），开关打开时 169.254/16 一并放行；执行者用例钉的是
> 「开关开→放行 / 开关关→拒绝」，并在 docstring 写明「任何收紧都必须是有意改这条用例」。loopback 恒拒仍然成立
> （python 侧既有裁定，node 放行——这是两端唯一刻意差异）。此处按事实更正，不回写历史提交。
>
> 邻接收口：同一条 prepare 路径上的 `_unshallow_bare_repo` 的 `fetch --unshallow` 也改走整树杀（同失效模式）。
> 剩余 P3：`_is_bare_git_repo` 的 rev-parse 探测仍是裸 `subprocess.run`（只读、不写缓存，风险低于本轮两条）。

---

## 19. 追加：第 20 轮（MinIO → RustFS）

| 项 | 内容 | commit |
|---|---|---|
| 服务端替换 | `docker-compose.yml` 的 `minio` 服务换成 `rustfs`（`rustfs/rustfs:1.0.4@sha256:ed9210d6…`，profile 改 `rustfs`）；非 root 10001 需 `volume-permission-helper`（alpine 固定 digest + chown + `depends_on: service_completed_successfully`）；卷 `minio_data`→`rustfs_data`+`rustfs_logs`；`LOG_STORAGE_ENDPOINT` 默认 `rustfs:9000`；`RUSTFS_*` env 与 `LOG_STORAGE_*` 的「留空跟随」关系已实测可用 | `14cf7409` |
| 客户端 | **不变**（npm `minio` 是通用 S3 SDK），`apps/admin-api/src/**` 一行未改 | — |
| 文档 | operations（mc alias/ilm + 迁移整节）、deployment（env 表 + profile 小节）、三个 README、DEPENDENCY-REVIEW-LOG（依赖图零变化、stream-json 告警仍在且与服务端无关）、atlas 四份失效描述、ci.yml 注释 | `14cf7409` |
| 守卫 | `check-image-pinned` 删掉 minio 的 `ALLOW_UNPINNED` 豁免；主跑 26 条镜像全固定（豁免 0） | `14cf7409` |

**真实端到端（非 mock）**：compose 起 RustFS → helper exit 0、60s healthy、`/health` 200；用 admin-api
实装的 `minio@8.0.7` + `S3LogStorage` 连 `127.0.0.1:9000`：listBuckets / makeBucket / putObject(size=91) /
getObject 字节一致（含 UTF-8 中文）/ `S3LogStorage.put` 58B gzip → `.get` 解压逐字节一致 / `.getStream`
流式一致 / removeObject 生效。反证：不 chown → `[FATAL] Permission denied (os error 13)`。

**数据不可原地迁移**：RustFS 的 MinIO 磁盘格式兼容是 preview 非默认构建、加密对象读不了。迁移路径：
① 新旧并存 `mc mirror --preserve`；② 历史日志按 30/90 天自然过期 + 人工删旧卷。文档两条都写了。

**残留**：DTO 描述与 openapi 生成物里仍写「S3/MinIO」文案（改动会牵动 api-types 守卫，另开）。

---

## 20. 追加：第 21 轮（契约文案去 MinIO 化）

| 项 | 内容 | commit |
|---|---|---|
| 契约 | `logObjectKey` 的 `@ApiProperty` 描述改为「日志存放于 S3 兼容对象存储（默认 RustFS）时的对象键」；重新导出 openapi → 注入英文映射 → 重新生成 `api-types.ts` | `35c8fd66` |
| 注释 | 五处「MinIO/S3」改为「S3 兼容存储（默认 RustFS）」（`configuration.ts` / `s3-log-storage.ts` ×2 / `s3-log-object-retention.service.ts` ×3），不动实现 | `35c8fd66` |

过程如实：改 DTO 后 `inject-openapi-en` **硬失败**并点名缺英文的那条（这正是 LANG-ERR-01 的守卫该做的），
补 `openapi-en-map.json` 后注入 1645 处成功。

验证：`check-api-reference` 218 路径全覆盖、附录与 openapi 逐字节一致；`check-openapi-response-schema`
241/254 无倒退；`jest task/log-storage + log-retention` 25 例绿；`test:guards:repo` **exit 0**。

---

## 21. 追加：第 22 轮（三线并行：db keyset 残差 / 文档再漂移 / 执行器跨端）

| 线 | 内容 | commit |
|---|---|---|
| db | keyset 分支早已存在；本轮修三处残差：**audit keyset 的 `total` 是「剩余条数」**（COUNT 在游标谓词之后，typeorm COUNT 保留 WHERE → 每页少一截，前端 totalPages 会漂；原 spec 的 `getCount` 桩恒按无游标计数 = **mock 比生产更正确**）、`GET /tasks` 与 `findAllByLastStatus` 的 OFFSET 单键排序（同刻行顺序未定义 → 静默重复/漏行） | `88d5526f` |
| 文档 | 再漂移审计（15 条：P1 4 / P2 7 / P3 4）落在 [2026-10-30-docs-redrift.md](../2026-10-30-docs-redrift.md)；P1 批补 G4/G5/G6 缺口（`runOnUpstreamFailure` 与 `$upstream("别名")` 四维契约、`get_session_steps`、README.en 缺的 4 行 `ALLOW_LOOPBACK_CORS`）+ 修 4 处**反向陈述**；P2 批补守卫体系入口文档（harness / 三条判据 / 两面接线）+ 测试与环境数字按现场重算 | `53818712` `2fec72a8` |
| 执行器 | zip 驱动器相对条目两端统一**拒绝**（`C:foo` 实测解析到 C 盘当前目录）、secret 名闸改 `fullmatch`（`$` 会匹配串尾前换行）、gitRepo SSRF 改复用 `_package_url_host_denied`（169.254/::1/0.0.0.0/100.64 从放行变拒绝）+ bundle 摘要补账 | `363caf4b` |

关键发现（都属「测试绿但语义错」）：audit 的 total 缩水（mock 比生产更正确）、`domain-modules.md` 的
依赖契约 **key/value 写反**、文档 4 处「只有全 SUCCESS 才扇出」与 G6 实现相反。

验证：`test:guards:repo` **exit 0**；audit+task 75 套件 1705 例；python 1541 passed（覆盖率 88.08%）；
node 1416 passed；`check-desktop-bundle-drift` 两段一致；check-docs / cli-doc / api-reference / atlas-counts 全绿。

**下轮建议**：① 把「spec 文件数 / selftest 文件数 / env 键数 / 常驻服务数 / README 切片一致性」加成守卫
（本轮反证证明这些数字改回旧值后 4 条验证命令 + check-guards-wired 仍全绿）；② minio→rustfs 的
DTO/注释收口已完成，剩下 `task-dependencies.ts` 头注（G6 后 key 已参与语义）需随 apps 改动一起修。

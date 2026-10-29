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

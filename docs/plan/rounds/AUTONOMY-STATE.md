# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 99 段全绿**
**会话**：第 123 轮 · 并行第 53 批

## 本轮落地
1. **迁移时间戳已登记**（`741fb9c9`）：`1790000000098 | AddBroadcastReservedCount` 写入 `docs/PLAN-CLAIMS.md` 分配表（142 行），`check:migrations` **exit 0**（141 个迁移全部注册、selftest 15/15）。
   - **W3 的处理方式值得记**：`check:migrations` 明写「**先登记再建文件**」，而登记表在它写域之外 ⇒ 它**停手报我**而不是先斩后奏（先建文件会让守卫立刻红）。**写域边界的正确处理 = 停手 + 给出可粘贴的整行**。
2. **ADR-038 步骤 1 定稿**（`c3f0e1a5`，W3）：`§5 步骤 1` 整节重写 —— ① **J1 不够**（量的是**计数**，广播后本就 ≥1，`executor.service.ts:6034` + 既有 `R-06` 已钉住；C 段说的是 `计数1/行数0` 的**行数口径**）② **J2 才是真判据**（广播 +1 后该机心跳 `reported=0`、零条非终态行 ⇒ 占用仍须 ≥1），附红证据 `artifacts/autonomy/R121-api/step1-red-evidence.md` ③ **否决条件的正确用法**（J1 绿**不触发**；**只有 J2 绿才停手重查**）④ 教训「**判据没红 ≠ 问题不存在**」⑤ J2 随步骤 3 入库。

## 已备好、步骤 2 直接套用（W3 稿）
- `artifacts/autonomy/R122-api/prepared-migration.ts` —— `ADD COLUMN IF NOT EXISTS "broadcastReservedCount" INTEGER NULL DEFAULT 0` / `down` = `DROP COLUMN IF EXISTS`，含「零回填、不建索引、回滚不需数据修补」说明；
- `prepared-entity-column.ts` —— 实体列片段（含「**不进心跳白名单**」说明）。

## 在途
- **W3**：ADR-038 **步骤 2** —— 落列 + 双向迁移（`run` / `revert`（数据行仍在）/ 再 `run` 幂等，三条 exit 必须真跑），`check:migrations` + `migration-symmetry` + `tsc` + `size-caps` 全 0；**只加列**，不动写路径/容量谓词/心跳白名单。
- **W2**：台账补 R116→R121（在跑）。

## 待办
1. 收 W3 步骤 2 ⇒ 步骤 3（广播 `+1`/释放改打新列 + 两处容量谓词改「两列之和」+ J2 转绿入库 + 对账判据）。
2. `§7.0` 里 `adr-038-broadcast-occupancy` 目前 = needs-implementation，步骤 2/3 完成后更新。
3. 其余 backlog：`execute-further-slimming`（needs-adr）、`ci-pg-race-unverified`、`web-flake-not-reproduced`（推进一格）、`release-notice-ops`。

## 方法学（累积，本轮新增标 ★）
只信「命令 + 真实 exit code」；**写域边界的正确处理 = 停手 + 给可粘贴的整行**（★先斩后奏会让守卫立刻红）；**「判据没红」≠「问题不存在」**；**判据要自带否决条件且只对真判据生效**；**语义分离优于消灭特殊性**；**失效半径要写方向性**（漏释放=少派单安全 / 漏算进谓词=超卖危险）；**同一列两种相反语义会互相抵消**；**不变量有适用范围**（只对单播）；**没有 dump 不归因产品**；**测量工具会撒谎**（累计 5 次：`signal` 缺失 / 失败行正则 / 判据方向 `!==` / 删行记账 / 假 oracle `--fixed`）；harness 与产品缺陷必须分栏；不变量要写成断言；记账口径要对齐生产；不编造 sha；文档与实测要对账；验收用链内同形式；收紧判据后复验原反例；守卫防「先咬自己」；前缀式清理/固定临时路径是并行互杀源；样本量不足的绿不算绿；「期望值同源」≠ oracle 成立；假 oracle 要删；抖动段不挂门禁；基线撞上限不许调上限；强/弱反向验证分开记；先看 `signal` 再判退步；一次只改一个文件；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。

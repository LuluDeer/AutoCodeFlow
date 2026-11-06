# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 98 段全绿**（含可见豁免）
**会话**：第 109 轮 · 并行第 42 批

## 本轮落地（HEAD）
1. **心跳 TOCTOU 原子闭合**（`8f25b481`，ADR-037 的方案）：`executor.service.ts:3805-3860` 不再「应用层算数字→写」，改为**追加一条原子** `update().set({runningTaskCount: () => GREATEST($上报, (SELECT count(*) … 非终态))})`。
   - **红证据是我要求的 (a) 真 PG 时序**（`artifacts/autonomy/R108-api/toctou-real-pg.sh`，容器 `acf-postgres-1` / 独立 schema `r108`）：t0 快照=3、窗口内 +2 行与 +2 占坑、**真实在途=5** ⇒ **旧实现写 3（超卖）**、新实现写 5 ✔，脚本断言 exit 0。
   - **反向验证**：去掉下限 ⇒ 用例「updates lastHeartbeat and metrics on heartbeat」红（期望 `GREATEST(...)` 实得 `"1"`）/ exit 1。
   - **回归**：87 suites / **1858 passed**；`tsc` 0。
   - **两个设计陷阱已记**：① `patch` **不能放函数值**（会进 metrics-history/返回值，且有 spec 断言 patch 键 ⊆ 心跳白名单）⇒ 最终形态 =「patch 保值语义 + 追加一条原子语句只写计数列」；② **重启清零分支必须排除下限**（`didRestart`/missing-baseline 故意清零，套下限会把 0 抬回行数 ⇒ 重启后虚高、**欠派**），用「客户端是否真上报」区分并写进注释。
2. **体量代签**：`executor.service.ts` 4446 → **4465**、`executor.service.spec.ts` 8729 → **8739**（回滚值已记）。
3. **harness 改造（部分）**（`b2f44be2`）：`--fixed` **已删除**（假 oracle）；模式改名 **`--toctou`**（不再叫 `--window`，那个窗口不存在）；期望值改为调真实产品函数 `resolveHeartbeatRunningTaskCount`；CI 稳定性结论 = 时序型不进门禁，CI 若覆盖只做「SQL 形状断言」并**显式标注较弱**。

## ⚠ 我抓到的关键问题：oracle 仍然红（修复落地后）
`npm run test:heartbeat-dispatch-race` 修复后**仍 exit 1**（`20 轮 · I1 超卖 20`，报文「期望 2，实得 0」）。
**根因**：harness 的**期望值**来自产品函数 ✔，但**实际写入仍用它自己写的 SQL**（脚本里「按现状实现覆盖写入」）⇒ 产品怎么改它都不会变 ⇒ **仍未成为真 oracle**。W1「修后不必改 harness」的结论是错的。
**修法（已派）**：W3 把**下限表达式抽成零依赖共享产物**（`heartbeat-count.util.ts`，0 import），产品侧改为使用它；W1 的 harness 改为 **import 同一表达式**做实际写入 ⇒ 物理同源，产品改了它自动变绿。

## 在途
- **W3**：抽共享表达式（含真 PG 时序脚本重跑 exit 0、去 `GREATEST` ⇒ 用例红）。
- **W1**：harness 改用共享表达式 + **机制证明**（harness 侧临时去 `GREATEST` ⇒ 必须转红）。

## 后续
修完后：接新段（98 → 99）+ 删除那条豁免（复核期 2026-12-31）；台账（`PLAN-CLAIMS`/`§7`）记录 R18-B 从 blocked → **活缺陷 → 单语句修复**的完整链条。

## 纪律（并行版）
只信「命令 + 真实 exit code」；**「期望值来自产品」≠「oracle 成立」——写入路径也必须同源**（本轮实证）；**能被反例证伪的判断优先**（W3 两次推翻自己）；**修之前先证窗口可达**；**假 oracle 要删不要留警告**；**模式名要诚实**；**patch 不许放函数值**；**重启清零分支要排除下限**（否则欠派）；**结构性重构先 ADR**；恒红段用可见豁免（到期日+每轮打印）；基线撞上限不许调上限；强/弱反向验证分开记；先看 `signal` 再判退步；链在无在途改动时跑；一次只改一个文件；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。

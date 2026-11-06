# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 98 段全绿**
**会话**：第 111 轮 · 并行第 43 批

## 本轮落地（HEAD）
1. **计数下限表达式抽成零依赖共享产物**（`52aa593b`，W3）：`heartbeat-count.util.ts` 新增 `buildRunningTaskCountFloorExpr({reported, outerRef?, executionsTable?, statuses?})` + `RUNNING_TASK_COUNT_OPEN_STATUSES`；产品侧改用它（生成 SQL 与 R108 **逐字相同** ⇒ 行为零变化，79 suites / **1601 passed**），`grep -c '^import'` 仍 **0**。
   - **可观察的「同源」特征**：反向验证（去 `GREATEST`）**同时击穿两层** —— 判据层 4 条 + **产品层** `updates lastHeartbeat and metrics on heartbeat`；而 R108 时改判据不影响产品断言，这正是「不同源」的签名。
2. **harness 改为与产品物理同源**（`80a9d262`，W1）：落库 SQL 由 `buildRunningTaskCountFloorExpr({reported: ':snap'})` 生成并**原样拼接**（`reported` 走**可信片段通道**，只传自造占位）；数值期望仍来自 `resolveHeartbeatRunningTaskCount`。
   - **机制证明成立**：`R110_STRIP_GREATEST=1`（落库退化回旧写法）⇒ **exit 1、3/3 轮违反**；还原 ⇒ exit 0。**harness 结论确实随共享表达式变化**。
3. **体量代签**：`executor.service.ts` 4465 → **4467**（回滚值已记）。

## ⚠ 我抓到的新问题：修复后 20 轮仍有 1 次违反
`npm run test:heartbeat-dispatch-race`（默认 **20 轮**）⇒ `I1(超卖) 1 轮 + I3(容量) 1 轮`，样例「期望 3，实得 2」。而 W1 只跑 `--rounds=3` 得 0 ⇒ **3 轮绿不等于 oracle 绿**。
**我的假设（待 W3 验证）**：原子 UPDATE 的子查询**只看得见已提交行**；若派发的「占坑 + 建行」事务**尚未提交**，心跳的子查询看不到它 ⇒ 写回较低值，随后该事务提交 ⇒ 最终计数 < 真实占坑 ⇒ 超卖。即 R108 的原子化**只闭合了「已提交之后」的窗口，没闭合「提交前」的窗口** ⇒ 需**行级串行化**（心跳对 executor 行加锁 / 派发对同一行加锁更新）。

## 在途
- **W3**：定性 20–50 轮的违反率与机制（未提交不可见？），残窗则修（锁策略 + 心跳超时/降级，保守不阻塞），判据 `--rounds=50 ⇒ 0 违反`。
- **W1**：违反轮**完整时序落盘**（两会话语句顺序/时间戳/中间值）+ `--rounds=50` 基线数字；**在违反率降到 0 前不许接任何门禁**（含 `needs-env` 慢通道）。

## 已裁决
- 接链时机：**先定性 ⇒ 修复 ⇒ `--rounds=50` 稳定 0 ⇒ 再接 `needs-env` 慢通道**；CI 的「SQL 形状断言」可稍后单独做，**必须显式标注「较弱：只验写法不验时序」**。
- 那条父脚本豁免继续保留（复核期 2026-12-31），修完一并删。

## 纪律（并行版）
只信「命令 + 真实 exit code」；**样本量不足的绿不算绿**（3 轮 vs 20 轮，本轮实证）；**「期望值同源」≠「oracle 成立」，写入路径也必须同源**；**同源的签名 = 反向验证同时击穿判据层与产品层**；**修之前先证窗口可达**；**原子化不等于闭合**——还要问「子查询看不见谁」；**假 oracle 要删**；**恒红/抖动段不挂门禁**，先定性再谈接链；基线撞上限不许调上限；强/弱反向验证分开记；先看 `signal` 再判退步；链在无在途改动时跑；一次只改一个文件；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。

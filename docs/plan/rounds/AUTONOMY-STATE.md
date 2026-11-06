# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · ⚠ **链 98/98 绿，但已确认存在「空转守卫」假绿**
**会话**：第 106 轮 · 并行第 39 批

## ⚠⚠ 本轮最重要的发现：链有假绿
1. **`npm run test:heartbeat-dispatch-race` ⇒ exit 1**（`汇总：20 轮 · I1(超卖) 20 轮违反 · I3(容量) 6 轮`，样例「心跳把已占坑数改小 ⇒ 超卖风险」）——**我独立复验，不是转述**。
2. **链的 98 段里没有 `test:guards:selftests`**（我用 `node -e` 解析 `test:guards:chain`：只有 `check:race-selftests-wired`（第 87 段）与 `check:desktop-selftests-wired`（第 25 段））。
3. `check-race-selftests-wired.mjs:54-58` 断言的是「该 selftest 被 `test:guards:selftests` 引用」，而**父脚本自身从不被链执行** ⇒ **这个守卫的保证是空转的**（证明「挂到了一条从不运行的命令上」）。

**结论**：`R18-B` **不是 blocked，是一条有 20/20 复现的活缺陷**（心跳覆盖写在途占坑计数 ⇒ 超卖 + 容量判断被绕开）。已派 W3 修（口径：**下限改读「占坑数」而非「执行行数」**，最小、不重构事务）。

## 本轮落地（HEAD）
- 台账（R104，`f4b49033`）：`PLAN-CLAIMS` 覆盖 R60–R103；`§7.0` backlog 重算为 5 条；`AGENT_HANDOFF` 加健康快照。
- 文档 + 判据（`f24daff0`）：`operations.md:1623` 浮空 rejection 覆盖边界（含 **`afterAll` 必须最后注册**）；`CATEGORY_ALIASES` 只做归一化的精确判据（`foo: true` ⇒ exit 1 点名）。
- W3 的 R18-B 复核（R105）：`reservedSlots<=running` 下限**已有**（`executor-heartbeat-report.collaborator.ts:318-341`）、心跳不低于服务端在途**已有**（`executor.service.ts:3805-3827`）、**占坑与建行未同事务**（`executor-dispatch-slot.collaborator.ts:146` 只 UPDATE 计数，建行在 `scheduler.service.ts:2855`/`task.service.ts:4193`）⇒ 剩余真阻塞就是那个窗口。

## 在途
- **W3**：修 R18-B（先判定 harness 是否调真实实现 —— 若纯模拟，改产品也不会变绿，那要先改造 harness）；修后 `test:heartbeat-dispatch-race` 默认模式须 **exit 0**；并接新段（98→99）。
- **W1**：给 `check-*-selftests-wired` 加判据「**被引用的父脚本必须真的会被链执行**，否则红」，治本；并按顺序处理 heartbeat 段接链（临时豁免需进基线、附理由，**不许静默**）。

## 纪律（并行版）
只信「命令 + 真实 exit code」；**「绿」要问一句「它真的跑了吗」**——本轮假绿正是「守卫证明 X 挂到 Y，而 Y 从不运行」；**恒红段不许用 `|| true`/`--passWithNoTests`/吞错变绿**；**blocked 条目要定期复核**（本轮复核发现它其实是活缺陷）；台账落后也是缺陷；基线撞上限不许调上限；未超阈值文件不登记；隐含前提写进文档；强/弱反向验证分开记；先看 `signal` 再判退步；链必须在无在途改动时跑；作者中断≠改动作废；一次只改一个文件 + `node --check`/`tsc`；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。

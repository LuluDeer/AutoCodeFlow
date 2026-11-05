# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · 守卫链 93 段（上次全绿 `b931b60a`）
**会话**：第 64 轮 · 并行第 3 批收集中（工作区有 12 个在途文件，属 W1/W2/W3/W4）

## 已入 HEAD（本轮新增）
- **W4 → ADR-032**（`57af38f0`）：python 出站闸的开关姿态与契约对齐；**关键事实**：`tests/test_execute.py:3618` 断言的正是 `_package_url_host_denied('169.254.169.254') is False` ⇒ **测试把“放行云元数据”钉成期望**；python 放行表在 `routers/execute.py:2155`（开关档 `:2196` 放行一切非 loopback 受限地址），admin 对照 `safe-http.util.ts:111`、node 对照 `git-repo-network-policy.ts:101`。ADR 六节齐备、索引恰好 1 次、`test:docs` 0（含负向对照）。
- **W4 → Step 1（红）**（`8f04f468`）：把上述旧断言**翻成契约方向**（开关开启时云元数据必须 DENY）——先红，待实现转绿。
- **W5 → pull 账本并发判据**（`2fa1377a`）：**无缺陷仅加判据**（+220 行纯测试）。落点：预留 `Atomics.add:367 → trackReservation:379`、归还 `finally Atomics.sub:555 → untrackReservation:558`、`accept200` 只 untrack 不减账本 `:492`、竞态回退 `:372` 未 track、计数器 `:73/:80`；**同步无 await = 是**。桩掉 `untrack` 递减 ⇒ **4 failed/34 passed exit 1**；恢复 38 passed。`tsc --noEmit` 0。
- **W1 → 助手推广 0/4（正确跳过）**：四个守卫夹具分别是 **repo 树 / files 组装 / 对象数组**，**不适合文本助手**；硬塞只会得到**恒真**。已按「不硬塞恒绿」停手，并给出兄弟助手方案（`expectRequiredKeys` / `expectRequiredPaths`）——已排 R63。

## 在途（5 路）
- **W1**：三个形态分派助手 + 4 守卫接线（每个都做「删夹具 ⇒ 红」+ 助手改恒真须变绿）。
- **W2**：列表页同类盲区（展示型修 / 非展示型加判据二选一）。
- **W3**：ADR-031 步骤 2 —— `per-call context` 收走 `opts.replayApproved`（若仍有语义依赖则停手列点）。
- **W4**：ADR-032 Step 2–3（恒拒表优先于开关 + 类别放行同构），先红后绿。
- **W5**：已交付，待新任务。

## ⚠ 待裁决/风险
1. **python 收紧是行为变更**：可能打断依赖内网/回环的 python 执行器用户 ⇒ ADR-032 的灰度开关（`PY_EXECUTOR_SWITCH_POSTURE_STRICT`）要不要接、默认值取哪边，需在实施轮一并定。
2. **W4 提的接链需求**：三向检查的 python 探针目前「按 `category_allowed` 建模」而非**真跑闸门** —— 本轮缺陷正是这个差；接链属 `scripts/**`（W1）。
3. **W3 提的台账需求**：python 收紧后将**严于 node 下载面** ⇒ 分歧需登记 `scripts/protocol-four-way-allowlist.json` 或给 node 另立项（Lead 决定）。
4. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；flaky 待复发取证；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；服务端仍无 `reservedSlots<=running` 下限（R17 范围外）。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；断言必须能失败（恒真⇒变绿才算有牙）；**形态不合就不套用**（W1 本轮示范）；文档断言命令形式；改 `ci.yml` 后立刻 `guards-wired`；验收用链内同形式；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`；worker 只跑定向，全量/93 段链由 Lead 在无在途改动时串行跑。

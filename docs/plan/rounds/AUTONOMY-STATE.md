# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 98 段全绿** · 工作区仅 atlas 在途
**会话**：第 105 轮 · 并行第 38 批

## 本轮落地（HEAD）
1. **三本台账补齐**（`f4b49033`）—— `PLAN-CLAIMS` / `PLAYBOOK §7` / `AGENT_HANDOFF` **最后一次更新是 R59，落后 44 轮**（我的调度疏漏，本轮补齐）：
   - `PLAN-CLAIMS`：新增 **1 个分组块（10 个子项，覆盖 R60–R103）**，每组附**命令/exit/commit**；
   - `PLAYBOOK` 新增 **`§7.0-现状（R104 重算）`**：**当前 backlog 只剩 5 条** —— `r18b-protocol-heartbeat-dispatch`(blocked) / `execute-further-slimming`(needs-adr) / `ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`；
   - `§7.1–§7-A` 原文**不删**（带 `since=` 与逐条「为什么不修」的判据，删了就丢证据）；主表只放今天仍成立的条目；
   - `AGENT_HANDOFF`：追加本轮健康快照（8054/0 · 2394 · 1865 · 1981/cov 87.45% · 链 98）。
   - `test:docs` **0**（台账有结构/索引/裸路径判据，本会话已两次踩坑）。
2. **文档 + 判据**（`f24daff0`，W1）：`operations.md:1623` 新增「浮空 rejection 的覆盖边界」节（含 **`afterAll` 必须最后注册**这个隐含前提）；`CATEGORY_ALIASES` 加了精确判据——**出现「别名 → 放行布尔」即红**，反例验证成立（`foo: true` ⇒ exit 1 点名第 13 行），段数仍 98。
3. **基线登记判定**（同批）：`tool-call-row.util.spec.ts` **不登记**（实测 76 非注释行，阈值 warn 600 / error 900）——**刚撞过条目上限，登记未超阈值的文件反而触发结构红**。

## 在途
- **W3**：复核 `R18-B` 是否该解除 blocked（挂了约 40 轮）。核对要点：① 心跳/派发的容量口径是否已同一事实源；② `test:pg-race` 的两个脚本（approval consume / rollout claim）**是否与心跳派发竞争同族**；③ 服务端是否已有 `reservedSlots <= running` 下限。结论三选一（可解除 / 重写重启条件 / 改判 wontfix），**只复核不改代码**。
- **W2**：B1+C1 生效后重测 web 稳定性（连跑 2 次全量）——这是把 `web-flake-not-reproduced` 往前推一格的证据；若出现「收尾窗口浮空」新红，判定真浮空（要修）还是已知签名（要加签名+证据）。

## 待办
1. 收 W3（R18-B 结论 + 可粘贴台账改写文本）、W2（稳定性证据）。
2. 其余 backlog 5 条中，`execute` 再瘦身需**事务设计 ADR**（我下一步优先项）；`ci-pg-race-unverified` 本地不可解；`release-notice-ops` 属运维。

## 纪律（并行版）
只信「命令 + 真实 exit code」；**台账落后也是缺陷**（本轮补了 44 轮）；**历史池不删**（带 `since=` 与逐条判据），主表只留当前成立的；**基线撞上限时不许调上限**——先找幽灵条目或真瘦身；**未超阈值的文件不要登记**（反而触发结构红）；**窗口/顺序这类隐含前提必须写进文档**；**强/弱反向验证分开记**；**守卫的自证盲区**；**能红验证是接链必要条件**；**先看 `signal` 再判退步**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check`/`tsc`；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。

# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 98 段全绿** · 工作区仅 docs/atlas 在途
**会话**：第 103 轮 · 并行第 37 批

## 本轮落地（HEAD）
1. **补上「`approvalId` 透传」的集成断言**（`a81a7da2`，W3）——**先核对覆盖后结论与预期不同**：`awaiting_approval` **本来就有**集成断言；真正没人盯的是 **denied 的四个分支**。本轮补 2 条（人工拒绝 / 已 consumed）+ 1 条否定例（闸门 DENY 不带 approvalId），期望值**现场用 `h.approvals.buildKey(...)` 算**而非手抄字面量。
   - **判据（红在集成层）**：把实现里两处 denied 的 `approvalId` 传参改 `null` ⇒ 断言①②红、否定例③仍绿；还原 ⇒ 绿。定向 **233 passed**、`tsc` 0。
2. **C1：`afterAll` 收窄浮空窗口**（`61a0bc27`，W2）：`test-setup.ts` +26/−1（reporter 未改，复用 `drainUnexpectedRejections`）。
   - **红**：临时 spec 在 `afterAll` 里 `void Promise.reject` ⇒ 该文件 exit 1，报文点名「文件收尾窗口出现 1 条浮空 rejection（无 test 可归属）」；
   - **绿**：全量 **291 files / 2394 passed + 1 skipped / exit 0**；
   - **不误伤**：同窗口灌 3 条已知签名 ⇒ **exit 0**（分类在入列前生效）；
   - **边界（重要）**：`afterAll` 只覆盖「最后一个 `afterEach` → 文件 hook 结束」；**真正的 jsdom teardown 在所有 hook 之后**，那里的拒绝任何 test 级钩子都抓不到 ⇒ **C1 是收窄窗口，不是让 `dangerouslyIgnoreUnhandledErrors` 退役**。实测磨合期 **0 次**。
   - **实现前提**：该 `afterAll` 必须**最后注册**（当前在 `test-setup.ts` 末尾天然满足）⇒ 将来新加的 `afterAll` 不能插到它后面。
3. **基线条目超上限已合法解决**（`238e52a3`，W1）：`基线条目 99 条 > 上限 98`（守卫原文「基线正在变成把所有大文件都签字的关灯键」）⇒ **删幽灵条目 + 把真实上限迁到新路径**，99 → **98**；`size-caps` exit 0（1980 文件 / 12196 函数 / 77 构造器 / 豁免 2 处）。

## 依赖我的代签（已办）
- `tool-executor.service.spec.ts` 1493 → **1539**（+46 是 denied 分支集成断言的验收证据，回滚值 1493）。

## 待办
1. W1 在途：① 文档补「浮空覆盖边界 + `afterAll` 顺序前提」；② `tool-call-row.util.spec.ts` 是否需登记（**先看是否超阈值，超了登记反而触发结构红**）；③ `CATEGORY_ALIASES` 只做归一化的精确判据。
2. 未收口：R18-B blocked；`execute` 再瘦身需**事务设计 ADR**（步骤 4 已到安全边界）；ADR-031 后续步骤。

## 纪律（并行版）
只信「命令 + 真实 exit code」；**基线/上限撞红时不许调上限了事**（那是「关灯键」）——先找幽灵条目或真瘦身；**「先核覆盖再动手」能纠正预期**（本轮发现真正缺口在 denied 分支而非 awaiting）；**强/弱反向验证要分开记**，弱的那次正是发现盲区的手段；**窗口收窄 ≠ 让全局开关退役**（要写清覆盖边界）；**hook 注册顺序是隐含前提，必须写进文档**；**守卫的自证盲区**；**能红验证是接链必要条件**；**先看 `signal` 再判退步**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check`/`tsc`；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。

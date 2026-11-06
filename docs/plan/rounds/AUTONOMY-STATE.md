# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 98 段全绿** · 工作区有 W2 在途
**会话**：第 101 轮 · 并行第 36 批

## 本轮落地（HEAD）
1. **真机 PG 并发接链的「能红」验证完成**（`127bf652`，W1）：临时把 `rollout-claim-pg-race` 的 `pass` 断言改成 `false` ⇒ **exit 1 且点名脚本**（`[pg-race] rollout-claim-pg-race.mjs … FAILED exit 1`）；还原 ⇒ exit 0。**这证明接链不是空转**（过去 30 轮它是「存在但没人跑」）。
   - DSN 三形式兼容：`--dsn=<url>` → `--dsn <url>` → `DATABASE_URL` → 皆无则 **SKIP 并 exit 0**；三种形式 + 无 DSN 四种情况均实测（`acf-postgres-1` 真跑 exit 0）。
   - `atlas:refresh` 显式入口 + `operations.md` 检查单第 ⑦ 行（**故意不接链、不自动跑**，避免文档数字自动衍生失去守卫意义）。
2. **`execute` 578 → 503、`tool-executor.service.ts` 843 → 771**（`61e9c0fa` + ADR-031 进度 `09c42eae`）：
   - 搬出 **8 处重复的「未执行落库行」纯格式化** → `tool-call-row.util.ts` 的 `deniedRow`/`awaitingRow`/`tierOf`（零副作用构造器），入口把身份四元组收成一次 `rowIds`；
   - **强反向验证**：`deniedRow` 返回空 ⇒ **8+ 条既有用例红**，横跨 **六个 describe**（闸门 DENY / denied 审批单 / 脱敏 / B-2 slug / B-3 澄清 / N3 指纹）；定向 **811 passed**；`tsc`/`size-caps`/`docs` 全 0；
   - **事务边界一行未改**（`persist` 闭包、三分支条件、日志、返回值原样）——这正是强反向验证能横跨六个 describe 的根因。
3. **棘轮收紧**（`db0a26ff`）：`tool-executor.service.ts` 911/678 → **771/503**（回滚值已写入 why）。基线只减不增，留 140 行松量会掩盖后续增长。

## ⚠ ADR-031 步骤 4 已到「安全边界」（W3 结论，我认可）
剩余 503 行主体是**事务耦合段**（审批查 / 三分支 / 闸门 / 出具审批单 / 领取与结清），按硬裁决**不跨函数拆**。再瘦身必须先改**事务设计** ⇒ 属独立立项，需新 ADR。

## 登记的两条缺口
1. **弱反向验证暴露覆盖缺口**：只删 `approvalId` ⇒ 229 条 agent 用例全绿，只有新构造器单测红 ⇒ 「**approvalId 透传到落库行**」没有集成断言（既有 mock 只校验 status/toolName）。**待补**。
2. `CATEGORY_ALIASES` 归一化表仍无独立判据（W3 建议）。

## 在途
- **W2**：评估「落在最后一个 `afterEach` 之后」的浮空窗口（C1 收紧 / C2 可见不阻断 / C3 文档化），**先出影响面数字再决定**。

## 待办
1. 补 `approvalId` 透传的集成断言（避免「弱反向验证」这类盲区）。
2. `CATEGORY_ALIASES` 独立判据；R18-B blocked；事务设计 ADR（若要再瘦身 `execute`）。
3. 机器：swap ≈99.9%；全量 21 分钟可跑。

## 纪律（并行版）
只信「命令 + 真实 exit code」；**守卫的自证盲区**（只查已登记项 ⇒ 永久放过未登记的同类）；**能红验证是接链的必要条件**；**强反向验证 vs 弱反向验证要分开记**——弱的那次恰好暴露「透传无集成断言」；**事务边界不跨函数**（结构拆分的止损线）；**棘轮只减不增**，降了就立刻收紧；**skip 必须打印且写明不判绿也不判红**；**CI 真跑无法本地验证 ⇒ 标 unverified**；**先看 `signal` 再判退步**；**审计要能反证「删掉这段还绿吗」**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check`/`tsc`；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。

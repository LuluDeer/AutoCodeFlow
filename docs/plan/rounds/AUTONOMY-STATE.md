# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 99 段全绿**
**会话**：第 117 轮 · 并行第 47 批

## 本轮落地
1. **三本台账补齐 R104 → R116**（`32924371`，W2）：`PLAN-CLAIMS` +1 块/9 条，完整记录 **R18-B 链条**（blocked → 活缺陷 20/20 → 方案 B 否（I2 永久饥饿）→ 方案 C 两次证伪 → 单条原子 UPDATE `8f25b481` → 共享表达式 `52aa593b` → harness oracle 同源 `80a9d262` → §5b 定性 `121a7f77` → 遗留 harness 模型 A）。
   - `§7.0` 现为 **5 条未修 + 1 条 resolved 留痕**：`r18b` **resolved**；`execute-further-slimming` needs-adr；`ci-pg-race-unverified`；`web-flake-not-reproduced`（推进一格）；**`r18b-harness-model-a` needs-fix（新增，原 blocked 的真遗留）**；`release-notice-ops`。
2. **W2 的核对抓到三处文档滞后**（这正是「台账/文档要能对账」的价值）：
   - ① **`8f25a481` 是笔误**（`git cat-file` 报 not a valid object），真实 **`8f25b481`** —— **这个笔误来自我的派发消息**；W2 写入前核对，**仓库内无残留**（我已 grep 全 `docs/` 确认 0 命中）。⇒ 纪律「不编造 sha」再次被验证有效。
   - ② `docs/health-baseline.md` 的**守卫链段数仍记 97**，实测 **99**（`categories-single-source`=97 / `test:pg-race`=98 / `destructive-global-commands`=99）⇒ R99/R114 两次加段后快照滞后。
   - ③ `docs/adr/adr-037` 的 **status 行仍写「实现未落地」**，而 R108 已落地 ⇒ 已派 W3 修（否则后来者会重开已 resolved 的问题）。
3. **harness 已切默认模型 B**（`24e21342`，W1）：`--rounds=5` ⇒ 0 违反；**B 下 `R110_STRIP_GREATEST=1` ⇒ 10/10 违反**（仍抓得住已修真缺陷）；`--model=a` 保留为对照并标注「生产不可达」。

## ⚠ 待定性：模型 B 下 20 轮出现 1 次违反
`artifacts/autonomy/R116-guard/violation-19.log`：`snapAtStart=0 / claimed=4 / inFlight=4 / finalCount=2 / productExpectation={value:4,clamped:true}`，且 **`claimed=4 > MAX=2`** ⇒ 违反在**容量侧**。两种可能：① 产品**派发侧容量谓词**仍有残窗（R108 只修了心跳写侧）② harness 的 B 实现（先 insert 再 update、失败 delete 回滚）使 `claimed` 与真实占坑短暂不一致。
**已派**：W3 查产品派发侧容量谓词（真 PG 证据，必要时共享化）；W1 加 `claimed <= MAX` 自检断言（**先判 harness 侧，不许把 harness 缺陷记成产品超卖**）。

## 在途
- **W1**：`claimed<=MAX` 断言 + 5/20 轮统计（本轮只做这两件，不摊薄）。
- **W3**：派发侧容量谓词定性（+ 修 ADR-037 status 行这件小活）。

## 待办
1. 收 W1/W3 ⇒ 定性那 1/20；修 `health-baseline.md` 段数（97→99）。
2. `needs-env` 慢通道接链（违反率稳定 0 后）；`--dump-dir` 降级复验；50 轮基线。

## 方法学（累积，本轮新增 ★）
只信「命令 + 真实 exit code」；**不编造 sha —— 连派发消息里也不行**（★本轮我的笔误被 W2 的 `git cat-file` 核对挡住）；**文档与实测要对账**（段数 97 vs 99、ADR 状态行滞后都会骗后来者）；**验收一律用链内同形式**；**收紧判据后要复验原反例仍被抓**；**守卫防「先咬自己」**；**前缀式清理与固定临时路径都是并行互杀源**；样本量不足的绿不算绿；「期望值同源」≠ oracle 成立（写入路径也要同源）；**同源签名 = 反向验证同时击穿判据层与产品层**；原子化 ≠ 闭合；**能被反例证伪的判断优先**；修前先证窗口可达；假 oracle 要删；抖动段不挂门禁；诊断代码失败不许静默；基线撞上限不许调上限；未超阈值文件不登记；强/弱反向验证分开记；先看 `signal` 再判退步；一次只改一个文件；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。

# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 98 段全绿** · 工作区干净
**会话**：第 100 轮 · 并行第 35 批

## 本轮落地（HEAD）
1. **真机 PG 并发自检接入 CI 与全链**（`d1c7df71`，链 **97 → 98**）——挂了约 30 轮的遗留收口：
   - **机制原因（值得记）**：`check:race-selftests-wired` 只断言「**已登记**的真机用例被某条链引用」⇒ 这两个脚本从未登记，所以**永远不会被要求接线**（守卫的自证盲区）。
   - **CI 档**：`ci.yml` 的 `admin-api-test` job（已有 `postgres:16-alpine` service，`:114-127`）在 E2E 前加 `PG race selftests (R99)` step，注入 `DATABASE_URL`，`timeout-minutes: 10`；缺 env ⇒ 打印 **SKIP** 并 exit 0（**不静默绿**）。
   - **链档**：`test:guards:chain` 增 `npm run test:pg-race` ⇒ **98 段**；无 PG 打印 `SKIP: 需要 DATABASE_URL（离线环境不判绿也不判红）` + 待跑清单；有 PG 真跑，任一失败 exit 1 并**逐条点名脚本**，每条 180s 超时。
   - **本地有 PG 时实测通过 2/2**（`pg-real-run.log` 尾部：`组3（DROP INDEX 后）… 证明索引是唯一防线 ✔` / `✔ PG 并发自检全部通过：2/2`）。
   - **踩坑**：脚本只认 `--dsn=`（`--dsn <url>` 被静默忽略、回落到历史端口）⇒ 已要求下轮让脚本自身也读 `DATABASE_URL`。
   - **CI 真跑 = `unverified`**（本地无法验证 CI），已如实标注。
2. **atlas 量级层**（`191c8fa7`）：新增脚本触发 `check:atlas-counts` 红（本会话第 4 次）⇒ 已刷新并提交；同时要求 W1 加显式 `atlas:refresh` 入口 + operations 清单（**不接链不接 CI**——自动衍生会让「文档数字」失去守卫意义）。

## 在途
- **W1**：脚本 DSN 三形式兼容 + **「能红」验证**（改坏断言 ⇒ exit 1 点名）+ `atlas:refresh` 入口。
- **W3**：ADR-031 步骤 4 —— `execute`（578 行 / service 843）纯段搬家，**硬裁决：事务边界不跨函数**；无可搬则停手并标「已到安全边界」。

## 待办
1. 收 W1（能红证据很关键：证明接链不是空转）、W3（行数下降或安全边界结论）。
2. 未收口：R18-B blocked；`CATEGORY_ALIASES` 独立判据；「最后一个 `afterEach` 之后」的浮空仍被开关兜住。
3. 机器：swap ≈99.9%，全量 21 分钟可跑；若被杀 ⇒ 分端跑或扩 swap。

## 纪律（并行版）
只信「命令 + 真实 exit code」；**守卫的自证盲区**：只检查「已登记项」的守卫，会永远放过「从未登记」的同类（本轮 30 轮遗留的根因）；**能红验证是接链的必要条件**（否则不知是空转）；**skip 必须打印且写明「不判绿也不判红」**；**CI 真跑无法本地验证 ⇒ 标 unverified**；**先看 `signal` 再判退步**；**审计要能反证「删掉这段还绿吗」**；**全局豁免会让纪律形同虚设**；**测量实验要能作废自己**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check`/`tsc` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。

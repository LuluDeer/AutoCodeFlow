# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · 守卫链 93 段
**会话**：第 63 轮 · 并行第 3 批在途

## 已收（HEAD）
- **W3 修复已验证**（`a358d6e1` + 进度回填 `8710f465`）：3 条红用例证实 ADR-031 §1.3 **不是假 bug** —— 「重提必须留下 in_flight 行」（Expected 1/Received 0）、「不得对不存在的行发起更新」（0 行却调用）、「原 awaiting_approval 行必须被结清」（settle 0 次）；改法 = 收成单判据 `ledgerRowExists` 贯穿 persist 与 in_flight 写入 + 0 行补插并 warn + 一次性单被领走时用 `settleToolCallByApprovalId` 条件写结清。定向 108 passed（扩面 210 passed），`tsc --noEmit` 0，`check-conditional-writes`/`stub-fidelity`/`source-text-contracts`/`test:docs` 全 0。**回退源码保留新测试 ⇒ 3 failed**（有牙）。
- **W2**：计数矛盾提示 + `RunningMetricsCard` 外提（棘轮靠外提消解，无需代签）；**W5**：心跳上报上界缺陷已修；**W4**：python 元数据恒拒 33 条用例钉死 + 发现闸门未消费恒拒表。

## 在途
- **W1**：① 代签体量棘轮（`tool-executor.service.ts` 876→911 / `execute` 619→678、spec 1370→1448，附 why「功能性修复」+ 回滚值）② 给 R60 的 ADR 结构判据补两条反例夹具 ③ `expectRequiredFixtures` 推广 0/4 ④ **跑全链验收**（docs / size-caps / 93 段链 / guards-wired）。当前脏文件正是它的两处改动。
- **W3b**：ADR-032（python 开关姿态对齐，只写设计）。**原 W4 在探索阶段崩溃、零文件产出**，任务已转 W3。

## ⚠ 未解决的安全分叉（ADR-032 要回答）
python 闸门开关开启时仍放行 `cgnat/linkLocal/multicast/reserved/unspecified`，**含 AWS 元数据 `169.254.169.254`**；契约与 node/admin 均不放行；`tests/test_execute.py:3618` 把相反行为钉住 ⇒ **三端两种安全承诺**。属契约级变更 ⇒ 先 ADR 后实施（实施轮需 py 写域，届时重启 W4 或新建席位）。

## 待办
1. 收 W1 全链验收结果（**若链红用 `--only <k>` 定位根因，不许跳段/放宽**）。
2. 收 ADR-032 → 复核 → 排实施轮（需 python 写域 + 可能改 `test_execute.py:3618`，属破坏性 ⇒ 走 ADR 回滚路径）。
3. 未收口：真机脚本接链（需 CI postgres，本地无法验证 CI 真跑）；R18-B blocked；flaky 待复发取证；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；W5 遗留（服务端无 `reservedSlots<=running` 下限）；W3 遗留（残留行按 denied 结清，若要区分 superseded 需迁移+前端+UI）。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；断言必须能失败（恒真⇒变绿才算有牙）；文档断言命令形式而非关键词；改 `ci.yml` 后立刻 `guards-wired`；验收用链内同形式；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`；worker 只跑定向测试，全量/93 段链由 Lead 在无在途改动时串行跑。

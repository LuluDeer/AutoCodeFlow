# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · 守卫链 93 段 · **并行流水线 5 worker（人工指令）**
**会话**：第 61 轮 · 多轮并行产出累积中

## 并行拓扑与写域（互斥）
| 席位 | 写域 | 状态 |
|---|---|---|
| Lead | 状态卡+三台账+`source-size-baseline`+共享闸门 | 集成中 |
| W1 `guard-chain` | `scripts/**`、`package.json`、`ci.yml`、`docs/operations.md`、`docs/UPGRADING.md` | R60 在跑（ADR 断言接链） |
| W2 `web-worker` | `apps/admin-web/**` | R59-A/B **已提交** |
| W3 `api-worker` | `apps/admin-api/**`、`docs/adr/**` | ADR-031 已交；R60 在跑（修 :797/:782） |
| W4 `py-worker` | `apps/executor-python/**` | 在跑（parity pytest） |
| W5 `node-worker` | `apps/executor-node/**` | **已交付**（真缺陷已修） |

## 本轮并行交付（已入 HEAD）
1. **W3 → ADR-031**（`7385fd7d`）：`replayApproved` 在 `:359` 读、`:366` 决定 14 处 persist；但 `:797` 用 `verdict.approvedApprovalKey` **另一判据**推导 in_flight 写、且按**新 `call.id`** 更新 ⇒ **命中 0 行且不检查返回值**；`:782` 幂等闸同因失效 ⇒ 已批准写重提时**无 in_flight 行 + 原行永久 `awaiting_approval`**。**静态推断，待测试钉住**（已派 W3 做 characterization + 最小修复）。
2. **W2 → 计数矛盾提示**（`b764ab92`、`2fa2230b`）：新增 `hasInconsistentMetrics` + 详情页提示「已按 0 显示」；两侧断言（矛盾⇒提示 / 不矛盾⇒不提示）。
3. **W5 → 心跳上报自洽**（`d9a67536`）：**真缺陷** —— 旧实现只有**下界归一**（非整数/负数→0）、**上界敞开**，脏 provider（账本 0 自述 5）原样出网。修后 `0<=reserved<=running`；`scheduler.spec` **21 passed**，相邻 `pull|health` **50 passed**，`tsc --noEmit` 0；反向验证（退回透传）⇒ 2 条用例红。
4. **W1 → `expectRequiredFixtures()`**（`c535085d`）：把「加断言必须同步自检夹具」机检化（R49/R58 两次同型事故），删夹具第③条 ⇒ `--selftest` 点名失败；恒真改造 ⇒ 变绿（有牙）。

## Lead 本轮动作
- 因 W5 改了 `apps/executor-node/src/**`，已跑 `npm run digest:regen`（source-digest 回填；② 字节哈希待 CI）—— 结果见本轮输出。
- **未跑 93 段链**：W1/W3/W4 仍有在途改动，合并后统一跑一次（避免中途红噪声）。

## 待办（按序）
1. 收 W1/W3/W4 回执 → 逐路定向回归 → 合并后跑 **93 段链（链内同形式）+ `test:docs` + `size-caps`**。
2. W3 的 characterization test：**若旧实现是绿的** ⇒ ADR-031 §1.3 静态推断作废，立即停手并记录（比修不存在 bug 更重要）。
3. W5 遗留：预留⊆账本仍靠 `pull.ts` 调用顺序纪律维持；**服务端仍无 `reservedSlots<=running` 下限**（旧版/第三方执行器可发自相矛盾载荷）。
4. 未收口：真机脚本接链（需 CI postgres，本地无法验证 CI 真跑）；R18-B blocked；flaky 待复发取证；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；断言必须能失败（恒真⇒必须变绿才算有牙）；文档断言**命令形式**而非关键词；改 `ci.yml` 后立刻 `guards-wired`；验收用链内同形式；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。

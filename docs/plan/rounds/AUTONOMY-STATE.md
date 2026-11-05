# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD 以 `git log -1` 为准 · 守卫链 93 段 · **⚠ 当前为并行流水线模式（5 worker）**
**会话**：第 60 轮 · 58 轮累计产出 · 手册 `AUTONOMY-LOOP.md` §7 已修正（禁止冻结）

## ⬆ 编排升档（人工指令，覆盖默认 ≤1/≤3 档）
**理由**：用户两次指出「推进太慢」，明确要求流水线 + 多 agent ⇒ 由 1 teammate 升到 **5 个并行 worker**。
**代价与对策**：① 并发提交会撞 `index.lock` ⇒ 全体约定「sleep 2s 重试一次，禁 `add -A`/`reset`」；② 本机 swap 已满、全量测试会 SIGTERM ⇒ **worker 只跑定向测试**，全量/93 段链由 Lead 串行跑；③ 共享文件（`package.json`/`ci.yml`/`size-baseline`/台账）**只有 Lead 或 W1 能改**。

## 写域切分（互斥，违反即回滚）
| 席位 | 写域 | 当前任务 |
|---|---|---|
| Lead | `docs/plan/rounds/**`、三份台账、`scripts/source-size-baseline.json`、共享闸门 | 集成 + 验收 |
| W1 `guard-chain` | `scripts/**`、`package.json`、`ci.yml`、`docs/operations.md`、`docs/UPGRADING.md` | R59 已交付 |
| W2 `web-worker` | `apps/admin-web/**` | 计数自相矛盾的 UI 提示 |
| W3 `api-worker` | `apps/admin-api/**`、`docs/adr/**` | replay 决策前移 ADR |
| W4 `py-worker` | `apps/executor-python/**` | 元数据地址 parity pytest |
| W5 `node-worker` | `apps/executor-node/**` | 心跳上报自洽（0≤reserved≤running） |

## R59 结论（W1，完成，方案 b）
`scripts/lib/guard-selftest.mjs` 新增 **`expectRequiredFixtures(required, fixtureText)`**：必需项数组与自检夹具**逐条正则比对**。
- **红→绿**：删夹具第③条 ⇒ `--selftest` 非 0 并点名「夹具缺必需项 admin-api-full」→ 还原 **7/7 exit 0**；
- **反向验证**：把比对改成**恒真** ⇒ 该红用例变绿（证明有牙）；还原 ⇒ 再删即红；
- 段数仍 **93**（未新增守卫）；`guards:repo`/`docs`/`size-caps`/`guards-wired` 均 0。提交 `c535085d`。
- **遗留**：其余 **4 个**带 `REQUIRED_*` 的守卫尚未接入（每个几行）—— 是 W1 的下一刀。

## 集成待办（Lead，按轮推进）
1. 收 4 路回执 → **逐个**跑定向回归；W5 改动后需 `npm run digest:regen`（② 由 CI）。
2. 合并后跑一次 93 段链（链内同形式）+ `test:docs` + `size-caps`；任一项红先修再合。
3. 台账（PLAN-CLAIMS / HANDOFF / PLAYBOOK §7）由 Lead 统一写，避免并发覆盖。
4. W1 继续：把 `expectRequiredFixtures` 接入剩余 4 个守卫（每个都做「删夹具 ⇒ 红」）。
5. 未收口：真机脚本接链（需 CI postgres，本地无法验证 CI 真跑）；R18-B blocked；flaky 待复发取证；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维。

## 纪律（并行版）
- 只信「命令 + 真实 exit code」；未跑标 `unverified`；**不许用预期值冒充实测**。
- 断言要能失败（反向验证恒真/放宽 ⇒ 必须变绿）；文档里的命令要断言**命令形式**而非关键词。
- 改 `ci.yml` 后立刻 `check:guards-wired`；验收用**链内同形式**；`git add` 只用显式路径；禁 `pkill -f`。
- 教训累计至 (72)：**能被重复违反的纪律必须变成机器可检约束**（R59 已实证：助手取代台账文字）。

# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `5c7bab3a` · 工作区干净 · **R18-B 同一阻塞第 2 次未解（止损计数 2/3）**
**会话**：第 21 轮已收 · 19 轮产出（R01–R19，55 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；R19 如实报「第 2 次卡」且**不放宽判据**，做对了）

## R19 结论（**仍卡，但性质推进**）
- **已打通**：执行行**由生产代码创建** —— 真 API 四步 `POST /api/auth/login` → `POST /api/executors/register` → `POST /api/tasks`（复用 `scripts/demo-failure-seed.mjs` 的任务定义形状，**未自造 SQL**）→ `POST /api/tasks/:id/trigger`（200/201/201/201）；触发后 `task_executions` 计数 = **1**（`status=pending`、`executorId=NULL`）。
- **仍卡**：40s 内 `task_executions.executorId` **恒为 NULL** ⇒ 未走 `claimExecutorSlotForExecution`（`executor-dispatch-slot.collaborator.ts:105-118`）⇒ 本执行器在途恒 0 ⇒ **I1/I2/I3 不可判定**。三个候选原因**均未验证**：① 队列消费侧（BullMQ/leader cron）在本夹具未跑；② 缺 `targetExecutorId`/`appId` 使选机前置不满足（`executor.service.ts:4463` 的 `status: ONLINE` + Top-K）；③ 派发段另有闸。
- **判据守住了**：`inFlight===0 ⇒ 红`，`--rounds=1` **exit 1**；**未接**红门禁（用例未绿就接链只会逼人调松断言）⇒「删引用能红」本轮不适用（已标注）。
- 回归：定向 0 · `typecheck` 0 · `guards:repo`(89) 0 · `docs` 0 · `size-caps` 0 · `race-wired` 0 · `reserved-slots` 0 · `guard-harness` 16/16；容器 `acf-r18-*`/`acf-r19-*` 残留 0，`acf-*` 未动。
- 提交：`b1306c9c`（用例打通生产造行 + 诊断 + 保持红判据）+ `5c7bab3a`（台账）。

## 方法论沉淀
㊷ **「交错发生」+「判定对象存在」两关，缺一不可**（R18 的㊶是本轮的前半句）：本轮拿到了交错证据（`claim_at_ms=6ms < hb_ms=43654ms`）、也有了执行行，但**该执行器名下没有在途行** ⇒ 判定仍然无效。判据必须显式断言「我要压的那个东西现在真的存在」。

## 未收口（按优先级）
1. **R18-B（第 3 次 = 止损线）**：下一轮**只读定位**（查 `dispatch-decision-log` + BullMQ 队列深度），区分「消费侧没跑 / 选机前置不满足 / 派发闸拦下」；**若结论仍是"指派卡住" ⇒ 记 blocked 换靶，不再换造数方式**。
2. `rolloutBatchClaimId` CAS / `agent_approvals` consume 两个并发轴仍未压。
3. 结构性债务（**换靶首选**）：守卫框架 meta 改造（89 段庞大，`check-guards-wired.mjs:424-425` 字符串展开面）。
4. `executor-node` 侧 `.env` 约束（§7.4）；`check:desktop-bundle-drift` 字节哈希待 CI；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线。
5. §7.17 P3：越界态无「数据不一致」提示；§7.18 P3：心跳耗时 6–43s 的超时预算。

## 下轮第一步（R20）
1. `git log -1 --oneline` 确认 `5c7bab3a`（**自己跑**）；
2. **先只读定位（不写代码，本轮前半）**：查 `dispatch-decision-log`、BullMQ 队列深度/消费者状态、选机前置（`targetExecutorId`/`appId`/`status: ONLINE`），给出**唯一根因**；
3. **只有根因落在"夹具缺一步操作"时才允许动手**（如触发队列消费 / 补 `targetExecutorId`）；若根因是"派发段另有闸且夹具无法越过" ⇒ **立即 blocked 换靶**；
4. 换靶预案（已备）：**守卫框架 meta 改造** —— 目标 = 让 `test:guards:repo` 的 89 段 `&&` 链变成「运行期解析、逐条独立报告、失败即停且能点名」，判据 = 现状注入一个失败守卫，报告能点名且不再依赖链尾兜底；`check-guards-wired.mjs:424-425` 是落点。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、**交错≠判定有效（㊶㊷）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

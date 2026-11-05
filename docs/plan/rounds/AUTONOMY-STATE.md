# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `a008c76c` · 工作区干净 · 真机并发第 3 轴完成
**会话**：第 18 轮已收 · 16 轮产出（R01–R16，47 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（已崩 2 次：R08、R16，均成功 recover）

## R16 结论（完成）—— 超卖真机 20/20 复现并修掉
- **写语义（关键区分）**：心跳 = **客户端上报值直接覆盖写**（`executor-heartbeat-report.collaborator.ts:192-210` 只做 0..10000 校验 → `executor.service.ts` 心跳段 `pickOwnedColumns`+`update`）；派发 = **原子增量 + 容量谓词**（`executor-dispatch-slot.collaborator.ts:105-118`）；释放 = `GREATEST(count-1,0)`（`:238`）⇒ 典型 **lost update**。
- **不变量**：I1（心跳不得把已占坑数改小）**修前 20/20 违反**（最终计数 0 < 在途 2）→ **修后 0/20**；I3（容量判断被覆盖放行超额）1/20 → 0/20；I2（饥饿）本轮**未观测到**（如实记录）。
- **修法**：新增 `heartbeat-count.util.ts`（`max(客户端上报, 服务端在途占坑)` 纯函数），落库前取大 + WARN。**刻意不加 CAS** —— 加 CAS 会丢心跳 ⇒ stale sweep 误杀执行器。
- 判据：真机 `--rounds=20` **exit 1** → `--fixed` **exit 0**（20/20 零违反）；确定性 spec 5/5；回归 523/523 · `typecheck` 0 · `guards:repo`(88) 0 · `docs` 0 · `size-caps` 0 · `race-wired` 0（4 条真机用例在链内，删引用 exit 1）。
- **自曝（重要）**：它先修掉自己压测脚本两个**假绿**来源 —— `psql -tAc` 把 `UPDATE 0` 当成功、`spawnSync` 把并发压成串行；修完才从「6/6 假绿」变「20/20 真红」。
- 提交：`80e45a3b` + `915e25c8` + `a008c76c`。

## 方法论沉淀
㊴ **压测脚本本身也会假绿**：并发用例必须自证「并发真的发生了」（R11 的「反向次序」、R16 的「20/20 违反」都是这种自证）+ 「断言失败时真的会失败」（`UPDATE 0` 不算成功）。**先证明测试有牙，再证明代码没病。**

## 未收口（按优先级）
1. **`reservedSlots` 缺同一下限**（§7.15 P2）：它是客户端自述值、**将被派发闸消费** ⇒ 消费前必须先补「不低服务端在途」约束（与 R16 同一族缺陷，**下一个消费点就是超卖 2.0**）。
2. **全栈真机未做**（§7.15 P1）：R16 只压 SQL 层，协议层（鉴权/DTO/调度选机）未压。
3. 真机并发仍缺 2 轴：`rolloutBatchClaimId` CAS / `agent_approvals` consume。
4. `check:desktop-bundle-drift` 字节哈希待 CI；executor-node `.env` 约束；守卫框架 meta 改造；`UPGRADING.md` 头部基线；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维执行。

## 下轮第一步（R17 = 补同族下限，最便宜的高收益）
1. `git log -1 --oneline` 确认 `a008c76c`（**自己跑**）；
2. 立项 **`reserved-slots-floor`**：先核 `reservedSlots` 的写入点与**消费点**（谁读它做容量判断），再给「客户端上报值不低服务端在途」加下限；
3. 判据：确定性 spec 先红后绿（旧实现能把 `reservedSlots` 降到在途数以下 ⇒ 红）+ 若消费点已存在，加一条真机/集成断言「不超卖」；接链（删引用能红）；
4. 若核查发现 `reservedSlots` **目前没有任何消费点**：改为「加一条守卫断言：任何读取 `reservedSlots` 作容量判断的地方必须同时读在途下限」，或直接标注为已知限制 —— 但**不许默默不管**。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 8（上一轮用满，故本轮先补写本卡）。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、未复现如实写、**ADR 也会错（R15 已证）**、**压测也会假绿（R16 已证）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

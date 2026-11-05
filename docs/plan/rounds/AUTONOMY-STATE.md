# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `54f3446b` · 工作区干净 · R16 副作用已收（A），协议层并发卡在造执行行（B）
**会话**：第 20 轮已收 · 18 轮产出（R01–R18，53 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩过 2 次均 recover；R18 对卡点「两次后停手 + 不放宽判据」做对了）

## R18 结论（**部分完成**，两部分口径分开）
### A（完成）
- 展示口径 `runningTaskCount − reservedSlots` **可能为负** → 新增纯函数 `apps/admin-web/src/utils/executor-metrics.ts::resolveRunningCount`（`reservedSlots == null ⇒ occupied` 旧口径；否则 `max(occupied − reserved, 0)`）+ `hasMeaningfulReservation`；`ExecutorDetailPage.tsx` 两处改用。**只动展示、不动落库**（派发闸门仍只读 `runningTaskCount`）。
- 判据：helper 临时回退成直接相减 ⇒ **exit 1（2 条红）** → 恢复 **7/7 exit 0**；页面级 11/11；既有「越界」断言按新语义由 `1` 收紧为 `0`（理由写进用例）。

### B（未完成，卡点明确且**不放宽判据**）
- **已证明有效的部分**：真 docker PG/Redis + 真 admin-api + 真 HTTP —— 注册 201；**心跳协议面 10/10 轮 201**（鉴权→DTO→service→R16 在途下限→落库）；**交错 10/10 被证明**（`claim_at_ms≈5–6ms < hb_ms≈170–220ms`，逐轮打印）⇒ 「测试有牙」这一关**过了**。
- **卡点**：占坑必须伴随**执行行**（R16 下限读 `task_executions`），SQL 造行被 `task_executions` NOT NULL（`taskId`/`taskName`）+ `tasks` 外键挡住 ⇒ `claimed=0`。**两次尝试后停手**。
- **正确处理**：让脚本在 `claimed===0` 时**主动判红**（「未建模生产，结论无效」），**不接进** `check:race-selftests-wired`（红门禁接链只会逼人调松断言）；仅留 `npm run test:executor-protocol-layer-race` 诊断入口 ⇒ **"删引用能红"本轮不适用（未接线）**，已如实标注。
- 回归：admin 523/523 · web 页面级 11/11 · `typecheck`(api+web) 0 · `guards:repo`(89) 0 · `docs` 0 · `size-caps` 0（web 861→863，why 含回滚）· `race-wired` 0 · `reserved-slots` 0 · `guard-harness` 16/16（新脚本先被抓到漏接 `hermeticEnv`，已修）。
- 提交：`defa759c`(A) · `7afeee71`(B 骨架+卡点) · `93a34bfc`(棘轮+hermeticEnv+atlas) · `54f3446b`(台账)。

## 方法论沉淀
㊶ **「测试有牙」和「判定可信」是两关**：本轮证明并发真的交错发生了（第一关过），但被压的对象（占坑）根本没建出来 ⇒ 判定无意义。**判据要同时守住「交错真的发生」和「被压的东西真的存在」**，缺一个就会产出绿灯废话。

## 未收口（按优先级）
1. **B 做完**（§7.17 P1）：用**真 API** 建 application→task（或 CI seed 最小 task）拿到真实执行行，再并发心跳，把 I1/I2/I3 跑成可信判定；**不得放宽 `claimed===0` 判据**。
2. 「占坑已成 / 行未建」**中间态未验证**，可能漏算（§7.17 P2）。
3. 越界态无「数据不一致」提示（§7.17 P3，展示层）。
4. 真机并发仍缺 2 轴：`rolloutBatchClaimId` CAS / `agent_approvals` consume。
5. 结构性债务：守卫框架 meta 改造（89 段庞大，`check-guards-wired.mjs:424-425` 字符串展开面）、executor-node `.env` 约束、desktop-bundle-drift 字节哈希待 CI、`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维。

## 下轮第一步（R19）
1. `git log -1 --oneline` 确认 `54f3446b`（**自己跑**）；
2. **继续 B（同一阻塞第 1 次，未到止损）**：先解决「造真实执行行」——用真 API `POST /applications` → `POST /tasks` → 触发一次派发（或 CI seed 最小 task），拿到 `task_executions` 行后，再跑并发心跳 vs 占坑 10 轮，判定 I1/I2/I3；
3. 判据不得改松：`claimed===0` 仍然红；跑绿后**再**接进 `check:race-selftests-wired`（先绿再接线，避免红门禁逼人调松）；
4. **若这条路 3 轮内仍造不出执行行** ⇒ 记为 blocked，换靶到 §7.17 P2/P3 或结构性债务（守卫框架 meta 改造）。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、未复现如实写、ADR 也会错（R15）、压测会假绿（R16）、**交错发生了不等于判定有效（㊶）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

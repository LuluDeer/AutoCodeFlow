# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `963df5f8` · 工作区干净 · R16 同族缺陷已收口
**会话**：第 19 轮已收 · 17 轮产出（R01–R17，49 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩过 2 次 R08/R16，均 recover；每单元一提交已稳定）

## R17 结论（完成，**选路 B 是正确的**）
- **事实核查（写进 `reserved-slots-facts.md`）**：`reservedSlots` 写入点 **3 类**（心跳客户端上报覆盖写 `executor-heartbeat-report.collaborator.ts:313-332`，含 `reservedSlots > runningTaskCount` 自洽拒绝；重启清零 `executor.service.ts:3735-3737`；缺失基线清零 `:3750-3752`）；**消费点 8 处，逐个判定「会因客户端报小而超卖」= 全部否**；**容量判定面 0 处**（`executor-dispatch-*`/`block-strategy-gate`/`scheduler`/`task.service` 全无该列；实体注释 `:207` 与迁移 `1790000000039` 头注写死「派发闸门绝不读本列」）。
- **选路 B 的理由**：当前无消费点 ⇒ 加「在途下限」是**死代码**（没有一行会在意）；把「暂无消费点」这条**事实**变成判据更有价值 —— 将来谁新增消费点，守卫立刻红，强迫其当场回答「要不要补下限」。
- **守卫**：新增 `check-reserved-slots-consumer`（容量面零容忍 / 未登记读者红 / 写入自洽约束与设计注释不许消失 / **全仓零命中也是红**），6/6 selftest，接进 `guards:repo` **89 段** + CI。
- **判据**：注入假消费点（拿 `reservedSlots` 算可用槽位）⇒ **exit 1** 报「是容量判定面却读了 reservedSlots」；删除 ⇒ exit 0；**删接线能红**（未挂 CI 时 `check:guards-wired` 报「有自检却没被 CI 执行」）。
- 回归：定向 523/523 · `typecheck` 0 · `guards:repo`(89) 0 · `docs` 0 · `size-caps` 0 · `race-wired` 0 · `guards-wired` 0（79 个 check-* 全被 CI 执行）；真机 `unverified`（纯静态守卫 + 事实核查）。
- 提交：`82bb459a`(守卫+接线+CI+事实) + `963df5f8`(台账)。

## 未收口（按优先级）
1. **R16 修复的展示副作用**（§7.16 P2）：展示口径 `runningTaskCount − reservedSlots` 现在**可能为负**，需 clamp ≥0 或改以 `runningTaskCount` 为准 + 展示层单测。**小但真实**。
2. **消费点将来出现时的正确姿势**（§7.16 P1）：不能只登记 `KNOWN_READERS`，必须同时补在途下限，并把容量面判据升级为「该文件必须引用 `resolveHeartbeatRunningTaskCount`」。
3. **全栈真机未做**（§7.15 P1）：R16/R17 都停在 SQL/静态层，协议层（鉴权/DTO/调度选机）未压。
4. 真机并发仍缺 2 轴：`rolloutBatchClaimId` CAS / `agent_approvals` consume。
5. `check:desktop-bundle-drift` 字节哈希待 CI；executor-node `.env` 约束；守卫框架 meta 改造（89 段已相当庞大，`check-guards-wired.mjs:424-425` 的字符串展开面）；`UPGRADING.md` 头部基线；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维执行。

## 下轮第一步（R18）
1. `git log -1 --oneline` 确认 `963df5f8`（**自己跑**）；
2. 立项 **`heartbeat-display-clamp` + 全栈协议层并发**（一件一轮里可以合并，因为同源）：
   - **A（必做，小）**：展示口径 clamp ≥0 + 单测（红→绿：构造 `reservedSlots > runningTaskCount` 的合法现状 ⇒ 旧实现输出负数 exit 1）；
   - **B（主靶）**：起 admin-api + 执行器 stub，并发 `POST /executors/heartbeat` 与真调度派发 **N≥10 轮**，复用 R16 的 I1/I2/I3 —— 这是 §7.15 P1 的协议层验证；
   - 若 B 因环境阻塞（stub 难造），**只做 A 并如实报 B 未做**，不许把 SQL 层结果冒充协议层。
3. R19 起建议换到**结构性债务**（守卫框架 meta 改造或 executor-node `.env`），避免并发轴边际收益递减后仍在原地。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、未复现如实写、ADR 也会错（R15）、压测也会假绿（R16）。
- 新增教训㊵：**"加防护"不一定是对的答案** —— 当消费点不存在时，正确的交付是「把事实钉成判据（守卫）」，而不是写一段没人会执行的下限代码。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

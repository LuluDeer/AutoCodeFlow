# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `538068ff` · 工作区仅剩本轮 Lead 的 `AUTONOMY-LOOP.md` 改动（随本卡一起提交）
**会话**：第 7 轮已收 · 6 个增量轮（R01–R06，13 提交）· 手册已修正「冻结」条款
**teammate**：`guard-chain`（熟栈，续跑即可，别新开）

## ⚠ 本轮最重要的事：一次设计错误被纠正
上一轮我写了「pause 被拒就冻结会话」的兜底 —— **那是错的**：pause 不可用 ⇒ 冻结 = 之后每轮零产出 = 永久空转，与「无人值守推进」直接冲突。已在手册 §7 改为「**用交接版状态卡代替新会话**」：交接做满 + 继续按原纪律产出增量（每轮 ≤8 调用、不读代码/测试输出/diff）。
教训 ㉟：**兜底机制不可用时要降级，不能升格成停摆**；引入任何「停止产出」的规则前先问：它会不会在无人干预时永久生效。

## R06 结论（完成）
- **缺陷**：R05 收口执行器出站姿态后，`docs/UPGRADING.md` §9 仍称「破坏性变更 — 无」⇒ **裸机/自建拓扑（admin 与执行器同内网）+ 同机回环执行器**升级后**静默**失去全部派发能力（注册/心跳正常、派发全失败）。
- **改动**：`UPGRADING.md` 新增 **§11**（4 类部署逐类结论 / 两条实测症状 / 两条修法：内网→开开关、同机回环→换内网地址或独立机器「开关救不了回环」/ 自查命令 / 回滚 `fbd85d26`）+ §9 口径修正；新增 `apps/admin-api/src/config/executor-posture.ts` 启动期**可操作告警**（模块顶层接线，不撑大 `bootstrap()`）+ spec 4/4；新增守卫 `scripts/check-upgrade-notes.mjs`（selftest 6/6 + 4 条机读判据，已进 `test:guards:repo` 与 `ci.yml`）。
- **判据红→绿**：`node scripts/check-upgrade-notes.mjs` **exit 1**（缺 §11 / 症状非实测行 / §9 仍称无 / `main.ts` 未接线）→ `npm run check:upgrade-notes` **exit 0**。
- **验证**：`test:docs` 0 · `guards:repo` **86 段** 0（1,446 ✔）· `size-caps` 0（main.ts 278→281，why 已写）· `check:guards-wired` 0 · `check:workflow-yaml` 0 · `typecheck:api` 0 · admin-api 定向 17 suites/199 tests 0。真机：本轮不需要；派发侧沿用 R05。

## 未收口（按优先级）
1. **`webhook-posture-cgnat`**：`policy:'webhook'` 姿态仍把 `restricted` 放在「开关开启才放行」组（§7.1，同族第二处）。**顺序：先立 webhook 面契约，再改实现** —— 别再犯 R05 那种「实现先动、契约后补」的错。
2. `docs/UPGRADING.md` 头部「核实基线」仍是 2026-11-02 的 commit，发版前刷新（不阻塞）。
3. executor-node 侧 `.env` 加载未同等约束（§7.4 P2）；守卫框架 meta-改造（§7.2 P2，`check-guards-wired.mjs:424-425`）。
4. 真机债：接管 CAS 并发 / 灰度 × 部分唯一索引 / agent 域 23505 归因 / firepoint 步骤 7。

## 下轮第一步
1. `git log -1 --oneline && git status --short`（预期 `538068ff` + 本卡提交、干净）；
2. 立项 `webhook-posture-cgnat`：**先写契约差异说明**（`policy:'webhook'` 下 `restricted` 该不该随开关放行？给出与 node/python 的对照），契约确定后再改实现；判据 = 四向 `check:protocol-three-way` exit 0 且 selftest 净增 + 该姿态的 deny-matrix 断言红→绿；
3. `send_message` 到 `guard-chain` 续跑。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本会话各轮实测：9 / 7 / 7 / 8 / 8 / 2 / 6。
- **只信命令 + 真实 exit code**；回执也会给错归因（R01→R02 已证）。
- 未跑标 `unverified`；`git add` 只用显式路径，禁 `-A`。

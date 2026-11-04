# AUTONOMY-STATE — 状态卡（≤40 行）

**会话**：第 5 轮已收 · HEAD `fbd85d26` · 工作区干净 · 手册 `AUTONOMY-LOOP.md`
**累计**：R01 CGNAT · R02 守卫链报告面 · R03 灰度租约空窗 · R04 自检 hermeticity · R05 协议两格四方对齐
**⚠ 下一轮（第 6 轮）= 收尾轮**（轮换闸：会话轮数 ≥6）：只做交接，不加新增量，然后 `goal pause`。
**teammate**：`guard-chain`（熟栈，续跑即可，别新开）

## R05 结论（完成，含**真机**验证）

- **哪一侧错 = 实现侧**：`safe-http.util.ts` 的 `allowedExecutor` 是 `private-lan` **恒放行** + 开关解锁 **loopback**，与契约 `privateIPv4.allowedUnderPrivateNetwork=true` / `loopback=false` 相反；node/python 与契约一致 ⇒ admin 唯一离群者。**次生**：smoke B4/B5 把「开关放通 loopback」写死（把被测行为当成语义）。
- **判据红→绿**：`ssrf-deny-matrix` **exit 1**（3 条断言红）→ **exit 0（17/17）**；`check:protocol-three-way` exit 0，selftest **20 → 22**；四向「5 格不一致 → 0 格」，allowlist **2 条 → 0 条**。
- **真机**：docker 实跑 `verify-smoke-dispatch-push` => **exit 0，PASS=84/FAIL=0**（B4 七条 + B5 八条；私网地址无开关⇒监听器 0 次+已拒绝；同址开开关⇒1 次+RUNNING）。
- 回归：`test:api` 460 suites/7,904 exit 0、`guards:repo`(85)、`test:docs`、`size-caps`、`ssrf-parity` 全 exit 0。

## ⚠ 必须公告的行为变更（R05 引入，未进 UPGRADING）

1. 内网执行器现在**必须显式** `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`（compose 默认栈已开）；
2. **同机 `127.0.0.1` 执行器不再可用**（契约「打自己回环没有合法拓扑」）—— 对已有自托管部署是破坏性变更，**`docs/UPGRADING.md` 缺此段**（§7.5 P1）。

## 未收口（按优先级）

1. **`docs/UPGRADING.md` 升级段 + 一条升级回归用例**（§7.5 P1）—— R05 的破坏性变更还没对外交代，**这是账上最脏的一笔**。
2. `policy:'webhook'` 姿态仍把 `restricted` 放开关组（§7.1，同族第二处；下轮候选 `webhook-posture-cgnat`）。
3. executor-node 侧 `.env` 加载未同等约束（§7.4 P2）；133 键二分（可选）。
4. 守卫框架 meta-改造（§7.2 P2，`check-guards-wired.mjs:424-425`）。
5. 真机债未碰：接管 CAS 并发 / 灰度 × 部分唯一索引 / agent 域 23505 归因 / firepoint 步骤 7。

## 下轮 = 收尾轮，只做三件

1. `git log -1 --oneline && git status --short`（预期 `fbd85d26`、干净）+ 读 `artifacts/autonomy/R05/receipt.md`；
2. **只做交接**：确认本卡「下轮第一步」可直接执行、`docs/PLAN-CLAIMS.md` / `AGENT_HANDOFF.md` / `PLAYBOOK §7` 三处台账与 HEAD 一致；
3. `goal pause` + 3 行交接结论 + 提示开新会话（新会话从「UPGRADING.md 升级段」起手）。

## 纪律速记

- 主会话 ≤8 次工具调用/轮；不读代码/完整测试输出/diff。本轮各轮实测：9(超1) / 7 / 7 / 8 / 8。
- **只信 `命令 + 真实 exit code`**；回执也会给错归因（R01→R02 已证），关键结论交叉复核。
- 未跑标 `unverified`；`git add` 只用显式路径，禁 `-A`。
- 同一阻塞连续 3 轮 → blocked；验证失败 2 次 → 回滚。

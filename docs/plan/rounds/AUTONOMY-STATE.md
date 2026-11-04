# AUTONOMY-STATE — 状态卡（≤40 行）

**会话**：第 3 轮已收 · HEAD `cec992f4` · 工作区干净 · 手册 `AUTONOMY-LOOP.md`
**累计**：R01 `49345111` CGNAT · R02 `a59ea83f` 守卫链报告面 · R03 `cec992f4` 灰度租约空窗
**teammate**：`guard-chain`（熟栈，续跑即可，别新开）

## R03 结论（部分完成：主靶绿，前置债未清）

- **修掉**：批次创建先 `PENDING`+`batchId` 再排 5s tick，**租约只在 tick 里写** ⇒ 最多 5s 空窗内，另一实例每 30s 的回收器按「`batchId` 行租约都过期」把**活批次整批判死**（`app-deployment-rollout.collaborator.ts:699-706`、`:30`、`:1623`、`:1663`/`:1683-1705`）。修法：创建期即写租约（函数体 +1 行）。
- **判据红→绿**：`-t R03` 新用例 `Received: undefined` **exit 1** → `app-deployment.rollout` 4 suites/64 tests **exit 0**；真机 `test:arch31-rollout` **23 通过/1 失败 → 24/0 exit 0**。
- **未删账**：`test:guards:selftests` 本机仍 **exit 1**，红点前移到 `test:pull-dispatch` ④⑤（401），根因是 `apps/admin-api/.env` 符号链接让 20+ 自检吃到本机 `EXECUTOR_SECRET`（CI 绿/本机红）。**移开符号链接后 21 套件全绿 exit 0** —— 这是 R02 unverified 的真答案，已写 §7.3。
- R03 顺带把 R02 两处 `unverified` 改写成实测结论。

## 未收口（按优先级）

1. **P1 `selftest-env-hermeticity`**：给 `ConfigModule.forRoot` 加 hermetic 开关 + 自检接线，让本地全链可信（§7.3，修法三选一已备）。**不修则每一轮的本机验证都不可信。**
2. P1 两格 `loopback@on`/`privateIPv4@off`：真阻碍是 `verify-smoke-dispatch-push.sh:27,60,701-750` 把「开关放通 loopback」写成期望（与契约相反）+ compose/.env 默认值。
3. 守卫框架 meta-改造（§7.2 P2，`check-guards-wired.mjs:424-425` 字符串展开面）。
4. `policy:"webhook"` 仍随开关放行 `restricted`（§7.1）。
5. 真机债：接管 CAS 并发 / 灰度 × 部分唯一索引 / agent 域 23505 归因 / firepoint 步骤 7。

## 下轮第一步（新会话照做）

1. `git log -1 --oneline && git status --short`（预期 `cec992f4`、干净）；
2. **打 P1 hermeticity**：立项 `selftest-env-hermeticity`，判据 = 「移开 `.env` 符号链接前后 `test:guards:selftests` 结果一致」+ 21 套件全绿；回滚 = 单文件还原；
3. 完成后才取 P1 两格（顺序不可颠倒：hermeticity 是后面所有验证的地基）；
4. 全程 `send_message` 到 `guard-chain` 续跑。

## 纪律速记

- 主会话 ≤8 次工具调用/轮；不读代码/完整测试输出/diff。R01 9 次（bootstrap 超 1）、R02 7、R03 7。
- **只信 `命令 + 真实 exit code`**；回执也会给错归因（R01→R02 已证），关键结论交叉复核。
- 未跑标 `unverified`；`git add` 只用显式路径，禁 `-A`。
- 同一阻塞连续 3 轮 → blocked；验证失败 2 次 → 回滚；轮数 ≥6 或已被压缩 → 收尾轮。

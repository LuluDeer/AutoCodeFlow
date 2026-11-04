# AUTONOMY-STATE — 状态卡（≤40 行）

**会话**：第 2 轮已收 · HEAD `a59ea83f` · 工作区干净 · 循环手册 `AUTONOMY-LOOP.md`
**累计**：R01 `49345111`（CGNAT 安全修复）· R02 `a59ea83f`（守卫链报告面）

## R02 结论（已结项，独立复核过）

- **主靶**：`test:guards:repo` 中断时尾部仍打 ✔（报告面说谎）。根因 `scripts/docs/check-docs.mjs:413-440` 旧 `main()` 无终态摘要 + 85 段 `&&` 链（`package.json:110`）不交代断点。
- **⚠ 重要纠错**：R01 归因「守卫链报告成功」**不准确** —— 退出码实测一直是 1，坏的只是**可见尾部**。台账已按此更正。
- **改动**：`check-docs.mjs` 报告契约（通过先打/失败后打/终态收尾 + `--root=` 测试注入）、新增 `scripts/guard-chain-fail.mjs`（链尾 ✘ 兜底，退出码原样传播）、新增 `scripts/guards-repo-report.mjs`（`test:guards:repo:report` 逐条 `[exit N]`）、`check-docs.selftest.mjs` +3 黑盒用例、`docs/plan/rounds/README.md` 索引表。
- **判据（红→绿）**：`check-docs.selftest` 旧码 exit 1（33 过/3 红）→ 新码 exit 0（36/36）；临时孤儿文档 ⇒ 整链 exit 1 且尾行 ✘；中段注入 `exit(9)` ⇒ 链 exit 9 且尾行 ✘。
- **主会话独立复核**：`npm run test:docs` => **exit 0**（本次实跑）。守卫全链 85/85 `[exit 0]` 由 verify.log 记录，未在 Lead 侧重跑。

## 未收口 / 未验证

1. `test:guards:selftests` **未跑 ⇒ unverified**（R02 遗留）。
2. 链仍是扁平 85 段 `&&`，原生逐条计数需先改造 `scripts/check-guards-wired.mjs:424-425` 字符串展开面（PLAYBOOK §7.2 P2）。
3. `policy:"webhook"` 姿态仍随开关放行 `restricted`（§7.1，不可借 cgnat 销账）。
4. 真机债：接管 CAS 并发 / 灰度 × 部分唯一索引 / agent 域 23505 归因 / firepoint 步骤 7 / `r5-dispatch*`。

## 下轮第一步（新会话照做）

1. `git log -1 --oneline && git status --short` 确认基线 = `a59ea83f` 且干净；
2. 读 `artifacts/autonomy/R02/verify.log` 尾部的 `test:guards:selftests` 段，**先补跑它取真实 exit code**（把 R02 的 unverified 削掉）；
3. 然后取 P1 两格 `loopback@on` / `privateIPv4@off`（需 compose/.env 默认值 + 真机 B4/B5 同批）；若要动守卫框架，走 §7.2 meta-守卫改造并单独立项；
4. **复用 teammate `guard-chain`**（`send_message` 到它，别新开）—— 它已熟 R01/R02 的栈内上下文。

## 纪律速记

- 主会话 ≤8 次工具调用/轮；不读代码、完整测试输出、diff。R01 实测 9（bootstrap 超 1）、R02 实测 7。
- 只信 `命令 + 真实 exit code`；未跑标 `unverified`。**R02 已证明「别人的回执也可能是错的归因」—— 关键结论要交叉复核。**
- `git add` 只用显式路径，禁 `-A`。
- 同一阻塞连续 3 轮 → blocked；验证失败 2 次 → 回滚；轮数 ≥6 或已被压缩 → 收尾轮。

# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `9ce83cba` · 工作区干净
**会话**：第 11 轮已收 · 10 轮产出（R01–R10，26 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（每单元一提交纪律已生效）

## R10 结论（完成）—— 「三端同读」从间接保证变成守门判据
- **做法**：地址清单取自契约 `networkPolicy`（`addresses.*.examples` + `metadataAddresses` = **25 个 IP 字面量**），判定由 `scripts/ssrf-category-matrix.mjs` **真跑三端实现**导出（admin/node 用各自 `ts-node/register`，python 用裸 `python3`）。**旧守卫保留并存**：旧抓「清单漏项」，新抓「判定漂移」—— R09 的 `192.0.0.192`（清单都在、判定差一类 ⇒ 全绿却四姿态放行）正**只有新守卫**抓得到。
- **反向验证（关键）**：注入 python 偏差 ⇒ **exit 1** 且点名 `100.100.100.200: admin=reserved/node=reserved/python=public`；还原 ⇒ **exit 0**，零豁免。⇒ 守卫**有牙**，不是恒绿门禁。
- **验证**：新守卫 selftest 3/3 · `three-way` 25/25 · `parity`/`protocol-sync`/`guards:repo`(86)/`docs`/`size-caps`/`upgrade-notes`/`typecheck:api` 全 0 · 三端单测 admin 75/75、node 40/40、python 全量 0；真机 `unverified`（纯新增守卫）。
- 提交：`d5634f07`（核心 4 文件）+ `9ce83cba`（台账）。

## ⚠ 换轴声明（升档/换靶理由，按手册要求写在此）
R01–R10 全部吃 **SSRF / 契约 / 守卫**这条线，边际收益已递减（R09+R10 都在守同一件事）。**R11 起换轴到「真机债」**：契约与守卫已足够硬，但**运行时并发正确性从未在真机上被验证过**，这是当前项目长期健康的更大风险面。编排仍为 **1 个 teammate**（无升档），因为真机实验需要独占 docker 栈。

## 未收口（按优先级）
1. **真机债（R11 起）**：接管 CAS 并发 —— R32-C5/C6 的 fail-closed 与接管 CAS 误判会导致「执行器永久 409」或「覆盖别人的行」；历史记录明确「未在真机并发触发」。
2. 灰度 × 部分唯一索引未真机；agent 域 23505 按约束名归因未开始。
3. `check:desktop-bundle-drift` 字节哈希待 CI 回填。
4. executor-node `.env` 约束（§7.4 P2）、守卫框架 meta 改造（§7.2 P2）、`UPGRADING.md` 头部基线刷新。
5. §7.9 P2：SSRF 矩阵扩到**闸层**（同地址同放行结论），非紧急。

## 下轮第一步（R11 = 换轴第一轮）
1. `git log -1 --oneline` 确认 `9ce83cba`（**自己跑，别信叙述里的 sha**）；
2. 立项 **`takeover-cas-race`（真机）**：判据 = 用真 docker 栈制造 **两个实例并发注册同一 executor 身份**，断言「恰好一行被接管、另一请求得到明确 409/或拿到自己的行，且**不出现**永久 409 与跨行覆盖」；红 = 现状下能复现竞态（贴证据），绿 = 修复后 N 次重复全稳；
3. 跑不了 docker 就**立刻换靶**（不许硬等），改做 §7.4 executor-node `.env` 约束（纯单测可判）。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因（R01→R02）、我会错摘要（㊱）、别编 sha（㊲）。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

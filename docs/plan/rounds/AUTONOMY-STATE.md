# AUTONOMY-STATE — 状态卡（≤40 行）· **本卡尚未提交（下轮第一个动作：commit）**

**基线**：HEAD `341c664a` · 工作区仅本卡未提交
**会话**：第 9 轮已收 · 8 轮产出（R01–R08，19 提交）· 手册 §7 已修正
**teammate**：`guard-chain`（R08 中途崩过一次，已 recover）

## R08 结论（完成）—— 裁决②落地：云元数据地址恒拒
- **ADR**：`docs/adr/adr-029-metadata-addresses-outbound-deny.md`
- **契约**：`networkPolicy.metadataAddresses = {addresses:["100.100.100.200/32"], enforcement:"deny-before-classification"}`
  语义 = **任何 posture × 任何开关都 DENY**、**判定先于风险分类**；协议版本不 bump。
- **三端同读**：都从同一份生成物派生（`packages/executor-protocol/protocol.json` → `scripts/generate-executor-protocol.mjs` → 三份生成物），非各抄常量。
- **判据红→绿**：`ssrf-deny-matrix` **exit 1**（`✕ webhook 姿态：开关开启也拒（R07 裁决点）`）→ **exit 0（72/72）**；`three-way` exit 0、selftest **22→24**、四向 0 格不一致。
- **验证**：`guards:repo`(86) 0 · `docs` 0 · `size-caps` 0 · `upgrade-notes` 0 · 三端单测 admin 72/72、node 38/38、python 全量 0（覆盖 87.46%）；真机 `unverified`（不涉容器，webhook 面无 smoke）。

## ⚠ 本轮的教训（我自己的错，必须记）
㊱ **截断的证据不能用来下判断**：我用 `git status --short | head -8` 看到「没有 ADR、没改 protocol.json」，就断定子代理漏了闸门 —— 实际 ADR 05:43 就写了、契约段也在，只是排在第 9 行之后。⇒ **摘要被截断时必须标「列表已截断」，不许据此发指令**（这次差点让子代理回滚掉一整套已到绿的改动）。

## 未收口（按优先级）
1. **`check:ssrf-deny-parity` 只比对两端（admin↔node），python 面缺失** ⇒ 「三端同读」目前靠「同一生成物 + python pytest」间接保证，不是守门判据（§7.7 P1）。
2. **R09 候选 = `192.0.0.192`（Oracle 元数据）被判 `public` ⇒ 四姿态全放行**（完全不受开关约束，比 R07 那个更硬）。
3. `check:desktop-bundle-drift` 的字节哈希待 CI 回填。
4. executor-node `.env` 约束、守卫框架 meta 改造、`UPGRADING.md` 头部基线刷新。
5. 真机债：接管 CAS 并发 / 灰度 × 部分唯一索引 / 23505 归因 / firepoint 步骤 7。

## 下轮第一步（R09）
1. 先 `git add docs/plan/rounds/AUTONOMY-STATE.md` + commit（本卡）；
2. 立项 **`192.0.0.192` 误判**：与 R08 同一套契约机制（`metadataAddresses` / reserved 分类），判据 = 断言 `classifyAddressRisk("192.0.0.192")` ≠ `public`，先写断言跑红 → 三端修 → 绿；**注意 `192.0.0.0/24` 部分地址属合法保留用途，逐地址核对 IANA**，别整段拉黑；
3. 顺手把 python 面并入 `check:ssrf-deny-parity`（若同批成本低，合并做；否则 R10）。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 8（其中一次是自己踩的坑）。
- **只信命令 + 真实 exit code**；回执会给错归因、我会给错摘要 —— **双向都要复核**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`。

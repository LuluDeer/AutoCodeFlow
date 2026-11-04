# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `ff9c491e` · 工作区干净
**会话**：第 10 轮已收 · 9 轮产出（R01–R09，22 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（R08 崩过一次已 recover；R09 起改为「每单元一提交」）

## R09 结论（完成）—— 拒绝清单漏项
- **缺陷**：`192.0.0.192`（Oracle Cloud 元数据）判 `public`（node `null` / python `None`）⇒ **四姿态（webhook off/on、executor off/on）全放行**，完全不受开关约束 —— 比 R07 那条更硬。
- **IANA 事实先核后改**：`192.0.0.0/24` = IETF Protocol Assignments（RFC 6890 §2.1），整段 Globally Reachable = False + 脚注「不更具体登记即不可用」；`192.0.0.192` 不在任何例外里 ⇒ 应拒。**段内 5 条合法例外核对后不动**（`192.0.0.0/29`、`.8`、`.9`、`.10`、`.170/31`）。
- **机制复用**：`metadataAddresses.addresses` 扩 `192.0.0.192/32`；分类层同步收口（admin `classifyAddressRisk` / node `classifyRestrictedIpv4` → `reserved`），理由写进 ADR-029 §7；**不新开枚举、不整段拒 /24**。
- **判据红→绿**：`ssrf-deny-matrix` **exit 1**（3 条断言红）→ **exit 0（75/75）**；`three-way` exit 0、selftest **24→25**、四向 0 格不一致。
- **验证**：`guards:repo`(86) 0 · `docs` 0 · `size-caps` 0 · `upgrade-notes` 0 · `protocol-sync` 0 · 三端单测 admin 75/75、node 40/40、python 全量 0（87.46%）；真机 `unverified`（纯分类/契约扩项）。
- 提交：`ff201da7`（核心 16 文件）+ `ff9c491e`（台账）。

## 我自己的教训
㊲ **不许编造 sha**：R09 派发时我在任务里写了「HEAD `d8a3b1`」，那是编的（真实是 `ea12ec41`）。正确做法：**要么先跑 `git log -1` 拿到真值，要么写「以你本地 `git log -1` 为准」** —— 编一个像样的 sha 会让子代理在错误的基线上做判断。

## 未收口（按优先级）
1. **`check:ssrf-deny-parity` 仍只比 admin↔node，python 面缺失**（§7.8 P1）：目前靠 R09 新增的「三端覆盖」判据在 `three-way` 里间接盯。**彻底收口 = 建 python parity 清单 + 守卫改三端矩阵比对 + 反向豁免机制**。
2. `check:desktop-bundle-drift` 字节哈希待 CI 回填。
3. executor-node `.env` 约束（§7.4 P2）、守卫框架 meta 改造（§7.2 P2）、`UPGRADING.md` 头部基线刷新。
4. 真机债：接管 CAS 并发 / 灰度 × 部分唯一索引 / agent 域 23505 归因 / firepoint 步骤 7。
5. 【方向提醒】R01–R09 主要吃的是 SSRF/契约这条线。**R10 收口 parity 后应换轴**（真机债或结构性债务），避免单轴收益递减。

## 下轮第一步（R10）
1. `git log -1 --oneline` 确认 `ff9c491e`（**别信我写的历史 sha，自己跑**）；
2. 立项 **`parity-python`**：给 `check:ssrf-deny-parity` 建 python parity 清单，守卫改**三端矩阵比对**（含反向豁免机制的判据），判据 = 先在 python 面注入一个已知偏差能红（反向验证守卫真的有牙）→ 修/还原后绿；并保证 `guards:repo`(86) / `three-way` / `protocol-sync` 仍 0；
3. R11 起换轴（建议：真机债「接管 CAS 并发」或「灰度 × 部分唯一索引」，需 docker）。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`。

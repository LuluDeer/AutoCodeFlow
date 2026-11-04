# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `f9ef9167` · 工作区干净
**会话**：第 8 轮已收 · 7 轮产出（R01–R07）· R07 = 契约矛盾，**Lead 已裁决**
**teammate**：`guard-chain`（熟栈，续跑即可）

## ✅ R07 裁决（Lead，本轮定）：选方案②——契约新增 `metadataAddresses`
**理由（三条，按权重）**：
1. **安全承诺不能降级**（排除③）：「云元数据恒拒」是文档对用户的承诺，改文档去凑实现，是把漏洞合法化。
2. **不能打断合法用户**（排除①）：webhook 面 `restricted` 恒拒会连带打死 Tailscale `100.64/10` 目标，属无公告破坏。
3. **②最接近已存在的设计意图**：执行器面与 git 面**已**恒拒 restricted，②把它们真正要的东西（元数据地址）从 `restricted` 里拆出来单列，语义更准、三端可同读、`check:ssrf-deny-parity` 能咬住。
**代价（如实记）**：需改契约 `protocol.json` + 三端分类器 + 契约文档；属**契约变更**，必须先写 ADR（含回滚路径）。
**落地路径**：`artifacts/autonomy/R07/contract-first.md` 附录已备 —— 先契约段 `metadataAddresses` → 三端同读 → parity 判据 → 文档。

## 附带发现（独立立项，R09 候选，别和 ② 混做）
`192.0.0.192`（Oracle 元数据）被判 **`public`** ⇒ **四姿态全放行**（含 R05 已对齐的执行器面），与契约「`reserved` = IANA special-purpose」口径不一致 ⇒ 三端分类器需同批修正。**这是比 ② 更硬的洞**（② 至少还受开关约束，这条完全不受约束）。

## R07 事实（已核）
- 契约矛盾：`docs/deployment.md:197-199` + `docs/api-reference.md:1021` + `safe-http.util.ts:44-52` docstring 同时写「restricted 随开关放行」与「云元数据恒拒」，而 `classifyAddressRisk("100.100.100.200")` 实测 = `restricted`，webhook 开关一开即 `allow`。
- admin 三姿态：执行器面（`safe-http.util.ts:104-107`）与 git 面（`:707+`）已恒拒，只有 webhook 面（`:90-93`/`:394-399`）随开关。
- node/python **无** webhook 姿态（只有执行器出站面）⇒ 无参考实现。
- 验证：`three-way` exit 0（selftest 22/22、四向 0 格不一致）· `guards:repo`(86) 0 · `docs` 0 · `size-caps` 0 · `ssrf-parity` 0；真机 `unverified`（零变更）。

## 下轮第一步（R08 = 落地裁决 ②）
1. `git log -1 --oneline` 确认 `f9ef9167`；
2. **先写 ADR**（`docs/adr/` 新增：`metadataAddresses` 契约段 + 三端同读 + 影响面 + 回滚路径 `git revert`），**没 ADR 不动契约**；
3. 再改：`protocol.json` 契约段 → 三端分类器 → `check:ssrf-deny-parity` 判据（红→绿：先加断言，旧三端必红）→ 文档（`deployment.md`/`api-reference.md`/`safe-http.util.ts` docstring）→ 若构成行为变更补 `UPGRADING` 段（`check:upgrade-notes` 会咬）；
4. `send_message` 到 `guard-chain` 续跑。

## 未收口
1. R08 = ② 落地（ADR 先行）；2. R09 候选 = `192.0.0.192` 误判 public（更硬）；3. `UPGRADING.md` 头部核实基线待刷新；4. executor-node `.env` 约束、守卫框架 meta 改造；5. 真机债：接管 CAS 并发 / 灰度 × 部分唯一索引 / 23505 归因 / firepoint 步骤 7。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执也会给错归因（R01→R02 已证）；**契约类问题由 Lead 裁决，不许子代理发明语义**。
- 未跑标 `unverified`；`git add` 只用显式路径，禁 `-A`。

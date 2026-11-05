# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `633d42df` · 工作区干净 · 守卫框架 meta 改造**收口**（旧链已退役）
**会话**：第 24 轮已收 · 22 轮产出（R01–R22，60 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；已多次自纠假绿/假证据）

## R22 结论（完成）—— 89 段 `&&` 链 → 矩阵入口
- **(a) 一致**：`npm run test:guards:repo` ⇒ **exit 0**，输出 **89 条 `[k/89]`**；与 `:matrix` **同一脚本**；末行自证「解析 89 / 执行 89 / diff 空」。
- **(b) banner 统一**：`guard-chain-fail.mjs` **已 `git rm` 退役**，职责并入矩阵入口（失败即停 + `✘ 第 k/N 条失败` + 退出码原样传播）⇒ **只剩一套失败文案**。连带 `test:docs` 的「裸路径指针」判据抓到 3 个台账文件 **7 处**引用已删文件 ⇒ 已改并复跑 0（**守卫当安全网的实证**）。
- **(c) CI**：`git diff --stat ci.yml` **为空** —— CI 本就无整链步骤，替换后**也不新增**矩阵步骤（否则守卫面跑两遍）。
- **(d) `check:guards-wired` 0 —— 但踩过一次真红**：换指针后 `expandNpmScripts` 展开不到任何 `npm run …` ⇒ `:report` 立刻报「首败：check:guards-wired」，**79 个守卫一次性全误报"未接线"**；修法 = 展开时把矩阵入口**等价代入** `test:guards:chain`。这条是本轮最有价值的发现。
- 判据红→绿：第 28 段注入 `exit(7)` ⇒ **exit 7 + 点名「第 28/90 条」+ 只跑 28 条**；移除 ⇒ **exit 0，89/89**。反向验证：矩阵少跑一条 ⇒ **exit 1**（88 vs 89）。
- 提交：`8cb3d03c`(指针+chain 键) · `c70ec4ed`(退役兜底+展开面代入) · `633d42df`(台账)。

## 方法论沉淀
㊺ **换「链的载体」必然打瞎所有解析该载体的工具**：`test:guards:repo` 一换，`check:guards-wired`/`:report` 的展开面同时失明（79 条误报）。⇒ **改任何被工具解析的键之前，先 grep 谁在读这个键**。
㊻ **退役一个「兜底脚本」前，先跑文档判据当安全网**：`test:docs` 当场抓到 7 处悬空引用 —— 没有它，退役就是留一堆死指针。

## 未收口（按优先级）
1. **`executor-node` 侧 `.env` 加载未做同等约束**（§7.4 P2）：R04 只收了 admin 三入口；node 侧同样会读开发者环境 ⇒ **本地 node 测试的可信度**仍是缺口。
2. R18-B 三条重启条件（§7.19，blocked）。
3. 并发轴仍缺：`rolloutBatchClaimId` CAS / `agent_approvals` consume。
4. `check:desktop-bundle-drift` 字节哈希待 CI；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3 越界态提示。
5. 矩阵入口不进 CI（与 CI 逐条守卫步骤重复）；将来改用矩阵须**同时**删逐条步骤。

## 下轮第一步（R23）
1. `git log -1 --oneline` 确认 `633d42df`（**自己跑**）；
2. 立项 **`executor-node-env-hermeticity`**：把 R04 的 `SELFTEST_SKIP_ENV_FILE` 语义搬到 node 侧（找 node 的 `.env` 加载入口；若 node 侧**根本没有 `.env` 加载**，那就把这个事实钉成守卫：任何新增 dotenv 加载必须受同一开关约束）；
3. 判据：**红→绿成对** —— 先在 node 测试里断言「存在 `.env`（伪造内容）时测试环境变量不被污染」，旧行为红 → 新机制绿；并复跑 node 侧全量测试 exit 0；
4. 若 node 侧确认无 dotenv 加载 ⇒ 只做守卫（不许写死代码），并如实报「无入口，仅钉事实」。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、**换载体先 grep 读者（㊺）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `a6d0b51e` · 工作区干净 · 守卫框架 meta 改造第一刀已落（旧链未动）
**会话**：第 23 轮已收 · 21 轮产出（R01–R21，57 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（本会话崩 2 次均 recover；已三次抓到自己的假绿）

## R21 结论（完成，可观测性；旧链一字未改）
- **新增** `scripts/guards-repo-matrix.mjs` + `package.json` 仅 +1 行（`test:guards:repo:matrix`）：
  **运行期解析** `test:guards:repo` 的 `&&` 链（不维护手写列表）；链尾 `|| node scripts/guard-chain-fail.mjs $?` 作为收尾器**剥离**；`||` 出现在别处 ⇒ fail-closed。逐条 `[k/89] <cmd> => exit N`；失败 ⇒ `✘ 第 k/N 条失败：<cmd>` + **退出码原样传播**、后续不跑。
- **等量性**：解析 **89** 段 / 执行 **89** 段 / diff **空**；开跑前 fail-fast（持有段数 ≠ 独立解析段数 ⇒ 立刻失败）。
- **判据红→绿**：中段注入 `node -e 'process.exit(7)'`（第 28/90 段）—— **旧链 exit 7 但「第 k 条」命中数 = 0（不能点名）**；**新入口 exit 7 + `✘ 第 28/90 条失败`（能点名）+「后续 62 段未执行」**；移除注入 ⇒ **exit 0，89/89**。
- **反向验证（含自纠）**：把解析换成硬编码并**少一条** ⇒ **exit 1**（`解析与 package.json 不一致：持有 88 / 独立解析 89`）。⚠ **第一次做失败了**：最初让「执行序列」与「自己持有的列表」自比 ⇒ 硬编码少一条也能自洽通过（**自证自洽的假绿**）；改成与**独立重新解析**比对后才真正有牙。
- 回归：`guards:repo`(旧链) 0 · 新入口 0（89/89）· `guards-wired` 0 · `docs` 0 · `size-caps` 0（首次与 89 段链并发跑超时返 1，单独复跑 0 —— CPU 争用，非体量问题）。
- 提交：`a6d0b51e`（`package.json` diff = **1 insertion**）。

## 方法论沉淀
㊹ **「与自己做比对」是最隐蔽的假绿**：等量性断言如果拿 A 与 A 自己比，删一条也能自洽。⇒ 断言必须锚在**独立来源**（原文/生成物/第二次解析），否则它只是在验证自己的一致性。R16 的假绿（假并发）、R20 的假证据（轮询污染）、R21 的自洽假绿，**同一族病**。

## 未收口（按优先级）
1. **替换旧链（Lead 已批准，见下）**：`test:guards:repo` → 指向矩阵入口；`guard-chain-fail.mjs` 的兜底文案与矩阵点名**统一**；CI **只跑一遍**（否则 89 段跑两次）。落点 §7.20 P1/P3。
2. R18-B 三条重启条件（§7.19，blocked）。
3. 并发轴仍缺：`rolloutBatchClaimId` CAS / `agent_approvals` consume。
4. `executor-node` `.env` 约束；`desktop-bundle-drift` 字节哈希待 CI；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3 越界态提示。

## ✅ Lead 决策（替代 ADR，本轮拍板）
**批准 R22 把 `test:guards:repo` 直接指向矩阵入口**，理由：① 矩阵入口与旧链**等量已证**（89/89 + 独立解析 diff 空）；② 旧链的链尾兜底是 R02 的补丁，矩阵入口天然满足其目的（失败即停 + 点名）；③ 留双入口的代价是 CI 跑两遍 + 两套失败文案漂移。
**约束**：替换当轮必须（a）`guards:repo` 与 `:matrix` 输出**逐条一致**否则回滚；（b）`guard-chain-fail.mjs` 要么退役要么改成矩阵失败时的统一 tail banner；（c）CI 只保留一条；（d）`check:guards-wired` 必须仍 0。

## 下轮第一步（R22）
1. `git log -1 --oneline` 确认 `a6d0b51e`（**自己跑**）；
2. 落地上述 Lead 决策的 (a)-(d)；判据：替换后 `npm run test:guards:repo` ⇒ **exit 0 且输出含 89 条 `[k/89]`**；中段注入 ⇒ **exit 7 + 点名第 k 条**（同一注入跑一次即可）；
3. 若替换后出现任何一条守卫少跑 / CI 重复跑 ⇒ **立即回滚到 `a6d0b51e`** 并如实报。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、**与自比对的断言是假绿（㊹）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

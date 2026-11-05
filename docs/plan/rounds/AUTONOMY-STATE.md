# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `8ec8c4ba` · 工作区干净 · 守卫链 **90 段**（矩阵入口）
**会话**：第 25 轮已收 · 23 轮产出（R01–R23，63 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；多次自纠假绿/假证据）

## R23 结论（完成）—— R04 的 hermeticity 语义覆盖到 executor-node
- **事实**：node 侧 `.env` 加载入口 **1 个**（`apps/executor-node/src/main.ts:2-4`，**无条件** `dotenv.config`）；`src/routes/deploy.ts` 只在**注释**里提 dotenv 语义，不加载环境。**测试"恰好"碰不到它**（jest `collectCoverageFrom` 排除 `!src/main.ts`、全仓无 spec 导入 main）—— **是巧合不是判据**（这条判断很关键）。
- **做法**：路 A（有入口 ⇒ 加同一开关）+ **额外加守卫**（开关只约束"当前那一处"，守卫才防"将来再写一处"）：新增 `src/config/env-file.ts`（`SELFTEST_SKIP_ENV_FILE` 三态，逐字对齐 R04）+ spec 5 条 + 新守卫 `check:executor-node-env-hermetic`（四条判据，selftest 5/5）。
- **判据红→绿**：`shouldLoadEnvFile` 临时恒 `true` ⇒ **2 条红 exit 1**（含「投毒 `.env` 不得污染」核心断言）→ 还原 **5/5 exit 0**；**核心断言 = 伪造 `EXECUTOR_SECRET=poisoned` 后进程环境未被污染**，另有【对照】证明关掉开关时**确实**会污染。
- **接链**：`test:guards:chain` **89→90 段**，新守卫在 `[90/90]` 可见；**删接线能红**（`check:guards-wired` exit 1 并点名该脚本）；`guards-wired` 0。
- 回归：`guards:repo` **0（90/90，末行「解析 90 / 执行 90 / diff 空」）** · `docs` 0 · `size-caps` 0 · node 全量 **0（60 suites/1514 passed）** · 默认无开关与 `=1` 两态均 0 · `bundle-drift` 0。
- 提交：`b831d374`(开关+spec) · `d62e5922`(守卫+接链+CI) · `8ec8c4ba`(bundle 回填+台账)。

## 反复出现的摩擦（值得单独立项）
**改 `executor-node/src/main.ts` 必然触发 `check:desktop-bundle-drift`**（bundle `source-digest` 输入 55→56）—— 这是本仓**第 4 次**发生（R08/R09/R11/R23），每次都要手工回填 digest。⇒ 结构性摩擦：**本地改一处就要重签一次棘轮**。候选立项：给 digest 回填做自动化（或让守卫在「仅 source-digest 变化」时给出可执行的一键回填命令）。另 ②字节哈希仍待 CI 回填（产物 gitignored，本地只判 ①）。

## 未收口（按优先级）
1. **同类 `.env` 入口未核查**（§7.21 P3）：`apps/admin-web`（vite 注入）与 `apps/executor-python`（`load_dotenv`）是否也有未受开关约束的入口。
2. bundle-digest 回填摩擦（上面那条，建议立项）。
3. R18-B 三条重启条件（§7.19，blocked）。
4. 并发轴仍缺：`rolloutBatchClaimId` CAS / `agent_approvals` consume。
5. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3 越界态提示。

## 下轮第一步（R24）
1. `git log -1 --oneline` 确认 `8ec8c4ba`（**自己跑**）；
2. 立项 **`env-entry-sweep`（R01 式一次性收尾）**：核查 `apps/admin-web`（vite `loadEnv`/`import.meta.env` 注入路径）与 `apps/executor-python`（`load_dotenv`）是否有同类未受约束入口；
   - **有** ⇒ 逐端按 R04/R23 同一语义加开关 + 接链；
   - **无** ⇒ 把「无入口」钉成守卫（同 R17 教训㊵：消费点不存在就把事实钉死，不写死代码）；
3. 判据：红→绿成对（每端各一条）+ `guards:repo` 段数 **N → N+k** 且全 90+k 段 exit 0 + 删接线能红；
4. 若发现 python 侧入口需要改运行时语义（超出测试域）⇒ **先写 ADR** 或只做守卫并如实报。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、**"恰好碰不到"不是判据（R23）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

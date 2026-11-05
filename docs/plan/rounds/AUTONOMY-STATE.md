# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `5ed14710` · 工作区干净 · 守卫链 **93 段** · **main-guard 守卫已上**
**会话**：第 48 轮已收 · 46 轮产出（R01–R46，100 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮把一次假红正确归因到**自己的 YAML 插入位置**）

## R46 结论（完成）
- **红**：扫描 169 个 `.mjs` ⇒ **5 个缺 guard**（`api-i18n/inject-openapi-en.mjs`、`check-agent-write-sanitize.mjs`、`check-credential-columns.mjs`、`check-spec-coupling-surfaces.mjs`、`gen-vscode-launch.mjs` —— 都有 export 且顶层有动作）+ 40 个未登记豁免 ⇒ 守卫 **exit 1**；补齐后 **exit 0**（`扫描 170 个 .mjs，66 个已有 guard …`）。
- **豁免设计（好）**：`script-main-guard-exempt.json` 显式登记 40 个「无 export 的可执行 CLI」，并写明**「有 export 的脚本一律不许豁免」** —— 将来某个 CLI 开始 export，守卫立刻红（刻意设计）。
- **反向验证**：注入 `scripts/.__r46-probe.mjs`（有 export + 顶层 `process.exit`）⇒ **exit 1 并点名**；删除 ⇒ 0。
- **接链 92 → 93 段**：`grep -c "^\[[0-9]*/93\]"` = 93；删接线 ⇒ `guards-wired` **exit 1 点名**；`guards-wired` 0。
- 回归：`guards:repo` **0（末行「解析 93 / 执行 93 / diff 空」）** · `docs` 0 · `size-caps` 0。提交 `5ed14710`。

## 方法论沉淀
(62) **假红的根因也可能在你自己的改动里**：CI step 插在 R25 步骤的 `run:` 行**之间**，把该步骤拆成两半 ⇒ `guards-wired` 报「另一条守卫未接线」。报错没错，**但根因是插入位置**。⇒ 编排类改动后先跑**依赖它的元守卫**（`guards-wired`），别等到链尾才发现。

## 未收口（按优先级）
1. **改动检查单入文档**（下轮主靶，小）：把「改 `ci.yml` 后立刻跑 `check:guards-wired`」「改 `executor-node/src` 后跑 `digest:regen`」「全量用 `npm test -- --maxWorkers=2`」收进 `docs/operations.md` 的**改动检查单**，并让 `check:ops-runbook` 断言该段存在（红→绿）。
2. 真机债（应开始偿还）：审批 PG 并发未验、`rolloutBatchClaimId` 真机未测；R18-B 三条重启条件（§7.19，blocked）。
3. `execute` 接口化下一刀：`persist()` 两处 → `ToolCallLedger`（**不要再碰 `sessions`**）。
4. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`；`xfail` 的 XML `skipped` 语义未覆盖。
5. 例行：`health:snapshot` 每 10 轮（下次 **R52**；现在四端都有真实通过数）。

## 下轮第一步（R47）
1. `git log -1 --oneline` 确认 `5ed14710`（**自己跑**）；
2. 立项 **`change-checklist`**：
   - 在 `docs/operations.md` 新增「**改动检查单**」一节，至少 4 条：① 改 `ci.yml` ⇒ 跑 `check:guards-wired`；② 改 `apps/executor-node/src/**` ⇒ `npm run digest:regen`（② 由 CI 回填）；③ 跑 admin-api 全量 ⇒ `npm test -- --maxWorkers=2`（默认并发会被 SIGTERM）；④ 改守卫链/`package.json` 脚本键 ⇒ 先 grep 读者（`guards-wired`/`:report`/矩阵入口）；
   - 每条附**一行可复制命令**；
   - **判据（红→绿）**：先扩展 `check:ops-runbook` 断言该节存在且 4 条命令齐全 ⇒ 现状 **exit 1**（贴缺什么）→ 写完后 **exit 0**；**反向验证**：删掉其中 1 条 ⇒ 守卫红并点名；
   - 若该守卫不允许扩展，则新建 `check:change-checklist` 并接链（**93 → 94 段**，删接线能红）；
3. 回归：`test:docs` 0 · `guards:repo` 0（段数与末行自证）· `check:size-caps` 0。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯、文本锚点不是定位手段、止损=换方法、两条路径收敛到唯一实现、改基线留标记并回填、拆不动时换维度、接缝价值≠行数收益、main-guard 与 pkill 自伤、**假红根因可能在自己改动里（62）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

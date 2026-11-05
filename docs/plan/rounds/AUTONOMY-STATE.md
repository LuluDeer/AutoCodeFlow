# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `80964beb` · 工作区干净 · 守卫链 **93 段全绿** · **真机债已开始偿还**
**会话**：第 53 轮已收 · 51 轮产出（R01–R51，110 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮真机验证通过且如实说明「未接链」）

## R51 结论（完成，**真机验证通过，未发现缺陷**）
- **栈**：只起 `postgres:16-alpine`（`acf-r51-pg`，端口 55451）；**两条独立 `pg.Client` 连接**执行与 `agent-approvals.service.ts:788` **同形裸 SQL**（不起 admin-api/executor —— 本项验的是**行锁 + 谓词在新行版本上重求值 + `rowCount`**，裸 SQL 比 service 层更直接，且 SQL 逐字取自 service）。
- **不变量（10/10）**：**恰好一条 affected=1** · 输家 **not_granted**（其后行 `consumed`）· **无两枚同时可用**；逐轮 `connA=1 connB=0 winners=1 statusAfter=consumed ✔`，**无例外轮**。
- **反向验证（关键）**：去掉 `status='granted'` 谓词 ⇒ **connA=1 connB=1**（两条都成功）⇒ 证明平台**真能并发打同一行**，所以「恰好一条」**不是串行假绿**。
- **未接链（如实）**：该用例需 docker + 真实 PG，CI 无此环境 ⇒ 记 `needs-env`（重启条件 = CI 加 postgres service 或本地慢通道），**段数仍 93**。
- **踩坑记录**：首版 `BEGIN` + `Promise.all([UPDATE…])` ⇒ **自锁**（后者等行锁、前者等 all），已**按作业 id 精确 kill** 并改为 autocommit 单语句。
- 回归：`typecheck` 0 · `guards:repo` **0（93 段）** · `docs` 0 · `size-caps` 0 · main-guard 守卫 0；容器 `acf-r51-pg` 已删、残留 0，`acf-*` 8 个历史栈未动。提交 `80964beb`。

## 方法论沉淀
(66) **验证并发必须证明「平台真能并发」**：只观察「恰好一条成功」不够 —— 串行执行也会恰好一条。**放宽谓词后必须出现「两条都成功」**，才算证明并发真实。这与 R11 的「反向次序」、R16 的「20/20 违反」同一族。

## 未收口（按优先级）
1. **`rolloutBatchClaimId` 真机**（下轮主靶，R30 降级的那笔）：同法可用最小 PG 验证「部分唯一索引 + 条件 UPDATE」的引擎行为。
2. 该真机用例待接链（CI 加 postgres service 后，先绿再接、删引用要能红）。
3. R18-B 协议层并发（blocked，§7.19 三条重启条件）。
4. `execute` 接口化下一刀：`persist()` → `ToolCallLedger`（不要碰 `sessions`）。
5. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`；`xfail` 的 XML `skipped`。
6. 例行：`health:snapshot` 已到期（上次 R42）—— 下轮之后尽快跑（链已绿，基线可信）。

## 下轮第一步（R52）
1. `git log -1 --oneline` 确认 `80964beb`（**自己跑**）；
2. 立项 **`rollout-claim-pg`**（真机，沿用 R51 最小栈手法）：
   - 起 postgres，验证 **`UNIQUE("applicationId") WHERE claim IS NOT NULL` 部分唯一索引** + 条件 UPDATE 的引擎行为：
     - 两连接并发认领**同一 application 的同一批次** ⇒ **恰好一条成功**，另一条 affected=0 且得到明确 blocked 原因；
     - **第三条连接**尝试为**同一 application** 插入/更新**另一个**批次 ⇒ 必须被部分唯一索引拒绝（证明索引真的生效，不是靠应用层判断）；
   - **反向验证（必做）**：临时 drop 掉该唯一索引（或在测试库上建无索引副本）⇒ **必须观察到两条批次同时成功**（证明索引是唯一防线），随后重建/清理；
   - 判据：N≥10 轮逐轮 + 负向用例 exit code；**栈起不来第一次就停手**标 `unverified` 并写 §7-A；
   - 容器自清残留 0，`acf-*` 别动；脚本**必须带 main-guard**。
3. 若时间允许：跑 `npm run health:snapshot`（后台 + `--maxWorkers=2`）拿过期体检的 delta —— **但不要与真机验证混在一个提交里**。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯、文本锚点不是定位手段、止损=换方法、两条路径收敛到唯一实现、改基线留标记并回填、拆不动时换维度、接缝价值≠行数收益、main-guard 与 pkill 自伤、假红根因可能在自己改动里、Lead 文档也在门禁内、同命令两上下文不同=环境依赖先取证、验收必须用链内同形式、判据针对命令形式、**验证并发须证明平台真能并发（66）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

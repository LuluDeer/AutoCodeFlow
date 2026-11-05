# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `5f5fff98` · 工作区干净 · 守卫链 **93 段全绿** · 真机债已还两笔
**会话**：第 54 轮已收 · 52 轮产出（R01–R52，111 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮逐字照抄生产索引定义，未凭记忆）

## R52 结论（完成，**三组验证通过，未发现缺陷**）
- **索引定义（逐字照抄迁移）**：`apps/admin-api/src/migrations/1790000000095-AddRolloutBatchClaim.ts:79-83`
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_deployments_rollout_claim" ON "app_deployments" ("applicationId") WHERE "rolloutBatchClaimId" IS NOT NULL`
  （脚本建**同形表 + 同名索引**，仅换表名以保证错误信息能对上生产）。
- **组1 同批次并发**：**恰好一条** —— **10 轮全部 `winners=1`**，含 A/B 互换轮（round10 `connA=0 connB=1`）。
- **组2 跨批次同 application**：PG **`23505`** + **约束名 `uq_app_deployments_rollout_claim`** ⇒ **索引在 PG 层真生效**，不是应用层判断。
- **组3 反向（drop index）**：**两条都成功**（`d1@batch-A=1 d2@batch-B=1`）⇒ **索引是唯一防线**；随后重建索引并清表。
- **未接链（如实，同 R51）**：需 docker ⇒ 记 `needs-env`（CI 加 postgres service 后可接 `check:race-selftests-wired`）。
- 回归：`typecheck` 0 · `guards:repo` **0（93 段）** · `docs` 0 · `size-caps` 0 · main-guard 守卫 0；容器 `acf-r52-pg` 已删、残留 0，`acf-*` 未动。提交 `5f5fff98`。

## 方法论沉淀
(67) **唯一的证据链 = 正向 + 反向 + 引擎错误码**：组1 给「恰好一条」，组3 给「去掉索引就两条都成功」，组2 给「PG 亲自报 23505 + 约束名」。三者缺一，都可能只是应用层假绿。

## 未收口（按优先级）
1. **健康体检已过期**（上次 R42，已 10 轮）：下轮主靶，跑 `health:snapshot` 拿真实 delta。
2. 两个真机脚本（R51/R52）待接链：需 CI postgres service；**本期无法验证 CI 是否真跑** ⇒ 若要接，必须同时说明「本地已验证、CI 未验证」。
3. R18-B 协议层并发（blocked，§7.19 三条重启条件）。
4. `execute` 接口化下一刀：`persist()` → `ToolCallLedger`（不要碰 `sessions`）。
5. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`；`xfail` 的 XML `skipped`。
6. 第 ⑥ 条检查项（`--only` 用法 + `race:pg` 慢通道）未写进改动检查单。

## 下轮第一步（R53 = 健康体检）
1. `git log -1 --oneline` 确认 `5f5fff98`（**自己跑**）；
2. 立项 **`health-snapshot-r53`**：
   - 跑 `npm run health:snapshot`（**后台 + 落盘**；admin-api 两态固定 `--maxWorkers=2`，避免 SIGTERM）；
   - 判据：产出「与上次基线对比」段 + 每项 `本次/上次/差值`；**明确结论**「无退步 / 有退步（哪项、差多少）」；
   - **数字对得上**（与命令汇总行一致；贴片段）；**不许**用「预期」代替实测；
   - 若被 SIGTERM（R27 教训）⇒ 用 `--skip-heavy` 并**如实标注步骤行未重跑**，不许拿历史数字冒充满血；
3. 顺带（成本低才做）：把 `race:pg` 慢通道入口 + `--only` 用法写进 `docs/operations.md` 改动检查单第 ⑥ 条（**记得同步 `check-ops-runbook` 自检夹具** —— R49/R50 教训）；
4. 回归：`test:docs` 0 · `guards:repo` 0（93 段，**用链内同形式验收**）· `check:size-caps` 0。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯、文本锚点不是定位手段、止损=换方法、两条路径收敛到唯一实现、改基线留标记并回填、拆不动时换维度、接缝价值≠行数收益、main-guard 与 pkill 自伤、假红根因可能在自己改动里、Lead 文档也在门禁内、同命令两上下文不同=环境依赖先取证、验收必须用链内同形式、判据针对命令形式、验证并发须证明平台真并发、**唯一证据链=正向+反向+引擎错误码（67）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

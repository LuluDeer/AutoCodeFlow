# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `62e980be` · 工作区干净 · 守卫链 93 段全绿 · **⚠ 发现退步：`admin-web` 全量 exit 1**
**会话**：第 55 轮已收 · 53 轮产出（R01–R53，113 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮如实报退步、且自纠了一处「读到旧基线」的草稿）

## R53 结论（体检完成，**基线第一次抓到真退步**）
| 项 | 本次 vs 上次 |
|---|---|
| admin-api 默认 | 7956 → 7956（—） |
| admin-api 开关 | 7956 → 7956（—） |
| **admin-web** | **exit 0 / 2357 passed → exit 1（退步）** |
| executor-node | 1514 → 1514（—） |
| executor-python | passed 1692 → 1692（—） |
| 守卫链 | 93 → 93（—，末行「解析 93 / 执行 93 / diff 空」） |

- **结论：有退步，唯一项 = `admin-web` 全量 exit 1**；幅度「整套失败」（无通过数）。**未猜测原因**，诊断方向已给：`cd apps/admin-web && npx vitest run` 抓失败用例名。
- 基线文件已按**真实产物**重写（`admin-web` 行 = `exit 1`，其余持平，对比段差值随之更新）。
- **第 ⑥ 条已加**（`--only <k>` 单段复现 / R51+R52 真机脚本属**慢通道不进链**）+ **自检夹具已同步**；**链内同形式验收** `npm run check:ops-runbook` ⇒ exit 0（selftest 6/6）；反向验证删第 ⑥ 行 ⇒ exit 1 点名。
- 回归：`docs` 0 · `guards:repo` **0（93 段）** · `size-caps` 0。提交 `9ed34647` + `62e980be`；体检 ≈12 分钟（后台 detached）。

## 方法论沉淀
(68) **基线第一次证明了自己的价值**：没有 R31/R42 的基线，`admin-web` 从 2357 passed 掉到整套失败**不会被任何人注意到**（它不在守卫链里，链只跑 93 段 check-*）。⇒ **「绿色门禁」覆盖不到的地方，只能靠定期全量体检发现**。

## 未收口（按优先级）
1. **`admin-web` 退步诊断与修复**（下轮主靶）：先取得失败用例名，再判断 flake vs 真回归。
2. 两个真机脚本（R51/R52）待接链（需 CI postgres；本期无法验证 CI 真跑）。
3. R18-B 协议层并发（blocked，§7.19 三条重启条件）。
4. `execute` 接口化下一刀：`persist()` → `ToolCallLedger`（不要碰 `sessions`）。
5. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`；`xfail` 的 XML `skipped`。

## 下轮第一步（R54 = 修退步，最高优先级）
1. `git log -1 --oneline` 确认 `62e980be`（**自己跑**）；
2. 立项 **`admin-web-regression`**：
   - **先取证**：`cd apps/admin-web && npx vitest run > /tmp/web.log 2>&1; echo exit=$?` —— 贴**失败用例名 + 错误首行 + 计数**（psst：`npx vitest` 若与 R26 的 `npx jest` 一样不可靠，就改用仓库既有 `npm run test:web`，**先校准尺子**教训㊼）；
   - **再定性**：`git log --oneline AGENT_HANDOFF 提到的上次 web 全绿以来 apps/admin-web 的改动`（R42 之后动过 web 的：R18 的 `executor-metrics`、R23/R24 的 env 相关、R38/R41 的 admin-api）⇒ 判断「真回归（改动引入）」还是「flake（重跑即过）」；
   - **修复**：真回归 ⇒ 按 R49 方法（先留证据、CodeGraph 定锚点、红→绿成对）；flake ⇒ 找出不稳定来源（时间/随机/共享状态）并让它确定化，**不许用重试掩盖**；
   - 判据：`npm run test:web` ⇒ **exit 0 且通过数 ≥ 2357**（贴真实汇总行）；若通过数变化，说明新增/删除用例的原因；
3. 修好后**再跑一次体检**（或至少 web 全量）确认基线回到 exit 0，并更新 `health-baseline.*`；
4. 回归：`guards:repo` 0（93 段，链内同形式）· `test:docs` 0 · `check:size-caps` 0。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯、文本锚点不是定位手段、止损=换方法、两条路径收敛到唯一实现、改基线留标记并回填、拆不动时换维度、接缝价值≠行数收益、main-guard 与 pkill 自伤、假红根因可能在自己改动里、Lead 文档也在门禁内、同命令两上下文不同=环境依赖先取证、验收必须用链内同形式、判据针对命令形式、验证并发须证明平台真并发、唯一证据链=正向+反向+引擎错误码、**绿色门禁覆盖不到的地方只能靠定期体检（68）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。

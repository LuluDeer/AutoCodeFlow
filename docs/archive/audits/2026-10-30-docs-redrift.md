# 文档再漂移审计（2026-10-30 · docs-truth 第 3 轮之后）

> 只读审计。本文件是本次**唯一**写操作；未改动任何源码 / 配置 / 既有文档。
> 本轮只看「第 3 轮 docs-truth 之后新落的改动，**现在会误导人**」的漂移；已修项在 §1.2 逐个列状态，
> 不重复计入发现数。所有「实际值」都是本会话当场重跑命令所得，逐条附取值命令。

## 1 范围与方法

### 1.1 第 3 轮之后新落的改动（本轮审计面）

| 改动 | 落点 | 文档面风险 |
|---|---|---|
| G4 会话发起人 + 审批四眼开关 | 迁移 `1790000000078`、`agent_sessions.createdBy`、`AGENT_BLOCK_SELF_APPROVAL` | 数据模型表 / 环境变量表是否跟上 |
| G5 `get_session_steps` / 会话转录导出 / `get_tool_call_result` | `tool-binder.service.ts`、`agent.controller.ts:148` | 工具清单 / 端点地图是否跟上 |
| G6 `runOnUpstreamFailure` + `$upstream("别名")` | 迁移 `1790000000079`、`task.service.ts:359/430/4587` | 依赖扇出语义（多处写着「仅 SUCCESS」） |
| RustFS 替换 MinIO | `docker-compose.yml:330-392`、profile `rustfs` | operations / deployment / atlas 是否同口径 |
| 守卫体系 T4 + 接线 | `scripts/lib/guard-selftest.mjs`、`check-image-pinned`、`check-guards-wired` 第三判据 | 「怎么加守卫、怎么跑」有没有文档 |
| 镜像 / action 固定（CIR-05） | compose 26 镜像引用 + Dockerfile 10 条 FROM + 106 处 `uses:` | 纪律是否可被读者发现 |

### 1.2 第 3 轮 12 条的现状（**不重复报**）

| id | 现状 | 复核命令/落点 |
|---|---|---|
| DT-01 pnpm | **已修** | `docs/development.md:8-18` 现在明写「包管理器是 npm，不是 pnpm」 |
| DT-02 Node 20.x | **已修** | `docs/development.md:7` = `24.x（engines: >=24）` |
| DT-03 根 `package.json` 版本掉队 | **未修**（非文档类，本轮不计） | `node -p "require('./package.json').version"` → `1.11.0` vs `version.txt` `1.15.0`；`release-please-config.json` 仍无 `/package.json` |
| DT-04 06-infra 数字 | **已修**（并有守卫） | `node scripts/check-infra-doc-counts.mjs` → 10 / 38 / 1963 / 125 全中 |
| DT-05 07-testing 规模表 | **部分修**：`test:unit` 套件数、e2e 已对；其余数字**又落后一档** → 本轮 RD-07 | 见 RD-07 |
| DT-06 README 67 子命令 | **未修** → 本轮 RD-06 | `README.md:226/:684` 仍写 67 |
| DT-07 `README.en.md` 缺 4 行 | **未修** → 本轮 RD-01 | `awk` 切片 diff 仍在 |
| DT-08 docs/README 三处 | **已修** | `docs/README.md:28/44/62` = 3–8 分钟 / 九层 / ADR-028；`docs/adr/README.md:48` 已写 ADR-028 |
| DT-09 两个失效命令名 | **已修** | `06-roadmap.md:51` 已写 `check:shell-multibyte`；`PLAN-CLAIMS.md:84` 已就地更正 `test:all` 不存在 |
| DT-10 your-org | **已修** | `grep -rn your-org docs/*.md README*.md` 零命中 |
| DT-11 两处 file:line | **部分修**（本轮另发现 1 处，见 RD-15） | — |
| DT-12 atlas 迁移 117 | **已修** | `docs/atlas/01-apps/admin-api/README.md:64` = 125 / …080 |

### 1.3 本次实跑的守卫（判断「是否已被机械覆盖」的依据）

```text
node scripts/check-docs.mjs            → 4 判据全绿（死链 / 孤儿 / 根目录 / 正文裸路径），自检 23 通过
node scripts/check-atlas-counts.mjs    → 125 迁移 / 22 模块 / 7 应用 / e2e 51 例 9 组 全绿
node scripts/check-infra-doc-counts.mjs→ workflow 10 / ci jobs 38 / deploy.sh 1963 / 迁移 125 全绿
node scripts/check-interface-maps.mjs  → MCP 56 工具 / REST 30 前缀 / SDK 1.15.0 / 审计动作 68 全绿
node scripts/check-guards-wired.mjs    → 45 个 check-*.mjs 全部被 CI 执行；46 个有自检、45 个两面都跑
node scripts/check-cli-doc.mjs         → 69 = 66 + 3
node scripts/check-env-drift.mjs       → 227 个 env 键被 .env.example 覆盖
npm run test:docs                      → 23 通过
bash scripts/deploy.selftest.sh        → 69 通过 / 0 失败
```

**因此本文排除**：文档间相对链接死链、`docs/` 孤儿、裸路径指针、CLI/atlas/infra 四组计数、MCP/REST 清单、
审计动作、指标名、索引漂移、env 键覆盖率、守卫接线完整性——这些都绿。

### 1.4 样本量

- `npm run` 引用 **446 处**（对 8 个 `package.json` 的脚本名并集比对：**0 处失效**，7 处是 `test:*` / `migration:*` 这类通配写法）。
- `make` 目标引用全量（对 `Makefile` 目标比对，**0 处失效**）。
- 围栏代码块内路径 **741 处**（`check-docs` 判据④刻意不查代码块，本会话单独扫）：**仅 1 处真失配**
  （`apps/executor-agent`，属设计稿提案名，不算漂移）。
- 守卫脚本名 / CI job 名 / workflow 文件名 / compose profile 名 / 环境变量名：各自全量扫，失效项见 RD-15。
- G4/G5/G6 关键词在 6 类文档面（`docs/design/**`、`docs/atlas/**`、`api-reference`、`operations`、README 三语、CHANGELOG）逐项比对。

## 2 未实测（只读纪律下的边界）

| 项 | 为什么没做 |
|---|---|
| 全量测试（admin-api / admin-web / desktop） | 未跑；因此**不声称**任何「N 套件 / M 例」数字等于当前实跑值，只做静态文件与断言计数（口径写在条内） |
| 起 compose 验 RustFS | 未起容器；`operations.md` / `deployment.md` 的迁移步骤只做**文本与 compose 定义逐项比对**（profile / 端口 / 卷 / env 四项已核对一致） |
| VitePress 站点死链 | 未 build |
| `check-image-pinned` 联网复核 digest | 未联网复算 digest 值，只确认「镜像条目都带 `@sha256:`」这一事实 |

## 3 发现总表

| id | 优先级 | 一句话（会怎么误导人） | 落点 |
|---|---|---|---|
| RD-01 | **P1** | 英文 README 缺 4 行必需环境变量：照 Option 1 做，admin-api **启动即退出**，而英文页没有任何解释 | `README.en.md`（对 `README.md:241-244`） |
| RD-02 | **P1** | G6 `runOnUpstreamFailure` **零文档**，同时 3 处 atlas 与 api-reference 反向写着「只有上游全 SUCCESS 才扇出」 | `docs/atlas/04-flows/task-lifecycle.md:14`；`docs/atlas/01-apps/admin-web/domain-modules.md:35`；`.../components-and-layout.md:52`；`docs/api-reference.md:518` |
| RD-03 | **P1** | G6 `$upstream("别名")` 不存在于任何文档；api-reference 只教两种旧形态，多上游 DAG 的数据契约无处可查 | `docs/api-reference.md:518` |
| RD-04 | **P1** | G5 `get_session_steps` 零文档；design 03 的工具/分级表漏 7 个**已注册**工具 | `docs/design/agent-and-deployment/03-agent-tools-and-boundary.md:30,104-120` |
| RD-05 | P2 | 设计文档 9 处写「43 个工具 / 7 组注册函数」，实际 **56 / 9**（同句「52 KB」也已是 124 KB） | `03:7,22,30`；`02:36`；`11:3,11`；`06:149,191`；`10:121` |
| RD-06 | P2 | README 三语写 `acf` **67** 个子命令，实际 **69**（守卫只校 `cli.md`） | `README.md:226,684`；`README.en.md:198`；`README.zh.md:202` |
| RD-07 | P2 | `07-testing` 规模表又落后一档；`scripts/*selftest*` 在**同目录两份文档里写成 32 和 15**，实际 27 | `07-testing/README.md:20-24,38`；`07-testing/contract-and-selftest.md:2,32` |
| RD-08 | P2 | 「deploy.sh 自检 **29 项**」4 处，实际 **69** | `docs/design/agent-and-deployment/README.md:122`；`06-roadmap.md:22,56`；`Makefile:175` |
| RD-09 | P2 | G4 四眼开关 `AGENT_BLOCK_SELF_APPROVAL` 只在 `.env.example`；运维两份参考表都没有；design 还写着「不给配置开关」 | `docs/deployment.md:75-122`（env 表）；`docs/atlas/06-infra/env-vars.md`；`03-agent-tools-and-boundary.md:75` |
| RD-10 | P2 | G4 `agent_sessions.createdBy` 未进数据模型：design 02 表 12 列、atlas agent 三表节都不含它 | `docs/design/agent-and-deployment/02-agent-architecture.md:58-73`；`docs/atlas/01-apps/admin-api/modules/agent.md:72` |
| RD-11 | P2 | atlas agent 模块**路由表 5 条 / 实际 9 条**：缺 G5 导出与 3 条审批端点 | `docs/atlas/01-apps/admin-api/modules/agent.md:55-62` |
| RD-12 | P3 | env 总表自述「`.env.example`（162 行）/ 约 80 个变量」，实际 **632 行 / 133 键** | `docs/atlas/06-infra/env-vars.md:2,9` |
| RD-13 | P3 | 「**9 个**常驻服务」，实际 **8**（同仓 atlas 另一页就写 8） | `docs/deployment.md:607` |
| RD-14 | P2 | 「怎么加守卫 / 怎么跑 `test:guards`」全仓无文档；harness 零提及；CI 门禁清单缺 `test:guards`；DOC-GOV 判据写成 3 条（实际 4 条） | `CONTRIBUTING.md:119-124,131`；`07-testing/README.md:41-58`；`README.md:420,874`；`package.json` `//test:guards` / `//check:docs` |
| RD-15 | P3 | 4 处零散失效引用（CI job 名 / compose profile 名 / demo 秒数口径 / 一处代码行号） | 见条内 |

> 计数：**P1 4 / P2 7 / P3 4 = 15 条**。其中 RD-01、RD-06 是第 3 轮已提未落地（如实标注），其余 13 条由本轮新落改动产生。

## 4 G4 / G5 / G6 覆盖三分类（重点 1 的答复）

**结论：7 个子特性里，2 个已文档化、3 个有但口径旧、2 个完全没有。** 新功能文档化的主力是
`docs/AGENT_HANDOFF.md`（逐轮流水）与 `CHANGELOG`——**这两处不算「文档化」**：交接文档是过程日志，
读者不会去那里查「这个字段怎么用」。

| 子特性 | 分类 | 已文档化的位置（file:line） | 缺失/过期的位置 |
|---|---|---|---|
| G5 `get_tool_call_result` | ✅ 已文档化 | `docs/design/agent-and-deployment/03-agent-tools-and-boundary.md:120`；`02-agent-architecture.md:191,204`；`.env.example:309`（回读提示） | — |
| G5 会话转录导出 `GET /agent/sessions/{id}/export` | ✅ 已文档化（仅附录） | `docs/api-reference.md:1314`（生成附录，摘要「导出 Agent 会话完整转录（JSON）」） | `docs/atlas/01-apps/admin-api/modules/agent.md:55-62` 路由表缺；无手写说明（是否含 trace/敏感字段、大小上限、谁可导） |
| G4 `agent_sessions.createdBy` | ⚠️ 有但口径旧 | 无；只有 `docs/atlas/01-apps/admin-api/README.md:64` 里那句迁移清单提到「G4 会话发起人列」 | `02-agent-architecture.md:58-73` 表（12 列无 createdBy）；`modules/agent.md:72` |
| G4 `AGENT_BLOCK_SELF_APPROVAL`（四眼开关） | ⚠️ 有但口径旧 | `.env.example:303`（带注释，**唯一**一处） | `docs/deployment.md` env 表（66 行，零 `AGENT_*`）；`docs/atlas/06-infra/env-vars.md`；`03-agent-tools-and-boundary.md:75` 反向措辞 |
| G6 `$upstream("别名")` | ⚠️ 有但口径旧 | `docs/api-reference.md:518`（**只写** `$upstream` 与 `$upstream.<dot-path>`） | 别名语法在**全部** live 文档零命中（`grep -rn '\$upstream("' docs --include=*.md` 仅命中 `AGENT_HANDOFF.md:70,77,82,87`） |
| G6 `runOnUpstreamFailure` | ❌ 完全没有 | 无（`grep -rn runOnUpstreamFailure docs --include=*.md` 只命中 `atlas/01-apps/admin-api/README.md:64` 的迁移清单一句） | 字段级：`docs/atlas/03-data/entities/task.md:28`（`dependencies` 行）无；语义级：见 RD-02 的 4 处反向陈述 |
| G5 `get_session_steps` | ❌ 完全没有 | 无（只有 `AGENT_HANDOFF.md:89-90`） | `03-agent-tools-and-boundary.md:104-120` 内部工具表 11 行无它；`docs/atlas/**` 零命中 |

> 守卫面：`check-interface-maps` 只校 `atlas/05-interfaces/mcp-tools.md`（56 个 MCP 工具）与 REST 前缀清单，
> **不校 design 的工具表，也不校 agent 模块自己的路由表**——所以上表 5 处缺口可以长期存活。
>
> README 三语层面：G4/G5/G6 都不在产品概览里出现，**这不算漂移**（README 只讲能力类目，
> 讲的是「MCP 56 工具 / 部署第二人审批」，两句当前都成立）。

## 5 逐条证据

### RD-01（P1）`README.en.md` 仍缺 4 行 `ALLOW_LOOPBACK_CORS`——英文读者照做即启动失败

**文档原文**：`README.en.md:201-210`（Option 1 代码块）

```bash
cp .env.example .env
# Required: INITIAL_ADMIN_PASSWORD (>= 8 chars; weak values are rejected at boot)
#           POSTGRES_PASSWORD / JWT_SECRET / JWT_REFRESH_SECRET / EXECUTOR_SECRET
vim .env
```

`README.md:238-244`（中文源）在同样的位置还有 4 行：

```text
# For a local trial you also need: ALLOW_LOOPBACK_CORS=true
#   (compose defaults to NODE_ENV=production + localhost CORS origins, and the
#    production guard rejects loopback origins unless this is explicitly set —
#    without it admin-api exits at boot. Use your real domain in production.)
```

**实际**：缺这 4 行时 `docker compose up -d` 后 admin-api 在启动校验阶段退出（生产形态 + localhost CORS 被拒）。
中文页与 `docs/quickstart.md` 都有这 4 行，**只有英文产物没有**。

**证据**（可复现）：

```text
$ awk '/<a name="english">/,/<a name="chinese">/{ if (/<a name="chinese">/) exit; print }' README.md | diff - README.en.md
213,216d212
< # For a local trial you also need: ALLOW_LOOPBACK_CORS=true
< #   (compose defaults to NODE_ENV=production + localhost CORS origins, and the
< #    production guard rejects loopback origins unless this is explicitly set —
< #    without it admin-api exits at boot. Use your real domain in production.)
```

`README.zh.md` 对同一机械切片**只差末尾 4 行导航**（属预期），说明生成器本身没坏，是产物没重跑
（生成器：`.github/workflows/readme-sync.yml`，`README.en.md` = `README.md` 的 `<a name="english">`
到 `<a name="chinese">` 切片 + 固定尾注）。

**修法**：重跑 `readme-sync`（或本地执行上面那条 `awk` + 尾注）后提交 `README.en.md`；
并把「`README.en/zh` 必须等于对 `README.md` 的机械切片」加成 `check-docs` 第 ⑤ 判据（第 3 轮 DT-07 已建议过，
这轮实测证明「靠人记得跑 workflow」不成立）。

### RD-02（P1）G6 失败边：零文档 + 4 处写着「只有全 SUCCESS 才扇出」

**文档原文**（4 处，全部是**反向**陈述）：

| file:line | 原文 |
|---|---|
| `docs/atlas/04-flows/task-lifecycle.md:14` | `├─ 触发源 C: 依赖扇出 triggerDependentTasks (task.service.ts:1337)`（下图仅描述 SUCCESS 路径） |
| `docs/atlas/01-apps/admin-web/domain-modules.md:35` | 「上游**全部最近执行 SUCCESS** 时由 task.service.triggerDependentTasks 自动扇出触发下游」 |
| `docs/atlas/01-apps/admin-web/components-and-layout.md:52` | 「真实下游触发顺序由依赖扇出语义（**上游全部 SUCCESS**）兜底」 |
| `docs/api-reference.md:518` | 「依赖触发时自动替换为上游 **SUCCESS** 执行的 {…}」 |

**实际**（G6 第一步，2026-10-29 落地）：

- `tasks.runOnUpstreamFailure boolean NOT NULL DEFAULT false`（迁移 `1790000000079`）；
- 上游进入**失败终态**（FAILED / TIMEOUT / KILLED / CANCELLED）时，只有**声明了该位**的下游会被扇出；
- 依赖闸门 `acceptFailure`（`apps/admin-api/src/modules/task/dependency-gate.util.ts:51`）与调度 misfire 补偿闸同口径；
- 落点：`task.entity.ts:163`、`create-task.dto.ts:217`、`task-response.dto.ts:103`、
  `task.service.ts:4590/4622/4639/4930/6169`、`scheduler.service.ts:985`。

**证据**：`grep -rn runOnUpstreamFailure --include=*.ts apps/admin-api/src | grep -v spec`；
`grep -rn runOnUpstreamFailure docs --include=*.md` → 仅 `atlas/01-apps/admin-api/README.md:64`（迁移清单）。
openapi 里有字段英文描述（`grep -o 'upstream dependency reaches a failed terminal state[^"]*' apps/admin-api/openapi.json`），
但 `api-reference.md` 的生成附录只到**端点**粒度，不含字段——所以字段级仍是零文档。

**修法**：`docs/atlas/03-data/entities/task.md` 字段表 `dependencies` 行后补一行 `runOnUpstreamFailure`（含默认 false 与语义）；
`api-reference.md`「Tasks」节补一段「失败边」；上面 4 处 SUCCESS-only 改成
「全部上游最近执行 SUCCESS，**或**该任务声明了 `runOnUpstreamFailure` 时任一失败终态」。

### RD-03（P1）G6 `$upstream("别名")` 未文档化

**文档原文**：`docs/api-reference.md:518`

> 下游任务的 params 里声明 `$upstream`（整个上游执行上下文）或 `$upstream.<dot-path>`（如 `$upstream.result.screenshot`）…

**实际**：多上游 DAG 已有按别名的数据契约——`$upstream("别名")` / `$upstream("别名").result.foo`，
别名 = `dependencies` 的**键**，**无需迁移**；未知别名解析为 `null`（显式缺失，不把哨兵当普通参数）。
实现：`apps/admin-api/src/modules/task/task.service.ts:359-377`（`UPSTREAM_ALIAS_SENTINEL_RE`）与
`:430-454`（`injectUpstreamContext(..., aliases)`）。

**证据**：`grep -rn 'upstream("' --include=*.ts apps/admin-api/src | grep -v spec`；
`grep -rn '\$upstream("' docs --include=*.md` → 只命中 `docs/AGENT_HANDOFF.md:70/77/82/87`。

**为什么 P1**：这是「多上游 DAG 怎么写下游取数」的**唯一**数据契约，读 api-reference 会以为只能用单上游整块透传；
照旧文档写多上游任务，下游拿到的是"本次触发的那一个上游"，多依赖场景直接错。

**修法**：`:518` 补第三形态与别名解析规则（含未知别名 → `null`）；并在 `docs/atlas/04-flows/task-lifecycle.md`
的依赖扇出段补一句交叉引用。

### RD-04（P1）G5 `get_session_steps` 零文档；工具/分级表漏 7 个已注册工具

**文档原文**：`docs/design/agent-and-deployment/03-agent-tools-and-boundary.md`

- `:104` 「## 4. 内部工具（Agent 专用，非 MCP 面）」表格 **11 行**（`run_doctor` … `get_tool_call_result`），**无 `get_session_steps`**；
- `:30` 「**43 个工具**按「产生多大后果」分三级」的三张表，也不含 `get_session_steps`。

**实际**：`get_session_steps` 是 read tier 的注册工具（`tool-registry.ts:294`、
`tool-binder.service.ts:84`）：`seq` 倒序分页（`beforeSeq`）、投影 `seq/role/content(≤300)/toolCallsJson/createdAt`、
会话隔离靠 `ctx.sessionId`（缺上下文拒绝）。定位是 langgraph `get_state_history()` 的只读等价物。

**证据**（工具集覆盖比对，registry 55 个名字 vs 文档正文）：

```text
registry tools: 55
mentioned in design 03: 48
missing: 7 → create_mutex_group, delete_mutex_group, get_session_steps, list_mutex_groups,
            list_pending_approvals, sop_assign, update_mutex_group
```

**为什么 P1**：`docs/design/**` 是本仓「怎么写 Agent」的规范面；工具表是边界控制（L1 白名单 + tier 分级）的输入。
漏 `list_pending_approvals` 与 4 个 mutex 工具会让实现者以为这些工具不存在（或没有 tier），
漏 `get_session_steps` 会让「上下文折叠后如何复核早期步骤」这个能力在文档里彻底消失。

**修法**：§4 表补 `get_session_steps`（read，配套 §4.3 上下文折叠）；§2 三张 tier 表补上述 6 个工具并给默认姿态。
（`get_tool_call_result` 已在 `:120`，无需动。）

### RD-05（P2）设计文档 9 处「43 个工具 / 7 组注册函数」vs 实际 56 / 9

**文档原文**（9 处）：

```text
03-agent-tools-and-boundary.md:7   tools.ts（52 KB）已把 admin-api 的 HTTP 面封装成 43 个工具，且分成 7 组注册函数
03:22                              零重复实现 —— 43 个工具的定义、参数校验、401 自愈全都有了
03:30                              43 个工具按「产生多大后果」分三级
02-agent-architecture.md:36        ★ 收编 mcp-server 的 43 个工具
11-agent-collaboration-api.md:3    43 个工具全是「管理平台资源」，没有一个能用于 Agent 协作
11:11                              | **MCP**（43 工具） |
06-roadmap.md:149                  | 工具注册表 | 43 个工具（tier / resourceKind / schema） | ✅ |
06-roadmap.md:191                  ✅ 工具集与 mcp-server 的 43 个工具名双向逐一对应（无遗漏、无多余）
10-design-review.md:121            这些都不在 43 个工具里
```

**实际**：

```text
$ node scripts/check-interface-maps.mjs
✔ MCP 工具地图一致：56 个工具全部在文档中出现，9 个分域计数相符。
$ grep -o "register[A-Za-z]*Tools" packages/mcp-server/src/tools.ts | sort -u | wc -l
9
$ ls -l packages/mcp-server/src/tools.ts        # :7 那句括号里写「52 KB」
125865 bytes（124 KB / 2729 行）
```

即：同一句话里的三个数字（52 KB / 43 个工具 / 7 组）**全都过期**（124 KB / 56 / 9）。

**为什么值得修**：`:191` 是一条**验收声明**（「双向逐一对应，无遗漏」）——它在 43 的基数上成立，
在 56 上不成立（SOP / Mutex / Project 三组是在这句写完之后加的）。读者拿它当"工具集已收口"的证据会踩空。

**修法**：9 处统一改成 56 / 9 组；或更稳的做法——删掉硬编码数字，改成「见
`docs/atlas/05-interfaces/mcp-tools.md`（由 `check-interface-maps` 守护）」。

### RD-06（P2）README 三语：`acf` 67 个子命令 vs 实际 69（第 3 轮 DT-06 未落地）

**文档原文**：

- `README.md:226`（英文段）：`` | **Tooling** | `acf` CLI (67 subcommands), Node/Python SDKs, MCP server (56 tools) … ``
- `README.md:684`（中文段）：`` | **交付** | `acf` CLI（67 个子命令）… ``
- `README.en.md:198`、`README.zh.md:202`：同上（由 `readme-sync` 从上面两处拆出，会一起错）

**实际：69**。

```text
$ node scripts/check-cli-doc.mjs
✔ CLI 命令地图一致：13 节计数与代码相符，总数 69 = 66 个 .command( + 3 个根命令。
$ sed -n '1p' docs/atlas/05-interfaces/cli.md
# CLI 命令地图（acf，69 个子命令）
```

**为什么仍要报**：`check-cli-doc` 只校 `cli.md`，README 是守卫盲区（第 3 轮已指出，未落）。
读者按 67 判断 CLI 能力边界，会漏掉 2 条命令。

**修法**：4 处 67 → 69，再重跑 `readme-sync`；顺手在 `check-cli-doc.mjs` 里加一行 README 断言（它已经算出 69）。

### RD-07（P2）`07-testing` 规模数字又落后一档；`scripts/*selftest*` 在同目录两份文档里写成 32 和 15

**文档原文**：`docs/atlas/07-testing/README.md`（头注「最后核对: 2026-10-29」，「规模（2026-10-29 静态核实）」）

| 行 | 文档值 | 实际值 | 取值命令（口径同上表标注） |
|---|---|---|---|
| `:20` | admin-api **361** 个 `*.spec.ts`，`it/test` **6108** 处 | **370 / 6143** | `find apps/admin-api/src -path '*__tests__*' -name '*.spec.ts' \| wc -l`；`grep -rhoE '^\s*(it\|test)\(' … \| wc -l` |
| `:22` | executor-node **54** / **1097** | **55 / 1105** | 同法 |
| `:23` | executor-python **45** 个 `test_*.py` / **808** 个 `def test_` | **50 / 906**（另有 142 处 `async def test_` 未计） | `ls apps/executor-python/tests/test_*.py \| wc -l`；`grep -rhoE '^\s*def test_' apps/executor-python/tests \| wc -l` |
| `:24` | admin-web **252** 个 `*.test.ts*` | **257** | `find apps/admin-web/src/__tests__ -name '*.test.ts*' \| wc -l` |
| `:38` | `scripts/*selftest*`（**32 个**） | **27** | `ls scripts/*selftest* \| wc -l` |
| `contract-and-selftest.md:2` / `:32` | `scripts/*selftest*`（**15 个**，标题「…清单（15 个，ls 核实）」） | **27** | 同上 |

**为什么值得报**：同一事实（脚本自测文件数）在**同一个目录的两份文档**里写着 32 和 15，
而真值是 27——两个都错，且差了 17 个。`32` 是第 4/5 轮把伴生 `*.selftest.mjs` 收编进主文件并删除后的残留；
`15` 更旧。任何「靠自测脚本数量判断覆盖面」的判断都会失准。

**为什么守卫没抓到**：`check-atlas-counts` 的 5 条判据只覆盖迁移 / 模块 / 应用 / e2e / 占位标记，
`check-infra-doc-counts` 只覆盖 `06-infra`；`07-testing` 其余文件无任何计数判据。

**修法**：五行按上表重算（建议删掉 `it/test` 估算列，只留文件数——纯机械可判）；两份文档的 selftest 数统一为 27
并注明「其中 `check-desktop-selftests-wired.mjs` 是守卫不是自测」；把「spec 文件数 / selftest 文件数」
加成 `check-atlas-counts` 第 ⑥/⑦ 判据。

### RD-08（P2）「deploy.sh 自检 29 项」4 处，实际 69

**文档原文**：

```text
docs/design/agent-and-deployment/README.md:122   | **P0** 一键部署脚本 | deploy.sh（双模 8 阶段）+ doctor --json + rollback | 29 项自检 |
docs/design/agent-and-deployment/06-roadmap.md:22 … 产物：deploy.sh（双模）、scripts/deploy.selftest.sh（29 项自检）、
docs/design/agent-and-deployment/06-roadmap.md:56 ✅ 29 项自检全绿（npm run test:deploy-script）
Makefile:175                                     selftest-deploy: ## deploy.sh 自检（29 项纯逻辑回归）
```

**实际：69**（本会话实跑）：

```text
$ bash scripts/deploy.selftest.sh
=== 结果: 69 通过, 0 失败 ===
```

（`PLAN-CLAIMS.md:3137/3155/3227` 已记录 58→61→69 的演进，因此 `29` 是**四轮前**的值。）

**为什么值得报**：这是唯一会改生产主机的脚本，其覆盖度是运维信任它的依据；写 29 而实际 69，
会让评审判断「deploy.sh 覆盖不足」而重复劳动，或反过来低估新增用例的维护成本。

**修法**：4 处改 69；更稳的做法是把这 4 处都改成「见 `scripts/deploy.selftest.sh` 末行汇总」（数字不再手写）。

### RD-09（P2）G4 四眼开关只在 `.env.example`：运维两份参考表都没有

**文档原文**：

- `docs/deployment.md:75-122`「环境变量」表 **66 行**——`grep -n 'AGENT_' docs/deployment.md` → **零命中**；
- `docs/atlas/06-infra/env-vars.md`（「环境变量总表（以 .env.example 为准）」）——同样零 `AGENT_*`；
- `docs/design/agent-and-deployment/03-agent-tools-and-boundary.md:75`：「**建议硬编码禁止，不给配置开关**——这是安全红线，不是可调参数」。

**实际**：

- `.env.example:303`：`AGENT_BLOCK_SELF_APPROVAL=false`（注释「G4 四眼原则：true 时发起人不能批准自己发起的 Agent 会话审批单（默认 false，单人部署可处置）」）；
- `apps/admin-api/src/config/configuration.ts:299`（`blockSelfApproval: process.env.AGENT_BLOCK_SELF_APPROVAL === "true"`）；
- 命中即 `403 AGENT_APPROVAL_SELF_DENIED`（`agent.controller.ts:337`，码表 `common/errors/catalog/executor.ts:415`）。

**为什么值得报**：`.env.example` 是「事实源」，但运维不会去读 632 行的 example；`deployment.md` 的 env 表
是本仓最准的一份数字表（第 3 轮核过 16 项全对），缺这一行等于这个安全开关对部署者不存在。
`03:75` 那句「不给配置开关」虽然说的是 `approve_deployment`（确实 `hardDisabled: true`，`tool-registry.ts:811-813`），
但在四眼开关落地后极易被读成「这类开关一律不存在」。

**修法**：`deployment.md` env 表与 `env-vars.md` 各补一行（默认 false / 开启后发起人不能批准自己的审批单 / 拒绝不受限 / 存量 NULL 只 warn）；
`03:75` 补一句「四眼开关管的是**人类发起人**，Agent 侧 `approve_deployment` 仍永久硬禁用」。

### RD-10（P2）G4 `createdBy` 未进数据模型文档

**文档原文**：`docs/design/agent-and-deployment/02-agent-architecture.md:58-73`（`### 3.1 agent_sessions` 表 12 列：
`id/kind/status/title/triggerSource/parentSessionId/contextJson/budgetJson/resultJson/summary/startedAt·finishedAt/createdAt·updatedAt`）
——**无 `createdBy`**；`triggerSource` 那行只写「`user:<id>`」。
`docs/atlas/01-apps/admin-api/modules/agent.md:72`（三张表职责）同样不含。

**实际**：迁移 `1790000000078-AddAgentSessionCreatedBy` 加 `createdBy varchar(64) NULL`（存量 NULL = 未知，不回填）；
三处建会话入口分别写 `user:<name>` / `system:event:<type>` / `system:cron`；响应 DTO 暴露；前端抽屉头部显示「发起人」。

**证据**：`grep -rn "createdBy" apps/admin-api/src/modules/agent --include=*.ts | grep -v spec`；
`ls apps/admin-api/src/migrations | tail -6`。

**修法**：design 02 §3.1 表补 `createdBy`（并说明与 `triggerSource` 的分工）；atlas agent.md 的三表节补一句。

### RD-11（P2）atlas agent 模块路由表 5 条 vs 实际 9 条

**文档原文**：`docs/atlas/01-apps/admin-api/modules/agent.md:55-62`

```text
| GET  | /sessions            | POST | /sessions            |
| GET  | /sessions/:id        | POST | /sessions/:id/resume |
| GET  | /budget              |
```

**实际**（`agent.controller.ts`）：

```text
109 @Get("sessions")        128 @Get("sessions/:id")      148 @Get("sessions/:id/export")  ← G5
178 @Post("sessions")       220 @Post("sessions/:id/resume")
297 @Get("budget")
394 @Post("sessions/:id/approvals/:approvalKey/grant")  405 …/deny   416 @Get("sessions/:id/approvals")
```

**为什么值得报**：这是**模块级地图**（读者查「agent 模块有哪些端点」的第一站）。缺的 4 条里，
`/export` 是 G5 新能力、3 条 approvals 是 G4 四眼开关的**操作面**——即"想用 G4/G5 的人在这个页面找不到入口"。
`check-interface-maps` 只校 `rest-api.md` 的路由前缀，不校模块路由表，所以无害通过。

**修法**：表补 4 行；可选把「模块路由表 ↔ controller 装饰器」纳入 `check-interface-maps`（成本约 30 行，
先例是它已经在做 `@Controller` 扫描）。

### RD-12（P3）env 总表自述规模陈旧：162 行 / 约 80 个 → 实际 632 行 / 133 个

**文档原文**：`docs/atlas/06-infra/env-vars.md:2`（头注）与 `:9`：

> 最后核对: 2026-09-13 · 对应代码: `.env.example`（**162 行**）…
> 共 **20+ 分组、约 80 个变量**，此处列全分组与关键项。

**实际**：

```text
$ wc -l < .env.example → 632
$ grep -cE '^[A-Z][A-Z0-9_]*=' .env.example → 133
```

**为什么值得报**：该页自称「总表」，读者用 162/80 的直觉判断"这里列全了"，而实际变量数已翻 1.6 倍；
`check-env-drift` 只核「代码消费的键是否被 `.env.example` 覆盖」，**不核文档自述**。

**修法**：两处数字改 632 / 133（或干脆去掉行数，改「键数以 `grep -cE '^[A-Z][A-Z0-9_]*=' .env.example` 为准」）；
顺手核一下 41 行表格是否还覆盖关键分组。

### RD-13（P3）「9 个常驻服务」vs 实际 8

**文档原文**：`docs/deployment.md:607`

```text
# 1) 起对象存储（9 个常驻服务不受影响，profile 默认不启用 = 零资源占用）
```

**实际：8 个常驻**：

```text
$ python3 -c "import yaml;d=yaml.safe_load(open('docker-compose.yml'));print(len(d['services']),
  [k for k,v in d['services'].items() if not (v or {}).get('profiles')])"
21 ['postgres','redis','admin-api','admin-web','executor-python','executor-node','registry-pypi','registry-npm']
```

13 个带 profile（monitoring×8 / rustfs×2 / replica / jaeger / backup），21 − 13 = **8**。
同仓 `docs/atlas/06-infra/README.md:56` 就写对了「8 个常驻服务 + profile 服务」。

**修法**：改 8（并建议写成「21 个服务中 13 个在 profile 下」以避免下次加服务再腐）。

### RD-14（P2）守卫体系文档：「怎么加守卫 / 怎么跑」全仓无文档

这是重点 3 的答复。现状四条：

1. **没有「新增守卫」指南**。`README.md` / `AGENTS.md` / `CONTRIBUTING.md` / `docs/**` 里都查不到
   共享 harness `scripts/lib/guard-selftest.mjs`（`grep -rn guard-selftest --include=*.md docs README*.md`
   → 只命中 `PLAN-CLAIMS`/`AGENT_HANDOFF` 的过程记录）。而 T4 已 100%：`check-guards-wired` 自报
   「**46 个守卫有自检，45 个在本地 `test:guards` 与 CI 都真的执行了自检**」。新人加守卫的默认写法
   （进程内 `assert`、不 spawn 真脚本、不断言退出码）正是第 4 轮审计判为「假绿」的那一类。
2. **跑法只在一处**：`docs/audit-playbook.md:29` 有 `npm run test:guards`（审计者手册，不是贡献者入口）。
   而 `CONTRIBUTING.md:119-124` 的「本地跑什么」5 条里**没有** `test:guards`；`docs/atlas/07-testing/README.md:41-58`
   的「运行命令速查表」里也没有（`:40` 只写「不含 `test:guards`」——读者知道有这个名字，但表里查不到怎么跑）。
3. **判据数字过期**：`package.json` 的 `//test:guards` 仍写「**37 个** `check-*.mjs`」，
   实际 `ls scripts/check-*.mjs | wc -l` = **44**，加上 `scripts/docs/check-docs.mjs` 共 **45** 个守卫脚本；
   `//check:docs` 写「21 例自检」，实际 `npm run test:docs` = **23 通过**。
4. **DOC-GOV 判据描述少一条**：`README.md:420`（`dead links / orphan docs / root hygiene`）、`README.md:874`
   与 `CONTRIBUTING.md:122`（`死链 / 孤儿 / 根目录洁癖`）都只写 3 条，实际 4 条（`check-docs.mjs` 头注：
   ① links ② orphans ③ root-hygiene ④ **bare-paths 正文裸路径**）。
5. **量级夸大**：`CONTRIBUTING.md:131`「PR 会触发 **60+ 个 job**」——全仓 10 个 workflow 合计 **52** 个 job，
   其中 PR 会跑的是 `ci.yml` 的 38 个 + `auto-label` 的 1 个 = **39**
   （`python3 -c "import yaml,glob;print(sum(len(yaml.safe_load(open(f))['jobs']) for f in glob.glob('.github/workflows/*.yml')))"` → 52）。

**证据**：上面每条附的命令；另 `check-image-pinned`（CIR-05 第二步，26 条镜像全固定）与
`check-guards-wired` 的第三判据（「有自检 ⇒ 自检必须真被跑」）在文档里**零描述**，
只在 `docs/DEPENDENCY-REVIEW-LOG.md:208` 出现过一次 `check-image-pinned` 的名字。

**修法**：`CONTRIBUTING.md` 加一节（10 行足够）：新增守卫 checklist = ① 用 `scripts/lib/guard-selftest.mjs`
② 本地 `test:guards:repo` 与 CI 两边接线 ③ 带反证（把修好的代码改回去必须红）④ 跑 `check:guards-wired` 确认没有只接一面；
并把 `npm run test:guards` 补进 `CONTRIBUTING.md:119-124` 与 `07-testing/README.md:41-58`；
两处判据描述补「正文裸路径」；`package.json` 两个注释数字改 44/23。

### RD-15（P3）4 处零散失效引用

| file:line | 文档原文 | 实际 | 修法 |
|---|---|---|---|
| `docs/ARCH-28b-turbo-adoption.md:267` | 「`.github/workflows/ci.yml` \| **`repo-guards` job** 接入」 | ci.yml **无** `repo-guards` job（38 个 job 名已列全；同职责现为 `selftests`，另有 `consumer-routes` 等） | 改为 `selftests` job，并注明「原 `repo-guards` 已并入」 |
| `docs/PLAN-CLAIMS.md:24` | 「minio 仅在 **`--profile minio`** + `LOG_STORAGE_DRIVER=s3` 时启用」 | profile 已改名 `rustfs`（`docker-compose.yml:334`），且服务名不再是 `minio`；`--profile minio` 现在直接报错 | 加一句现状注记（历史条目保留原文，但需标「现已 `--profile rustfs`」） |
| `README.md:230` / `README.md:688` / `README.zh.md:206` / `README.en.md:202` | 「`./scripts/demo.sh` … **约 1–3 分钟**」 | 同一份 README `:61`/`:519` 与 `docs/quickstart.md:5` 都写「首次 3–8 分钟」；`scripts/demo.sh:349-350` 首跑要 `compose build admin-api admin-web executor-node` | 统一为「首次 3–8 分钟（要构建镜像），之后 ~30 秒」 |
| `docs/atlas/04-flows/task-lifecycle.md:14` | 「依赖扇出 `triggerDependentTasks`（**task.service.ts:1337**）」 | 定义在 **`task.service.ts:4587`**；`:1337` 落在项目角色解析里（`resolution.status === "unavailable"`） | 行号改 4587（或只留方法名——第 3 轮 DT-11 已建议去裸行号） |

## 6 引用抽查：18 处（重点 5 的答复）

抽查方式：`npm run`（446 处，对 8 个 `package.json` 脚本名并集）、`make`（全量对 `Makefile` 目标）、
workflow 文件名、CI job 名、`check-*.mjs` 名、compose profile 名、代码块内路径。**结论：这一类比预期干净**——
`npm run` / `make` / 相对链接 / 裸路径 **0 处失效**；失效集中在"名字改过但文档没跟"的少数几处。

| # | file:line | 引用 | 判定 |
|---|---|---|---|
| 1 | `README.md:270` | `npm run migration:run` | ✅ 存在于 `apps/admin-api/package.json`（根无，但上下文是 `cd apps/admin-api`） |
| 2 | `docs/operations.md:241` | `npm run migration:run:prod` | ✅（`apps/admin-api`） |
| 3 | `docs/design/agent-and-deployment/06-roadmap.md:56` | `npm run test:deploy-script` | ✅（根 `package.json` = `bash scripts/deploy.selftest.sh`） |
| 4 | `docs/atlas/07-testing/contract-and-selftest.md:67` | `docs-site/scripts/sync-check.selftest.mjs` | ✅（实际 `packages/docs-site/scripts/…`） |
| 5 | `docs/sdk-guide.md:126` | `node examples/scripts/check-task-examples.mjs` | ✅ |
| 6 | `docs/atlas/01-apps/executor-desktop/README.md:75` | `scripts/bundle-executor.sh`（树内相对路径） | ✅（`apps/executor-desktop/scripts/bundle-executor.sh`） |
| 7 | `docs/DEPENDENCY-REVIEW-LOG.md:208` | `check-image-pinned` | ✅ `scripts/check-image-pinned.mjs` |
| 8 | `docs/atlas/06-infra/README.md:74` | `docker compose --profile rustfs\|jaeger\|replica up -d` | ✅ 三个 profile 都在 |
| 9 | `docs/deployment.md:555` | `--profile replica` / `postgres-replica` | ✅ |
| 10 | `docs/deployment.md:631` | `--profile backup up -d pg-backup` | ✅ |
| 11 | `docs/deployment.md:575` | `--profile jaeger up -d jaeger` | ✅ |
| 12 | `docs/atlas/06-infra/deployment-and-ci.md:23` | `actions/labeler@v7` + `.github/labeler.yml` | ✅ 文件在（action 已固定在 40 位 SHA，文档只提版本号，可接受） |
| 13 | `docs/atlas/07-testing/e2e-testing.md`（多处） | 三份 legacy spec 路径 | ✅ 三份都在 `apps/admin-web/e2e/legacy/` |
| 14 | `docs/operations.md:1049` | `npm run migration:*` | ✅ 通配写法（非失效名） |
| 15 | `docs/ARCH-28b-turbo-adoption.md:267` | ci.yml `repo-guards` job | ❌ **不存在**（现 `selftests`）→ RD-15 |
| 16 | `docs/PLAN-CLAIMS.md:24` | `--profile minio` | ❌ **profile 已改名 rustfs** → RD-15 |
| 17 | `docs/api-reference.md:518` | `$upstream` / `$upstream.<dot-path>` | ❌ **不完整**（缺 `$upstream("别名")`）→ RD-03 |
| 18 | `docs/atlas/04-flows/task-lifecycle.md:14` | `task.service.ts:1337` | ❌ **行号错位**（实际 4587）→ RD-15 |

> 另附：围栏代码块内路径扫描（`check-docs` 判据④刻意跳过代码块，本会话单独扫了 741 处），
> 唯一失配是 `docs/design/agent-and-deployment/07-executor-agent.md:112` 的 `apps/executor-agent`
> ——那是**设计稿里的提案目录名**（实际实现落在 `apps/executor-desktop` + `AgentHost`），属历史设计稿口径，不计入本表。

## 7 建议实施顺序

| 批次 | 内容 | 涉及文件 | 为什么这个顺序 |
|---|---|---|---|
| **A. 照做会失败 / 会写错契约**（RD-01 + RD-02 + RD-03 + RD-04） | 重跑 readme-sync 修英文 README；补 `runOnUpstreamFailure` 字段与失败边语义、`$upstream("别名")` 语法；补 `get_session_steps` 与 6 个漏掉工具的 tier | `README.en.md`、`api-reference.md`、`atlas/03-data/entities/task.md`、`atlas/04-flows/task-lifecycle.md`、`atlas/01-apps/admin-web/{domain-modules,components-and-layout}.md`、`design/03` | 这四条都是「按文档做就做错」：英文读者启动失败、多上游 DAG 数据契约缺失、失败补偿编排无处可查、Agent 工具白名单漏项 |
| **B. 新功能的可发现性**（RD-09 + RD-10 + RD-11） | 四眼开关进 env 表；`createdBy` 进数据模型；agent 路由表补 4 行 | `deployment.md`、`atlas/06-infra/env-vars.md`、`design/02`、`atlas/.../modules/agent.md` | 同属 G4/G5 的"操作面"，一次改完一次核 |
| **C. 守卫体系入口**（RD-14） | `CONTRIBUTING.md` 加「新增守卫 checklist」；两处命令表补 `test:guards`；DOC-GOV 判据补第 4 条；`package.json` 两处注释数字 | `CONTRIBUTING.md`、`atlas/07-testing/README.md`、`README.md:420,874`、`package.json`（仅注释） | 它决定"以后还会不会再漂"：现在没有入口告诉新人守卫必须用 harness、必须两面接线 |
| **D. 数字一次性对齐**（RD-05 + RD-06 + RD-07 + RD-08 + RD-12 + RD-13） | 43→56 / 67→69 / 07-testing 五行 / 29→69 / 162→632 / 9→8 | 6 组文件 | 纯数字替换，风险最低；**建议同批把 3 类数字纳入守卫**（README 的 CLI 数、`07-testing` 的 spec/selftest 数、deploy.selftest 汇总行），否则下轮还会漂 |
| **E. 零散失效引用**（RD-15） | `repo-guards`→`selftests`；`--profile minio` 加现状注记；demo 秒数统一；`task.service.ts:4587` | 4 处 | 单行级，可搭任意 PR |

**跨批纪律**：`README.en.md` / `README.zh.md` 是**生成产物**，必须先改 `README.md` 再跑 `readme-sync`，
否则生成器会把旧值刷回去（第 3 轮 DT-06/DT-07 就是这个顺序问题的两次复现）。

---

### 与同批其他报告的关系

本报告只谈「文档与代码事实是否一致」，不重复 round3 的 `ci-release` / `security` / `db` 等域结论，
也不重复 round4/5/6 INDEX 已登记的实施项。所有"实际值"都是本会话当场重跑所得，
命令与口径逐条写在条内，便于在工作区继续变动后复核。

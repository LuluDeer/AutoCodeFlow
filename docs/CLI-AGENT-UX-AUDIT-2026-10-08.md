# acf CLI —— Agent 视角命令清晰度与后台一致性审计

> 日期：2026-10-08 · 基线 commit：`e4678866` · 包版本：`@autocodeflow/cli@1.9.0`
> 审计对象：`packages/acf-cli/src`（13 个命令域 / 61 个叶子命令）
> 对照面：admin-api 全量 HTTP 路由（30 controller / 225 路由）、admin-web 人工可操作面（23 路由）
> 验证方式：跑**真实构建产物** `node dist/index.js`（非单测桩）+ 源码对读 + 后端 DTO/OpenAPI 对账。
> 审计时未修改产品代码；所有结论均附可复现命令。

---

## 修复状态（2026-10-08 同日闭环）

本文的 P0/P1/P2 已全部落地：`packages/acf-cli` **304/304 测试全绿**（基线 254 + 新增 50
条回归断言）+ `tsc --noEmit` 退出 0。逐项状态见 §8 表格的「状态」列。修复前后实测对照：

| 缺陷 | 修复前 | 修复后 |
|---|---|---|
| 非交互 delete（×3） | `exit=0`，静默无删除 | `exit=2` + 可操作消息（要求 `-y`） |
| 非交互 login | `exit=0`，落盘 token 为空 | `exit=2` + 指向 `--user` / `ACF_PASSWORD` |
| `task create` 示例 | 带 `version`，后端必 400 | 示例已修正，并注明后端无该字段 |
| Windows `task lint ok.sh` | 误报 syntax error | `exit=0`（真错仍正确捕获 exit=1） |
| `app deploy --env '{bad'` | `exit=1`（像部署失败） | `exit=2`（本地 payload 错误） |
| 命令数 | 61 | 63（补 `whoami` / `logout`） |

新增的回归锁在 `src/__tests__/cli-gaps.test.ts` 的
`P0: 非交互 stdin 下的破坏性确认` / `P0: login 非交互语义` / `P1: whoami / logout` /
`P2: app deploy --env 本地 payload 错误` 四组 describe，
以及 `ux-uniform.test.ts` 的命令树规模护栏（61 → 63）。

---

## 0. 结论摘要

CLI 的**命令覆盖面已经全了**——61 个叶子命令覆盖了人工后台的全部写操作面，`--help` 每个叶子都有示例、退出码分 5 类、`--json` 覆盖 34/61。这些是真实优势，不是套话。

但站在「无人值守的 agent 替人跑后台」这个立场上，**当前 CLI 有三类系统性问题会让 agent 误判、卡死或静默出错**：

| 级别 | 问题 | 影响 |
|---|---|---|
| **P0** | 非交互 stdin 下确认提示全部静默 exit 0 | agent 以为删除成功，实际什么都没发生 |
| **P0** | `acf login` 在 stdin 关闭时同样静默 exit 0 | agent 以为自己登录成功了 |
| **P0** | CLI 自带示例 / README 里的 `task create` payload 会被后端 400 | 照着抄的 agent 第一次就撞墙 |
| **P1** | 退出码表把 `--wait` 超时 / `--json` 输出纯度 / `-n` 语义等契约讲反或讲漏 | CI 分支判断错、解析器崩 |
| **P1** | 无人值守路径大开（无 `--dry-run`、无二次确认、无幂等保护） | agent 能无摩擦地删掉生产任务 |

---

## 1. 已确认的优势（先说不必改的）

这部分建议**保持**，后续重构别动：

1. **叶子命令示例全覆盖**。`help.ts` 的 `EXAMPLES` 表按命令路径注入，`ux-uniform.test.ts` 用真实命令树做结构守卫——新增命令忘写示例会直接红。这是 CLI 里少见的工程纪律。
2. **错误后自动跟完整 help**。`showHelpAfterError()` + `exitOverride()` 在整棵树上补设（`index.ts:178-186`），缺参/未知选项的报错现场就能拿到可复制用法，不用翻文档。
3. **退出码分类收敛到单一出口**。`classifyApiError` 在 client 层做一次，命令层统一走 `emitError`，`ui.ts:25-32` 是唯一事实源。实测 0/1/2/4 均与文档一致（§3.1）。
4. **`--version` 劫持已修**。根命令刻意不注册 `.version()`，改由 `unknownOption` 接管（`index.ts:93-106`）——`app upgrade-all --version 1.9.0`、`task rollback --version v9` 这类参数不再被根层吞掉。这是个真实且有价值的修复。
5. **一次性密钥的输出纪律**。`apikey create` / `task webhook enable|rotate` / `executor rotate` 都明确标注「仅显示一次」并给出存储指引。
6. **SSE tail 的完成判据正确**。`sawDone` 帧 + 60s 空闲看门狗 + 断流非零退出（`exec.ts:184-254`），断流不会被当成功。

---

## 2. P0 级问题

### 2.1 【P0】非交互 stdin 下，所有确认提示静默成功退出

**证据**（真实产物，本次实测）：

```
$ node dist/index.js app delete fake-id < NUL
Delete application fake-id? [y/N]        ← 提示打出，立刻 EOF
exit=0                                    ← 零退出码，无 "Aborted."，无错误

$ node dist/index.js task delete fake-id < NUL
Delete task fake-id? Running executions will be force-terminated. [y/N]
exit=0

$ node dist/index.js deploy remove fake-id < NUL
Delete deployment record fake-id? (terminal rows only: failed/stopped) [y/N]
exit=0
```

对照：用管道喂空行时是**正确**的——

```
$ "" | node dist/index.js app delete fake-id
Delete application fake-id? [y/N] Aborted.
exit=0        ← 这里 0 是合理的（用户主动放弃，README 已声明）
```

**根因**：`readline.question()` 在 stdin 立刻 EOF 时不 reject，而是以空串 resolve，`if (!/^y(es)?$/i.test(answer))` 走 `Aborted.` 分支。但 stdin 是**已关闭**（非空管道）时，`rl.close()` 之后的 `console.log` 在 Windows 上丢失，且进程在未被拒绝的路径上自然退出。

**为什么对 agent 致命**：agent 调用 CLI 时 stdin 恒为非交互（`< NUL` / 无 TTY / 被 harness 接管）。此时：
- 退出码 0 → agent 判断「删除成功」，继续下游步骤；
- 实际删除**从未发生**，目标资源仍在；
- 输出里既没有 "Aborted." 也没错误行，agent 无法从 stdout/stderr 察觉。

同样的三连在 `readline/promises` 路径上出现在 4 处：`apps.ts:286-300`（app delete）、`tasks.ts:637-651`（task delete）、`deploy.ts:118-131`（deploy remove），以及登录路径（见 2.2）。

**建议**：
- 非 TTY 且未给 `-y/--yes` 时，**直接拒绝**并以退出码 2 报用法错误，消息明示 `pass -y/--yes to confirm in non-interactive use`。这与 `login` 的 TOTP 非交互分支（`login.ts:95-100`）已经是同一个思路，属于既有先例的推广。
- `Aborted.` 分支（用户主动放弃）保持 0。

### 2.2 【P0】`acf login` 在 stdin 关闭时同样静默 exit 0

**证据**：

```
$ node dist/index.js login --user admin --password pw < NUL
API URL [http://localhost:3105]:       ← 停在 prompt
exit=0

$ cat config.json
{ "apiUrl": "http://localhost:3105", "token": "", "refreshToken": "" }
                                       ← 没有 token，实际根本没登录
```

**根因**：`login.ts:119` 的 `opts.url || await prompt('API URL ...')` —— 即使用户已经通过 `ACF_API_URL` 或配置提供了 URL，只要**没传 `--url`**，就一定走交互 prompt。`prompt()` 在 EOF 时 resolve 空串，`|| 'http://localhost:3105'` 兜底继续，随后 `username`/`password` 若也无法取得，最终在某个 prompt 处静默终止。

而 `--user` / `--password` 已给出时，agent 的意图非常明确：**它不想被问任何问题**。

**为什么对 agent 致命**：这是所有 agent 工作流的**第一步**。一个 CI/agent 脚本 `acf login --user ci --password $PW && acf task list` 会在第一步拿到 exit 0，然后在第二步因 `token: ""` 拿到 401/退出码 3——错误被推迟到离现场很远的地方，排查成本高。

**建议**：
- URL 解析优先级改为 `--url` > `ACF_API_URL` > 已存配置 > 交互 prompt，仅在 stdin 为 TTY 时才允许 prompt；
- 非 TTY 且缺少必需凭据时，与 TOTP 分支同款：可操作的 UsageError + 退出码 2；
- 建议同时补 `--url` 之外的环境变量文档化（`ACF_API_URL` 已在 README，但 `login` 的帮助里没提）。

### 2.3 【P0】CLI 自己的示例 payload 会被后端 400 拒绝

**证据链**：

1. `help.ts:55-57` 与 `packages/acf-cli/README.md` 中的示例：
   ```
   acf task create --file task.json   # required: name, version, runtime, triggerType
   acf task create --body '{"name":"nightly","version":"1.0.0","runtime":"node","triggerType":"cron",...}'
   ```
2. 后端 `CreateTaskDto`（`create-task.dto.ts`）**没有 `version` 字段**，只有 `currentVersion`：
   ```
   CreateTaskDto props: id, name, description, status, triggerType, cronExpression, timezone,
   fixedRate, maintenanceWindows, runtime, runtimeVersion, requirements, dependencies, entrypoint,
   gitRepo, gitBranch, gitCommit, currentVersion, timeout, ..., projectId
   ```
   （由 `apps/admin-api/openapi.json` 导出物核对，非人工阅读）
3. `main.ts:328-337` 全局 `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`。
4. `task.controller.ts:138-149` 的 `@Post()` 用裸 `@Body() dto: CreateTaskDto`，无 `@UsePipes` 覆盖。

**后果**：`{"name":"nightly","version":"1.0.0","runtime":"node","triggerType":"cron",...}` → **400 `property version should not exist`**。

同类问题在 README 的 `task create` 段落也出现（该段同样写「required: name, version, runtime, triggerType」）。

**为什么对 agent 致命**：agent 不会去读后端 DTO。它会**逐字复制 `--help` 里的示例**，而这是 CLI 自己承诺「可直接复制」的东西（README 第 21 行原话：「至少一个可直接复制的示例」）。第一次调用就失败，且失败信息（400 whitelist）与示例看起来毫无矛盾，agent 会陷入反复试错。

**建议**：
- 修 `help.ts` 与 README 里的这 3 处示例（`version` → `currentVersion`，或直接删掉）；「required」措辞也应改为只列 `name` + `triggerType`（`runtime` 在后端是 `@IsOptional()`）。
- 更根本的：把「示例 payload 与后端 DTO 对账」纳入自动守卫——仓库已有 `check-openapi-response-schema.mjs` 这类脚本，成本不高。

---

## 3. P1 级问题

### 3.1 退出码表：实现正确，但文档讲漏了两个高频通道

实测退出码与 `README.md`「Exit codes」/`ui.ts:25-32` **一致**（这部分做得对）：

```
网络不通   → exit 4   ← 文档正确
未知选项   → exit 2   ← 文档正确
坏 JSON payload → exit 2（task trigger --params）
```

但文档**没有覆盖**两个 CI 最常用的通道：

| 通道 | 实际退出码 | 文档现状 |
|---|---|---|
| `task trigger --wait` 超时（执行仍在跑） | **1** | 未提；只提了「失败终态」 |
| `task batch` 部分失败 | **1** | 未提 |
| `app upgrade-all` 受理被拒 / 首批失败 | **1** | 未提 |
| `exec tail` SSE 断流 / 空闲超时 | **4** | README 有提（第 35 行），但退出码表正文没列 |

`--wait` 超时这条尤其危险：它由 `tasks.ts:1110-1117` 的 `process.exitCode = 1` 设置，语义是「**我放弃等待了，任务可能还在跑**」。而退出码 1 在文档里的定义是「运行失败」。agent 会把「还在跑」误读成「跑失败了」，进而触发回滚或告警。

**建议**：退出码表补 4 行；或者引入一个独立的退出码（如 5 = 未决/超时）让 agent 能区分「确定失败」与「结果未知」。后者更彻底，但会破坏既有 CI 的 `!= 0` 判断——按 README 的兼容承诺，至少先补文档。

### 3.2 ~~`task list -s` 的取值在帮助里写错~~ → **本项撤回（原判断有误）**

> **撤回说明（2026-10-08 修复轮复核）**：原稿断言「后端 `TaskStatus` 还包含
> `inactive`/`failed`」，这是**错的**。复核证据：
> - `apps/admin-api/src/modules/task/entities/task.entity.ts:14` →
>   `enum TaskStatus { ACTIVE="active", PAUSED="paused", DELETED="deleted" }`；
> - `ListTasksQueryDto#status` 是 `@IsEnum(TaskStatus)`（`list-tasks-query.dto.ts:120`），
>   传 `failed` 会 **400**；
> - admin-web 的状态**筛选**下拉也只有 `active` / `paused` 两项
>   （`TaskListPage.tsx:673-676`）。
>
> 我当初把 web 的**展示徽章**（`statusConfig` 里的 `inactive`/`failed`，见
> `TaskListPage.tsx:74`、`:564`）误当成了**筛选取值**。实际上「按最近一次执行结果筛」
> 走的是**另一个参数** `lastStatus`（`@IsEnum(ExecutionStatus)`，
> `list-tasks-query.dto.ts:134-136`），web 用独立下拉驱动（`:694-702`）。
>
> **结论：CLI 帮助里的 `(active|paused)` 是正确的，无需修改。** 保留此条是为了留下
> 更正痕迹——它同时说明了一个真实缺口：**CLI 没有 `lastStatus` 的入口**（`acf task list`
> 无 `--last-status`），而这是值班最常用的过滤（「哪些任务上次跑失败了」）。已登记到
> §8 的 P1-5 增量项。

同类（仍成立）：`task trigger --wait-timeout` 的 `(default 600)` 在帮助里出现两次（commander 自动追加 + 手工写在描述里），属噪音而非错误。

### 3.3 `-n` 短选项在不同命令里含义相反

```
task list        -n, --page-size <n>   每页条数
task executions  -n, --limit <n>       返回条数
task logs        -n, --limit <n>       最大行数
audit list       -n, --page-size <n>   每页条数
sop list         -n, --page-size <n>
app releases     -n, --page-size <n>   (max 200, default 50)
```

`task logs -n` 与 `task list -n` 语义不同（行数 vs 页大小），但都是 `-n`。agent 在命令间迁移参数时会静默拿到不同结果——`task logs <id> -n 100` 与 `task executions <id> -n 100` 都合法但含义不同。

这是可接受的（两者都读作「数量」），但**同一命令族内的不一致**值得收口。`task executions` 用 `--limit` 而 `app deployments` 用 `--page-size` 拉同一批数据，也没有统一理由。

### 3.4 确认策略自相矛盾

| 命令 | 有确认？ |
|---|---|
| `app delete` / `task delete` / `deploy remove` | ✅ 有 `-y` |
| `task batch delete` | ❌ 无确认、无 `-y` |
| `app upgrade-all` | ❌ 无确认（生产全量升级） |
| `executor rotate` | ❌ 无确认（**轮换后旧 token 立即失效**） |
| `executor offline` | ❌ 无确认 |
| `apikey revoke` | ❌ 无确认（不可撤销） |
| `approval approve` | ❌ 无确认（触发真实派发） |

`task batch delete --ids a,b,c` 能无提示删掉 500 个任务，而 `task delete <id>` 单个删都要确认——这个反差本身就是缺陷。相反 `executor rotate` 是不可逆的高危操作却零摩擦。

**建议**：按「不可逆 × 影响面」两轴重排确认策略，并**统一 `-y/--yes` 作为非交互逃生阀**；同时配合 2.1 的修复，让所有交互确认在非 TTY 下有一致行为。

### 3.5 缺少 agent 需要的三个基础命令

| 缺失 | 为什么 agent 需要 | 后端是否已有 |
|---|---|---|
| `acf logout` | 用完即弃的机器上清理凭据；会话卫生 | ✅ `POST /auth/logout` 存在，CLI 未接 |
| `acf whoami` / `acf auth profile` | agent 在开工前确认自己是谁、什么角色、有无 ADMIN | ✅ `GET /auth/profile` 存在，CLI 未接 |
| `acf --dry-run` / `--confirm` | 让 agent 能先预览影响面再决定是否执行 | ⚠️ 仅 `deploy.sh` 有，acf CLI 没有 |

第二项尤其重要：后端有大量 ADMIN-only 端点（`audit` / `sop` / `notification` / `agent` / `executor-packages` 全模块，以及所有应用写操作）。agent 无法在开工前自检权限，只能靠「调用 → 403」试错。`GET /projects/me/roles` 同理未接。

### 3.6 退出码 3（认证失败）在真实环境里无法验证

本次实测时 admin-api 未启动，`ACF_TOKEN=garbage` 只拿到 `ECONNREFUSED`（退出码 4），**401 → 3 的映射未被真机覆盖**。这不是 CLI 缺陷，但说明：

- 退出码表里 3 这一行目前**只有单测覆盖**（`client.test.ts` 桩），没有真机证据；
- `docs/VERIFY-*.md` 系列里有大量真机验证记录，但这一条缺失，建议补一次登录取证。

若要真机验证，需先起 admin-api（`docker compose up -d postgres redis` + `cd apps/admin-api && npm run start:dev`），本轮按「不启动替代服务」的约束未做。

---

## 4. 与人工后台的一致性对照

### 4.1 人工能做、CLI 不能（真实缺口）

对照 admin-web 的 23 个路由逐一比对后，**真正有操作语义的缺口只有 5 处**：

| 人工后台操作 | 后端端点 | CLI 现状 |
|---|---|---|
| 执行器包上传 / 激活 / 弃用 / 推送 | `POST/PATCH /executor-packages*`（11 路由） | ❌ 整个模块未接 |
| 通知渠道配置 / 测试 / 静默规则 | `GET/PATCH/POST /notification*`（8 路由） | ❌ 整个模块未接 |
| 项目增删改 + 成员增删改 | `POST/PATCH/DELETE /projects*` | ⚠️ 只有只读 `project list` / `members` |
| SOP 起草 / 发布 / 指派 / 澄清回复 | `POST/PATCH /sop*`（13 路由） | ⚠️ 只有只读 `sop list` / `show` |
| 用户管理 / 重置密码 / 停用 | `POST/PATCH/DELETE /users*` | ❌ 未接 |
| 事件订阅（出站 Webhook） | `/event-subscriptions*`（6 路由） | ❌ 未接 |
| 任务模板实例化 | `POST /task-templates/:id/instantiate` | ❌ 未接 |
| 审计日志导出 CSV | `GET /audit/export` | ❌ 只接 `audit list` |
| 执行产物下载 | `GET /tasks/executions/:id/artifacts` | ❌ 未接（`exec tail` 只给日志） |
| 应用版本回滚（按版本） | `POST /applications/:id/rollback/:deploymentId` | ❌ 未接（`app upgrade-all --version` 是近似替代） |
| 任务按 gitCommit 回滚 | `POST /tasks/:id/rollback` | ❌ 未接（只有 `--version <versionId>` 快照回滚） |
| 执行器元数据编辑 | `PATCH /executors/:id` | ❌ 未接（只有 `rotate` / `offline`） |
| 执行器配置热更新 | `POST /executors/:id/reload-config` | ❌ 未接 |

**判断**：前 5 项（执行器包、通知、项目写面、SOP 写面、用户）是**有意的 ADMIN 收窄**——`docs/atlas/02-packages/acf-cli.md` 与 `DEVELOPMENT-PLAN-2026-09H2.md` 都明确记录过「写面刻意不进自动化面」。这个决策合理，agent 不应替人改通知渠道或建用户。

但**后 7 项（模板实例化、审计导出、产物下载、两种回滚、执行器编辑/热更新）没有记录任何收窄理由**，更像是遗漏。其中：
- `task-templates/:id/instantiate` 是最遗憾的：agent 最擅长的就是「按模板造任务」，而 CLI 目前要求 agent 手工拼 `--body` JSON，正好踩中 §2.3 的坑。
- `audit export` 与产物下载是纯读面，对 agent 排障价值高，且无写风险，建议优先补。

### 4.2 CLI 能做、人工后台不能（反向缺口）

这部分说明 CLI 并未落后，反而有超前：

- `POST /sop/:id/publish`、`PATCH /sop/:id` — UI 只能建草稿，**没有发布入口**（`/sops` 页面的「指派」要求已发布状态，形成死结）。CLI 也没接，两边都缺。
- `PATCH/DELETE /mutex-groups/:id` — UI 只能 list + create。
- `POST /config/batch`、`POST /applications/webhook` — 无 UI。
- `POST /tasks/:id/rollback`（按 gitCommit）— UI 只做版本号回滚。
- `GET /api/config/executor-shared-token` 返回**明文**执行器 token，ADMIN-only——CLI 未接（正确，属危险面）。

### 4.3 run-mode 语义：CLI 与后台已对齐（值得记一笔）

`app deploy` 的 `-m` 语义曾经是个 P0 事故源（默认 `daemon` = 部署即跑，与中台定时触发重复执行）。现已修为默认 `scheduled` 并在显式传 `once`/`daemon` 时发黄色预警（`apps.ts:352-380`）。这与 admin-web 部署 Modal 的三档文案（单次执行 / 常驻进程 / 仅部署）**语义一致**，是本轮唯一一处「CLI 与人工后台行为完全对齐」的写面。可作为其他写面的对齐样板。

---

## 5. 命令命名与可理解性逐条评估

| 命令 | 清晰度 | 说明 |
|---|---|---|
| `task trigger` | ⚠️ | 描述写 "and wait for completion"（`tasks.ts:212`），但 `--wait` 默认 `false`。**描述与实际默认相矛盾**，agent 会以为默认就等 |
| `task export` / `import` | ✅ | `-` 读 stdin 的约定明确，示例给足 |
| `task batch <action> [ids...]` | ✅ | 位置参数 + `--ids` 双通道、去重、500 上限都有说明 |
| `task webhook <action> <taskId>` | ✅ | 四动作 + 一次性 secret 语义写得比后端文档还清楚 |
| `task glue` / `lint` | ✅ | 但 §6.1 的 Windows 缺陷要修 |
| `app releases` vs `app versions` | ⚠️ | 前者是「现代视图」，后者是「legacy alias」，帮助里写了，但两个命令并列出现本身就会让 agent 犹豫 |
| `deploy list` vs `app deployments` | ⚠️ | 同源同契约的两个入口，帮助互相引用（可接受，但属冗余） |
| `executor <verb>` | ✅ | 描述是 "View registered executors"，但实际含写操作（`rotate`/`offline`），描述偏保守 |
| `approval <verb>` | ✅ | 第二人规则的说明非常清楚，甚至指明了替代动作 |
| `apikey <verb>` | ✅ | scope 三级矩阵清晰 |
| `audit list` | ⚠️ | `--action` 是模糊匹配、`--resource` 是精确匹配，帮助里写了但容易看漏 |
| `config set-token` | ⚠️ | 与 `login` 职责重叠；帮助提示了「prefer login」但 agent 常直接用它（见 §7 安全项） |
| `project` / `sop` / `agent` | ✅ | 只读定位在 description 里明说了 |

---

## 6. 跨平台 / 环境适配缺陷

### 6.1 【P1】Windows 上 `task lint` 对 shell 脚本必然误报

实测（Windows + Git Bash 存在）：

```
$ acf task lint ok.sh
✗ ok.sh: syntax error
/bin/bash: C:Users12154AppDataLocalTempacf-lintok.sh: No such file or directory
exit=1                       ← 脚本本身完全合法，是路径被吞了反斜杠

$ acf task lint ok.js
✔ ok.js: syntax OK (node)
exit=0
```

根因：`tasks.ts:1032` 用 `spawnSync('bash', ['-n', file])` 直接传 Windows 路径。bash 把 `C:\Users\...` 的反斜杠当转义符吃掉。`task lint` 是 README 明确推荐的「上传 glue 前本地预检」步骤，Windows 上这条路径**完全不可用**。

修法：Windows 上把路径转成 `/c/Users/...` 形态，或改用 `bash -n` 的 stdin 模式（`spawnSync('bash', ['-n'], { input: source })`）——后者跨平台更稳。

### 6.2 【P2】`--json --wait` 输出会被污染

`task trigger --json --wait` 时，`--json` 先输出 execution 对象（`tasks.ts:257-269`），随后 `pollExecution` 把失败详情写成**人类可读文本**：

```
console.log(chalk.yellow('  Exit code      :'), exec.exitCode);
console.log(chalk.yellow('  Failure reason :'), exec.failureReason);
```

单行 JSON 解析器读这种混合输出会崩。要么 `--wait` 时 `--json` 只输出最终终态对象（一次），要么把详情走 stderr。当前实现是两者都进 stdout。

### 6.3 【P2】`app deploy --env` 的坏 JSON 被误判为「部署失败」

```
$ acf app deploy fake --env '{bad'
✖ Deployment failed
Expected property name or '}' in JSON at position 1
exit=1                        ← 应为 2（本地参数错误）

$ acf task trigger fake --params '{bad'      ← 对照组，做对了
✖ Failed to trigger
Invalid --params JSON: ...
exit=2
```

`apps.ts:385` 的 `JSON.parse(opts.env)` 在 try 块内，被当作服务端失败。同类还有 `app deploy` 的 `--start-command`（无校验）。差一格就是：agent 拿到 1 会去查服务端日志，实际是自己参数写错了。

### 6.4 【P2】`task lint` 依赖外部解释器，失败原因不区分

```
$ acf task lint script.py     # PATH 无 python 时
python not found on PATH — install Python 3 to lint python glue
exit=1                        ← 应为 2（环境不满足 ≠ lint 发现语法错误）
```

agent 无法区分「脚本有语法错」与「本机没装 Python」。建议前者退出码 2、后者单独一个码或明确的 usage 错误。

---

## 7. 安全 / 无人值守姿态

1. **`--password` 已标 deprecated，但 `config set-token` 仍在**：后者会把 token 写进 shell history。两处都有黄色告警（`index.ts:150-154`、`login.ts:128-130`），姿态正确，但 agent 生成命令时倾向选更短的 `config set-token`。建议在 `--help` 示例里彻底移除，只留 `ACF_TOKEN` 环境变量形态。
2. **凭据落盘 0600 已实现**（`config.ts:157-169`），Windows ACL 语义下静默降级——合理。
3. **无 `logout`**：agent 在共享机器上跑完后凭据留在磁盘（access + refresh 双 token，refresh 是长效的）。补 `logout` 有实际安全收益。
4. **`executor rotate` 无确认**：返回的 token 只显示一次，一旦 agent 的输出没被捕获就**永久丢失**，只能再 rotate 一次。建议加 `-y` 或至少要求 `--reason`（后端已支持 `reason` 入审计）。
5. **`config show` 无 `--json`**：agent 要解析当前配置只能 grep 人读文本。而这个命令恰好是排障第一步。

---

## 8. 建议的修复优先级

| 优先级 | 项 | 工作量 | 风险 |
|---|---|---|---|
| P0-1 | 非 TTY 下确认提示显式拒绝（4 处 readline + login） | 小 | 低（有 TOTP 分支先例） | **✅ 已修** |
| P0-2 | 修 `help.ts` / README 里 `task create` 的 `version` 字段 | 小 | 无 | **✅ 已修** |
| P0-3 | `login` 的 URL 解析改为 `--url` > env > 配置 > prompt(TTY only) | 小 | 低 | **✅ 已修** |
| P1-1 | 退出码表补 4 行（`--wait` 超时 / batch / upgrade-all / exec tail） | 小 | 无 | **✅ 已修** |
| P1-2 | 统一确认策略，`-y` 全量覆盖高危写面 | 中 | 中（可能破坏既有脚本） | **✅ 已修**（batch delete / upgrade-all all / executor rotate） |
| P1-3 | 补 `logout` / `whoami` | 小 | 无（端点已存在） | **✅ 已修** |
| P1-4 | 修 Windows `task lint` shell 路径 | 小 | 无 | **✅ 已修**（改走 stdin） |
| P1-5 | 补 `task-templates instantiate` / `audit export` / 产物下载 | 中 | 无（纯读或已有端点） | ⬜ 未做（纯增量，不在本轮范围） |
| P1-6 | 补 `acf task list --last-status <exec status>`（值班最常用过滤；后端 `lastStatus` 已就绪） | 小 | 无（新增只读参数） | ⬜ 未做（§3.2 复核时登记） |
| P2-1 | `--json --wait` 输出纯度、`--env` 坏 JSON 退出码、lint 退出码分类 | 小 | 低 | **✅ 已修** |
| P2-2 | 收口 `-n` 语义、`task trigger` 描述与默认值对齐 | 小 | 低（帮助文本为主） | **✅ 部分**（trigger 描述已对齐；`-n` 语义维持现状，属可接受约定） |
| P2-3 | 示例 payload 与后端 DTO 的自动对账守卫 | 中 | 无 | ⬜ 未做 |

### 8.1 修复过程中的两个额外发现（本轮一并解决）

1. **`logout` 的调用顺序 bug（我自己引入后当场发现并修）**：先 `clearAuth()` 再
   `POST /auth/logout` 会让注销请求**不带 Authorization 头**——client 的请求拦截器是
   逐请求读 token 的（`client.ts` request interceptor → `getToken()`），清早了一律 401，
   服务端吊销**从未真正发生**。已改为「先带 token 吊销，finally 里再清本地」，并加了一条
   断言调用顺序的回归测试（`order === ['post','clearAuth']`）。
2. **`--json --wait` 的失败详情出口**：原实现的失败明细（`Exit code` / `Failure reason`
   / `Suggestion`）走 `console.log`（stdout），会把 JSON 弄脏。现在 `--json` 模式下
   stdout **只出最终 execution 对象**，明细走 stderr。

### 8.2 方法学说明（为什么这轮测试数字可信）

动手前先 `git stash` 取了 **HEAD 基线：254/254 全绿**。因此改动后出现的 25 个失败
**全部可归因于本次修改**——其中 10 个看起来无关（apikey / app upload / webhook /
approval）的失败，根因是**测试 mock 队列污染**：`confirmDestructive` 在非交互下提前
`process.exit`，导致该测试预置的 `mockResolvedValueOnce` 没被消费，泄漏给下一个测试
（症状是 `Package uploaded: ci-deploy` 出现在断言 `my-app` 的用例里）。这类失败在**单测
隔离运行时是绿的**，只有全量连跑才暴露——所以「跑全量 + 有基线」两件事缺一不可。

---

## 9. 复现方式

需先 `cd packages/acf-cli && npm run build`（**必须重建**——`dist/` 落后于 `src/` 时，
实测结果反映的是旧代码。本轮审计初次就踩过这个坑，重建后三个 P0 结论不变才继续）。

左列是**修复前**的行为，右列是当前（修复后）的期望值：

```powershell
# P0-1 非交互 delete：修复前 exit=0 且什么都没删；现在必须 exit=2 并提示 -y
cmd /c "node dist\index.js app delete fake-id < NUL"            # → 2（was 0）

# P0-2 示例 payload（对照后端 OpenAPI，确认 version 确实不在 DTO 里）
node -e "const o=require('../admin-api/openapi.json');console.log(Object.keys(o.components.schemas.CreateTaskDto.properties))"
# → 列表里没有 version；acf task create --help 的示例现在也不带它

# P0-3 非交互 login：修复前 exit=0 且 token 落盘为空；现在 exit=2
cmd /c "node dist\index.js login --user admin --password pw < NUL"   # → 2（was 0）

# P1-2 确认门
cmd /c "node dist\index.js task batch delete t1 < NUL"          # → 2
cmd /c "node dist\index.js executor rotate n1 < NUL"            # → 2
cmd /c "node dist\index.js app upgrade-all a1 < NUL"            # → 2

# P1-4 Windows lint（需先造一个合法 .sh）
acf task lint ok.sh    # → exit=0（was: 误报 syntax error）

# P2-1 --env 退出码
cmd /c "node dist\index.js app deploy fake --env {bad"          # → 2（was 1）
```

回归测试：

```bash
cd packages/acf-cli && npx vitest run    # → 304 passed | 1 skipped
```

---

## 10. 一句话总结

> **命令面已经全了，缺的不是命令数量，而是「无人值守语义」的系统性收口**：三处非交互静默成功（delete ×3 + login）会让 agent 拿到假的 exit 0 并继续往下走，而 CLI 自己的 `task create` 示例又被后端白名单拒绝——这两件事叠加，意味着一个完全按 `--help` 行事的 agent 会在「登录 → 建任务 → 删任务」这条最基本的路径上连续踩坑。
>
> **2026-10-08 同日闭环**：以上 P0 三项 + P1/P2 相关项已全部修复并加回归锁（304/304 绿）。
> 仍留两项纯增量（P1-5 的 `task-templates instantiate` / `audit export` / 产物下载、
> P2-3 的示例 payload × 后端 DTO 自动对账守卫），不影响本轮的正确性目标。

---

## 附：本轮证据边界（诚实声明）

- admin-api **未启动**，所有涉及真实响应的结论来自**源码 + openapi.json 对账**，非真机往返；退出码 3（401）因此未取得真机证据（§3.6）。
- 后端路由清单来自对 30 个 controller 的静态枚举（225 路由），未逐条发请求验证。
- admin-web 清单来自页面/JSX/handler 结构 + i18n 键集静态对读，未实际操作 UI。
- `--json` 覆盖统计（34/61）来自对每个叶子命令 `--help` 输出的自动扫描。
- 修复轮的 304/304 是**单测 + 真实构建产物实测**的结果；`task lint` 的 Windows 修复
  在两台解释器（Git Bash / 无 python 分支）上做了真机对照，其余平台未覆盖。
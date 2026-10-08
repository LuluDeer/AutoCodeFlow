# CLI 命令地图（acf，63 个子命令）
> 所属: docs/atlas/05-interfaces · 最后核对: 2026-10-08 · 对应代码: packages/acf-cli/src（index.ts + commands/ 12 个文件）

## 怎么连

- 包 `@autocodeflow/cli`，bin 名 **`acf`**（`packages/acf-cli`：`npm run build` 后全局 link 或 `npx` 调用）。
- 目标是 admin-api 的 REST（同 [rest-api.md](rest-api.md)），默认 `http://localhost:3105`。

## 配置与鉴权

| 方式 | 说明 |
|---|---|
| `acf login --url … --user … --password …` | 交互登录，access+refresh token 存本地 conf（projectName `acf-cli`），文件 0600（SEC-NEW-4）；TOTP 账号加 `--code <6位码>` |
| `acf config set-url <url>` / `set-token <token>` / `show` | 手工维护配置 |
| 环境变量 `ACF_API_URL` / `ACF_TOKEN` / `ACF_REFRESH_TOKEN` | 每次调用注入，**不落盘**——CI/cron 推荐方式 |
| 全局选项 `--api-url <url>` / `--token <token>` | 单次覆盖（preAction 写回 env） |

优先级：CLI 选项 > 环境变量 > conf 存储。CLI 不持有 executor token；执行器面操作不在命令范围内。

## 命令地图（12 个域 + config，共 63 个子命令）

### login / config（6）

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `acf login` | 登录并保存凭证 | `--url` `--user` `--password` `--code`（TOTP） |
| `acf whoami` | 打印当前凭据的身份与角色（开工前自检 ADMIN-only 面） | `--json` |
| `acf logout` | 服务端吊销会话 + 清本地凭据（**先吊销再清**，顺序见源码注释） | — |
| `acf config show` | 查看当前配置 | — |
| `acf config set-url <url>` | 设置 API 基地址 | — |
| `acf config set-token <token>` | 直接写入 token（提示优先 login/ACF_TOKEN） | — |

> **无人值守语义（2026-10-08，CLI-AGENT-UX-AUDIT）**：`app delete` / `task delete` /
> `task batch delete` / `deploy remove` / `app upgrade-all`(all) / `executor rotate`
> 都有确认门；**stdin 非 TTY 时缺 `-y/--yes` 以退出码 2 拒绝**（既不静默放行也不
> 静默取消）。`login` 在非交互下不会对地址/用户名/密码发问，缺 `--user` 或
> `ACF_PASSWORD` 时同样以 2 报可操作错误。

### task（23）— commands/tasks.ts

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `task list` | 任务列表 | `-s/--status` `-k/--keyword`（仅 name）`--search <kw>`（name OR description，走 `q` 参数）`-p/-n` 分页 `--json` |
| `task get <id>` | 任务详情 | `--json` |
| `task create` | 创建任务（JSON 体） | `--body <json>`/`--file`；`--executor <id>` 钉扎（与 broadcast 互斥）。**后端 `CreateTaskDto` 无 `version` 字段**（要版本用 `currentVersion`），示例 payload 已按此修正——`forbidNonWhitelisted` 下多一个 `version` 必 400。`body.params` 注入为 `AUTOFLOW_<KEY>` 环境变量（JSON 序列化：布尔/数字裸值，字符串带引号） |
| `task update <id>` | 更新任务 | `--body`/`--file`；`--executor <id>`；`--body {"executorId":null}` 清除钉扎 |
| `task delete <id>` | 删除（强杀运行中执行） | `-y/--yes` 跳过确认（**非交互必传**，否则码 2） |
| `task trigger <id>` | 触发执行（立即返回 execution id；`--wait` 轮询到终态，失败终态/超时退出码 1） | `--wait` `--wait-timeout <s>` `--params <json>`（按 run 覆盖任务默认参数）`--json`。**`--json --wait` 下 stdout 只出最终 execution 对象**（失败详情走 stderr），保证可解析 |
| `task executions <id>` | 近期执行列表 | `-n/--limit` `--json` |
| `task logs <execId>` | 日志行分页 | `-f/--from-line` `-n/--limit`(≤2000) `--tail <n>` `--json` |
| `task analyze <taskId> <execId>` | AI 失败分析 | — |
| `task suggest-schedule <id>` | AI 建议 cron | — |
| `task stats <id>` | 执行统计 | `--json` |
| `task versions <id>` | 版本历史 | `--json` |
| `task rollback <id>` | 版本回滚 | `--version <versionId>`（根命令不注册 --version，该选项不被劫持） |
| `task compare <id> <v1> <v2>` | 版本 diff | `--json` |
| `task pause <id>` / `resume <id>` | 暂停/恢复调度 | — |
| `task kill <taskId> <execId>` | 强杀执行 | — |
| `task export <id>` / `import <file>` | 定义导出/导入（`-`=stdin；导入后默认 paused） | `-o <file>` |
| `task batch trigger\|pause\|resume\|delete` | 批量动作（≤500 个） | `--ids id1,id2` 或 positional；**`delete` 需 `-y/--yes`**（非交互缺则码 2），其余 action 无门 |
| `task webhook enable\|rotate\|disable\|status <id>` | 入站 webhook（HMAC；secret 只回显一次） | — |
| `task glue <id>` | 在线更新 GLUE 脚本 | `-f <file>`/`--stdin` `--language python\|javascript\|shell` |
| `task lint <file>` | 本地语法检查 glue 脚本（js/mjs/cjs/py/sh，不执行） | `--language <lang>` 覆盖自动识别；源码经 **stdin** 传给解释器（Windows 路径反斜杠不再被 bash/python 吃掉）；解释器缺失 → 码 2（环境问题，区别于语法错的码 1） |

### app（12）— commands/apps.ts

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `app list` / `get <id>` | 列表/详情 | `--json` |
| `app create` / `update <id>` | 创建/更新（JSON 体；必填 name/version/runtime；不支持改名） | `--body <json>`/`--file`（`--json <body>` 是过渡期弃用别名） |
| `app delete <id>` | 删除 | `-y` |
| `app analyze <id>` | AI 健康分析 | — |
| `app deploy <id>` | 部署到执行器（`--executor` 缺省=自动选最低负载）。**缺省 `-m scheduled`（仅部署、中台/定时触发）**；显式 `once`/`daemon` 会立刻启动入口脚本（CLI 发请求前黄色预警）；`deploy-only` 是 scheduled 的自解释别名 | `-e/--executor` `-m/--run-mode once\|daemon\|scheduled\|deploy-only` `--env '{"K":"v"}'` `--start-command <cmd>` |
| `app deployments [appId]` | 部署列表 | `-p/-n` `--json` |
| `app versions <id>` | 应用版本历史（过渡期 legacy alias） | `--json` |
| `app releases <appId>` | **DEP-01 统一发布追溯**：版本 × 最近部署（状态/次数/执行器/runMode/触发方式） | `-p/-n`（上限 200）`--json` |
| `app upload <zip>` | multipart 上传应用包（按名称 upsert；`.zip` 校验在服务端） | `--name`（必填）`--runtime` `--version <v>`（**不被根 --version 劫持**）`--json` |
| `app upgrade-all <appId>` | 全量/灰度滚动升级（受理≠完成，异步推进） | `--strategy all\|canary` `--percentage <n>` `--version <v>`（定向灰度/渐进回滚）；**`all`（缺省）需 `-y/--yes`**（动全量，非交互缺则码 2），canary 无门 |
| `app deploy <id>` | 部署到执行器 | `--env <json>` 坏 JSON → 码 2（本地 payload，请求不发出） |

### executor（4）— commands/executors.ts

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `executor list` | 执行器列表 | `--json` |
| `executor get <id>` | 详情（配置/状态/指标） | — |
| `executor rotate <nameOrId>` | 轮换 token（ADMIN；新 token 只显示一次） | `--reason`（≤200 字符入审计）；**需 `-y/--yes`**（不可逆且 token 只回显一次） |
| `executor offline <nameOrId>` | 标记离线（ADMIN；不打断运行中任务，用于崩溃残留） | — |

### deploy（4）— commands/deploy.ts

| 命令 | 作用 |
|---|---|
| `deploy list [appId]` | 部署列表（与 `acf app deployments` 同源同契约；部署列表挂 app 组下，此处补可发现入口） |
| `deploy upgrade <deploymentId>` | overlay 升级拉最新应用版本 |
| `deploy stop <deploymentId>` | 停止运行中的部署 |
| `deploy remove <deploymentId> -y` | 删除**已终结**的部署记录（failed/stopped；在途/运行/待审批 409——先 stop，或走 approval reject/cancel）；非交互必传 `-y` |

### approval（4）— commands/approval.ts

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `approval list` | 待审批待办队列（ADMIN） | `--status pending\|approved\|rejected\|cancelled` `--application <id>` `--json` |
| `approval approve <deploymentId>` | 批准并派发（第二人规则：审批者≠提交者） | `--note`（≤200，映射 reason） |
| `approval reject <deploymentId>` | 拒绝（行落 FAILED，不派发） | `--note` |
| `approval cancel <deploymentId>` | 提交者撤回自己的请求 | — |

### apikey（3）— commands/apikeys.ts

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `apikey create` | 创建限权 API Key（明文只回显一次） | `--name` `--scope readonly\|trigger\|manage` `--expires <days>` |
| `apikey list` | 脱敏列表 | `--json` |
| `apikey revoke <id>` | 吊销 | — |

### project（2）与 sop（2）与 agent（1）

| 命令 | 作用 |
|---|---|
| `project list` / `project members <id>` | 项目列表 / 成员 |
| `sop list` / `sop show <id>` | SOP 列表 / 详情 |
| `agent sessions` | Agent 会话（`--status` 过滤） |

### audit（1）与 exec（1）

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `audit list` | 审计日志（倒序） | `--action` `--resource` `--user-id` `--username` `--start-time/--end-time`(ISO) `-p/-n`(≤100) |
| `exec tail <execId>` | **SSE 实时跟随日志**（终态执行则打印日志退出） | `--json` 输出原始行 JSON |

## 常见坑

1. `task trigger` 默认**不**等待（立即返回执行 id）；需要等终态并拿退出码时加 `--wait`（失败终态/超时退出码 1），超时上限 `--wait-timeout <s>`。
2. `task logs` 单次 ≤2000 行，超大输出用 `--from-line` 分页；实时场景用 `exec tail`（走 `/logs/stream` SSE）。
3. `executor rotate` 结果只显示一次，丢失只能再 rotate。
4. `app deploy` 缺省 `scheduled`（仅部署、中台触发）；显式 `once`/`daemon` 会**立刻启动入口脚本**（CLI 发请求前打预警）——批处理脚本请用 scheduled，避免部署即跑与后续 trigger 双跑。
5. `task create` 的 `body.params` 注入为 `AUTOFLOW_<KEY>` 环境变量且 JSON 序列化：布尔/数字是裸值（`true`/`3`），**字符串带双引号**（`"yes"`）——脚本侧按 JSON 解析而非当普通字符串。
6. CI 中用 `ACF_TOKEN` 短期 access token 注入而非 `set-token` 落盘；机器账号建议改用 API Key 直调 REST（`acf_…`）。

## 相关文档

- [../02-packages/acf-cli.md](../02-packages/acf-cli.md) — 包实现与测试
- [rest-api.md](rest-api.md) — 命令背后的端点 · [README.md](README.md) — 鉴权速查
- [../01-apps/admin-api/modules/audit.md](../01-apps/admin-api/modules/audit.md) — 审计查询白名单语义

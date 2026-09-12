# CLI 命令地图（acf，39 个子命令）
> 所属: docs/atlas/05-interfaces · 最后核对: 2026-09-13 · 对应代码: packages/acf-cli/src（index.ts + commands/ 7 个文件）

## 怎么连

- 包 `acf-cli`，bin 名 **`acf`**（`packages/acf-cli`：`npm run build` 后全局 link 或 `npx` 调用）。
- 目标是 admin-api 的 REST（同 [rest-api.md](rest-api.md)），默认 `http://localhost:3105`。

## 配置与鉴权

| 方式 | 说明 |
|---|---|
| `acf login --url … --user … --password …` | 交互登录，access+refresh token 存本地 conf（projectName `acf-cli`），文件 0600（SEC-NEW-4） |
| `acf config set-url <url>` / `set-token <token>` / `show` | 手工维护配置 |
| 环境变量 `ACF_API_URL` / `ACF_TOKEN` / `ACF_REFRESH_TOKEN` | 每次调用注入，**不落盘**——CI/cron 推荐方式 |
| 全局选项 `--api-url <url>` / `--token <token>` | 单次覆盖（preAction 写回 env） |

优先级：CLI 选项 > 环境变量 > conf 存储。CLI 不持有 executor token；执行器面操作不在命令范围内。

## 命令地图（7 个域 + config，共 39 个子命令）

### login / config（4）

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `acf login` | 登录并保存凭证 | `--url` `--user` `--password` |
| `acf config show` | 查看当前配置 | — |
| `acf config set-url <url>` | 设置 API 基地址 | — |
| `acf config set-token <token>` | 直接写入 token | — |

### task（18）— commands/tasks.ts

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `task list` | 任务列表 | `-s/--status` `-k/--keyword` `-p/-n` 分页 `--json` |
| `task get <id>` | 任务详情 | — |
| `task create` | 创建任务（JSON 体） | `--file <path>` 或 `--json`；`--executor <id>` 钉扎（与 broadcast 互斥） |
| `task update <id>` | 更新任务 | `--file`/`--json`；`--executor <id>`；`--json {"executorId":null}` 清除钉扎 |
| `task delete <id>` | 删除（强杀运行中执行） | `-y/--yes` 跳过确认 |
| `task trigger <id>` | 触发并轮询到终态 | `--wait`（默认轮询等待完成） |
| `task executions <id>` | 近期执行列表 | `-n/--limit` |
| `task logs <execId>` | 日志行分页 | `-f/--from-line` `-n/--limit`(≤2000) `--tail <n>` |
| `task analyze <taskId> <execId>` | AI 失败分析 | — |
| `task suggest-schedule <id>` | AI 建议 cron | — |
| `task stats <id>` | 执行统计 | — |
| `task versions <id>` | 版本历史 | — |
| `task rollback <id>` | 版本回滚 | `--version <versionId>` |
| `task compare <id> <v1> <v2>` | 版本 diff | — |
| `task pause <id>` / `resume <id>` | 暂停/恢复调度 | — |
| `task kill <taskId> <execId>` | 强杀执行 | — |
| `task lint <file>` | 本地语法检查 glue 脚本（js/mjs/cjs/py/sh，不执行） | `--language <lang>` 覆盖自动识别 |

### app（9）— commands/apps.ts

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `app list` / `get <id>` | 列表/详情 | `--json` |
| `app create` / `update <id>` | 创建/更新（JSON 体；必填 name/version/runtime） | `--file`/`--json` |
| `app delete <id>` | 删除 | `-y` |
| `app analyze <id>` | AI 健康分析 | — |
| `app deploy <id>` | 部署到执行器（`--executor` 缺省=自动选最低负载） | `-e/--executor` `-m/--run-mode once\|daemon\|scheduled` `--env '{"K":"v"}'` `--start-command <cmd>` |
| `app deployments [appId]` | 部署列表 | `-p/-n` |
| `app versions <id>` | 应用版本历史 | — |

### executor（4）— commands/executors.ts

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `executor list` | 执行器列表 | `--json` |
| `executor get <id>` | 详情（配置/状态/指标） | — |
| `executor rotate <nameOrId>` | 轮换 token（ADMIN；新 token 只显示一次） | `--reason`（≤200 字符入审计） |
| `executor offline <nameOrId>` | 标记离线（ADMIN；不打断运行中任务，用于崩溃残留） | — |

### deploy（2）— commands/deploy.ts

| 命令 | 作用 |
|---|---|
| `deploy upgrade <deploymentId>` | overlay 升级拉最新应用版本 |
| `deploy stop <deploymentId>` | 停止运行中的部署 |

### audit（1）与 exec（1）

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `audit list` | 审计日志（倒序） | `--action` `--resource` `--user-id` `--username` `--start-time/--end-time`(ISO) `-p/-n`(≤100) |
| `exec tail <execId>` | **SSE 实时跟随日志**（终态执行则打印日志退出） | `--json` 输出原始行 JSON |

## 常见坑

1. `task trigger` 默认就等待终态（历史行为）；不需要等待时看 `task executions`。
2. `task logs` 单次 ≤2000 行，超大输出用 `--from-line` 分页；实时场景用 `exec tail`（走 `/logs/stream` SSE）。
3. `executor rotate` 结果只显示一次，丢失只能再 rotate。
4. `app create/update` 不接受内联 JSON 字符串拼任务体，优先 `--file`（避免 shell 转义事故）。
5. CI 中用 `ACF_TOKEN` 短期 access token 注入而非 `set-token` 落盘；机器账号建议改用 API Key 直调 REST（`acf_…`）。

## 相关文档

- [../02-packages/acf-cli.md](../02-packages/acf-cli.md) — 包实现与测试
- [rest-api.md](rest-api.md) — 命令背后的端点 · [README.md](README.md) — 鉴权速查
- [../01-apps/admin-api/modules/audit.md](../01-apps/admin-api/modules/audit.md) — 审计查询白名单语义

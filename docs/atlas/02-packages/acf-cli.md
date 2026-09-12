# acf-cli — 命令行工具

> 所属: docs/atlas/02-packages · 最后核对: 2026-09-13 · 对应代码: packages/acf-cli

## 职责

`acf` 是 AutoCodeFlow 的命令行管理入口（npm 包名 `acf-cli`，v1.0.0，bin `acf`）：面向运维/开发者在终端里完成任务 CRUD、触发与跟日志、应用部署、执行器管理与审计查询。**它只是 admin-api REST 的客户端**——所有业务能力都来自 admin-api，CLI 不含调度/执行逻辑。

依赖（package.json 核实）：`commander 12.0.0`、`axios 1.20.0`、`conf 10.2.0`（持久配置）、`chalk 4.1.2`、`cli-table3 0.6.5`、`ora 5.4.1`；engines `node>=18`。测试 vitest（根目录 `npm run test:cli`）。

## 目录结构与关键文件

```
packages/acf-cli/
├── package.json          bin: acf → dist/index.js
├── src/
│   ├── index.ts          program 装配：全局选项、preAction、8 个命令组
│   ├── client.ts         axios 实例：Bearer 头、401 单飞刷新、信封拆包、formatApiError
│   ├── config.ts         conf 持久存储（0600）、env 覆盖、clearAuth、showConfig
│   ├── commands/         login / tasks / apps / executors / deploy / audit / exec
│   └── __tests__/        client、commands、config-security、exec、executors-nf07
```

## 命令清单（自 src/commands/ 注册代码核实，共 39 个子命令）

| 组 | 子命令 |
|---|---|
| `acf login` | 交互式（或 `--url/--user/--password`）登录，存双 token |
| `acf task`（18） | `list` `get` `create` `update` `delete` `trigger`（`--wait` 等待完成）`executions` `logs` `stats` `versions` `rollback --version` `compare` `analyze` `suggest-schedule` `pause` `resume` `kill` `lint <file>`（本地语法检查 js/mjs/cjs/py/sh） |
| `acf app`（9） | `list` `get` `create` `update` `delete` `analyze`（AI 健康分析）`deploy`（省略 `--executor` 时自动选最低负载在线执行器）`deployments [appId]` `versions` |
| `acf executor`（4） | `list` `get` `rotate <nameOrId>`（ADMIN，新 token 只显示一次）`offline <nameOrId>`（ADMIN，不中断运行中任务） |
| `acf deploy`（2） | `upgrade <deploymentId>`（overlay 升级拉最新应用版本）`stop <deploymentId>` |
| `acf audit`（1） | `list`（审计日志，倒序分页过滤） |
| `acf exec`（1） | `tail <execId>`（SSE 实时跟踪执行日志；已终结则打印后退出） |
| `acf config`（3） | `show` `set-url <url>` `set-token <token>` |

## 鉴权与凭据

- `acf login` → `POST /auth/login`，保存 `accessToken` + `refreshToken`（BUG-13：refresh 一并入库，供 401 自愈）。
- **401 自愈**：client.ts 收到 401 且本地有 refresh token 时做**单飞**（并发 401 共享一次）`POST /auth/refresh`，成功换发双 token（DR-07 原子轮换，新 refreshToken 必须跟进）并重放原请求一次；彻底失败则 `clearAuth()` 清凭据回未登录态。
- **凭据解析优先级**：`ACF_API_URL` / `ACF_TOKEN` / `ACF_REFRESH_TOKEN` 环境变量 > conf 存储；全局选项 `--api-url` / `--token` 会在 preAction 里转写为环境变量。CI/cron 推荐纯 env 注入（不落盘）。
- **落盘安全**（SEC-NEW-4）：conf 存储 projectName `acf-cli`，文件 0600；加载时 `hardenConfigPermissions()` 尽力修复旧文件权限；`ACF_CONFIG_DIR` 可重定向目录（测试/气隙 CI 用）。
- `executor rotate` / `executor offline` 要求 ADMIN 角色（403 时 client 会透出后端 message）。

## 配置与输出格式

- 配置文件：conf 按平台默认用户配置目录存储（`acf config show` 打印实际路径）；`apiUrl` 默认 `http://localhost:3105`。
- 输出：列表用 `cli-table3` 表格 + chalk 着色，长操作用 `ora` spinner；所有列表类命令支持 `--json` 输出原始 JSON（CI 可消费、无表格）。错误经 `formatApiError` 透出后端 message（信封/校验数组 `"; "` 连接），而非 axios 泛化文案。

## 典型用法

```bash
# 首次登录（交互式，或 --url/--user/--password 免交互）
acf login

# 触发任务并等待执行完成（脚本里常用）
acf task trigger <taskId> --wait

# 跟踪一次执行的实时日志（SSE；已终结的执行直接打印后退出）
acf exec tail <execId>

# 本地语法检查 glue 脚本（不上传、不执行；支持 js/mjs/cjs/py/sh）
acf task lint ./scripts/sync.py

# CI 环境：纯 env 注入凭据，不落盘
ACF_API_URL=https://acf.example.com ACF_TOKEN=<jwt> acf task list --json

# 管理操作（需 ADMIN 角色）
acf executor rotate <nameOrId>    # 轮换执行器 token，新 token 只在输出里出现一次
acf deploy upgrade <deploymentId> # 应用 overlay 升级
```

版本与帮助：`acf --version` 打印 `1.0.0`（index.ts 硬编码）；每个命令组支持 `--help`。进程退出码：成功 0，抛错 1（`program.parseAsync` 的 catch 统一处理）。

## 与其他组件的关系

- **依赖**：apps/admin-api（REST：`/auth/*`、`/tasks*`、`/applications*`、`/app-deployments*`、`/executors*`、`/audit*`、SSE 日志端点）。
- **被依赖**：无（终端用户直接使用；docs-site 文档引用其用法）。契约测试消费 [contract-fixtures](contract-fixtures.md)（client.test.ts）。
- admin-api 的 [响应信封](../04-flows/security-model.md) 由 client.ts 统一拆包；`exec tail` 依赖 admin-api 的 SSE 推送（见 [执行回调链路](../04-flows/execution-callback.md)）。

## 常见改动场景

**如何加一个命令**（以 `task` 组为例）：
1. 在 `src/commands/tasks.ts` 的 `tasksCommand()` 里 `cmd.command('xxx <id>').description(...).option(...)` 并写 action（用 `get/put/post/del` helper，自动带鉴权与拆包）；
2. 需要新 REST 端点时先在 admin-api 落地（见 [新增后端模块](../08-workflows/add-new-api-module.md)）；
3. 在 `src/__tests__/commands.test.ts` 补测试；表格输出复用现有 Table 模式，机读字段记得加 `--json` 分支；
4. 更新 `src/index.ts` 头部 Usage 注释与本文件命令表，勾选"最后核对"。

## 相关文档

- [包生态总览](README.md) · [MCP Server（同源能力的 AI 入口）](mcp-server.md)
- [CLI 对外接口地图](../05-interfaces/cli.md) · [认证与信任链](../04-flows/security-model.md)
- admin-api 对应模块：[task](../01-apps/admin-api/README.md)、[executor](../01-apps/admin-api/README.md)、[audit](../01-apps/admin-api/README.md)

# 快速上手指南

> **受众**：第一次部署、想先跑通 demo 的开发者 · **状态**：稳定 · **最后核对**：2026-11-20
> 三条路径：一键 demo（推荐先看效果）→ 手动 Docker → 源码开发。另见「一行接入」（CLI / MCP）：服务端就绪后可跳过 UI，直接把任务与 AI 客户端接上。
> 生产启用北极星看板 / TTFV 漏斗（迁移 + 密钥 + 授权前置）见 [北极星/TTFV 生产启用 runbook](plan/north-star-enablement.md)。

## 一行接入：CLI / MCP（TTFV 关键路径）

当你已经有可访问的 AutoCodeFlow 服务（一键 demo 或手动 Docker 任一条路径启动后），**不必先走 UI**，可以用 CLI 或 MCP 一行接入，直接创建任务 / 让 AI 客户端托管任务管理。

### CLI 接入（3 行跑通）

CLI 包名 `@autocodeflow/cli`，全局安装后提供 `acf` 命令（版本/来源：`packages/acf-cli/package.json` 的 `name` / `bin.acf`）。

```bash
npm install -g @autocodeflow/cli          # 安装；bin 名 acf → packages/acf-cli/dist/index.js
acf login                                 # 登录并保存凭据；TOTP 账号可加 --code <6 位>
acf task create --file examples/daily-report/task.example.json   # 用示例 JSON 直接创建任务
```

命令与参数均为源码事实：`acf login` 见 `packages/acf-cli/src/index.ts:125` 注册的 `loginCommand()`；`acf task` 子命令树见 `packages/acf-cli/src/index.ts:128` 的 `tasksCommand()`；`task create` 的载荷旗标是 `--body <json>` / `--file <path>`（`packages/acf-cli/src/commands/tasks.ts:579`、`:581`）——**没有 `-f` 短选项**，`-f` 在别处仅用于 import / script / glue 等命令。文件示例见 `examples/daily-report/task.example.json`（每日报表导出：cron 定时触发 + 文件产物），另有 `examples/intranet-inspection/task.example.json`（内网巡检：批量探测 + 结果汇总回调）与 `examples/desktop-data-entry/task.example.json`（桌面执行器数据填报）。以上 3 个路径已与示例切片（`scenario-examples`）最终确认一致；每个示例目录含 README + `task.example.json` + 任务代码，可直接照抄。

自检命令：

```bash
acf --help                    # 根命令帮助（含全部子命令与 Examples）
acf task create --help        # 确认 create 的 --body / --file 旗标
```

### MCP 接入（粘进 Claude / 其它 MCP 客户端）

MCP server 包名 `autocodeflow-mcp-server`，bin 名 `autocodeflow-mcp`（`packages/mcp-server/package.json` 的 `name` / `bin.autocodeflow-mcp`），走 **stdio transport**（`packages/mcp-server/src/index.ts:121-122` 的 `new StdioServerTransport()` + `server.connect(transport)`）。

把下面片段粘进 Claude Desktop 的 `claude_desktop_config.json`（或其它 MCP 客户端等价配置，口径对齐 `packages/mcp-server/README.md:132-138`）：

```json
{
  "mcpServers": {
    "autocodeflow": {
      "command": "node",
      "args": ["/path/to/packages/mcp-server/dist/index.js"],
      "env": {
        "AUTOCODEFLOW_API_URL": "http://localhost:3105",
        "AUTOCODEFLOW_API_TOKEN": "acf_<your-api-key>"
      }
    }
  }
}
```

环境变量口径（真实名称与默认值来自源码，勿改名）：

| 变量 | 是否必填 | 说明 | 源码出处 |
|------|---------|------|---------|
| `AUTOCODEFLOW_API_URL` | 否（默认 `http://localhost:3105`） | Admin API 基地址，请求时自动补 `/api` 前缀 | `packages/mcp-server/src/api.ts:12` |
| `AUTOCODEFLOW_API_TOKEN` | 是 | API key（`acf_…`）或用户 JWT，作为 `Bearer` 凭证；缺失时 server 启动即以退出码 1 拒绝 | `packages/mcp-server/src/api.ts:40`、`packages/mcp-server/src/index.ts:114-120` |
| `AUTOCODEFLOW_API_REFRESH_TOKEN` | 否 | 可选；access token 过期时自动刷新并回放一次请求 | `packages/mcp-server/src/api.ts:65` |

### 收敛提示：高频工具速查

MCP 共暴露几十个工具，全部交给 LLM 自由选择会拉高工具选择成本；**日常高频只用 task / application 类**即可覆盖绝大多数场景。下列工具名取自 `packages/mcp-server/src/tools.ts` 的 `registerTaskTools` / `registerApplicationTools`（含其拆分的 task 子注册文件），均为真实注册名：

| 高频工具 | 用途 | 源码出处（register / 文件:行） |
|---------|------|------------------------------|
| `list_tasks` | 列出任务（分页/过滤） | `registerTaskDefinitionTools` → `packages/mcp-server/src/tools/task-definition.ts:23` |
| `get_task` | 查看单个任务详情 | `registerTaskDefinitionTools` → `packages/mcp-server/src/tools/task-definition.ts:63` |
| `trigger_task` | 手动触发一次任务 | `registerTaskDefinitionTools` → `packages/mcp-server/src/tools/task-definition.ts:76` |
| `list_executions` | 列出任务执行记录 | `registerTaskExecutionTools` → `packages/mcp-server/src/tools/task-execution.ts:27` |
| `get_execution` | 查看单次执行详情 | `registerTaskExecutionTools` → `packages/mcp-server/src/tools/task-execution.ts:70` |
| `get_execution_logs` | 拉取执行日志 | `registerTaskExecutionTools` → `packages/mcp-server/src/tools/task-execution.ts:164` |
| `list_applications` | 列出应用 | `registerApplicationTools` → `packages/mcp-server/src/tools.ts:173` |
| `analyze_application` | 应用健康分析（LLM） | `registerApplicationTools` → `packages/mcp-server/src/tools.ts:348` |

> 其余工具（版本/回滚、部署审批、SOP、审计、项目、执行器等）按需在客户端工具列表里开启；不必一开始全量放出。

---

## 路径 A：一键 demo（首次约 3–8 分钟，之后 ~30 秒）

要求：**Docker Desktop**（Windows / macOS）或 **Docker Engine + Compose v2**（Linux），外加 **Node.js 18+**（仅用于 demo 的 seed/校验脚本，不需要 `npm install` 项目依赖）。

```bash
git clone https://github.com/LuluDeer/AutoCodeFlow.git
cd AutoCodeFlow
./scripts/demo.sh          # 等价于 make demo
```

脚本会替你做完这些事：

- 生成 `.env.demo`（强随机口令，**不会碰你的 `.env`**）
- 用隔离的 compose 项目启动 PostgreSQL、Redis、admin-api、admin-web、executor-node 和两个私服
- 只绑定 `127.0.0.1`，UI 在 **http://localhost:8088**（避开常见的 `:80` 占用）
- 注入 3 个 demo 任务 + 3 条 demo SOP
- 触发 `demo-hello-fixed` 并等到 `SUCCESS`，最后打印管理员口令

停止与重置：

```bash
./scripts/demo.sh --down     # 停止，保留数据
./scripts/demo.sh --reset    # 停止并删除数据 + .env.demo
./scripts/demo.sh --logs     # 跟踪日志
```

> 换端口：`./scripts/demo.sh --port 8090`。
> 端口被占用时脚本会直接报错并告诉你用哪个参数。

> 可选真实模型：`ACF_LLM_API_KEY=... ACF_LLM_BASE_URL=... ACF_LLM_MODEL=... ./scripts/demo.sh`
> 会在首次生成 `.env.demo` 时把 OpenAI-compatible provider 写进中台（不写入仓库）。
>
> 桌面 Agent（Linux X11）：`./scripts/demo-desktop-agent.sh`——无需 Docker / LLM / API key，
> 跑通 SOP → plan → GUI 动作 → 沙箱试跑 → acceptance → delivered（默认脚本化 plan；
> 设置 `ACF_LLM_API_KEY/BASE_URL/MODEL` 可换真实 provider）；只验证 GUI 驱动可用
> `./scripts/demo-desktop-gui.sh`。依赖
> `xvfb xfwm4 xdotool xprop ffmpeg python3-tk`。
>
> 截图诊断：`./scripts/demo-desktop-agent-diagnose.sh`——先输错、模型看截图后修正，需 `ACF_LLM_*`。
>
> 中台 ops Agent：`node scripts/demo-ops-agent.mjs`——真实模型调只读工具分析 demo 任务，需 AI provider。
>
> Headless 执行器（无 Electron）：`node scripts/demo-headless-agent.mjs`——注册执行器 →
> 真实 SOP 指派 → 中台 LLM relay → 沙箱试跑 → 验收 → `completed`；需先配置 AI provider。

---

## 路径 B：手动 Docker（自定义配置 / 生产试跑）

### 第一步：启动服务

```bash
# 下载代码
git clone https://github.com/LuluDeer/AutoCodeFlow.git
cd AutoCodeFlow

# 初始化配置
cp .env.example .env
# 必须先把 .env 中的 INITIAL_ADMIN_PASSWORD 改成你自己的强口令（>=8 字符）：
# .env.example 的占位值 change_me_immediately 是弱口令，原样启动会被
# admin-api 的启动校验（fail-fast）拒绝（compose 默认 NODE_ENV=production）。
# 也可以用 `openssl rand -base64 18` 生成一个。
vi .env   # 或任意编辑器

# 本机试跑再加一行（否则 admin-api 启动即退出，见下）：
#   ALLOW_LOOPBACK_CORS=true
# 原因：compose 默认 NODE_ENV=production，而默认 CORS_ORIGINS 就是
# http://localhost ——生产守卫（configuration.ts 的 CORS 检查）会拒绝回环来源。
# 真实域名部署时不要设它，改成 CORS_ORIGINS=https://你的域名。

# 一键启动
docker compose up -d
```

等待约 30 秒，执行下面的命令确认所有服务健康：

```bash
docker compose ps
```

所有服务 STATUS 列显示 `healthy` 即启动成功。

浏览器打开 **http://localhost**，进入登录页面。

---

## 第二步：登录

| 字段 | 值 |
|------|-----------|
| 用户名 | `admin` |
| 密码 | `.env` 文件中 `INITIAL_ADMIN_PASSWORD` 的值（第一步里你自己设置的强口令，系统没有默认口令） |

登录后**立即到「系统 → 用户管理」，在对应用户行点击「重置密码」修改初始密码**。（W8 已移除「个人信息」死菜单项，此处原路径失效。）

---

## 可选：一键生成演示数据

如果只是想快速看到完整 UI 流程，可以跳过手工创建，直接注入一组演示任务：

```bash
# 使用你在 .env 中设置的 INITIAL_ADMIN_PASSWORD；也可直接替换为你的管理员密码
ACF_PASSWORD='你的管理员密码' npm run demo:seed
```

脚本会幂等创建 3 个 `demo-` 前缀任务：

- `demo-hello-fixed`：每 15 秒固定频率执行，持续产生成功记录
- `demo-cron-report`：每 5 分钟 Cron 执行，演示 Python glue 与时区配置
- `demo-fragile`：故意失败的手动任务，用于查看失败分类、错误信息与执行详情

默认会触发一次 Cron/失败样本；如只想建任务不触发，追加 `-- --skip-trigger`。卸载时在 UI 删除 `demo-` 前缀任务即可。

---

## 第三步：创建第一个应用

应用是任务的分组容器，建议按业务线或项目划分。

1. 点击左侧菜单 **「应用 → 应用管理」**
2. 点击右上角 **「新建应用」**
3. 填写：
   - 名称：`我的第一个应用`
   - 描述：随意填写
4. 点击 **「确认」**

---

## 第四步：创建定时任务

1. 在应用详情页，点击 **「新建任务」**（也可在左侧「任务 → 任务调度」列表页内点击「新建任务」；侧栏并无单独的「新建任务」菜单项）
2. 填写基本信息：

   | 字段 | 示例值 | 说明 |
   |------|--------|------|
   | 任务名称 | `测试任务` | 任意名称 |
   | 所属应用 | `我的第一个应用` | 刚刚创建的应用 |
   | 调度方式 | `Cron` | 定时执行 |
   | Cron 表达式 | `*/5 * * * *` | 每 5 分钟执行一次 |
   | 脚本类型 | `JavaScript` | |

3. 在脚本编辑器中输入：

   ```javascript
   // 这是一个简单的测试脚本
   const msg = `Hello from AutoCodeFlow! Time: ${new Date().toISOString()}`;
   console.log(msg);
   return { message: msg, success: true };
   ```

4. 点击 **「保存并启用」**

> 💡 **Cron 表达式帮助**：编辑器旁边有「Cron 助手」按钮，可以可视化选择执行周期，无需记忆语法。

---

## 第五步：立即执行并查看结果

不想等到下个调度周期？可以手动触发：

1. 进入任务详情页
2. 点击 **「立即执行」**
3. 在 **「执行记录」** 标签页，点击最新一条记录
4. 进入执行详情，查看 **执行日志**（运行中会实时推送日志）

执行成功后状态显示绿色 `成功`，日志区域会显示 `Hello from AutoCodeFlow!`。

---

## 第六步：连接执行器

系统默认已包含一个内置执行器（docker compose 中的 `executor-node`）。

要查看执行器状态：
1. 点击左侧菜单 **「执行器 → 执行器列表」**
2. 可以看到已注册的执行器列表及其在线状态

如果要在其他服务器上部署额外的执行器：
1. 在 **「执行器列表」** 页点击 **「安装向导」** 按钮
2. 按向导填写目标服务器地址，复制生成的安装命令
3. 在目标服务器上粘贴并执行

---

## 常见问题

### 服务启动后访问页面空白？

```bash
# 入口流量统一走 admin-web 镜像内置的 nginx（本栈没有独立的 nginx 服务）
docker compose logs admin-web
docker compose logs admin-api
```

### 任务执行失败，提示「无可用执行器」？

```bash
# 检查执行器是否在线
docker compose ps executor-node
docker compose logs executor-node
```

执行器注册后需要约 10 秒完成心跳，刷新页面再试。

### 忘记管理员密码？

用仓库自带脚本重置（Postgres `pgcrypto` 的 bcrypt，重置后自动吊销该用户已有会话）：

```bash
./scripts/reset-admin-password.sh                 # 生产 .env，交互输入新口令
./scripts/reset-admin-password.sh --demo          # 本地 demo 栈
./scripts/reset-admin-password.sh --user alice --password 'NewPass123!'
./scripts/reset-admin-password.sh --dry-run       # 只打印 SQL，不写库
```

脚本要求 Docker 主机上能执行 `docker compose exec postgres`；非 Docker 部署用 `--dry-run` 拿到 SQL 后手动 `psql` 执行。

> ⚠️ 不要再用旧文档里的 `UPDATE users SET password_hash = '$2b$10$placeholder'`：
> 列名其实是 `"password"`，而且那个占位值不是合法 bcrypt 哈希——照做会把账号锁死。

### 如何查看所有执行日志？

点击左侧菜单 **「执行记录」**，可按应用、任务、状态、时间范围筛选。

---

## 已知问题与注意事项（基于 Linux E2E 测试）

### executor-node 环境变量不生效

如果 executor-node 容器启动后心跳始终失败，检查 `.env` 中 `ADMIN_API_URL` 是否正确。容器内必须使用服务名而非 `localhost`：

```bash
# 正确（容器内部网络）
ADMIN_API_URL=http://admin-api:3105

# 错误（容器内 localhost 指向容器自身）
ADMIN_API_URL=http://localhost:3105
```

### 执行器心跳触发限流（429）

心跳接口若频繁返回 429，说明 throttle 配置过严。可通过以下命令确认：

```bash
docker compose logs executor-node | grep '429\|throttle\|rate'
```

遇到此问题时，适当降低执行器心跳频率（`HEARTBEAT_INTERVAL_MS`）或联系管理员调整限流配置。

### 执行器注册后任务执行失败

注册成功后立即触发任务，偶尔出现「无可用执行器」。这是因为心跳同步需要约 10-15 秒。等待一个心跳周期后重试即可。

---

## 下一步

- 🧭 [教程系列：从 0 到生产](tutorials) — 第一个定时任务、私服依赖、多执行器扩容、告警接入值班
- 📖 [部署指南](deployment.md) — 生产环境部署、HTTPS、反向代理配置
- 🔧 [开发指南](development.md) — 本地开发环境搭建、调试方法
- 📦 [SDK 指南](sdk-guide.md) — 脚本中使用私有包仓库
- 🔗 [API 参考](api-reference.md) — 通过 API 集成外部系统

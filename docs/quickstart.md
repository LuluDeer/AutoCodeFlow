# 快速上手指南

> 三条路径：一键 demo（推荐先看效果）→ 手动 Docker → 源码开发。

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
# 查看 nginx 和 admin-web 日志
docker compose logs nginx
docker compose logs admin-web
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

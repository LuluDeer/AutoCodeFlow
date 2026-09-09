# 快速上手指南

> 5 分钟跑起来，10 分钟完成第一个定时任务。

## 准备工作

只需要安装 **Docker Desktop**（Windows / macOS）或 **Docker + Docker Compose**（Linux）。

- 下载地址：https://docs.docker.com/get-docker/
- 验证安装：`docker -v` 输出版本号即可

---

## 第一步：启动服务

```bash
# 下载代码
git clone https://github.com/your-org/AutoCodeFlow.git
cd AutoCodeFlow

# 初始化配置（直接用默认值即可体验）
cp .env.example .env

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
| 密码 | `.env` 文件中 `INITIAL_ADMIN_PASSWORD` 的值（默认 `Admin@123456`） |

登录后**立即到「设置 → 个人信息」修改密码**。

---

## 可选：一键生成演示数据

如果只是想快速看到完整 UI 流程，可以跳过手工创建，直接注入一组演示任务：

```bash
# 使用 .env 中的 INITIAL_ADMIN_PASSWORD；也可直接替换为你的管理员密码
ACF_PASSWORD='Admin@123456' pnpm demo:seed
```

脚本会幂等创建 3 个 `demo-` 前缀任务：

- `demo-hello-fixed`：每 15 秒固定频率执行，持续产生成功记录
- `demo-cron-report`：每 5 分钟 Cron 执行，演示 Python glue 与时区配置
- `demo-fragile`：故意失败的手动任务，用于查看失败分类、错误信息与执行详情

默认会触发一次 Cron/失败样本；如只想建任务不触发，追加 `-- --skip-trigger`。卸载时在 UI 删除 `demo-` 前缀任务即可。

---

## 第三步：创建第一个应用

应用是任务的分组容器，建议按业务线或项目划分。

1. 点击左侧菜单 **「应用」**
2. 点击右上角 **「新建应用」**
3. 填写：
   - 名称：`我的第一个应用`
   - 描述：随意填写
4. 点击 **「确认」**

---

## 第四步：创建定时任务

1. 在应用详情页，点击 **「新建任务」**，或点击左侧菜单 **「任务」→「新建任务」**
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
1. 点击左侧菜单 **「执行器」**
2. 可以看到已注册的执行器列表及其在线状态

如果要在其他服务器上部署额外的执行器：
1. 点击 **「安装执行器」**
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

```bash
# 通过 API 重置（需要数据库直接操作）
docker compose exec postgres psql -U autoflow -d autoflow \
  -c "UPDATE users SET password_hash = '\$2b\$10\$placeholder' WHERE username = 'admin';"
# 建议使用环境变量重新设置初始密码后重启服务
```

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

- 🧭 [教程系列：从 0 到生产](./tutorials/) — 第一个定时任务、私服依赖、多执行器扩容、告警接入值班
- 📖 [部署指南](./deployment.md) — 生产环境部署、HTTPS、反向代理配置
- 🔧 [开发指南](./development.md) — 本地开发环境搭建、调试方法
- 📦 [SDK 指南](./sdk-guide.md) — 脚本中使用私有包仓库
- 🔗 [API 参考](./api-reference.md) — 通过 API 集成外部系统

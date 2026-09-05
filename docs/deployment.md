# 部署指南

## 系统要求

| 组件 | 最低要求 | 推荐配置 |
|------|----------|----------|
| Docker | 24.0+ | 最新稳定版 |
| Docker Compose | 2.20+ | 最新稳定版 |
| CPU | 2 核 | 4 核+ |
| 内存 | 4 GB | 8 GB+ |
| 磁盘 | 20 GB | 50 GB+ |
| 操作系统 | Linux / macOS / Windows (WSL2) | Ubuntu 22.04 LTS |

## 必填环境变量

复制 `.env.example` 为 `.env` 并按下表填写：

| 变量名 | 示例值 | 说明 |
|--------|--------|------|
| `JWT_SECRET` | `change-me-32chars-min` | JWT 签名密钥，生产环境须使用随机长字符串 |
| `DB_HOST` | `postgres` | PostgreSQL 主机名 |
| `DB_PORT` | `5432` | PostgreSQL 端口 |
| `DB_NAME` | `autoflow` | 数据库名称 |
| `DB_USER` | `autoflow` | 数据库用户名 |
| `DB_PASSWORD` | `your_db_password` | 数据库密码（必须修改） |
| `REDIS_HOST` | `redis` | Redis 主机名 |
| `REDIS_PORT` | `6379` | Redis 端口 |
| `REDIS_PASSWORD` | `your_redis_password` | Redis 密码（生产环境必须设置） |
| `ADMIN_API_PORT` | `3105` | Admin API 监听端口 |
| `EXECUTOR_SECRET` | `change-me-executor-secret` | 执行器认证密钥 |
| `AI_API_KEY` | `sk-...` | AI 服务 API Key（可选） |
| `AI_BASE_URL` | `https://api.openai.com/v1` | AI 服务端点（可选） |

## 快速部署（5 步）

### 第 1 步：克隆仓库

```bash
git clone https://github.com/your-org/AutoCodeFlow.git
cd AutoCodeFlow
```

### 第 2 步：配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少修改所有密码和密钥字段
nano .env
```

### 第 3 步：启动所有服务

```bash
docker compose up -d
```

### 第 4 步：执行数据库迁移

```bash
docker compose exec admin-api npm run migration:run
```

### 第 5 步：验证服务状态

```bash
docker compose ps
# 所有服务应显示 healthy 状态
```

## 服务访问地址

| 服务 | 地址 | 说明 |
|------|------|------|
| Admin Web | http://localhost:80 | 管理后台界面 |
| Admin API | http://localhost:3105 | REST API 接口 |
| API 文档 | http://localhost:3105/api/docs | Swagger UI |
| Executor Python | http://localhost:8001 | Python 执行器 |
| Executor Node | http://localhost:8002 | Node.js 执行器 |

默认管理员账号：`admin` / 密码由环境变量 `INITIAL_ADMIN_PASSWORD` 决定（首次登录后请立即修改密码）

## 裸机执行器安装（artifact 通道，第八轮 N24 根治）

compose 栈之外的目标机（裸机/虚机）可用一键脚本安装 executor-node，安装
代码经 admin-api 承载的 **真 artifact 通道** 下发（不再要求目标机有项目
checkout）：

1. **生成 artifact**（在有仓库 checkout 的构建机上）：

```bash
bash scripts/bundle-executor-artifact.sh
# 产物: <repo>/artifacts/executor-node.tar.gz（dist + package.json + 生产 node_modules）
```

2. **放到 admin-api 可读位置**（`EXECUTOR_ARTIFACT_DIR`，默认进程 `<cwd>/artifacts`）：

```bash
# 裸机 admin-api（cwd=apps/admin-api）：脚本默认输出改指或直接拷贝
cp artifacts/executor-node.tar.gz apps/admin-api/artifacts/
# docker 部署：compose 为 admin-api 增加卷 + 环境变量，例如
#   volumes: - ./artifacts:/app/artifacts:ro
#   environment: EXECUTOR_ARTIFACT_DIR=/app/artifacts
```

3. **目标机安装**（管理后台「执行器 → 安装命令」即 `GET /api/executors/install-cmd` 生成同款命令）：

```bash
curl -fsSL 'http://<admin>:3105/api/executors/install.sh' \
  | bash -s -- --api-url 'http://<admin>:3105' --secret '<EXECUTOR_SECRET>'
```

鉴权姿态：artifact 端点 `@Public` + 执行器共享 token（Bearer 头，`?token=`
兜底），token 即 `--secret` 传入值，未配置时 fail-closed 401；artifact 未
生成时 404。脚本在下载失败时回退本地 checkout 复制（开发场景），两者皆无
则明确报错退出。可选参数：`--name --port --runtime --work-dir --install-dir`。

## 常用运维命令

### 查看日志

```bash
# 查看所有服务日志
docker compose logs -f

# 查看单个服务日志
docker compose logs -f admin-api
docker compose logs -f executor-python
```

### 服务管理

```bash
# 重启单个服务
docker compose restart admin-api

# 停止所有服务（保留数据）
docker compose stop

# 停止并删除容器（保留数据卷）
docker compose down

# 强制重新构建镜像
docker compose build --no-cache
docker compose up -d
```

### 数据库操作

```bash
# 连接数据库
docker compose exec postgres psql -U autoflow -d autoflow

# 备份数据库
docker compose exec postgres pg_dump -U autoflow autoflow > backup_$(date +%Y%m%d).sql

# 恢复数据库
docker compose exec -T postgres psql -U autoflow autoflow < backup.sql
```

### Redis 操作

```bash
# 连接 Redis CLI
docker compose exec redis redis-cli -a your_redis_password

# 查看队列状态
docker compose exec redis redis-cli -a your_redis_password INFO keyspace
```

## 升级指南

1. **备份数据**

```bash
docker compose exec postgres pg_dump -U autoflow autoflow > backup_before_upgrade.sql
```

2. **拉取最新代码**

```bash
git pull origin main
```

3. **对比环境变量**（查看 `.env.example` 是否有新增变量）

```bash
diff .env .env.example
```

4. **重新构建并启动**

```bash
docker compose build
docker compose up -d
```

5. **执行新增迁移**

```bash
docker compose exec admin-api npm run migration:run
```

6. **验证服务正常**

```bash
docker compose ps
curl http://localhost:3105/health
```

## 常见问题排查

### 服务启动后无法访问

- 检查端口是否被占用：`ss -tlnp | grep -E '80|3105|8001|8002'`
- 检查防火墙规则是否放行了对应端口
- 查看服务日志：`docker compose logs admin-api`

### 数据库连接失败

- 确认 `.env` 中 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD` 填写正确
- 确认 postgres 容器已启动：`docker compose ps postgres`
- 检查数据库日志：`docker compose logs postgres`

### 迁移失败

- 确认数据库已成功启动且可连接
- 查看迁移日志了解具体错误：`docker compose exec admin-api npm run migration:run 2>&1`
- 如需回滚：`docker compose exec admin-api npm run migration:revert`

### 执行器无法注册

- 确认 `EXECUTOR_SECRET` 与 admin-api 配置一致
- 检查执行器容器网络能否访问 admin-api：`docker compose exec executor-python curl http://admin-api:3105/health`
- 查看执行器日志：`docker compose logs executor-python`
- **关键**：`ADMIN_API_URL` 必须使用 Docker 服务名（`http://admin-api:3105`），不能用 `localhost`

### 执行器注册后心跳失败（401 / 429）

心跳接口出现 401 说明执行器 Token 失效，需要重新注册；出现 429 说明触发了限流：

```bash
# 查看执行器心跳日志
docker compose logs executor-node | tail -50
docker compose logs executor-python | tail -50

# 强制重启执行器（重新注册）
docker compose restart executor-node
```

### 部署任务卡在 deploying 状态

极少情况下部署任务因网络抖动卡住，此时执行器状态不更新：

```bash
# 查看 admin-api 调度日志
docker compose logs admin-api | grep -i 'deploy\|timeout' | tail -30

# 重启 admin-api 触发超时检测与状态回收
docker compose restart admin-api
```

### 内存不足

- 检查各容器内存用量：`docker stats`
- 适当调整 `docker-compose.yml` 中各服务的 `mem_limit` 配置
- 建议生产环境至少配备 8 GB 内存

---

## Windows 部署（R14 实测路线，2026-09）

> 本章按 Windows 深度测试轮（`docs/WINDOWS-TESTING-PLAN.md` / `docs/windows-findings.md`）实测行为编写。
> `install.sh` 一键脚本依赖 systemd，**仅支持 Linux**；非 Linux 平台脚本会主动报错并给出指引（R-02）。
> Windows 上 executor-node 作为普通前台/后台进程运行即可，功能与 Linux 一致（R14 全链路 9 项冒烟通过）。

### 1. 前置

- Node.js **24.x**（与 CI 对齐）、Git for Windows。PostgreSQL 16 + Redis 7 用 Docker Desktop（WSL2 后端）或 WSL2 内原生服务；WSL 开 **mirrored 网络模式**时 Windows 侧直接 `localhost:5432/6379` 可达。
- ⚠️ 行尾：仓库已配 `.gitattributes`（`* text=auto eol=lf`，`*.sh`/`*.py` 强制 LF）。若 clone 时 `core.autocrlf=true` 早于该文件生效，用 `git add --renormalize . && git checkout .` 修复工作树（windows-findings W-01）。

### 2. admin-api

```powershell
cd apps\admin-api
copy .env.example .env    # 至少改掉 DB_PASSWORD / JWT_SECRET / EXECUTOR_SECRET / INITIAL_ADMIN_PASSWORD
npm ci
npm run build
# 首次需手动建库与迁移：
npx typeorm-ts-node-commonjs migration:run -d src/data-source.ts
node dist\main.js         # 生产；开发可 npm run start:dev
```

- 生产模式有密钥 fail-fast（`DB_PASSWORD>=16` 非弱值、JWT>=32 等，configuration.ts M3）；示例占位值会被拒绝——本地冒烟建议用 dev 模式或改成强值。
- 同机部署（admin-api 与 executor 都在本机）时，`.env` 必须设 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`：SSRF 防护默认拦回环/私网出站（F-3），否则调度器把 localhost:8002 判为受限地址。

### 3. executor-node（手动路线，替代 systemd）

```powershell
cd apps\executor-node
copy .env.example .env    # 填 ADMIN_API_URL / EXECUTOR_SHARED_TOKEN(与 admin EXECUTOR_SECRET 一致) / EXECUTOR_ADDRESS / WORK_DIR
npm ci
npm run build
node dist\main.js
```

- 成功标志：日志 `Registered to admin-api (runtimes: shell, node, python, ...)`，admin 侧 `GET /api/executors` 显示 `online`。
- `WORK_DIR` 支持中文与空格（如 `C:/测试 目录/af`，R14-2.7 实测通过）；POSIX 风格路径（`/var/lib/...`）会被解析到当前盘根，建议显式用盘符路径。
- 运行机需 `git`（任务 git 检出）、`node.exe` 与 `python.exe`（runtime=node/python 按 PATH 解析；executor-python 侧已统一用 `sys.executable` 免 `python3` 依赖，W-02）。

### 4. shell 任务在 Windows 的语义（R-09 / W-11）

- 调度中心 runtime=shell 在 Windows 用 `cmd.exe /c` 执行，glue 脚本以 `glue_script.cmd` 落盘（Windows 下写 `.sh` 会被 cmd.exe 挂死，已修）。**bash 语法脚本不保证可用**——POSIX 语法预期失败，请改用 node/python runtime 或写 cmd 兼容脚本。
- POSIX 风格入口 `./x.cmd` 会被自动归一化为 `x.cmd`（W-09）。

### 5. 停服与优雅退出（R-08，重要）

- `taskkill <pid>`（不带 /F）**无法**停 Windows 控制台程序；`taskkill /F` = 强杀，**不会**执行优雅收尾，运行中任务的子进程树会泄漏为孤儿。
- 正确姿势：用 **NSSM / 任务计划程序「停止任务」**（转发 Ctrl+C→SIGINT），或在控制台按 **Ctrl+Break**（→SIGBREAK）。两者都已注册进 executor-node / admin-api 的优雅退出链（P-10，实测收到信号→`Waiting for N task(s)...`→宽限期内收割任务进程树→`shutdown complete`）。
- 超时/取消的任务经 `taskkill /T /F` **树杀**，孙进程不残留（P-7 / R14-2.4 实测 0 泄漏）。

### 6. 已知限制

- **长路径（R-06 实测结论）**：把 WORK_DIR 设到 MAX_PATH 附近本身可行——执行器文件操作（libuv 自动 `\\?\`）支持长路径；但**任务进程的 cwd 不行**（CreateProcess 限制：未启用系统长路径时 >260 字符 cwd 会 spawn 失败；执行器将该任务干净失败并提示 MAX_PATH，不崩进程）。要求：`WORK_DIR + 36 字符 executionId` 拼完保持 **<260 字符**；确需更长则启用 `LongPathsEnabled`（`reg add HKLM\SYSTEM\CurrentControlSet\Control\FileSystem /v LongPathsEnabled /t REG_DWORD /d 1`，重启生效）——部分 Win11 镜像默认仍为 0，勿假设已开。
- 任务日志文件以 UTF-8 读取；cmd 子进程的 GBK 中文输出会乱码但不影响执行（W-10）。
- executor-desktop（Electron）在 Windows 的打包验证见路线图 R16。
- 服务化 admin-api 用 `pm2`（`ecosystem.config.js`）或任务计划程序自启 + 失败重启均可。

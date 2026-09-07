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

## 端口暴露面与生产边界

默认 Compose 配置仅将基础设施和包 registry 的宿主端口绑定到本机回环地址：`infra/docker-compose.yml` 的 PostgreSQL `127.0.0.1:5432`、Redis `127.0.0.1:6379`，以及根目录 `docker-compose.yml` 的 PyPI registry `127.0.0.1:8003`、npm registry `127.0.0.1:4873`，以及两个执行器端口 `127.0.0.1:8001`（executor-python）与 `127.0.0.1:8002`（executor-node）。执行器容器同时设置 `REQUIRE_TOKEN=true`——任务派发/执行接口要求携带共享 token（与 `EXECUTOR_SECRET` 一致），回环绑定加 token 校验保证宿主机之外无法绕过 admin-api 直连执行器。应用、执行器和 registry 之间优先使用 Compose 内部网络和服务名，不依赖宿主端口映射；生产环境不要将这些端口直接绑定到 `0.0.0.0`。

如确需远程管理或发布包，应使用受控的 Compose override 将端口绑定到指定管理网卡，或通过认证的反向代理暴露，并同步配置主机防火墙/云安全组和访问控制。外部客户端若必须连接数据库或 Redis，应明确评估其加密、认证和来源限制。CI 的服务容器和测试端口属于隔离测试环境，不代表生产暴露面。

`.env.example` 中的密码和密钥均为开发占位值；生产部署必须覆盖数据库密码（包括 `POSTGRES_PASSWORD`/`DB_PASSWORD`）、`REDIS_PASSWORD`、`JWT_SECRET`、`EXECUTOR_SECRET`、registry 凭据和 `INITIAL_ADMIN_PASSWORD`，并通过密钥管理系统或受控环境变量注入。CI/e2e 中出现的测试凭据只用于自动化测试，不得复制到生产；本仓库未据此证明生产使用默认口令，生产防火墙和安全组仍需部署方核实。

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
| `THROTTLE_LIMIT` / `THROTTLE_TTL` | `60` / `60000` | admin-api 全局限流（次/窗口毫秒，默认 60/分钟）；压测前建议调高，见 `scripts/load-test.README.md` |
| `LOGIN_THROTTLE_LIMIT` | `20` | 登录接口限流（默认 20/分钟，生产建议 5） |
| `STALE_RECOVERY_RETRY_ENABLED` | `true` | stale sweep 兑现重试预算开关（`false` 恢复旧行为：只置 FAILED 不重试） |
| `EXECUTOR_ALLOW_PRIVATE_NETWORK` | `false` | SSRF 防护回环/私网出站白名单开关；同机部署（admin-api 与执行器都在本机）必须设 `true` |
| `EXECUTION_CALLBACK_SECRET` | - | 执行回调 token 的 HMAC 密钥（可选，≥16 字符；缺省回落 `EXECUTOR_SECRET`，两侧须同源） |
| `NPM_REGISTRY_TOKEN`（或 `NPM_REGISTRY_USER`/`NPM_REGISTRY_PASS`） | - | npm registry 服务账号/预签发 token（registry-npm 全量要求认证，不配置则 admin 的 npm 包列表为空） |
| `REGISTRY_UPLOAD_TIMEOUT_MS` | `60000` | registry 上传代理超时（毫秒，慢链路可调大） |
| `REQUIRE_TOKEN` | `true` | 执行器无 token 时拒绝 `/api/*` 请求（fail-closed，compose 已内置 `true`） |
| `DISK_CLEANUP_TTL_DAYS` | `7` | executor-python 工作目录 TTL 回收天数（配套 `DISK_CLEANUP_INTERVAL_SECONDS`/`DISK_CLEANUP_INITIAL_DELAY_SECONDS`） |
| `LOG_STORAGE_DRIVER` | `db` | 执行日志存储：`db` 或 `s3`（`s3` 需启用 minio profile 并配置 `LOG_STORAGE_*` 与 `MINIO_ROOT_PASSWORD`） |
| `MINIO_ROOT_PASSWORD` | - | MinIO root 密码（启用 minio profile 时必填，无默认值） |
| `LOG_RETENTION_DAYS` | `7` | 执行器工作目录/日志 TTL 回收天数（下限 1） |
| `SEC_SECRETS_KEY` | - | 任务级 secrets（tasks.secrets）落库加密密钥，32 字节 hex（`openssl rand -hex 32`）或 base64。留空 = 明文存储（启动 warn 一次，零破坏升级路径）；配置后写路径全加密（AES-256-GCM，`enc:v1:` 信封格式，明文/密文行可共存——存量行首次 update 自然转密文）。**生产环境必须配置并纳入密钥备份**：密钥丢失则密文 secrets 无法解密（任务派发报错，不静默裸跑）；轮换 = 更换 key 后对任务执行一次任意 update |
| `ZIP_MAX_RATIO` | `100` | SEC-05 上传面 zip bomb 防护——解压比上限（中央目录声明的 uncompressed 总量 / compressed 总量），超出拒绝上传（400） |
| `ZIP_MAX_ENTRIES` | `10000` | SEC-05——zip 条目数上限，超出拒绝上传（400） |
| `ZIP_MAX_FILE_BYTES` | `1073741824` | SEC-05——单文件解压后大小上限（字节，默认 1 GiB），超出拒绝上传（400） |
| `ZIP_MAX_TOTAL_BYTES` | `2147483648` | SEC-05——全包声明解压总量上限（字节，默认 2 GiB；比率上限无法约束绝对膨胀），超出拒绝上传（400） |
| `ZIP_MAX_NESTING_DEPTH` | `1` | SEC-05——嵌套 zip 积极探测层数；更深层按其声明大小计入外层比率/总量（探测成本有界），执行器解压时按同规则再校验 |
| `CLAMD_ENABLED` | `false` | SEC-05 可选 clamd（ClamAV 守护进程）病毒扫描钩子。**默认 false = 零影响**；`true` 时 application / executor-package 上传包流式 INSTREAM 送扫。**失败策略 = fail-closed**：扫描不可达/超时/异常一律拒绝上传（503），检出威胁 400（签名名仅入服务端日志）——未获 verdict 绝不放行（安全缺省） |
| `CLAMD_HOST` / `CLAMD_PORT` | `127.0.0.1` / `3310` | SEC-05——clamd TCP 地址（`CLAMD_ENABLED=true` 时必达，否则上传全拒） |
| `CLAMD_TIMEOUT_MS` | `10000` | SEC-05——单次扫描超时（毫秒），超时按 fail-closed 拒绝 |
| `OTEL_ENABLED` | `false` | OBS-01 OpenTelemetry 分布式追踪开关。**默认 false = 零开销零行为变化**（不生成 traceId、不带头、不落库）；`true` 时 traceId 贯穿落库（`task_executions.traceId`）+ W3C traceparent 头 dispatch 透传/回调回传，执行详情页展示追踪标识（详见下方「OTEL / Jaeger」段） |

> 注：以上变量均已收入 `.env.example`；其中 `THROTTLE_*`、`STALE_RECOVERY_RETRY_ENABLED`、`EXECUTOR_ALLOW_PRIVATE_NETWORK`、`EXECUTION_CALLBACK_SECRET`、`NPM_REGISTRY_*`、`REGISTRY_UPLOAD_TIMEOUT_MS`、`DISK_CLEANUP_*` 由服务进程直接读取，根 compose 默认未注入——独立部署时通过进程环境传入，或在 compose 的 `environment:` 中显式添加。

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

Admin Web 容器内置 Nginx 是所有 `/api` 请求的统一入口，三条代理语义需要了解：`/api/` 前缀 location 使用**不带 URI** 的 `proxy_pass`，原样保留 `/api` 前缀（与 admin-api 的 `setGlobalPrefix("api")` 对齐，误写成尾斜杠形式会剥离前缀导致全量 404）；`client_max_body_size 510m` 为上传体积预留——执行器包最大 500MB、应用包 200MB、PyPI 代理包 50MB，nginx 默认 1m 会让大包上传直接 413；执行日志 SSE 流（`/api/tasks/<id>/executions/<execId>/logs/stream`）有专有正则 location（`proxy_read_timeout 1h`、`proxy_buffering off`），避免被通用 `/api/` 的 60s 读超时掐断，也不受上传体积语义影响。两份配置 `apps/admin-web/nginx.conf` 与 `infra/nginx/default.conf` 需保持同步。

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

> **SEC-02 备份安全注记**：配置 `SEC_SECRETS_KEY` 后，DB 备份中的 `tasks.secrets`
> 为 AES-256-GCM 密文（`enc:v1:` 信封），备份文件泄露不再直接泄密——但**密钥与
> 备份必须分开保管**（密钥入密钥管理系统，不入同一备份介质），否则攻击者可解密。
> 未配置 key 的部署中 secrets 为明文，备份即明文，生产环境务必配置。

### 上传面 zip bomb 防护与病毒扫描（SEC-05）

上传纵深分两层，独立生效：

**第 1 层（admin-api 上传口）**：`POST /applications/upload` 与
`POST /executor-packages` 在包落库/对外可见前，对 zip 家族（.zip/.whl，含
PEP 427 wheel）做零依赖的中央目录结构解析，按上表 `ZIP_MAX_*` 阈值校验
解压比/条目数/单文件与总量上限，超限返回 400（`Package rejected by
zip-bomb guard (<violation>)`），具体规则命中记服务端 warn 日志。结构
损坏（截断、中央目录尺寸被篡改、zip64 哨兵）同样拒绝——无法核验的包不
入库。gzip 流（.tar.gz/.tgz）无中央目录，由 500 MB multer 上限 + 第 2 层
防护覆盖。嵌套 zip 积极探测 1 层（`ZIP_MAX_NESTING_DEPTH` 可调），更深层
按声明大小计入外层总量/比率，探测成本有界。

**第 2 层（executor-node 解压口）**：应用包部署（`/deploy`，zip 路径）在
下载落盘后、Expand-Archive/unzip 执行前，先过同规则的 zip-guard（声明
尺寸校验，拒绝在真实磁盘字节产生之前），再过既有的 S6 路径穿越校验
（`assertSafeZipEntries`，两闸独立）。被拒包标记部署失败并回传原因，
临时目录自动清理。

**可选 clamd 病毒扫描（默认关闭）**：`CLAMD_ENABLED=true` 时上传包流式
INSTREAM 送 ClamAV 守护进程（docker 部署建议 `clamav/clamd` 镜像 + 内网
端口 3310）。**失败策略 = fail-closed**（安全缺省，有意决策）：扫描服务
不可达/超时/异常响应一律拒绝上传（503 `antivirus scan is unavailable`），
检出威胁 400（签名名仅入服务端日志，如 EICAR 测试串
`EICAR-STANDARD-ANTIVIRUS-TEST-FILE`）。开启前请确认 clamd 可达，否则
上传通道整体拒绝。可用性优先于严格扫描的部署保持默认 `false` 即可。

### OTEL / Jaeger 分布式追踪（OBS-01）

平台在 `OTEL_ENABLED=true` 时启用 admin-api → 执行器 → 回调的全链路 traceId 贯穿（W3C Trace Context）；**默认 `false`，开启与否不影响任何既有行为**（关闭时不生成 traceId、不加请求头、`task_executions.traceId` 保持 null）。trace-id 在触发/入队侧生成落库，dispatch 指令以 `traceparent` 头透传执行器并注入任务 env `AUTOFLOW_TRACE_ID`（任务代码可读），执行器终态回调回传同名头关联。管理台执行详情页在 traceId 有值时展示追踪标识与「复制 traceId」按钮。契约细节见 api-reference.md「Distributed Tracing」段。

**架构决策（@opentelemetry/api-only）**：当前仅依赖 `@opentelemetry/api`（轻量 API 包，无 SDK 实现）——span 树在 admin-api 进程内管理并以 `[trace] start/end` 结构化日志输出，**不引入 `@opentelemetry/sdk-*` 全家桶与 exporter**。理由：本项目无稳定部署的 collector，SDK 捆绑大量传递依赖并引入每 span 出站序列化开销，而当前唯一消费场景是「traceId 贯穿 + UI 展示/复制检索」；埋点边界（trigger/enqueue/dispatch/callback）已按 OpenAPI 语义收敛，未来接 Jaeger/Tempo 时只需实现 SDK `TracerProvider` 挂载到 `@opentelemetry/api` 全局并配置 OTLP exporter，无需改动任何埋点代码。

**Jaeger 接入（可选 profile，当前为预置）**：

```bash
# 启动 Jaeger all-in-one（未启用 profile 时零资源占用）
docker compose --profile jaeger up -d jaeger
# UI: http://localhost:16686
```

> 注意：collector 容器已预置（OTLP gRPC 4317 / HTTP 4318 + UI 16686，loopback-only），但平台 span **尚未出站**——需先完成上述 SDK TracerProvider 挂载（一次性、埋点零改动），并在 admin-api 侧设置 `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317`。挂载后从执行详情页复制 traceId 粘贴到 Jaeger「Search」框即可定位整条 span 树。

**执行器侧行为**：双执行器读取 dispatch 头 → 记日志（trace-id 段）→ 注入 `AUTOFLOW_TRACE_ID` env → 回调回传；执行器侧不做完整 span 树（缩水声明，见 api-reference 契约段）。

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

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

## 容器安全（SEC-07）

执行器是平台的代码执行面（`/api/execute` 接收并运行任意任务脚本），最小权限按「镜像层 + 运行时层」双闸收敛：

**镜像层 non-root**（SEC-07 前置侦察确认已在位，无需改动）：

- `apps/executor-node/Dockerfile`（Q-09）：运行段 `addgroup -S appgroup && adduser -S appuser -G appgroup`，`/data/tasks` 与 `/app` 均 `chown` 到该用户后 `USER appuser`。
- `apps/executor-python/Dockerfile`（Q-08）：`addgroup --system appgroup && adduser --system --ingroup appgroup --no-create-home appuser`，同样 `chown /data/tasks /app` 后 `USER appuser`。
- 镜像内进程以 `appuser`（非 root，alpine 分配的系统 uid）运行；任务脚本继承同一 uid，即使被容器逃逸面利用也无法获得 root。

**运行时层 capability 收敛**（本轮 SEC-07 落地，见根 `docker-compose.yml` 两个 executor 服务）：

```yaml
cap_drop: ['ALL']              # 移除全部 Linux capabilities——任务派发/执行/依赖安装均不需要特权操作
security_opt:
  - no-new-privileges:true     # 阻断 setuid/setgid 文件提权路径
```

- `cap_drop: ['ALL']` 从内核 capability 边界表清空全部能力（含 CHOWN/SETUID/NET_ADMIN 等），配合 non-root uid 形成双保险：即使容器内进程被提权利用，也无法获取任何 capability。
- `no-new-privileges:true` 通过内核 `NoNewPrivs` 标志使 `execve` 无法经 setuid 位或其他途径获得比父进程更多权限。
- admin-api/admin-web/nginx 等基础设施服务**未**默认加 `cap_drop`（nginx 需绑定 80 端口、admin-api 镜像当前以 root 启动 node），后续可单独评估；执行器作为最高风险面先行收敛。
- 回滚：若某任务确需特殊 capability（罕见），在受控的 compose override 中按能力白名单 `cap_add` 单项放开，不要整体恢复 `cap_drop` 缺省。

**真机验收清单**（留真机轮执行，本轮本机无 docker 环境未实测）：

1. `docker compose build executor-node executor-python` 成功；
2. `docker compose run --rm executor-node id` 输出 `uid=<非0> appuser`、`docker compose run --rm executor-python id` 同理；
3. 派发一个真实任务（script 执行 + 依赖安装），确认 `/data/tasks` 读写、回调上报均正常（非 root 下常见坑：工作目录属主、npm/pip 缓存目录 `HOME` 不可写——如遇 EACCES，在 Dockerfile 中补 `ENV HOME=/app` 或 `NPM_CONFIG_CACHE=/app/.npm` 级别的环境变量，不要回退 USER）。


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
| `EXECUTOR_MIN_VERSION` | （空） | 执行器最低版本门禁（EXE-VER-1）：点分数字 1~4 段（如 `1.3.0`），空=关闭零行为变化。开启后 register 的 version 低于下限被拒 403（报文含升级指引），未上报版本的存量执行器放行；heartbeat 响应回显 `minVersion`/`versionCompliant`，执行器侧打版本漂移告警日志（10 分钟节流） |
| `AI_ALLOW_PRIVATE_NETWORK` | `false` | AI 出站私网豁免（ARCH-31）：默认 false 时本地 Ollama（localhost:11434）也被 SSRF 闸拒绝；true 放行 loopback/restricted/private-LAN，云元数据恒拒 |
| `EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK` | `false` | 事件订阅 webhook 私网豁免（ARCH-31）：订阅校验与派发复核共用；事件订阅普通用户可建，开启即信任所有登录用户可向内网发 webhook，生产建议 false |
| `NOTIF_ALLOW_PRIVATE_NETWORK` | `false` | 通知渠道私网豁免（R17）：企业微信/钉钉/Slack/飞书/自定义 webhook 五渠道共用；内网自建网关需 true，云元数据恒拒；email 走 SMTP 不受影响 |
| `OIDC_ENABLED` | `false` | OIDC SSO 总开关（AUTH-04，ADR-014）：false 时 SSO 端点关闭、本地密码登录零变化；OIDC_* 其余键见 `.env.example` 与「OIDC SSO」段 |
| `OIDC_AUTO_PROVISION` | `false` | SSO JIT 自动建号开关：true 时未知 IdP 用户首登自动建 USER 账号；生产建议保持 false（管理员预建同名账号 → 首登绑定） |
| `OIDC_ALLOW_PRIVATE_NETWORK` | `false` | IdP 私网豁免：自建内网 Keycloak/Entra 网关需 true（云元数据段恒拒） |
| `OIDC_GROUPS_CLAIM` | `groups` | 组声明名（R20）：组→角色映射的数据来源 |
| `OIDC_ADMIN_GROUPS` | （空） | 命中即授 ADMIN 的组清单（逗号分隔）；空=SSO 建号恒 USER；**仅在 JIT 建号时生效**，已绑定账号角色不受 IdP 组影响 |
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
| `PYTHON_RUNTIME_VERSION_MIN` / `PYTHON_RUNTIME_VERSION_MAX` | `3.7` / `3.14` | Python 任务可声明的运行时版本区间（主.次，`^\d+\.\d+$`）。**admin-api（写面校验）与 executor-python（运行时）必须同源一致**，compose 已对两侧注入同一变量；非法值静默回退契约缺省，不会让写面 500。区间外声明 → 400。3.7 需离线预填（见「解释器缓存与私有化模式」段） |

> 注：以上变量均已收入 `.env.example`；其中 `THROTTLE_*`、`STALE_RECOVERY_RETRY_ENABLED`、`EXECUTOR_ALLOW_PRIVATE_NETWORK`、`EXECUTION_CALLBACK_SECRET`、`NPM_REGISTRY_*`、`REGISTRY_UPLOAD_TIMEOUT_MS`、`DISK_CLEANUP_*` 由服务进程直接读取，根 compose 默认未注入——独立部署时通过进程环境传入，或在 compose 的 `environment:` 中显式添加。
>
> **解释器缓存相关变量**（`UV_PYTHON_INSTALL_DIR` / `UV_PYTHON_INSTALL_MIRROR` / `INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS` / `INTERPRETER_SINGLE_VERSION_MB` / `INTERPRETER_TOTAL_GB` / `PYTHON_RUNTIME_VERSION_MIN` / `PYTHON_RUNTIME_VERSION_MAX` / `UV_BIN`）根 compose **已注入并带缺省值**（见 `docker-compose.yml` 两个执行器服务与 `admin-api` 服务），无需配置即可用；需要覆盖时在根 `.env` 设同名变量。执行器侧逐项说明见 `apps/executor-python/.env.example` 与 `apps/executor-node/.env.example`，完整说明见下方「解释器缓存与私有化模式」段。

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

### 反代 SSE/长流验证（部署前必跑，BUG-17）

SSE 能否存活**完全取决于代理层**（缓冲、读取超时、连接复用），应用侧单测覆盖不到。
用真实 nginx 跑一遍代理层门禁：

```bash
npm run test:nginx-sse                                    # 默认 180s soak + 500 并发长流档
NGINX_SOAK_SECONDS=86400 npm run test:nginx-sse           # 24h 长流（发布门禁/大版本上线前）
NGINX_SSE_CONNS=0 npm run test:nginx-sse                  # 跳过 500 并发档（快速冒烟）
```

脚本用 `infra/nginx/default.conf` **原件**（仅替换上游地址与监听端口）起真实 nginx
容器，并自带**探针执行器**（接受派发但不回报结果 + 周期心跳）把执行稳定维持在
RUNNING，从而让"专用 SSE 位置的长流"有真实载体。断言 **24 项**，重点：

- 流式语义：`text/event-stream` + 无 `Content-Length`（chunked）+ **首帧不迟滞**（缓冲开启时首帧会被攒到 buffer 满才下发，正是"日志不实时"的根因）；
- 长流存活：专用位置日志流持续不断连（该位置 `proxy_read_timeout 1h`；通用位置仅 60s，soak 超过 60s 不断连即为专用位置生效的证据）、保活帧间隔 ≤ 45s；
- 事件穿透：executor 回调 → 终态 winner → 领域事件 → `executions/stream` 帧经 nginx 到达订阅方，且日志流在终态后正常收尾；
- 并发长流：**500 条并发 SSE 经 nginx**（`NGINX_SSE_CONNS`，默认 500，0 跳过）建连率/存活率/保活帧均 ≥99%、RSS 涨幅受控、批量断流后槽位回收干净；三条代表性 SSE 并存互不干扰、长流期间普通请求延迟 < 5s。

> 本机实测（2026-09-12）：默认档 **24/24 通过**（含 500 并发长流：1.04s 建连、
> 35s 后 500/500 存活且有帧、RSS +14MB）；`NGINX_SOAK_SECONDS=100` 长稳档 19/19。
> 24h 档建议在目标环境（含真实执行器）跑一次，作为上线前门禁。
>
> **两个必读细节**（实测踩过）：
> ① 并发长流的 hold 必须 > `EXECUTIONS_STREAM_IDLE_PING_MS`（默认 30s）——事件流
> 无初始快照，短于该值会出现「一半连接零帧」的假象；
> ② 并发数受 nginx `worker_connections` 与上游连接数共同约束（500 条客户端 + 500
> 条 upstream ≈ 1000 连接）。默认镜像 `worker_connections 1024` 在 500 档可通过，
> **更高并发（>1000 长连接）需显式调大 `worker_connections`/`worker_processes`**，
> 否则表现为连接被拒而非应用报错。

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

# ARM64 / Apple Silicon 部署前核对 multi-arch manifest（发布镜像模式）
docker buildx imagetools inspect <image>:<tag>
docker compose pull && docker compose up -d
```

CI 的 `docker-multiarch-build` job 只构建不推送，覆盖 `admin-api`、`executor-node`、
`executor-python` 的 `linux/amd64,linux/arm64` 构建可达性；生产发布镜像接入后，应在
发布闸保留 manifest inspect 与 ARM64 冒烟。

> **本机核验记录（DSK-05，2026-09-11）**：安装 buildx 0.17.1 + QEMU binfmt（qemu-aarch64），
> 建 `docker-container` builder（`--platform linux/amd64,linux/arm64`）后，三镜像
> `docker buildx build --platform linux/amd64,linux/arm64` 全部构建通过（CI
> `docker-multiarch-build` 同款形态：不 push 不 load，结果留 buildkit 缓存）。
> 细节：Dockerfile 全 alpine/slim 无 native 编译依赖（node:24-alpine ×2 +
> python:3.12-slim + uv 0.8.17），arm64 构建无交叉编译载荷；非 root
> `adduser/APP_USER` 与 `uv venv --no-project` 探针两条 arm64 路径均已实际执行。

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

### 读写分离与只读副本（可选，ARCH-24，默认关闭）

`DB_READ_REPLICA_URL`（可选，默认空 = **关闭**）为 admin-api 配置一个 PostgreSQL 只读副本连接串。未配置时 TypeORM 使用既有的单连接形态，行为与本节引入前**完全一致**；配置后 TypeORM 改用内建 replication 形态（`{ replication: { master, slaves } }`），**无需改动任何业务查询代码**——读写路由是驱动内建行为：

- **走 slaves（副本）**：SELECT 读面——repository `find*` / `findOne*`、query builder `getMany/getManyAndCount/getRawMany` 等（TypeORM 0.3 的 `SelectQueryBuilder` 以 `defaultReplicationModeForReads()`（默认 `"slave"`）取连接）。
- **恒走 master（主库）**：`save/update/delete/insert`、事务（`dataSource.transaction`）、迁移（`migrationsRun` → `MigrationExecutor` 以默认 master 模式取连接，**迁移永远写主库**）、事务内的 `SELECT ... FOR UPDATE`。
- master/slaves 连接池共享同一 `extra` 池参数（`DB_POOL_SIZE` 等）；slave 凭据支持 `postgres://user:pass@host:port/db` 连接串（密码/SSL 参数经 URL 传递）。

**何时值得开**：列表/聚合读压力成为主库瓶颈（大量执行日志查询、任务列表翻页）且已有（或计划建）热备副本时。单机或读写压力不大时**不建议开**——复制延迟带来的可见性代价通常大于收益（见下）。

**如何配**：

```bash
# .env（admin-api 侧）
DB_READ_REPLICA_URL=postgres://readonly@<replica-host>:5432/autocodeflow
# 云 RDS：直接填 read replica endpoint；自建 PG：配置流复制后填备库地址
# 本地联调（演示形态，不真正同步数据）：
docker compose --profile replica up -d postgres-replica
```

**注意点**：

1. **复制延迟与「创建后立即列表可见」**：异步流复制下，写入 master 后副本存在毫秒~秒级滞后。触发任务/创建应用后立即刷新列表，可能在副本上读不到刚写入的行。若业务要求强一致读，保持该配置关闭（默认）；或开启后把关键列表读改走主库（需代码介入，本实现未做）。
2. **调度主链的结论——会走 slaves**：本实现是纯配置面，TypeORM 内建路由对所有 `find*`/`getMany` 生效，**scheduler 的轮询读（`taskRepo.find`/`execRepo.find` 等调度决策输入）同样会走副本**。调度写回（claim/状态机条件 UPDATE、入队）走 master 且多在事务内，正确性不受影响；但「刚落库的执行被下一轮 sweep 读到」存在副本滞后窗口。stale sweep 的条件 UPDATE 以 `WHERE status='PENDING'`（乐观条件）在 master 上执行，读到旧数据最多延迟一轮 sweep，不会覆盖新状态。延迟敏感场景建议将 `DB_READ_REPLICA_URL` 留空（保持默认关闭）。
3. **副本必须是真只读/流复制形态**：云 RDS read replica 天然满足；自建用 `standby.signal` + `primary_conninfo`。compose 的 `postgres-replica`（`--profile replica`）**只是演示形态**（独立空实例，不自动同步主库数据），仅用于本地联调连接与路由行为。
4. **迁移不写副本**：`migrationsRun`/手动迁移恒走 master；副本以只读身份跟随回放 WAL，请勿给应用配置带写权限的副本账号，避免误写。

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

> **M-2（2026-09 修复）**：compose 的 redis 服务现已强制 `--requirepass`（密码来自
> `.env` 的 `REDIS_PASSWORD`，未设置时 compose 解析即报错）。admin-api 侧已同步
> 注入同源 `REDIS_PASSWORD`，无需额外配置；下方示例密码请换成 `.env` 实际值。

```bash
# 连接 Redis CLI（密码从 .env 取）
REDIS_PASSWORD=$(grep -E '^REDIS_PASSWORD=' .env | cut -d= -f2-)
docker compose exec redis redis-cli -a "$REDIS_PASSWORD"

# 查看队列状态
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" INFO keyspace
```

### 定时备份（profile: backup，M-1）

compose 内置每日自动备份服务（**默认未启用**，需显式开 profile）：

```bash
# 启用（默认每日 02:00 pg_dump 全量 + gzip，保留 30 天）
docker compose --profile backup up -d pg-backup

# 立即手动备份一次（验证连通性与产物）
docker compose --profile backup exec pg-backup /usr/local/bin/pg-backup.sh

# 查看备份产物（backup_data 卷）与执行日志
docker compose --profile backup exec pg-backup ls -lh /backup
docker compose logs pg-backup
```

- 调度用 `BACKUP_SCHEDULE`（busybox crond 格式，默认 `0 2 * * *`）、保留天数用
  `BACKUP_RETENTION_DAYS`（默认 30）覆盖。
- **生产建议**：`backup_data` 卷另挂宿主目录或对象存储做异地副本（备份与库同
  机同卷 = 单点失效，防勒索/误删场景必须异地）。
- 文档级方案（宿主机 cron + pg_dump）仍有效，见 operations.md「数据备份与恢复」；
  容器方案更开箱即用。

### 监控与告警（profile: monitoring，M-3/M-4）

compose 内置可观测性栈（**默认未启用**，`--profile monitoring` 一键拉起）：

```bash
docker compose --profile monitoring up -d
# Grafana  http://localhost:3000   默认 admin/admin（生产务必设 GRAFANA_ADMIN_PASSWORD）
# Prometheus http://localhost:9090  Alertmanager http://localhost:9093
# Loki      http://localhost:3100
```

- **指标**：Prometheus 自动抓取 postgres / redis / admin-api（`/api/metrics`，
  prom-client 内置，R7 默认开启）；Grafana 已预置 Prometheus+Loki 数据源。
- **告警**：最小告警集（InstanceDown）已内置；平台侧 Alertmanager webhook
  （OBS-02）需要 HMAC 签名，Alertmanager 原生 webhook 无法直接调用——需一个
  HMAC 转发侧车，接线说明见 `config/monitoring/alertmanager.yml` 注释。
- **日志聚合**：Promtail 经宿主 `docker.sock` 采集全部容器日志推 Loki（Grafana
  Explore 可按 `container` 标签过滤）；日志保留 7 天（`config/monitoring/loki.yml`
  的 `limits_config.retention_period`）。

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
curl http://localhost:3105/api/health/live
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
- 检查执行器容器网络能否访问 admin-api：`docker compose exec executor-python curl http://admin-api:3105/api/health/live`
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

## 执行器部署形态对比（E-4）

「执行器」有三种互不排斥的部署形态，新运维请按表选择，**不要误以为桌面端也走
compose**：

| 形态 | 载体 | 分发渠道 | 适用场景 |
|---|---|---|---|
| `executor-python`（compose 服务） | Docker 容器（python:3.12-slim） | `docker compose up -d executor-python` | 与 admin-api 同栈的标准容器部署；多版本 Python 解释器按需下载 |
| `executor-node`（compose 服务） | Docker 容器（node:24-alpine） | `docker compose up -d executor-node` | 同上；当前镜像未内置 uv/python，解释器池能力主要在桌面端消费 |
| `executor-desktop`（桌面应用） | Electron 安装包（.exe/.dmg/.AppImage/deb） | **GitHub Releases**（electron-builder 打包，见 ci.yml `desktop-*` jobs） | 目标机不在 compose 栈内/无 Docker/需直连宿主 Python 与解释器池；内含 uv + 宿主 Python 多版本 |
| `executor-node`（裸机 artifact 通道） | 裸机脚本安装 | admin-api 下发 `artifacts/executor-node.tar.gz`（见上文「裸机执行器安装」） | 无 Docker 的目标虚机，走内网回连 |

---

## Linux 桌面端（executor-desktop，DSK-02/DSK-03）

> ⚠️ **状态标注**：打包配置已 CI 化（`.github/workflows/ci.yml` 的
> `desktop-linux-bundle` job，PR / 手动触发时构建 AppImage + deb 并上传
> artifact），但 **Ubuntu 22.04 真机验证待做**（本节安装/自启动/更新三项
> 均按 electron-builder 26 + electron-updater 6.8.9 文档化行为编写）。

### 安装

两种产物形态（x64），按发行版习惯二选一：

**AppImage（免安装，便携）**

```bash
chmod +x AutoCodeFlow.Executor-*.AppImage
./AutoCodeFlow.Executor-*.AppImage
```

- 建议固定放置路径（如 `~/Applications/`）再运行——开机自启动条目会记录
  AppImage 的**当前绝对路径**，事后挪动/重命名文件会使自启动失效（重新在
  设置里开关一次自启动即可修复）。
- 运行 AppImage 需要 FUSE2（`libfuse2`）。Ubuntu 22.04+ 默认可能未装：
  `sudo apt install libfuse2`。

**deb（系统集成）**

```bash
sudo dpkg -i autocodeflow-executor_*.deb
# 缺依赖时补一次：
sudo apt -f install
```

- deb 安装到 `/opt/AutoCodeFlow Executor/`，并写入
  `/usr/share/applications/` 桌面入口与 hicolor 图标（electron-builder 自动
  生成 `.desktop`）；菜单/启动器里显示为 "AutoCodeFlow Executor"。
- Ubuntu 24+ 安装 AppArmor 提示时按发行版指引确认即可（electron-builder
  已支持 per-target AppArmor profile，本仓当前未自定义）。

### 开机自启动

应用内设置（托盘菜单或配置页）打开「开机自启动」后：

- 实现走 `auto-launch` 5.0.6：**Linux 上写入
  `~/.config/autostart/AutoCodeFlow Executor.desktop`**（XDG Autostart 规范），
  关闭即删除该文件。
- 依赖桌面环境实现 XDG autostart（GNOME / KDE / XFCE 均支持）；纯 WM 用户
  需自行确认会话管理器读取 `~/.config/autostart`。
- deb 安装时自启动 Exec 指向 `/opt/...` 固定路径，升级后仍有效；AppImage
  见上方路径提醒。

### Ubuntu 信任注记（对应 Windows 的 Gatekeeper/SmartScreen）

Ubuntu 无 Gatekeeper；对应关注点是 **apt/dpkg 签名与来源信任**：

- 官方渠道为 GitHub Releases；从 Releases
  下载的 deb 是未签名的自发布包，`dpkg -i` 直接装，不经过 apt 签名校验。
  请只从本仓库 Releases 页面下载，并核对随产物提供的 `SHA256SUMS.txt`
  （DSK-06 起每个平台的 artifact 都会生成该清单）。
- AppImage 首次运行如被文件管理器拦截（"untrusted application launcher"
  提示），右键 → Properties → Allow executing（或终端 `chmod +x`）即可；
  这是 GNOME 对可执行位 + 自定义 launcher 的常规提示，不是病毒告警。
- 更严格环境可用 `AppArmor`/`bwrap` 沙箱运行 AppImage（本仓未做 snap/flatpak
  封装，缩水声明）。

### 桌面端自动更新（DSK-03）

**双更新源**（优先级从高到低）：

1. **通用 HTTP 源**：设置环境变量 `AUTOUPDATE_URL` 后优先生效，指向任何
   提供 electron-builder 产物布局的静态服务器（`latest-linux.yml` +
   `*.AppImage` / `*.deb`），适配 executor-packages / 私有化部署通道。
2. **GitHub Releases**（默认）：未设置 `AUTOUPDATE_URL` 时使用
   `electron-builder.yml` 的 `publish: { provider: github, owner: LuluDeer,
   repo: AutoCodeFlow }`，检测 Releases 上的 `latest-linux.yml`。

**版本流**：

```
git tag v<version> → push tag → release.yml
  ├→ version-guard（tag == 三包 + desktop 的 version 一致性，违反即整轮拒绝）
  ├→ publish-npm / publish-pypi（environment: release 人工审批闸）
  └→ desktop-installer（win/mac/linux 三平台原生 runner 构建安装包）
客户端：启动 30s 延迟检查 → 发现新版本 → 状态监控页顶部提示 → 用户点「下载更新」
      → 进度条（updater:progress）→ 下载完成 →「重启并安装」
      → quitAndInstall（AppImage 原地替换 / deb 走 dpkg）
```

### 桌面端安装包发布（DSK-06）

**当前姿态：CI 已就绪，但安装包不自动发布到 Releases。**

`release.yml` 的 `desktop-installer` job 在每个 tag 上构建三平台安装包
（`dist:win` / `dist:mac` / `dist:linux`，均带 `--publish never`），产物以
workflow artifact 形式上传（保留 30 天）并附 `SHA256SUMS.txt`，**不上传
GitHub Releases**。原因与启用步骤：

- **为何不自动发布**：electron-builder 检测到 `package.json` 的 `repository`
  字段会默认走 GitHub publisher（provider/repo 见 `electron-builder.yml` 的
  `publish` 段）；无 `GH_TOKEN` 时该路径硬失败。改用 `--publish never` 后
  构建可稳定出包，是否上架由人工决定——首次接入不宜直接放出 96MB 级产物。
- **启用自动发布的前置条件**：
  1. 从 workflow artifact 下载产物、核对 `SHA256SUMS.txt`，真机安装验证；
  2. **macOS 需 Apple Developer ID 并完成公证**——当前 CI 以
     `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过签名，产物在 Gatekeeper 下
     不可直接分发；
  3. 把 job 内的 `--publish never` 去掉（或在 tag 上追加一步把 artifact
     附到既有 Release），并配置 `GH_TOKEN` secret；
  4. 确认 desktop 的 `version` 与 tag 一致——`version-guard` 已把
     `apps/executor-desktop/package.json` 纳入 lockstep 检查清单，
     漂移会在发布前拦截（安装包版本号同时是 `latest.yml` 与客户端
     electron-updater 的比较基准，漂移会让自动更新永久失效）。

**注意**：客户端自动更新读取的 `latest.yml` / `latest-mac.yml` /
`latest-linux.yml` 只有在安装包真正挂到 Releases 后才可达。当前姿态下
自动更新链路是「代码就绪、无可用更新源」。

**行为细节**：

- 仅生产包启用（`app.isPackaged` 守卫）；开发模式跳过更新检查。
- `autoDownload=false`：检测到新版本只提示，不静默下载；离线/私服无网络/
  检查失败一律静默（仅写主进程日志 `userData/logs/main.log`），不打扰用户。
- **deb 更新**：electron-updater 6.x 依据包内 `resources/package-type`
  自动分派 DebUpdater，`quitAndInstall` 会弹系统授权（pkexec/sudo）执行
  dpkg 安装——无桌面授权代理的环境（纯 WM）建议手动升级。
- **AppImage 更新**：原地替换运行中的 AppImage 文件，重启后生效。

**回滚**：客户端自动更新不做降级。回滚 = 从 Releases 下载旧版本安装包
重新安装（AppImage 覆盖回旧文件 / deb `dpkg -i` 旧包覆盖），配置存储在
`~/.config/autocodeflow-executor/`（electron userData 目录），重装不丢配置。

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

## OIDC SSO（单点登录，AUTH-04 / ADR-014）

企业 IdP（Keycloak / Entra ID / Okta 等）接入，授权码模式（confidential client）。默认关闭，开启步骤：

1. **IdP 侧注册客户端**：类型=confidential；Redirect URI = `{API_BASE}/auth/oidc/callback`（如 `https://acf.example.com/api/auth/oidc/callback`）；Scope 至少 `openid` + 用户名声明（默认取 `preferred_username`，可用 `OIDC_USERNAME_CLAIM` 更换）。
2. **平台侧配置**：`OIDC_ENABLED=true` + `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI`（完整清单见 `.env.example`），重启 admin-api。discovery 从 `{issuer}/.well-known/openid-configuration` 自动拉取（进程内缓存 1h）。
3. **账号绑定策略**（关键安全拍板，见 ADR-014）：
   - `OIDC_AUTO_PROVISION=false`（默认，生产推荐）：未知 IdP 身份登录被拒；管理员先在「用户管理」建**同名**账号，该用户首次 SSO 登录时自动写入 `oidcSub` 绑定；
   - `OIDC_AUTO_PROVISION=true`：未知身份首登自动建 USER 账号（占位随机密码，该账号不走密码登录）；适合全员开通场景。
4. **前端**：登录页在 `GET /auth/oidc/status` 返回 enabled 时自动出现「企业账号（SSO）登录」按钮，回调落地页 `/auth/sso/complete` 完成 token 注入。

**部署注意**：
- IdP 在同机/内网（如本机 Keycloak）：需 `OIDC_ALLOW_PRIVATE_NETWORK=true`（SSRF 态势默认拒内网出站，云元数据段恒拒）；
- 反代需放行 `/api/auth/oidc/*` 且**不得缓存** callback 响应；token 仅经 `#fragment` 回传前端，不会出现在访问日志；
- 多实例部署无需共享会话存储：state/nonce 为 HMAC 签名 cookie（密钥复用 `JWT_REFRESH_SECRET`），任一实例均可独立完成回调校验；
- SSO 与 TOTP 正交：IdP 侧 MFA 责任面由 IdP 承担，平台侧 TOTP 仍只作用于密码登录。


### 解释器缓存与私有化模式（python_task_multiversion）

Python 任务可声明 `runtimeVersion`（主.次版本，如 `3.7` / `3.12` / `3.13`），执行器按声明**按需获取对应 CPython 解释器**并以其创建 venv 运行；不声明版本的任务沿用宿主解释器（存量语义逐字节不变）。解释器由执行器内置的 uv 下载（`uv python install <version>`）到**本地解释器缓存池**，同宿主多个任务 venv 复用同一解释器层，避免重复下载。

#### 主路径与两种可选模式（D9）

| 模式 | 启用方式 | 适用 |
|---|---|---|
| **在线主路径**（默认，所有部署必有） | 无需配置 | 执行器可达 Astral CDN / GitHub Releases。声明的版本首跑触发 `uv python install`，约 13~17s |
| **可选模式 A：内网镜像** | `UV_PYTHON_INSTALL_MIRROR=https://mirror.internal/...` | 无外网、仅内网镜像可达 |
| **可选模式 B：离线预填缓存卷** | 部署期预置解释器到 `interpreter_cache` 卷 | 无外网无镜像，或需要 **3.7**（见下） |

镜像地址格式约束（复用 `validate_pypi_registry_url` 规则）：**仅 http(s)，且不得含 userinfo（凭据）/ query / fragment**——该值会进入 uv 的 argv，不得携带密钥。

**镜像必须复刻 uv 的路径布局**（实测：设 `UV_PYTHON_INSTALL_MIRROR=https://mirror.internal/pbs` 后，uv 0.8.17 请求的是）：

```
<mirror>/<pbs发布tag>/cpython-<完整版本>%2B<tag>-<pbs平台三元组>-install_only_stripped.tar.gz
# 实例（uv 0.8.17 实测请求 URL）：
#   https://mirror.internal/pbs/20250902/cpython-3.9.23%2B20250902-x86_64-pc-windows-msvc-install_only_stripped.tar.gz
```

即：镜像根 → `/<tag>/` → 文件名（`+` 被 URL 编码为 `%2B`）。**注意此处用的是 python-build-standalone 的三元组**（与池目录名的 uv 三元组不同，见 runbook §1.2）。内网镜像可直接反向代理 `github.com/astral-sh/python-build-standalone/releases/download/` 实现。

> 镜像**只替换下载源，不改变 uv 的可下载版本清单**：3.7 不在清单内，镜像放什么都不会被查询到——这是 3.7 必须走离线预填而非镜像的原因。

#### 桌面客户端（Windows/macOS）的对应配置

上面用环境变量描述的模式，在**桌面客户端**上等价地在「设置 → Python 运行环境」里配置
（内部同样以环境变量下发给执行器子进程，语义完全一致）。运维无需改配置文件：

| 部署文档里的变量 | 桌面客户端设置项 | 说明 |
|---|---|---|
| `UV_BIN` / uv 位置 | **uv 可执行文件路径** | 留空 = 用安装包自带 uv |
| `UV_PYTHON_INSTALL_MIRROR` | **解释器镜像源** | 内网镜像地址 |
| `UV_PYTHON_INSTALL_DIR` | **解释器池目录** | 离线预填的落点 |
| `PYPI_REGISTRY_URL` | **私有 PyPI 源** | 仅影响依赖安装 |
| `INTERPRETER_DOWNLOAD_TIMEOUT_MS` | **解释器下载超时（毫秒）** | 0 = 默认 |

设置页顶部会实时显示**实际生效**的 uv 路径、解释器池目录与池内已就绪的版本，
是排查「配置了却没生效」最快的一手信息。

> **重要前提：安装包只自带 uv，不含 Python 本体。** uv 是包管理器，负责按任务声明的
> `runtimeVersion` **去获取**解释器。因此「自带 uv」不等于「离线可用」：
> - **能访问外网** → 首跑自动下载（默认主路径，无需配置）；
> - **纯内网** → 必须配镜像源，或按本手册离线预填解释器池；
> - **3.7** → 无论哪种情况都必须离线预填（不在 uv 可下载清单内）。

#### ⚠ 关于 Python 3.7（必读）

**uv 的可下载清单只覆盖 `3.8 ~ 3.14`，不含 3.7**——`uv python install 3.7` 必然失败（`error: No download found for request: cpython-3.7-<platform>`，exit 2），**升级 uv 也无法解决**（已交叉实测 0.11.14，下界同样是 3.8）。

3.7 因此**只能由部署方离线预填缓存卷**（可选模式 B 的强制场景）。完整操作步骤、平台三元组对照表、故障诊断见 **[`docs/design/python-task-upload-and-multiversion/OFFLINE-PROVISIONING.md`](./design/python-task-upload-and-multiversion/OFFLINE-PROVISIONING.md)**；支持矩阵定稿（含 3.7 仅 x86_64 可用等限制）见同目录 [`SUPPORT-MATRIX.md`](./design/python-task-upload-and-multiversion/SUPPORT-MATRIX.md)。

可声明区间 `3.7 ~ 3.14`；在线可下载区间 `3.8 ~ 3.14`。区间外版本声明被拒绝保存。

#### 降级语义（D14：明确失败，不回退）

未启用 A/B 且网络不可达时，声明缺失版本的任务**明确失败**：

- 失败分因 `interpreter_unavailable`；
- 错误消息含声明版本、失败原因、候选执行器及其已缓存解释器快照；
- 声明 3.7 而缓存缺失时，消息**明确指引**"3.7 不支持在线下载，需部署方离线预填解释器缓存卷"。

**为什么不回退到宿主解释器**：回退会让"版本不匹配"被静默掩盖——任务看起来跑成功了，实际用的是错误版本，问题推迟到生产环境才暴露（例如 3.7 项目在 3.12 下依赖解析失败或行为漂移）。**明确的失败比静默的错误结果更有价值**。若未来需要"降级到最接近可用版本"，属新需求，须显式评估语义风险后另行决策。

#### 容量规划（NFR-12 / NFR-15）

```
缓存池总占用 = 已缓存版本数 × 单版本解压后体积
约束：版本数 × 单版本体积(≤ INTERPRETER_SINGLE_VERSION_MB = 250MB) ≤ INTERPRETER_TOTAL_GB = 4GB
```

实测输入（作容量测算基准）：

| 项 | 实测值 |
|---|---|
| 单版本压缩包 | 21 ~ 30 MiB |
| 单版本解压后 | **≈ 57 MB** |
| 首次下载耗时 | **≈ 13~17 s**（D11 默认超时 300s，余量 18~23 倍） |
| 3.7.9 Windows 产物（含 `.pdb`） | 121.9 MB（剔除 `.pdb` 后 70.6 MB） |

**工作示例**：验收矩阵四版本（3.7 + 3.9 + 3.12 + 3.13）≈ **230 MB**，仅占 4 GB 上限的 **5.6%**；全区间七版本（3.8~3.14）≈ 400 MB（10%）。

**治理方式（与常规 TTL 的区别，重要）**：解释器层**豁免常规 TTL 清扫**——`DISK_CLEANUP_TTL_DAYS`（默认 7 天）的清扫只作用于 `WORK_DIR`（任务工作目录与 venv），**不删解释器**。解释器是可复用资产，被 TTL 删掉就要重新下载（离线环境下永久不可恢复）。因此：

- 物理隔离：`UV_PYTHON_INSTALL_DIR`（compose 为 `/data/interpreters`）**独立于** `WORK_DIR`（`/data/tasks`），两者挂不同命名卷；
- 显式豁免：`maintenance.py` 跳过解释器层（物理隔离是主防线，豁免是第二道——即便部署方把池配进了 `WORK_DIR`，清扫也会放过它）；
- 改由**体积红线**治理：单版本 > `INTERPRETER_SINGLE_VERSION_MB`（250MB）或总池 > `INTERPRETER_TOTAL_GB`（4GB）→ **告警 + 回收最久未使用版本**（按目录 mtime）。

> **回收是「引用感知」的**：仍被任务 venv 依赖的版本一律跳过（venv 的 `bin/python` 只是指向池内目录的 shim，删了 venv 当场报废）。若所有超限候选都被引用，则**一个都不删**、只告警——宁可池暂时超红线，也不静默弄废用户 venv。此时需等 `.venvs` 到期被 TTL 清扫，或调大 `INTERPRETER_TOTAL_GB`。详见 [`docs/operations.md`](./operations.md)「解释器缓存池运维」。

> ⚠️ **不要**把 `UV_PYTHON_INSTALL_DIR` 设成 `WORK_DIR` 的子目录（如 `/data/tasks/interpreters`），否则会被 TTL 清扫误删。

#### 并发模型（NFR-16 / D13）

多任务并发首次请求同一版本时，执行器保证**该版本只下载一次**：

- **per-version 锁**：同版本请求串行化，先到者下载，后到者等待；
- **全局单下载队列**：任意时刻全局至多一个 in-flight 下载（避免多版本并发下载打满带宽）；
- 等待者阻塞至下载完成后走"缓存命中"分支复用，**不重复下载、不产生目录写竞争**。

#### compose 配置（已内置，默认即可用）

根 `docker-compose.yml` 已为两个执行器声明池目录与命名卷，**默认无需改动**：

```yaml
services:
  executor-python:
    environment:
      UV_PYTHON_INSTALL_DIR: /data/interpreters   # 独立于 WORK_DIR
      UV_PYTHON_INSTALL_MIRROR: ${UV_PYTHON_INSTALL_MIRROR:-}   # 留空 = 在线主路径
      INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS: ${INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS:-300}
      INTERPRETER_SINGLE_VERSION_MB: ${INTERPRETER_SINGLE_VERSION_MB:-250}
      INTERPRETER_TOTAL_GB: ${INTERPRETER_TOTAL_GB:-4}
      PYTHON_RUNTIME_VERSION_MIN: ${PYTHON_RUNTIME_VERSION_MIN:-3.7}
      PYTHON_RUNTIME_VERSION_MAX: ${PYTHON_RUNTIME_VERSION_MAX:-3.14}
    volumes:
      - executor_python_data:/data/tasks          # 任务工作目录（受 TTL 清扫）
      - interpreter_cache:/data/interpreters      # 解释器缓存池（豁免 TTL）
  executor-node:
    environment:
      UV_BIN: ${UV_BIN:-}                          # 留空 = 自动解析（desktop 注入内置 uv）
      UV_PYTHON_INSTALL_DIR: /data/interpreters
      # …同名变量同义
    volumes:
      - executor_node_data:/data/tasks
      - interpreter_cache:/data/interpreters       # 与 python 执行器共享同一卷

volumes:
  interpreter_cache:
```

> **⚠️ 两个执行器基底 libc 不同，解释器产物不可互换**：`executor-python` 基于 `python:3.12-slim`（Debian/**glibc**，池目录用 `linux-x86_64-**gnu**`），`executor-node` 基于 `node:24-alpine`（Alpine/**musl**，用 `linux-x86_64-**musl**`）。**共卷是安全的**（uv 按平台分量过滤，非本平台条目被安全跳过——实测池内混放时 `uv python list --only-installed` 仍 exit 0），但**离线预填时须两个 libc 各放一份**，否则其中一个执行器探测不到该版本。详见 [`OFFLINE-PROVISIONING.md`](./design/python-task-upload-and-multiversion/OFFLINE-PROVISIONING.md) §5.4。

> **⚠️ 池内同平台损坏条目会拖垮整份清单**：一个"目录名看着对、但 uv 查询其版本失败"的条目，会让 `uv python list --only-installed` **整条 exit 2**；执行器随即 fail-safe 上报**空清单**（正常版本其实仍可用，只是上报被拖垮，管理台该执行器 `interpreters` 列变空）。预填后务必按 runbook §3.5 三关验证，**只把验证通过的解释器放进生产池**。详见 runbook §5.5 / §7.5。

**启用内网镜像（可选模式 A）**：在 `.env` 设 `UV_PYTHON_INSTALL_MIRROR=https://mirror.internal/...` 后 `docker compose up -d`。

**启用离线预填（可选模式 B）**：

```bash
# 1) 在能联网的机器上按 runbook 备好池目录（含 3.7 时必做）
#    步骤见 docs/design/python-task-upload-and-multiversion/OFFLINE-PROVISIONING.md
# 2) 确认卷名（compose 会加项目名前缀）
docker volume ls | grep interpreter_cache
# 3) 拷入卷
docker run --rm -v autocodeflow_interpreter_cache:/pool \
  -v "$PWD/seed/interpreters:/seed:ro" alpine sh -c 'cp -a /seed/. /pool/ && chmod -R a+rX /pool'
# 4) 重启执行器并验证
docker compose restart executor-python
docker compose exec executor-python uv python list --only-installed
```

> 池内文件须对非 root 的 `appuser` **可读可执行**（执行器容器以 `appuser` 运行）。若预填后报 `Permission denied`，补 `chmod -R a+rX`。

**多副本（HA）**：`docker-compose.ha.yml` 无需改动——`interpreter_cache` 定义在基线文件，admin-api 多副本与执行器解释器缓存无耦合；执行器不随 `--scale` 扩展，池仍是每台执行器一份（符合"同宿主复用同一解释器层"语义）。执行器横向扩容时每台各有独立池，各自按需下载或各自预填。

**观测点**：执行器启动/心跳上报 `interpreters` 清单（缓存池已装版本），管理台「执行器」列表可见；任务执行详情页展示 `interpreter_unavailable` 分因与 `result.interpreter` 快照。

## 多副本（HA）部署（DEP-HA-1）

admin-api 无状态层支持水平扩展：多实例行为一致性（渠道配置落库读穿、调度 Leader 恰一、灰度租约、outbox 恰一次派发）已由 ARCH-31 闭环并真机验证（`npm run test:arch31-multi-instance` 15/15、`npm run test:arch31-outbox-dup` 13/13）。本段给出部署菜谱与约束。

> **适用边界（E-1）**：`docker-compose.ha.yml` 只解决**应用层**（admin-api）多副本
> ——postgres 与 redis 在本 compose 中仍是**单实例单点**（数据库/缓存故障时所有
> 副本同时不可用）。本 override 不是数据层 HA。生产级数据层方案：
> - PostgreSQL：云 RDS 主从 + 自动故障切换，或自建 PG 流复制 + Patroni（compose
>   中的 `postgres-replica` 仅为演示只读路由联调用，**不做真流复制**）；
> - Redis：Sentinel 或 Cluster（应用侧已有 fail-open 降级：Redis 不可用退化为
>   DB 条件 UPDATE claim 兜底，但队列/锁语义会降级）；
> - admin-web/nginx 同为单点（入口可用云 LB 或多副本 nginx 解决）。

### 何时需要

- 单实例 CPU/内存水位长期偏高（任务派发、回调写入、SSE 推送为的主要负载）；
- 滚动重启不中断服务（一台重启时另一台继续接流量）。

### 步骤

```bash
# 1. 多副本启动（--scale 指定副本数；override 负责清空宿主端口 + 共享 uploads 卷）
docker compose -f docker-compose.yml -f docker-compose.ha.yml up -d --scale admin-api=2

# 2. 验证：经 admin-web（nginx）访问，请求应轮询命中两个副本
curl -si http://localhost/api/health | grep -i x-upstream   # X-Upstream 取证头显示实际命中的容器
npm run test:ha-compose                                     # 真机自检：多副本轮询断言（4/4）

# 3. 回到单副本
docker compose -f docker-compose.yml -f docker-compose.ha.yml up -d --scale admin-api=1
```

要求 Docker Compose v2.24+（`docker-compose.ha.yml` 使用 `ports: !reset []` 清空基线的 `3105:3105` 宿主端口发布——多副本共用宿主端口必冲突，流量统一走 admin-web 内置 nginx 反代）。

### nginx 侧行为（infra/nginx/default.conf，DEP-HA-1 已改）

- 上游为「变量 + 运行时再解析」形态：`resolver 127.0.0.11 valid=10s`（Docker 内嵌 DNS）+ `set $admin_api_upstream admin-api:3105`，两个 proxy_pass 位置（通用 `/api/`、SSE 专用位置）全部走变量（F-4：`/socket.io/` 块已删除，全仓无 WebSocket 实际使用）；
- `--scale` 出的多副本容器 = 服务名多条 A 记录，nginx 每请求轮询命中（自检实测 20 请求命中 2 副本，12:8）；容器重建 IP 漂移后 10s 内收敛，**滚动重启无需重启代理**；
- 响应带 `X-Upstream: <ip>:3105` 取证头（`always`，内网信息），排障可定位实例、自检据此断言轮询；
- 单副本部署行为不变（一条 A 记录 = 原直连语义）。

### 约束与建议

| 项 | 说明 |
|---|---|
| 调度 Leader 恰一 | cron 调度由 ARCH-31 Leader 选举保证不会双跑，无需运维动作 |
| 限流计数器 | `THROTTLE_*` 为进程内存态，多副本按实例独立计数；依赖精确限流阈值时建议入口层（云 LB/网关）统一限流 |
| uploads 一致性 | override 已为两副本挂同一命名卷 `admin_uploads:/app/uploads`；经实例 A 上传的应用包/artifact 对实例 B 可见 |
| 执行日志 | `LOG_STORAGE_DRIVER=db`（默认）存 PG 天然一致；切 `s3`（minio profile）同样共享 |
| 会话/令牌 | JWT 无状态校验 + OIDC state 为 HMAC 签名 cookie，多副本无需共享会话存储 |
| 入口单点 | nginx/admin-web 仍为单容器；入口级高可用用云 LB 或 K8s Ingress 前置 |
| 升级 | 拉新镜像后 `up -d --scale admin-api=2` 逐副本替换；迁移在副本启动时幂等执行，多副本同刻启动由「空库多实例种子竞态」防护兜底 |

## 执行器 pull 派发模式（NAT 回连，ARCH-32 / ADR-015 + ARCH-33 / ADR-016）

默认 **push** 派发要求执行器接受中心端入站连接。执行器位于多层 NAT 内（无公网 IP、不可端口映射）时，设 **pull 模式**即可零入站接入：执行器只用出站连接（长轮询取件 + 心跳 + 回调，同一方向），只要出站能访问中心端 URL（心跳已要求）即可收任务。

> **ARCH-33（ADR-016）起，pull 通道同时承载控制面。** ADR-015 只把「任务派发」搬上了 pull；部署/停止/卸载/配置热更新/终止执行/包推送这些**中台主动拨入执行器**的调用仍是入站 POST，在公网中台 + 内网执行器拓扑下必然超时（生产实证：`app_deployments.statusMessage = "Failed to reach executor after 3 attempts: timeout of 30000ms exceeded"`）。ADR-016 把它们改为经 pull 响应的 `commands` 字段下发，执行器本地回环执行。**协议 v2** 起生效。

### 使用步骤

```bash
# 1. 执行器侧：启动时设 EXECUTOR_PULL_MODE=true（executor-node / executor-python 同名变量）
#    重启后重注册自动上报 dispatchMode=pull + protocolVersion=2，管理台执行器列表可见
# 2. 中心端（可选调参，默认即工作）：
#    EXECUTOR_PULL_WAIT_MS=25000   # 长轮询等待窗口，须 < 反代 60s 读超时
#    EXECUTOR_PULL_TTL_MS=900000   # 任务载荷过期丢弃阈值（15min）
#    EXECUTOR_CMD_TTL_MS=1800000   # 控制命令载荷过期阈值（30min，长于任务——丢命令无兜底）
# 3. 触发任务：调度侧选择语义（分组/标签/亲和/loadScore/占坑）与 push 完全一致
```

### 语义与边界

| 项 | 说明 |
|---|---|
| 选择语义 | 与 push 逐字节一致——仅传输层分支：占坑成功后载荷入 Redis 队列 `acf:pull:{executorId}`，执行器长轮询取走 |
| 派发时延 | 执行器空闲即挂长轮询（25s 窗口），载荷入队后 ≤500ms 被取走 |
| 零行为变化 | 不设 `EXECUTOR_PULL_MODE` 的执行器默认 push，存量部署不受影响 |
| 多副本（HA） | 队列在共享 Redis，任意 admin-api 副本可应答拉取——与 DEP-HA-1 轮询负载均衡天然兼容 |
| never-pulled 兜底 | 执行器长期不拉取：载荷超 TTL 丢弃；执行行由既有 stale sweep 收敛（失败→重试预算） |
| 广播/钉死 | broadcast 对 pull 执行器逐台入队；pinning 到 pull 执行器同样生效 |
| 真机验证 | `npm run test:pull-dispatch`——执行器地址设不可达值跑通触发→取件→执行→回调全链（9/9），成功本身即零入站依赖的证明 |

### 控制面 pull 通道（ARCH-33 / ADR-016）

| 项 | 说明 |
|---|---|
| 命令队列 | `acf:cmd:{executorId}`，与任务队列 `acf:pull:{executorId}` **物理分离**——任务派发这条已验收链路的语义逐字节不变，命令的更长 TTL 与批量语义互不污染 |
| 命令类型 | **封闭枚举**六类：`deploy` / `app-stop` / `app-uninstall` / `config-reload` / `kill-execution` / `update-package`。本地路径由执行器按类型**自行构造**，绝不接受中台下发的自由路径 |
| 协议门禁 | 仅当执行器上报 `protocolVersion >= 2` 才下发 `commands`。v1/未上报的执行器会**静默忽略**该字段——中台若照发会把「静默丢弃」误判成「投递成功」，故退回 push（失败可见） |
| 满载仍可运维 | 执行器长轮询时上报 `freeSlots`；`0` = 满载 → 服务端**只发命令、不出队任务**（取走也没槽位跑，等于把瞬态容量问题固化成执行失败）。旧实现在满载时连轮询都不发，控制命令永远送不到 |
| 结果上报 | `POST /api/executors/command-result`（best-effort，仅可观测性）。**业务终态另有通道**：deploy 靠 `/app-deployments/heartbeat` 收敛，update-package 靠 `push-result` |
| kill 通知 | **ADR-016 起对 v2 pull 执行器可达**（走命令队列）。此前 best-effort 入站对 NAT 执行器不可达，只能依赖执行器自身硬超时；现在队列不可达时仍回落既有 fail-open 语义 |
| 同步→异步 | `deploy`/`stop`/`uninstall`/`kill` 无损失；`config-reload` 与 `update-package` 失去同步结果，接口如实返回 `queued: true`（**不谎报成功**），终态看执行器上报 |
| python 能力缺口 | python 执行器只有 `config-reload` / `kill-execution` 两个本地路由；`deploy`/`app-stop`/`app-uninstall`/`update-package` 是 node-only（`protocol.json` 的 `executorNodeOnly` 段已登记）。python 收到这四类**如实回报 unsupported**，而非回环打一个必然 404 的请求。这是**既有**缺口，不是本改动引入的回归 |
| 日志回填 | `GET api/logs/:id` 属**读**方向，单向 pull 通道载不了响应体——**明确不在本机制范围内**。NAT 执行器维持既有降级路径（终态回调携带日志尾部） |
| 升级顺序 | 无约束：中台先升级 → 旧执行器回落 push（行为不变）；执行器先升级 → 上报 v2，旧中台忽略该字段（行为不变） |

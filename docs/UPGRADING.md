# 升级指南：v1.15.0（生产 main）→ develop 下一版本

> **读者**：单人运维，生产跑 `main`/v1.15.0，要照着本文件把中台 + 执行器升到 develop 的内容。
> **核实基线**（2026-10-30，工作区 `/home/yongsheng/project/AutoCodeFlow`）：
> - `main` = `643cf3f1`（v1.15.0，2026-10-26）；`develop` = `a8cb3a2c`；
>   `git rev-list --left-right --count main...develop` → `0	302`（develop 领先 302 个提交，main 无独有提交）。
> - `version.txt` = `1.15.0`；最新 tag = `v1.15.0`（下一版本号由 release-please 生成，见 `release-please-config.json`）。
> - 本文所有命令/路径/env 键均可在仓库内核对；锚点写成 `file:line`，行号取上述基线，合并后可能漂移，**以符号名/文件名兜底**。
> - 本轮有 3 条破坏性改动处于**在途未提交**状态（`git status` 可见），文中统一标注「随本次发布生效」，并给出核实方式。

## 0. 一页纸结论

| 层 | 要不要动 | 结论 |
|---|---|---|
| **中台**（admin-api / admin-web） | **必须** | 15 个新迁移 + 13 个新 env 键（12 个有默认值；仅启用 `rustfs` profile 时的 `RUSTFS_SECRET_KEY` 必填；`WEBHOOK_DELIVERY_TTL_DAYS` 默认 7）。admin-web 必须与 admin-api 同批换。 |
| **执行器**（node / python / desktop） | **建议，非必须** | 协议版本没变（两端 `PROTOCOL_VERSION` 在 v1.15.0 与 develop **都是 8**），`supportedMinProtocolVersion` 仍为 1，老执行器照常注册收任务。升级只换来健壮性修复（见 §3.4）。 |
| **已开发/已部署应用** | **不需要** | releases 两段布局（5c）与参数 env 口径（A-11R）**已在 v1.15.0 内**，存量部署无需重部署、应用代码无需改（判据见 §4）。 |

- **预计停机窗口**：中台 **≈2–5 分钟**（换镜像 + 启动；容器 `HEALTHCHECK --start-period=60s`，见 `apps/admin-api/Dockerfile:34-35`）。迁移**不占**这段窗口——15 个新迁移可在旧版本继续服务时先跑完（§2.3 给出为什么安全）。
- **回滚方式**：admin-api/admin-web 回旧镜像 tag + **保留新库结构**即可（旧代码能读新表/新列，§5.2 逐条判定）；迁移层只有 `0073` 会真删数据（§5.1 列出），其余 14 个的 `down()` 都在。
- **本轮三条破坏性/行为改动**（§6.4 有专项验证命令）：产物上传默认只认 per-executor 令牌（403 `ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN`）、executor artifact 下载默认拒 `?token=`、应用发布 webhook 的 `x-autoflow-delivery` 真正参与幂等（返回 `duplicate: true`）。

## 1. 版本与兼容矩阵

先看「怎么判断某台执行器是不是旧版」——**不要看版本号**：`apps/executor-node/package.json` 与 `apps/executor-python/config.py:589` 的 `EXECUTOR_VERSION` 在 v1.15.0 与 develop 都是 `2.0.0`（没 bump）。可用判据是注册载荷里的 `protocolVersion` 与「是否携带 per-executor 令牌」。

| 组件 | v1.15.0 行为 | 新版本要求 / 变化 | 是否必须升级 |
|---|---|---|---|
| **admin-api** | 111 个迁移（`git ls-tree v1.15.0` 计数）；`migrationsRun: false`（`configuration.ts:889`），启动时由 `main.ts:144` `runBootstrapMigrations()` 带 `pg_advisory_lock` 跑 | 126 个迁移（15 个新，`node scripts/check-migrations.mjs` 实测「126 个迁移全部唯一且已注册，下一可用 1790000000082」）；+12 env 键 | **必须** |
| **admin-web** | 静态构建，nginx 托管（`docker-compose.yml:278`） | 同 release 一起换；新页面依赖新 API | **必须**（与 admin-api 同批） |
| **executor-node（docker）** | protocol 8；产物上传用 `getCurrentToken()` 的 per-executor 令牌 | 行为修复：部署失败自动重启旧进程（`c5d83f8e` EN-01）、日志缓冲溢出标记、退出码带信号名 | 否（建议） |
| **executor-node（裸机 systemd）** | 同上 | `scripts/install.sh` 可重跑（§3.2）；新版本只是同一脚本拉新 artifact | 否（建议） |
| **executor-python** | protocol 8；产物上传同用回调令牌（`artifacts.py:162-163`） | 停机取消丢终态载荷 / 下载面审计修复（`30e8cd7a`） | 否（建议） |
| **executor-desktop** | `1.9.3`（v1.15.0 的 `apps/executor-desktop/package.json`） | `1.9.4`；内嵌 executor-node bundle 随之更新 | 否（走自动更新即可） |
| **已部署应用**（daemon / once / scheduled） | `releases/<version>/<deploymentId>/` 两段（v1.15.0 已是，见 CHANGELOG 1.15.0「5c releases 目录两段化」） | 无变化；`readCurrentTarget` 同时兼容旧单段（`deploy.ts:937-953`） | **否** |
| **私有 npm / PyPI 私服**（registry-npm / registry-pypi） | — | registry-pypi 只有 Dockerfile digest pin + 防爆破修复，**路由与客户端契约未变**（`git diff v1.15.0..HEAD -- apps/registry-pypi/main.py` 无 `@app.` 增删） | 否（建议同批重建） |
| **Postgres** | `postgres:16-alpine` | 同一个镜像，只加了 digest pin（`docker-compose.yml:21`） | 否 |
| **Redis** | `redis:7-alpine` | 同一个镜像，只加了 digest pin（`docker-compose.yml:94`） | 否 |

**协议侧红线**（决定了「执行器先升还是中台先升」都能成立）：
- `PROTOCOL_SUPPORTED_MIN = 1`（`protocol-compat.util.ts:14`）、`protocol.json` 的 `supportedMinProtocolVersion: 1` → 旧执行器**不会被剔除**，新执行器注册进旧中台也不会被拒（register DTO 的 `protocolVersion` 无上限校验，`executor-register.dto.ts:47`）。
- `PROTOCOL_CONTROL_PLANE_MIN = 2`（`protocol-compat.util.ts:30`）→ 只有 `<2` 的执行器拿不到 deploy/stop 等控制命令。
- `EXECUTOR_MIN_VERSION` 默认为空 = 门禁关闭（`configuration.ts:407`、`.env.example` 中该键留空）。

## 2. 中台升级步骤（按序执行）

> 全程在仓库根执行；`<TAG>` 替换为要升到的 tag（下一版本号待 release-please 生成，或直接用 `develop` 的提交）。

### 2.1 备份（先做，不跳）

```bash
cd /path/to/AutoCodeFlow

# ① 用仓库自带的备份脚本（profile: backup；脚本自带 pipefail + 最小尺寸校验）
docker compose --profile backup up -d pg-backup        # 只需服务在跑，crond 默认每日 02:00
docker compose --profile backup exec pg-backup /usr/local/bin/pg-backup.sh
# 产物落在 backup_data 卷的 /backup/db_<YYYYmmdd_HHMMSS>.sql.gz

# ② 想留一份在宿主机（便于异地）：
docker compose --profile backup exec -T pg-backup sh -lc 'ls -1d /backup/db_*.sql.gz | tail -1'
docker compose --profile backup cp pg-backup:/backup/<上一步的文件名> ./pre-upgrade.sql.gz
```

- 脚本用法见 `scripts/pg-backup.sh:3-4`（手动验证命令逐字取自该头注）；`BACKUP_SCHEDULE` / `BACKUP_RETENTION_DAYS` 在 `.env.example` 的「PostgreSQL 定时备份」段。
- **判据**：`pg-backup.sh` 退出 0 且打印 `backup ok <path> <bytes>`；字节数 < 256 会被脚本自己判失败（`pg-backup.sh:31-35`）。
- 顺带备份**配置面**（迁移不回滚 env）：`cp .env .env.bak.$(date +%F)`。
- 想验证备份真能恢复，用演练库（默认不碰生产库）：`docker compose --profile backup run --rm pg-backup bash /usr/local/bin/pg-restore.sh /backup/db_xxx.sql.gz`（用法见 `scripts/pg-restore.sh:94-106`，写生产库必须显式加 `--force-overwrite-production`）。

### 2.2 拉代码 / 构建镜像

```bash
git fetch --all --tags
git checkout <TAG>              # 或 develop 的具体提交；不要在生产工作区留未提交改动
docker compose build admin-api admin-web
```

- 镜像是**本地构建**，不是拉 registry 镜像（`docker-compose.yml:124-127` 有 `build: context: ./apps/admin-api`）——所以「回滚镜像 tag」实际是「回滚到旧 git tag 重新 build」，见 §5.3。
- 构建产物含迁移 CLI：`apps/admin-api/package.json:31` 的 `migration:run:prod` = `node dist/migration-lock-cli.js up`。

### 2.3 先跑迁移，再起新容器（**顺序不能反**）

**为什么是这个顺序**（读码结论，不是习惯）：
1. 新容器启动时**确实会自己跑迁移**——`main.ts:186` 在 `NestFactory.create` 之前 `await runBootstrapMigrations()`（`main.ts:144`，`nodeEnv === "development"` 才跳过）。所以「先起容器」也能迁移，但**失败方式最差**：迁移报错 → 进程非零退出 → compose `restart: unless-stopped` 反复重启，你看到的是一串崩溃循环而不是一条明确的 SQL 错误（`main.ts` 的 `bootstrap().catch` 会 `process.exit(1)`）。
2. 迁移必须由**新镜像**执行（迁移文件在新镜像的 `dist` 里），旧镜像是「不知道有新迁移」的。
3. 15 个新迁移对**旧版本在线**是安全的：4 个建新表（`agent_approvals` / `ai_media` / `ai_sop_sessions` / `webhook_deliveries`，旧代码不碰）、6 个加列（全部 `NULL` 或 `NOT NULL DEFAULT`，见 §5.2）、4 个 `CREATE INDEX CONCURRENTLY`（`0075/0076/0077/0080`，不锁写）。唯一动数据的是 `0073`，它删的是 `agent_tool_calls` 里 `(session_id, tool_call_id)` 重复行——而 `tool_call_id` 列由 `0069` 才加上，旧代码写的全是 `NULL`，partial 索引 `WHERE tool_call_id IS NOT NULL` 不含 NULL，**实际 0 行被删**。

```bash
# 用新镜像跑迁移（--rm 跑完即走；compose run 会用新的 build 产物）
docker compose run --rm --no-deps admin-api node dist/migration-lock-cli.js up

# 迁移前后各查一次，数字应恰好 +15（TypeORM 的迁移记账表默认就叫 migrations）
docker compose exec -T postgres psql -U autoflow -d autoflow -c 'SELECT count(*) FROM migrations;'
```

- 迁移 CLI 带 `pg_advisory_lock` 互斥（`apps/admin-api/src/migration-lock-cli.ts:1-15`），与 boot 路径同键，HA 双副本同时跑不会互相踩。
- **判据**：命令退出 0，日志出现迁移逐个 `Migration Xxx has been executed successfully`；再跑一次应输出 `No migrations are pending`（`migration-runner.util.ts:192`）。

### 2.4 15 个新迁移的落地顺序与耗时量级

按时间戳顺序（TypeORM 天然按名排序），耗时量级取决于**现场行数**，不是常数——所以给判据而不是给数字：

| 迁移 | 操作 | 锁/耗时判据 |
|---|---|---|
| `0022/0049/0050/0051/0053/0055/0056/0061` | **已执行过**（v1.15.0 内），develop 只改了 `down()` 与超时豁免 | 不会重跑（TypeORM 按 `name` 记账）。`0061` 的 `up()` 从 `CREATE INDEX` 改成 `CONCURRENTLY`，对存量库**无影响**（索引已在），只在全新库上生效 |
| `0067` `CreateAgentApprovals` | 建表 | 空表，毫秒级 |
| `0068` `0072` `0074` `0078` `0079` | 加列（`NULL` 或 `NOT NULL DEFAULT`） | PG 11+ 元数据操作，瞬时；`0074/0079` 有默认值不重写表 |
| `0069` `AddAgentToolCallToolCallId` | 加列（`NULL`） | 瞬时（`0077` 的唯一索引依赖它先存在） |
| `0070` `CreateAiMedia` / `0071` `CreateAiSopSessions` | 建表 | 毫秒级 |
| `0073` `AddAgentToolCallUniqueToolCallId` | **DELETE 去重** | 可重复执行；耗时 ∝ `agent_tool_calls` 行数（新功能表，通常很小） |
| `0075` `0076` `0080` | 建索引 CONCURRENTLY | ∝ 各自表行数；不锁写，各自带 `statement_timeout=0` 豁免 |
| `0077` `AddAgentToolCallUniqueIndexConcurrently` | 建**唯一**索引 CONCURRENTLY | ∝ `agent_tool_calls`；必须排在 `0073` 之后（顺序敏感） |

现场估时（把 `<各表>` 换成实测行数）：

```bash
docker compose exec -T postgres psql -U autoflow -d autoflow -c "
SELECT relname, n_live_tup FROM pg_stat_user_tables
WHERE relname IN ('tasks','task_executions','audit_logs','agent_tool_calls','event_outbox','executor_metrics_history')
ORDER BY n_live_tup DESC;"
```

- 索引类迁移都带会话级 `SET statement_timeout = 0` + `finally RESET`（例：`1790000000075-AddTasksCreatedAtIdIndex.ts`），所以不会撞连接池 30s 上限。
- ⚠️ **半成品索引检查**（迁移被中途 Ctrl-C / 容器被杀时的残留）。`IF NOT EXISTS` 会命中 `indisvalid=false` 的同名索引并跳过，导致索引永远建不起来：

```bash
docker compose exec -T postgres psql -U autoflow -d autoflow -c \
"SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE NOT i.indisvalid;"
```
- 结果非空即需 `DROP INDEX CONCURRENTLY <名>` 后重跑该迁移。

### 2.5 迁移能不能回滚

- **代码层**：15 个新迁移**全部有 `down()`**（逐文件 `awk '/async down/',0'` 核对）。例外是 `0073` 的 `down()` 是刻意的空实现——头注写明「被删的重复行不可恢复，不伪造数据」（`1790000000073-...ts:38-40`）。
- **数据层**：不可逆的只有三种，回滚前必须知道：
  1. `0073` 删掉的重复台账行 —— 不可恢复（除非用 §2.1 的备份）；
  2. `down()` 里的 `DROP COLUMN`（`0068/0069/0072/0074/0078/0079`）—— 该列数据随回滚丢弃；
  3. `0070/0071/0067` 的 `down()` 是 `DROP TABLE` —— 表内数据全丢。
- **结论**：**回滚镜像不必回滚迁移**（§5.2 证明旧代码能读新结构）；只有「必须回到旧结构」时才有上面三类数据损失。

### 2.6 新 env 键怎么填 + 自检

13 个新键**全部可选、全部有默认值**（含本轮 SEC-3 的 `WEBHOOK_DELIVERY_TTL_DAYS=7`）（逐条核对 `configuration.ts` 的 `|| 默认值` 与 `.env.example`）——存量 `.env` 不改也能起来：

| 键 | 必填？ | 默认 | 说明 / 读取点 |
|---|---|---|---|
| `AI_MEDIA_BASE_URL` | 否 | 空 | 空 = 「视频转 SOP」不可用，其余 AI 能力不受影响（`configuration.ts:279`） |
| `AI_MEDIA_URL_SECRET` | 否 | 空 | 签名直链 HMAC 密钥，≥16 字符；空则如实报错（`ai-media-url.ts:141`） |
| `AI_MEDIA_URL_TTL_MS` | 否 | `3600000` | `configuration.ts:282` |
| `AI_MEDIA_RETENTION_DAYS` | 否 | `7` | `configuration.ts:286` |
| `AI_SESSION_RETENTION_DAYS` | 否 | `30` | `configuration.ts:288` |
| `AGENT_BLOCK_SELF_APPROVAL` | 否 | `false` | `true` 才启用四眼原则（`configuration.ts:299`） |
| `AGENT_CONTEXT_MAX_TOKENS` | 否 | `24000` | `configuration.ts:317` |
| `AGENT_CONTEXT_MIN_RECENT_MESSAGES` | 否 | `12` | `configuration.ts:319` |
| `LOG_STORAGE_ENDPOINT` | 否 | compose 里 `${LOG_STORAGE_ENDPOINT:-rustfs:9000}` | 仅 `driver=s3` 用（`docker-compose.yml:198`） |
| `LOG_STORAGE_ACCESS_KEY` | 否 | 跟随 `RUSTFS_ACCESS_KEY`→`autoflow` | `docker-compose.yml:200` |
| `RUSTFS_ACCESS_KEY` | 否 | `autoflow` | `docker-compose.yml:347` |
| `RUSTFS_SECRET_KEY` | **仅当启用 `rustfs` profile** | 无 | compose 写 `${RUSTFS_SECRET_KEY}`（`docker-compose.yml:350`，无 `:?` 也无默认）⇒ 起 rustfs 时为空即启动失败；`.env.example` 已注释说明 |

- 真·必填（compose 的 `:?` 强制注入，未设即解析报错）仍是老那 11 个，**本轮没有新增**：`POSTGRES_PASSWORD`/`REDIS_PASSWORD`/`DB_PASSWORD`/`JWT_SECRET`/`JWT_REFRESH_SECRET`/`EXECUTOR_SECRET`/`INITIAL_ADMIN_PASSWORD`/`REGISTRY_PASS`/`EXECUTOR_PYTHON_PUBLIC_ADDRESS`/`EXECUTOR_NODE_PUBLIC_ADDRESS`/`GRAFANA_ADMIN_PASSWORD`（monitoring profile）。核对命令：`grep -oE '\$\{[A-Z_]+:\?' docker-compose.yml | sed 's/\${//;s/:?//' | sort -u | wc -l` → 12（其中 1 个是注释里的示例 `VAR`）。
- **本轮在途新增的三个开关**（未提交，随本次发布生效）：`EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN`（默认 false，`artifacts.service.ts:256-274`）、`EXECUTOR_ARTIFACT_QUERY_TOKEN_COMPAT`（默认 false，`configuration.ts:490-491`）、`WEBHOOK_DELIVERY_TTL_DAYS`（默认 7，`webhook-delivery.service.ts:40-43,81`）。前两个在 `configuration.ts` 里**未注册**也能生效（`ConfigService` 走 process.env 兜底），所以直接写进 `.env` 即可。

自检漂移（**必跑**，退出码 0 = 无漂移）：

```bash
node scripts/check-env-drift.mjs
# 基线实测输出：代码消费的 227 个 env 键全部被 .env.example 覆盖或已豁免（豁免 39 个）
```

### 2.7 起新容器 + 健康检查 + 首验

```bash
docker compose up -d admin-api admin-web

# ① 存活（恒 200，不查依赖）
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/api/health/live
# ② 就绪（DB + Redis 都通才是 200；不就绪是 503，不是「200 + not_ready」）
curl -s http://localhost/api/health/ready | head -c 400
# ③ 登录（换成你的管理员账号）
curl -s -X POST http://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<INITIAL_ADMIN_PASSWORD>"}' | head -c 300
# ④ 详细健康（需 JWT，看 db/redis/queue/executors 五组件）
curl -s -H "Authorization: Bearer <accessToken>" http://localhost/api/health/detailed | head -c 600
```

- 端点与语义：`health.controller.ts` 的 `@Get("live")` 恒 200、`@Get("ready")` 不就绪返回 **503**（该文件内 A3 注释明确「此后不再恒返 200」）；全局前缀 `api`（`main.ts:365`），登录路由 `auth.controller.ts:119`。
- **首验「创建一条测试任务」**：用 admin-web 建一条最小 Git/Shell 任务并手动触发一次，判据是执行行进入 `success` 且执行器日志有本次 executionId。命令行等价：

```bash
curl -s -X POST http://localhost/api/tasks -H "Authorization: Bearer <accessToken>" \
  -H 'Content-Type: application/json' -d '{"name":"upgrade-smoke","type":"shell", ...}'
# 字段以 openapi.json / admin-web 表单为准；不确定就用界面建，避免猜 schema
```

- 容器自身也在探活：`apps/admin-api/Dockerfile:34-35` 的 `HEALTHCHECK` 打 `/api/health/live`，`docker compose ps` 里应为 `healthy`。

## 3. 执行器升级

### 3.1 桌面端（executor-desktop）

- **自动更新链**：`electron-updater` 6.8.11（`apps/executor-desktop/package.json:33`）。源有两种（`apps/executor-desktop/src/main/updater.ts:20-23`）：环境变量 `AUTOUPDATE_URL` 指通用 HTTP 源（`provider: 'generic'`，`updater.ts:336`）；没配则用打包时 `app-update.yml` 里的 `provider: github`，不需要显式 `setFeedURL`（`updater.ts:339`）。
- **最小版本要求**：仓库里**没有**桌面端「最低版本门禁」常量（全仓 grep `MIN_DESKTOP|minimumVersion|minSupported` 无桌面侧命中）。也就是说更新链是「谁在线谁自己更」，不存在「低于 X 必须手动装」的硬闸。
- **手动安装包回退**（自动更新失败/被墙时）：去 GitHub Releases 取对应平台的安装包直接装；注意 deb/rpm 安装形态**没有**应用内自更新通道（`apps/executor-desktop/src/renderer/i18n.ts:425` 注释），只有 AppImage 走 `AppImageUpdater`（`updater.selftest.ts:726`）——若生产用的是 deb/rpm，**必须**走手动装包，别指望自动更新。
- 桌面端内嵌 executor-node bundle，所以升桌面 = 同时升内嵌执行器。

### 3.2 裸机 node 执行器：`scripts/install.sh` 重跑是否幂等

**结论：可重跑，但不是「无损幂等」——它会覆盖两样东西。** 逐条依据（全部在 `scripts/install.sh`）：

| 步骤 | 重跑行为 | 判据 |
|---|---|---|
| 建用户 `autocodeflow` | 幂等（已存在则跳过） | `install.sh:187-191`（`useradd -r ... || true`） |
| 拉 artifact | `curl -fsSL -H "Authorization: Bearer ${EXECUTOR_SECRET}"` | `install.sh:206-209` —— **本来就是 Bearer 头**，所以 §6 的 `?token=` 收口对它零影响 |
| 解包 | `tar -xzf ... -C "$INSTALL_DIR"`，**覆盖**同名文件 | `install.sh:240` —— 旧的 `dist/` 被新版覆盖，属预期 |
| 写配置 | `cat > "${INSTALL_DIR}/.env"`，**整文件覆盖** | `install.sh:307` 起 —— ⚠️ 你在 `.env` 里手改过的行（并发数、WORK_DIR、额外 env）**会丢**。重跑前 `cp .env .env.bak` |
| systemd | 重写 unit + `daemon-reload` + `enable` + `restart` | `install.sh:347-380` —— 服务会重启，正在跑的任务会中断（执行器侧有 drain，但不是无限等） |
| sha256 | 有 `X-SHA256` 头就校验，没有就跳过（旧后端容忍） | `install.sh:212-233`（`X-SHA256` 解析在 218） |

**在「旧版 admin」上重跑会不会坏**：不会。旧 admin 同样接受 `Authorization: Bearer`（v1.15.0 的 `getExecutorArtifact` 是 `auth ?? Bearer(token)`，即头优先），且没有 `X-SHA256` 头时脚本走「跳过完整性校验」分支（`install.sh:233`）。**只有反向不成立**：新 admin 默认拒 `?token=`，而本脚本不用查询串。

### 3.3 python 执行器

```bash
# docker 部署（compose 服务名 executor-python，镜像本地构建）
docker compose build executor-python
docker compose up -d executor-python
docker compose logs --tail=50 executor-python     # 判据：注册成功、心跳 200、无 401/409

# 裸机部署（仓库内无 install.sh 的 python 分支）：按原部署方式重装依赖后重启
cd apps/executor-python && pip install -r requirements.txt && <你的 systemd/supervisor 重启命令>
systemctl restart <python-executor-unit>          # 或 supervisordctl restart ...
```

- 判定升级成功：心跳里 `protocolVersion` 仍为 8（`scheduler.py:444`），且没有新的 `/token` 409。**注意**：python 侧至今**不上报** `registrationConflict`（`config.py:675-689` 注释说明了这个「两处缺席」裁定），所以别拿这个键判断 python 是否新版。

### 3.4 升级顺序：先执行器还是先中台？

**推荐：先中台、后执行器；但先执行器也不会坏。**

- **先中台安全**：协议没 bump（v1.15.0 与 develop 都是 8），`supportedMinProtocolVersion=1`，`EXECUTOR_MIN_VERSION` 默认关 → 老执行器在新中台上照常注册、收任务。
- **先执行器也安全**：新执行器注册进 v1.15.0 中台，`protocolVersion` 无上限校验（`executor-register.dto.ts:47`），多出来的可选字段（`registrationConflict`）旧中台按「缺席/忽略」处理。
- **唯一的顺序耦合是产物上传（随本次发布生效）**：

| 场景 | 新中台 + 老执行器 | 结论 |
|---|---|---|
| 执行器用 `getCurrentToken()` 的 per-executor 令牌上传 | 通过（走渠道 2，`artifacts.service.ts:363-388`） | v1.15.0 的 node/python 执行器**本来就是这样**（`artifacts.ts:111` + `execute.ts:3042`；`artifacts.py:162`），所以**不升级也不会 403** |
| 执行器拿不到动态令牌，`getCurrentToken()` 回退静态共享令牌 | **403** `ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN`（`reason: shared_token`） | `middleware/auth.ts:450-452` 的 `dynamicToken \|\| readStaticToken()` 就是这条回退路径。触发条件：`/token` 长期失败、手工只配了 `EXECUTOR_SHARED_TOKEN` |
| 执行行缺 `executorAddress` | **403**（`reason: executor_address_unbound`，`artifacts.service.ts:366-380`） | 与执行器版本无关，属数据面问题 |

- **产物缺失是否影响任务终态？不影响，已核实**：产物上传全程 best-effort。node 侧 `uploadOne` 对非 2xx 只 `logger.warn('artifacts: 上传 X 返回 HTTP 403（跳过）')` 并 `return false`（`apps/executor-node/src/artifacts.ts:124-125`）；终态收集外层再包一层 `try/catch`，异常时返回 `undefined` 而**不阻塞回调**（`routes/execute.ts:3070-3086`，注释逐字为「best-effort——任何异常只记日志返回 undefined」）。python 侧同姿态（`routers/execute.py:3862` 日志文案「artifacts collection/upload failed (non-blocking)」）。
  ⇒ **任务的终态（success/failed）与退出码只由任务进程决定；403 只表现为「这次执行没有产物」，回调里 `artifacts` 字段缺席。**
- 所以升级顺序建议：**先中台（§2）→ 观察一次执行 → 再批量升执行器**。真要并行，先把 `EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN=true` 打开当保险，升完再关（§7 说明风险）。

## 4. 已开发应用是否需要调整

**结论：不需要改应用代码，也不需要重新部署存量应用。** 三条判据如下。

### 4.1 `5c` releases 两段化对**存量**部署的影响

- 两段布局 **v1.15.0 就已上线**（CHANGELOG 1.15.0 Features：「executor: 5c releases 目录两段化——`releases/<version>/<deploymentId>/`」），develop 只是继续沿用 → 生产上跑的执行器已经在写两段。
- 代码层面**两种布局都认**：`readCurrentTarget()` 把 `current` 软链解析成「相对 `releases/` 的 key」，注释明写「新两段：`<version>/<deploymentId>`；旧单段：`<version>-<deploymentId>`…相对路径无 `/` 时原样返回」（`apps/executor-node/src/routes/deploy.ts:937-953`）；`resolveReleasePaths()` 只在**同名目录已存在**时追加后缀、指向新目录，不迁移旧目录（`deploy.ts:985-1017`）；`pruneOldReleases()` 按「组」删除，两段/单段都自适配（`deploy.ts:1145-1149`）。
- **判据**：`ls -l <WORK_DIR>/apps/<appId>/releases/` 看到的是 `<version>` 目录（两段）或 `1.0.0-<uuid>` 目录（单段）——**两种都不需要动**。
- ⇒ **无需重部署**。若某台执行器的 `current` 是坏软链（`readCurrentTarget` 返回 null，`deploy.ts:944`），那是数据面异常，重部署一次即可，与本次升级无关。

### 4.2 `A-11R` 参数 env 口径（字符串不再 JSON 化）

- **已在 v1.15.0 内**：`A-11R` 的实现提交 `2b4a52f2` 是 `v1.15.0` 的祖先（`git merge-base --is-ancestor 89f4af45 v1.15.0` 成立），协议 v5 起生效（`docs/adr/adr-023-params-env-injection-contract.md`）。
- develop 里 `apps/executor-node/src/param-env.ts` 的改动是 `c59741fa`（params 折叠冲突两端拒绝 + env 转发清单），不改变「字符串裸值 + `AUTOFLOW_PARAMS_JSON` 类型化通道」这一口径。
- ⇒ 对存量任务/应用**零影响**：已经在 v1.15.0 上跑通的应用，其 `process.env.AUTOFLOW_X` 拿到的仍是裸字符串，`AUTOFLOW_PARAMS_JSON` 仍是精确类型通道。**不需要改应用、不需要重发版**。

### 4.3 本轮产物上传鉴权变化对已部署应用的影响

- 应用**不直接**上传产物：产物由**执行器**在终态回调前收集并 `PUT /api/executions/:execId/artifacts/:name`（`routes/execute.ts:3070` → `artifacts.ts:97`），凭据是执行器的 per-executor 令牌。应用进程只拿到 `AUTOFLOW_ARTIFACTS_DIR` 这个写目录（`routes/execute.ts:2382-2390`），把文件写进去即可。
- ⇒ 应用侧**没有任何凭据/接口变化**。若某应用历史上自己直连中台上传产物（非常规用法），它会走共享令牌 → 本轮会 403；这种应用需要改成「写文件到 `AUTOFLOW_ARTIFACTS_DIR`，由执行器代传」。
- **判据**（确认你的应用没有直连中台传产物）：`grep -rn "artifacts" <你的应用仓库>` 只应命中写文件的路径；若出现 `PUT /api/executions/.../artifacts` 则是直连，需要改。

### 4.4 明确结论

> **应用代码不需要改。** 判据三条同时成立：① 应用与中台的契约面（`AUTOFLOW_*` env + 产物目录 + 回调由执行器代发）在 v1.15.0 → develop 之间未变（协议仍 8，`A-11R` 早已在 v1.15.0）；② releases 目录布局两种都兼容（`deploy.ts:937-953`）；③ 产物上传凭据只涉及执行器身份，与应用进程无关。
> 唯一需要动的应用形态：**自己直连中台 `PUT .../artifacts` 上传产物的应用**（§4.3 判据）。

## 5. 回滚

### 5.1 迁移可逆性清单（15 个新迁移）

| 迁移 | `down()` | 回滚代价 |
|---|---|---|
| `0067` 建 `agent_approvals` | `DROP TABLE` | 表数据全丢 |
| `0068` 加 `consumedAt` | `DROP COLUMN` | 列数据丢 |
| `0069` 加 `toolCallId` | `DROP COLUMN` | 列数据丢 |
| `0070` 建 `ai_media` | `DROP TABLE` | 表数据（媒体元数据）全丢 |
| `0071` 建 `ai_sop_sessions` | `DROP TABLE` | 表数据全丢 |
| `0072` 加 `turnLockedAt` | `DROP COLUMN` | 列数据丢 |
| `0073` 去重（删行） | **空实现（刻意）** | ⚠️ **被删行不可恢复**，且回滚不会把行加回来 |
| `0074` 加 `autoResumeCount` | `DROP COLUMN` | 列数据丢 |
| `0075/0076/0080` 建索引 | `DROP INDEX CONCURRENTLY` | 无数据损失 |
| `0077` 建唯一索引 | `DROP INDEX CONCURRENTLY` | 无数据损失 |
| `0078` 加 `createdBy` | `DROP COLUMN` | 列数据丢 |
| `0079` 加 `runOnUpstreamFailure` | `DROP COLUMN` | 列数据丢 |
| `0081` 建 `webhook_deliveries` + 2 索引（随本次发布） | `DROP TABLE` | 投递账本全丢——只影响幂等（重投会被当首投），不影响业务数据 |

执行回滚（只在你确实要回到旧结构时）：

```bash
docker compose run --rm --no-deps admin-api node dist/migration-lock-cli.js down
# 一次只回滚最后一个迁移；要连续回滚就重复执行（TypeORM CLI 语义）
```
- 前置判据：`migration-lock-cli.ts` 与 boot 同 `pg_advisory_lock` 键，回滚时不要有别的实例在启动迁移。
- 半途失败会留下「半删索引」：用 §2.4 的 `indisvalid` 查询复查。

### 5.2 回滚后旧版本（v1.15.0 镜像）能否读新表/新列

**逐条结论：能。** 依据：

| 新结构 | 旧代码行为 | 结论 |
|---|---|---|
| 3 张新表（`agent_approvals` / `ai_media` / `ai_sop_sessions`） | 旧实体不映射 → 完全不访问 | ✅ 无影响 |
| `task_executions.executorId`（`0055`，`uuid NULL`） | 旧代码 SELECT 显式列 / INSERT 不含该列 → NULL | ✅ |
| `executor_metrics_history.executorId`（`0061`，无 `NOT NULL`） | 同上 | ✅ |
| `agent_approvals.consumedAt` / `agent_tool_calls.toolCallId` / `ai_sop_sessions.turnLockedAt` / `agent_sessions.createdBy` | 全部 `NULL` 可空 | ✅ |
| `agent_sessions.autoResumeCount` `integer NOT NULL DEFAULT 0`（`0074`） | 有默认值 ⇒ 旧 INSERT 不写该列也成功 | ✅ |
| `tasks.runOnUpstreamFailure` `boolean NOT NULL DEFAULT false`（`0079`） | 同上 | ✅ |
| `agent_tool_calls` 上的 partial unique index（`0077`） | 旧代码从不写 `tool_call_id` ⇒ 恒 NULL ⇒ 不进索引 | ✅ 不会 23505 |
| `webhook_deliveries`（随本次发布：`0081`） | 旧代码不读不写 | ✅ |
| `tasks.name` 唯一索引（`0050`，**v1.15.0 已有**） | 不是本轮引入，不受影响 | — |

唯一要在意的是**旧代码 + 新表结构下的行为差异**：`runOnUpstreamFailure` 之类的字段旧代码不认，界面上会「消失」，但不会报错。

### 5.3 中台回滚步骤

```bash
cd /path/to/AutoCodeFlow
git checkout v1.15.0                 # 回到生产基线
docker compose build admin-api admin-web
docker compose up -d admin-api admin-web
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/api/health/live
```
- **不要**顺手 `docker compose down -v`（会删 `postgres_data` / `admin_uploads` / `backup_data` 卷）。
- 新 env 键留着无害（旧代码不读）；也可以还原 `.env.bak`。
- 若中台回滚后要连带回滚库结构，先读 §5.1 的三类数据损失。

### 5.4 执行器回滚

| 组件 | 回滚方式 |
|---|---|
| node（裸机） | `git checkout v1.15.0 && bash scripts/install.sh --api-url ... --secret ...` 重跑（会覆盖 `.env`，先备份）；或 `systemctl stop` 后把旧 `dist/` 放回原位再 `start` |
| node（docker） | `git checkout v1.15.0 && docker compose build executor-node && docker compose up -d executor-node` |
| python | 同 §3.3 的构建 + 重启命令，代码回 `v1.15.0` |
| desktop | 装回旧版安装包；`electron-updater` 不会自动降级（`isNewerVersion` 只升不降，`updater.ts:53-106`）⇒ **必须手动装包** |

## 6. 升级后自检清单

### 6.1 中台

- [ ] `node scripts/check-migrations.mjs` 通过（应报 126 个迁移，下一可用 `1790000000082`）
- [ ] `docker compose run --rm --no-deps admin-api node dist/migration-lock-cli.js up` 二次执行输出 `No migrations are pending`
- [ ] `node scripts/check-env-drift.mjs` 退出 0
- [ ] `curl -s -o /dev/null -w '%{http_code}' http://localhost/api/health/live` → `200`
- [ ] `curl -s http://localhost/api/health/ready` → 200 且 `status:"ready"`
- [ ] 登录成功、`/api/health/detailed` 五组件正常
- [ ] `docker compose ps` 中 admin-api 为 `healthy`
- [ ] `SELECT ... indisvalid` 无 `false`（§2.4）

### 6.2 执行器

- [ ] 执行器列表里在线数 = 预期台数，无新增 401/409
- [ ] `journalctl -u autocodeflow-executor -n 100`（或 `docker compose logs executor-node`）无 `注册失败`
- [ ] 跑一条最小任务，终态 `success`

### 6.3 应用

- [ ] `ls -l <WORK_DIR>/apps/<appId>/releases/` 与 `current` 软链可解析
- [ ] daemon 应用重启后仍在跑（`current` 指向正确、进程在）

### 6.4 本轮三条破坏性改动的专项验证

> 以下命令按「随本次发布生效」的在途实现写（`artifacts.service.ts:256-274,312-390`、`executor.controller.ts:1142-1160`、`application.controller.ts` webhook 段）。

**① executor artifact 下载：无头 → 401；带 Bearer → 200；`?token=` → 401（默认）**

```bash
A=http://localhost/api/executors/artifact/executor-node.tar.gz
curl -s -o /dev/null -w 'no-auth=%{http_code}\n' "$A"                        # 期望 401
curl -s -o /dev/null -w 'bearer=%{http_code}\n' -H "Authorization: Bearer $EXECUTOR_SECRET" "$A"   # 期望 200（404 = 产物未生成，见 EXECUTOR_ARTIFACT_DIR）
curl -s -o /dev/null -w 'query=%{http_code}\n' "$A?token=$EXECUTOR_SECRET"   # 期望 401（默认）
docker compose logs --tail=20 admin-api | grep -c 'SEC-2'                     # 期望 0 条（未开兼容模式）
# 打开兼容模式后再验一次：
# EXECUTOR_ARTIFACT_QUERY_TOKEN_COMPAT=true → query=200 且日志出现一条 [SEC-2] warn
```

**② 产物上传：共享令牌 → 403 且任务终态仍 success**

```bash
# 取一条真实执行：先制造一次带产物的执行，记下 execId
EXEC=<execId>
# 用共享令牌直传（模拟老执行器）
curl -s -o /dev/null -w 'shared=%{http_code}\n' -X PUT \
  -H "Authorization: Bearer $EXECUTOR_SECRET" \
  -F file=@/etc/hostname \
  "http://localhost/api/executions/$EXEC/artifacts/probe.txt"
# 期望 403，body 的 code = ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN，params.reason = shared_token
```
- 然后确认该执行的终态：`GET /api/tasks/executions/<execId>` 仍为 `success`（产物字段缺席即可）——依据 §3.4 的 best-effort 链路。
- 兼容模式复验：`EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN=true` → 同一命令 `200`，`docker compose logs admin-api | grep 'SEC-1 兼容模式'` 有一行 warn。

**③ 应用发布 webhook：重复投递 → `duplicate: true` 且不再重复升级**

```bash
# 用一个真实应用与其 webhookSecret，固定同一个 delivery id 连投两次
SECRET=<app webhookSecret>; TS=$(date +%s)
BODY='{"appName":"<appName>","version":"9.9.9","triggerDeploy":false}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
for i in 1 2; do
  curl -s -X POST http://localhost/api/applications/webhook \
    -H 'Content-Type: application/json' \
    -H "X-Hub-Signature-256: sha256=$SIG" -H "X-AutoCodeFlow-Timestamp: $TS" \
    -H "x-autoflow-delivery: probe-$(date +%F)-001" -d "$BODY"; echo
done
# 第 1 次：正常响应（ok:true）
# 第 2 次：{"ok":true,"duplicate":true,"deliveryKey":"probe-...","receivedAt":"...","deduplicated":true}
```
- 判据②：只产生**一次**版本更新 / 一轮升级（`docker compose logs admin-api | grep -c 'duplicate delivery'` = 1）。
- 老集成不传 `x-autoflow-delivery` 时行为不变（`claim` 返回 `no_key`，`webhook-delivery.service.ts:45`），仍由 10 分钟 Redis 签名窗兜底（`deduplicated:true`）。

## 7. 已知取舍

1. **为什么 `EXECUTOR_ARTIFACT_QUERY_TOKEN_COMPAT` 默认关**：查询串凭据会进 nginx/ALB access log、shell history、`ps`、Referer，而这里是**机队共享令牌**——一条日志泄露 = 整支机队安装通道泄露（同类通道已在 SSE 面撤除，见 `apps/admin-web/src/api/sse.ts`）。仓库内**零** `?token=` 消费者（`scripts/install.sh:206-209` 早就是 `-H "Authorization: Bearer …"`），所以关掉不打断任何内置链路。
   - **开了的风险**：共享令牌以明文形态出现在访问日志里；`SEC-2` 每次命中打一条 warn，便于你统计欠账，但它不会自动收敛——**开关忘了关就等于把这次收口作废**。
2. **为什么 `EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN` 默认关**：共享令牌不携带执行器身份，持它者只要知道 `execId`（UUID，出现在回调载荷、管理台 URL、日志里）就能：往**别人执行**的产物目录写入任意文件（产物可下载、可被部署消费 ⇒ 替换他人交付物），或用 `MAX_ARTIFACT_COUNT` 把目录灌满让合法执行器后续上传失败（`artifacts.service.ts:279-292`）。
   - **开了的风险**：上述跨执行器写权限完整恢复；日志里每次上传都会有一条 `SEC-1 兼容模式` warn。设计上它只是**过渡**，执行器升完必须关。
   - 注意这条收口**刻意也不放过「自己的执行」**：共享令牌不携带身份，放行「自己」等于放行全部（`artifacts.service.ts:352-354` 注释）。
3. **为什么 webhook 幂等默认就是开**（不需要开关）：默认值即正确值——`deliveryKey` 缺席时退回旧行为（签名窗去重），只有显式带 `x-autoflow-delivery` 才启用 7 天 DB 账本；账本不可达时 **fail-open**（宁可重复一次发布，也不让所有 CI 集成因附属表抖动全挂，`application.controller.ts` webhook 段注释）。
   - **风险**：同一个 delivery id 在 7 天内重投会被判重——如果某个 CI **复用**固定 delivery id 做「多次发布」（错误用法），第 2 次起会被静默跳过。判据：`WEBHOOK_DELIVERY_TTL_DAYS`（默认 7）与 CI 是否生成唯一 id（GitHub Actions 用 `${{ github.run_id }}-${{ github.run_attempt }}` 即天然唯一）。
4. **为什么不把执行器升成硬要求**：协议没 bump，硬要求会让「只升中台」的窗口期无法灰度。代价是你会有一段时间跑「新中台 + 老执行器」，拿不到 `c5d83f8e` EN-01 的修复——即**升级失败时旧 daemon 应用会被留在停服状态**（旧行为：只回滚 `current` 软链、不重启旧进程）。这也是「建议尽快升执行器」的真实理由，而不是协议不兼容。

## 8. 本次核实中与既有说法不一致的地方（以代码为准）

写文档时逐条复核，以下 4 处与「任务背景」的表述不符，本文按**代码事实**落笔：

1. **「22 个新增迁移」** → 实际是 **15 个新迁移 + 8 个「已执行过但被修改」的迁移**。`git diff --name-only v1.15.0..HEAD -- 'apps/admin-api/src/migrations/*.ts'` 出 22 个，但 `--diff-filter=A` 只有 14 个，`--diff-filter=M` 有 8 个（`0022/0049/0050/0051/0053/0055/0056/0061`）；再加未提交的 `0081`（`webhook_deliveries`）= 15 个待执行。总数 111 → 126，`scripts/check-migrations.mjs` 实测一致。
2. **「三条破坏性改动正在落地」** → 核实时刻（`a8cb3a2c` + 工作区）它们在**工作区未提交**（`git status` 可见 `artifacts.service.ts` / `executor.controller.ts` / `application.controller.ts` / `configuration.ts` 的 `M`，以及 `?? 1790000000081`），**HEAD 上还没有**。核实方式：`git grep -n EXECUTOR_ARTIFACT_QUERY_TOKEN_COMPAT HEAD` 为空 ⇒ 未提交；工作区有 ⇒ 在途。文档按「随本次发布生效」写。
3. **webhook 幂等的返回字段**：背景写 `duplicate: true`，代码里实际**同时**返回 `duplicate: true`、`deduplicated: true`、`deliveryKey`、`receivedAt`（后者为兼容既有「同签名去重」的响应形态）。且幂等账本按 `(scope, deliveryKey)` 唯一的 DB 表实现（`0081`），**不是**按签名——签名窗去重（10 分钟 Redis）仍然并存。
4. **桌面端「最小版本要求」不存在**：全仓无桌面最低版本门禁常量；`electron-updater` 只做「远端是否严格新于本地」的 semver 比较（`updater.ts:53-106`），不会自动降级，也没有「低于 X 强制升级」的闸。

另有两处值得单独记一笔（不构成冲突，但会影响你的操作）：
- **迁移不是必须先手动跑**：`main.ts:186` 在非 development 环境会先跑 `runBootstrapMigrations()`。本文仍推荐手动先跑，理由是**失败可见性**（容器崩溃循环 vs 一条 SQL 报错），不是能力缺失。
- **`0061` 的 `up()` 在 develop 里从 `CREATE INDEX` 改成了 `CREATE INDEX CONCURRENTLY`**，但该迁移在 v1.15.0 已执行过、TypeORM 按 `name` 记账不会重跑 ⇒ 存量库的该索引仍是普通方式建的，**本次升级不会自动重建成 CONCURRENTLY**（无害，仅记录）。

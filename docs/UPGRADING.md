# 升级指南：v1.15.0 → v2.0.0（已发布），以及 v2.0.0 → develop

> **受众**：正在执行版本升级的自托管运维 · **状态**：稳定 · **最后核对**：2026-11-02
> **读者**：自托管运维。本文覆盖两段路，按需取用：
> - **① v1.15.0（上一稳定线）→ v2.0.0（2026-10-30 已发布）**——**必须做**，含 15 个迁移与 3 条破坏性改动（§0–§8）；
> - **② v2.0.0 → develop（未发布）**——**可选灰度**，12 个纯增量迁移、2 个新 env 键、无破坏性变更（§9）。
>
> **核实基线**（2026-11-02，工作区 `/home/yongsheng/project/AutoCodeFlow`）：
> - `main` = `3159ad86`（v2.0.0 之后 31 个提交）；`develop` = `e3cb0797`（领先 main 45 个提交，main 无独有提交）。
> - `version.txt` = `2.0.0`；`release-please-manifest.json` 的 `"."` = `2.0.0`；最新平台 tag = `v2.0.0`（2026-10-30 04:44 +0800，commit `4da13ab3`）；桌面最新 tag = `desktop-v1.10.2`。
> - 本文所有命令/路径/env 键均可在仓库内核对；锚点写成 `file:line`，行号取上述基线，合并后可能漂移，**以符号名/文件名兜底**。
> - v2.0.0 的三条破坏性改动**已随版本发布**（不再是「在途」）；§6.4 保留可直接复制的验收命令。

## 0. 一页纸结论

| 层 | 要不要动 | 结论 |
|---|---|---|
| **中台**（admin-api / admin-web） | **必须** | 15 个新迁移 + 13 个新 env 键（10 个写进 `.env.example`、3 个只读进程环境；全部有默认值，仅启用 `rustfs` profile 时 `RUSTFS_SECRET_KEY` 必填）。admin-web 必须与 admin-api 同批换。 |
| **执行器**（node / python / desktop） | **建议，非必须** | 线缆协议没变（`currentProtocolVersion` 在 v1.15.0 与 v2.0.0 **都是 8**），`supportedMinProtocolVersion` 仍为 1，老执行器照常注册收任务。升级只换来健壮性修复（见 §3.4）。 |
| **已开发/已部署应用** | **不需要** | releases 两段布局（5c）与参数 env 口径（A-11R）**已在 v1.15.0 内**，存量部署无需重部署、应用代码无需改（判据见 §4）。 |

- **目标版本（已发布）**：中台/根 `2.0.0`（tag `v2.0.0`，2026-10-30），桌面客户端 **`1.10.2`**（v2.0.0 当日出 `1.10.0`，随后两个补丁版本），SDK/CLI/MCP `2.0.0`（与平台同一版本线）。
- **示例形态**：源码部署（`./deploy.sh --mode source --env production`）；如果你的执行器只有桌面客户端一种，可按 §3.5 跳过裸机 node/python 步骤。
- **预计停机窗口**：中台 **≈1–2 分钟**（只有 `systemctl restart autoflow-admin-api` + `nginx reload`；`npm ci`/构建耗时在重启之前，旧进程仍在服务）。迁移**不占**这段窗口——15 个新迁移可在旧版本继续服务时跑完（§2.3 说明为什么安全）。
- **回滚方式**：`git checkout v1.15.0` + 再跑一次 `./deploy.sh --mode source`（**保留新库结构**即可，旧代码能读新表/新列，§5.2 逐条判定）；迁移层只有 `0073` 会真删数据（§5.1 列出），其余 14 个的 `down()` 都在。
- **桌面执行器回退**（`1.9.3` → `1.10.x` 升级失败时）：客户端自动更新**不做降级**（`allowDowngrade` 未开启），回退 = 从 `desktop-v1.9.3` Release 取 `AutoCodeFlow-Executor-1.9.3.AppImage`（Windows 用 `AutoCodeFlow-Executor-Setup-1.9.3.exe`）覆盖安装；可复制命令 + 装完验证（`~/.config/executor-desktop/config.json` 仍在）见 `docs/deployment.md` 的「回退：从 Releases 重装上一版」。
- **三条破坏性/行为改动（v2.0.0 已生效）**（§6.4 有专项验证命令）：产物上传默认只认 per-executor 令牌（403 `ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN`）、executor artifact 下载默认拒 `?token=`、应用发布 webhook 的 `x-autoflow-delivery` 真正参与幂等（返回 `duplicate: true`）。

## 1. 版本与兼容矩阵

先看「怎么判断某台执行器是不是旧版」——**不要看版本号**：`apps/executor-node/package.json` 与 `apps/executor-python/config.py` 的 `EXECUTOR_VERSION` 在 v1.15.0 与 v2.0.0 都是 `2.0.0`（没 bump）。可用判据是注册载荷里的 `protocolVersion` 与「是否携带 per-executor 令牌」。

| 组件 | v1.15.0 行为 | 新版本要求 / 变化 | 是否必须升级 |
|---|---|---|---|
| **admin-api** | 111 个迁移（`git ls-tree v1.15.0` 计数）；`migrationsRun: false`（`configuration.ts`），启动时由 `main.ts` 的 `runBootstrapMigrations()` 带 `pg_advisory_lock` 跑 | **126 个迁移**（15 个新，`node scripts/check-migrations.mjs` 在 `v2.0.0` tag 上实测「126 个迁移全部唯一且已注册」）；**13 个新 env 键**（10 个在 `.env.example`、3 个运行时开关） | **必须** |
| **admin-web** | 静态构建，nginx 托管（`docker-compose.yml:278`） | 同 release 一起换；新页面依赖新 API | **必须**（与 admin-api 同批） |
| **executor-node（docker）** | protocol 8；产物上传用 `getCurrentToken()` 的 per-executor 令牌 | 行为修复：部署失败自动重启旧进程（`c5d83f8e` EN-01）、日志缓冲溢出标记、退出码带信号名 | 否（建议） |
| **executor-node（裸机 systemd）** | 同上 | `scripts/install.sh` 可重跑（§3.2）；新版本只是同一脚本拉新 artifact | 否（建议） |
| **executor-python** | protocol 8；产物上传同用回调令牌（`artifacts.py:162-163`） | 停机取消丢终态载荷 / 下载面审计修复（`30e8cd7a`） | 否（建议） |
| **executor-desktop** | `1.9.3`（v1.15.0） | **`1.10.2`**（当前桌面最新；v2.0.0 发布的是 `1.10.0`，`1.10.1`/`1.10.2` 为随后补丁。内嵌 executor-node bundle 随之更新——EN-01 升级失败重启、日志缺口、信号退出码三处修复都在这里） | **建议升**（若使用桌面执行器） |
| **已部署应用**（daemon / once / scheduled） | `releases/<version>/<deploymentId>/` 两段（v1.15.0 已是，见 CHANGELOG 1.15.0「5c releases 目录两段化」） | 无变化；`readCurrentTarget` 同时兼容旧单段（`deploy.ts:937-953`） | **否** |
| **私有 npm / PyPI 私服**（registry-npm / registry-pypi） | — | registry-pypi 只有 Dockerfile digest pin + 防爆破修复，**路由与客户端契约未变**（`git diff v1.15.0..v2.0.0 -- apps/registry-pypi/main.py` 无 `@app.` 增删） | 否（建议同批重建） |
| **Postgres** | `postgres:16-alpine` | 同一个镜像，只加了 digest pin（`docker-compose.yml:21`） | 否 |
| **Redis** | `redis:7-alpine` | 同一个镜像，只加了 digest pin（`docker-compose.yml:94`） | 否 |

**协议侧红线**（决定了「执行器先升还是中台先升」都能成立）：
- `PROTOCOL_SUPPORTED_MIN = 1`（`protocol-compat.util.ts:14`）、`protocol.json` 的 `supportedMinProtocolVersion: 1` → 旧执行器**不会被剔除**，新执行器注册进旧中台也不会被拒（register DTO 的 `protocolVersion` 无上限校验，`executor-register.dto.ts:47`）。
- `PROTOCOL_CONTROL_PLANE_MIN = 2`（`protocol-compat.util.ts:30`）→ 只有 `<2` 的执行器拿不到 deploy/stop 等控制命令。
- `EXECUTOR_MIN_VERSION` 默认为空 = 门禁关闭（`configuration.ts:407`、`.env.example` 中该键留空）。

## 2. 中台升级步骤（示例形态：**源码部署**）

> 生产跑的是 `./deploy.sh --mode source --env production`：admin-api 由 systemd 单元
> `autoflow-admin-api.service` 托管，admin-web 的构建产物由 nginx 直接托管
> （`deploy.sh` 的 `build_phase` → `start_phase`，末尾 `nginx -t && systemctl reload nginx`）。
> 这条命令已经串好 **备份 → 迁移 → 构建 → 重写 unit → `systemctl restart` → 健康门**，
> 所以**不要**手工 `npm run migration:run` 再自己重启——那会绕过「迁移前强制备份」与健康门。

### 2.1 升级前（10 分钟）

```bash
cd /path/to/AutoCodeFlow

sudo ./deploy.sh --mode source doctor          # ① 环境/配置/服务诊断，有红先修
cp .env .env.bak.$(date +%F-%H%M)              # ② 配置面备份（deploy.sh 不备份 .env）
sudo ./deploy.sh --mode source --env production --dry-run   # ③ 先看将执行的每一步（口令掩码）
df -h / && free -g                             # ④ 构建 admin-web 需要 ≥2GB 空闲内存
```

`doctor` 的判据：五组件（admin-api / admin-web / executor / db / redis）逐项 OK 或明确的跳过原因；
`--dry-run` 的判据：打印出的步骤里能看到「迁移前备份」「15 个迁移」「systemctl restart」三段。

### 2.2 一条命令完成升级

```bash
git fetch --all --tags
git checkout <新版本 tag>        # 例如 v2.0.0；或待发布的 commit
sudo ./deploy.sh --mode source --env production --build
```

它按序执行（函数名即判据来源：`migration_phase()` / `build_phase()` / `start_phase()`）：

1. **迁移前强制备份**：`scripts/pg-backup.sh` 把 dump 写到 `logs/db-backups/db_<时间戳>.sql.gz`，
   并自检「产物 ≥ 256 字节」（空/半写判失败）。`--env production` 下备份失败**直接中止**
   （`deploy.sh` 的 `migration_phase()` 注释：不带着未备份的库跑迁移）。
   判据：日志出现 `backup ok <path> <bytes>`；失败时看 `logs/` 下 `PG_BACKUP_ERR_LOG` 指向的文件。
2. **迁移**：`cd apps/admin-api && npm run migration:run`（`migration-lock-cli` 带 `pg_advisory_lock`，
   多实例也只有一个在跑）。15 个待执行迁移见 §2.4；失败时 `deploy.sh` 非零退出，进程仍是旧代码。
3. **构建**：各组件 `npm ci` + `npm run build`；admin-api 出 `dist/`，admin-web 出 `dist/`。
4. **重写 unit + 重启**：`systemctl daemon-reload` → `enable --now` / `restart`；
   admin-web 走 `nginx -t && systemctl reload nginx`（配置错会被 `nginx -t` 拦住，不会把站点 reload 成 502）。
5. **健康门**：`/api/health/ready` 不通过即判部署失败（`--allow-degraded` 才会放行，
   生产不要加）。失败时先看 `sudo ./deploy.sh logs admin-api` 的末尾 50 行。

> 源码模式**不需要**停机窗口之外的额外操作：迁移可以在旧进程继续服务时跑完（新列全部是
> `NULL` 或 `NOT NULL DEFAULT`，见 §5.2），真正的中断只有第 4 步的 `systemctl restart`（秒级）。

### 2.3 15 个新迁移的落地顺序与耗时量级

按时间戳顺序（TypeORM 天然按名排序），耗时量级取决于**现场行数**，不是常数——所以给判据而不是给数字：

| 迁移 | 操作 | 锁/耗时判据 |
|---|---|---|
| `0022/0049/0050/0051/0053/0055/0056/0061` | **已执行过**（v1.15.0 内），v2.0.0 只改了 `down()` 与超时豁免 | 不会重跑（TypeORM 按 `name` 记账）。`0061` 的 `up()` 从 `CREATE INDEX` 改成 `CONCURRENTLY`，对存量库**无影响**（索引已在），只在全新库上生效 |
| `0067` `CreateAgentApprovals` | 建表 | 空表，毫秒级 |
| `0068` `0072` `0074` `0078` `0079` | 加列（`NULL` 或 `NOT NULL DEFAULT`） | PG 11+ 元数据操作，瞬时；`0074/0079` 有默认值不重写表 |
| `0069` `AddAgentToolCallToolCallId` | 加列（`NULL`） | 瞬时（`0077` 的唯一索引依赖它先存在） |
| `0070` `CreateAiMedia` / `0071` `CreateAiSopSessions` | 建表 | 毫秒级 |
| `0073` `AddAgentToolCallUniqueToolCallId` | **DELETE 去重** | 可重复执行；耗时 ∝ `agent_tool_calls` 行数（新功能表，通常很小） |
| `0075` `0076` `0080` | 建索引 CONCURRENTLY | ∝ 各自表行数；不锁写，各自带 `statement_timeout=0` 豁免 |
| `0077` `AddAgentToolCallUniqueIndexConcurrently` | 建**唯一**索引 CONCURRENTLY | ∝ `agent_tool_calls`；必须排在 `0073` 之后（顺序敏感） |

现场估时（把 `<各表>` 换成实测行数）：

```bash
# 源码部署：直接用 .env 里的 DB_* 连（下面 docker 版本仅当 PG 在 compose 里时用）
psql -h "${DB_HOST:-127.0.0.1}" -U "${DB_USER:-autoflow}" -d "${DB_DATABASE:-autoflow}" -c "
SELECT relname, n_live_tup FROM pg_stat_user_tables
WHERE relname IN ('tasks','task_executions','audit_logs','agent_tool_calls','event_outbox','executor_metrics_history')
ORDER BY n_live_tup DESC;"
```

- 索引类迁移都带会话级 `SET statement_timeout = 0` + `finally RESET`（例：`1790000000075-AddTasksCreatedAtIdIndex.ts`），所以不会撞连接池 30s 上限。
- ⚠️ **半成品索引检查**（迁移被中途 Ctrl-C / 容器被杀时的残留）。`IF NOT EXISTS` 会命中 `indisvalid=false` 的同名索引并跳过，导致索引永远建不起来：

```bash
psql -h "${DB_HOST:-127.0.0.1}" -U "${DB_USER:-autoflow}" -d "${DB_DATABASE:-autoflow}" -c \
"SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE NOT i.indisvalid;"
```
- 结果非空即需 `DROP INDEX CONCURRENTLY <名>` 后重跑该迁移。

### 2.4 迁移能不能回滚

- **代码层**：15 个新迁移**全部有 `down()`**（逐文件 `awk '/async down/',0'` 核对）。例外是 `0073` 的 `down()` 是刻意的空实现——头注写明「被删的重复行不可恢复，不伪造数据」（`1790000000073-...ts:38-40`）。
- **数据层**：不可逆的只有三种，回滚前必须知道：
  1. `0073` 删掉的重复台账行 —— 不可恢复（除非用 §2.1 的备份）；
  2. `down()` 里的 `DROP COLUMN`（`0068/0069/0072/0074/0078/0079`）—— 该列数据随回滚丢弃；
  3. `0070/0071/0067` 的 `down()` 是 `DROP TABLE` —— 表内数据全丢。
- **结论**：**回滚镜像不必回滚迁移**（§5.2 证明旧代码能读新结构）；只有「必须回到旧结构」时才有上面三类数据损失。

### 2.5 新 env 键怎么填 + 自检

**结论：13 个新键全部可选、全部有默认值**——存量 `.env` 不改也能起来。其中 **10 个写进 `.env.example`**，**3 个是只读 `process.env` 的运行时开关**（不在 `.env.example`，`check-env-drift` 已按豁免处理）。

**A. `.env.example` 新增的 10 个键**

| 键 | 默认 | 说明 |
|---|---|---|
| `AI_MEDIA_BASE_URL` | 空 | 空 =「视频转 SOP」不可用，其余 AI 能力不受影响 |
| `AI_MEDIA_URL_SECRET` | 空 | 签名直链 HMAC 密钥，≥16 字符；空则相关端点如实报错 |
| `AI_MEDIA_URL_TTL_MS` | `3600000` | 媒体直链签名有效期 |
| `AI_MEDIA_RETENTION_DAYS` | `7` | 上传媒体保留天数 |
| `AI_SESSION_RETENTION_DAYS` | `30` | 交互式 SOP 会话保留天数 |
| `AGENT_BLOCK_SELF_APPROVAL` | `false` | `true` 才启用四眼原则（禁止同一人申请并审批） |
| `AGENT_CONTEXT_MAX_TOKENS` | `24000` | Agent 上下文预算 |
| `AGENT_CONTEXT_MIN_RECENT_MESSAGES` | `12` | 折叠摘要时至少保留的最近消息数 |
| `RUSTFS_ACCESS_KEY` | `autoflow` | RustFS 访问键（替代 MinIO） |
| `RUSTFS_SECRET_KEY` | 无 | **仅启用 `rustfs` profile 时必填**；compose 无默认值，为空即启动失败 |

**B. 运行时开关（3 个，直接写进 `.env` 即生效）**

| 键 | 默认 | 说明 |
|---|---|---|
| `EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN` | `false` | 过渡开关：允许共享令牌上传产物；用完必须关（§7.2） |
| `EXECUTOR_ARTIFACT_QUERY_TOKEN_COMPAT` | `false` | 过渡开关：允许 `?token=` 下载产物；开启会把共享令牌写进访问日志（§7.1） |
| `WEBHOOK_DELIVERY_TTL_DAYS` | `7` | `x-autoflow-delivery` 幂等账本保留天数（SEC-3） |

> `LOG_STORAGE_ENDPOINT` / `LOG_STORAGE_ACCESS_KEY` 是 v1.15.0 **已有**的键，不是本轮新增；v2.0.0 只是把服务端默认从 MinIO 换成 RustFS。

- 真·必填（compose 的 `:?` 强制注入，未设即解析报错）仍是老那 11 个，**本轮没有新增**：`POSTGRES_PASSWORD`/`REDIS_PASSWORD`/`DB_PASSWORD`/`JWT_SECRET`/`JWT_REFRESH_SECRET`/`EXECUTOR_SECRET`/`INITIAL_ADMIN_PASSWORD`/`REGISTRY_PASS`/`EXECUTOR_PYTHON_PUBLIC_ADDRESS`/`EXECUTOR_NODE_PUBLIC_ADDRESS`/`GRAFANA_ADMIN_PASSWORD`（monitoring profile）。核对命令：`grep -oE '\$\{[A-Z_]+:\?' docker-compose.yml | sed 's/\${//;s/:?//' | sort -u | wc -l` → 12（其中 1 个是注释里的示例）。

自检漂移（**必跑**，退出码 0 = 无漂移）：

```bash
node scripts/check-env-drift.mjs
# 基线实测输出：代码消费的 227 个 env 键全部被 .env.example 覆盖或已豁免（豁免 39 个）
```

### 2.6 升级后首验（源码模式）

```bash
curl -s -o /dev/null -w 'live=%{http_code}\n'  http://127.0.0.1:3105/api/health/live
curl -s http://127.0.0.1:3105/api/health/ready | head -c 400     # 不就绪是 503，不是「200 + not_ready」
sudo ./deploy.sh status
sudo ./deploy.sh health
systemctl is-active autoflow-admin-api
```

- 判据：`live=200`、`ready` 返回 200（`db`/`redis` 全绿）、`status` 里 admin-api 为 `active`。
- 登录 + 首跑：浏览器登录 → 用「任务模板」建一条最小任务 → 手动触发一次 →
  执行行进入 **success** 且执行详情能看到日志（本轮改了 SSE/日志/指标读数，这三处必须覆盖）。
- 命令行等价（避免猜 DTO，字段以 openapi.json / 界面为准）：
  `curl -s -X POST http://127.0.0.1:3105/api/tasks -H "Authorization: Bearer <token>" ...`

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

### 3.3 python 执行器（本生产不使用，保留供将来）

```bash
# docker 部署（compose 服务名 executor-python，镜像本地构建）
docker compose build executor-python
docker compose up -d executor-python
docker compose logs --tail=50 executor-python     # 判据：注册成功、心跳 200、无 401/409

# 裸机部署（仓库内无 install.sh 的 python 分支）：按原部署方式重装依赖后重启
cd apps/executor-python && pip install -r requirements.txt && <你的 systemd/supervisor 重启命令>
systemctl restart <python-executor-unit>          # 或 supervisordctl restart ...
```

- 判定升级成功：心跳里 `protocolVersion` 仍为 8（v2.0.0 仍是 8；develop 已到 9，见 §9），且没有新的 `/token` 409。**注意**：python 侧至今**不上报** `registrationConflict`（`config.py` 注释说明了这个「两处缺席」裁定），所以别拿这个键判断 python 是否新版。

### 3.4 升级顺序：先执行器还是先中台？

**推荐：先中台、后执行器；但先执行器也不会坏。**

- **先中台安全**：协议没 bump（v1.15.0 与 v2.0.0 都是 8），`supportedMinProtocolVersion=1`，`EXECUTOR_MIN_VERSION` 默认关 → 老执行器在新中台上照常注册、收任务。
- **先执行器也安全**：新执行器注册进 v1.15.0 中台，`protocolVersion` 无上限校验（`executor-register.dto.ts`），多出来的可选字段（`registrationConflict`）旧中台按「缺席/忽略」处理。
- **唯一的顺序耦合是产物上传（v2.0.0 已生效）**：

| 场景 | 新中台 + 老执行器 | 结论 |
|---|---|---|
| 执行器用 `getCurrentToken()` 的 per-executor 令牌上传 | 通过（走渠道 2，`artifacts.service.ts:363-388`） | v1.15.0 的 node/python 执行器**本来就是这样**（`artifacts.ts:111` + `execute.ts:3042`；`artifacts.py:162`），所以**不升级也不会 403** |
| 执行器拿不到动态令牌，`getCurrentToken()` 回退静态共享令牌 | **403** `ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN`（`reason: shared_token`） | `middleware/auth.ts:450-452` 的 `dynamicToken \|\| readStaticToken()` 就是这条回退路径。触发条件：`/token` 长期失败、手工只配了 `EXECUTOR_SHARED_TOKEN` |
| 执行行缺 `executorAddress` | **403**（`reason: executor_address_unbound`，`artifacts.service.ts:366-380`） | 与执行器版本无关，属数据面问题 |

- **产物缺失是否影响任务终态？不影响，已核实**：产物上传全程 best-effort。node 侧 `uploadOne` 对非 2xx 只 `logger.warn('artifacts: 上传 X 返回 HTTP 403（跳过）')` 并 `return false`（`apps/executor-node/src/artifacts.ts:124-125`）；终态收集外层再包一层 `try/catch`，异常时返回 `undefined` 而**不阻塞回调**（`routes/execute.ts:3070-3086`，注释逐字为「best-effort——任何异常只记日志返回 undefined」）。python 侧同姿态（`routers/execute.py:3862` 日志文案「artifacts collection/upload failed (non-blocking)」）。
  ⇒ **任务的终态（success/failed）与退出码只由任务进程决定；403 只表现为「这次执行没有产物」，回调里 `artifacts` 字段缺席。**
- 所以升级顺序建议：**先中台（§2）→ 跑一条任务观察 → 再升桌面客户端到 1.10.2**。
  如果你的执行器只有桌面客户端一种，**不存在**「批量升裸机执行器」这一步；真要并行，先把
  `EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN=true` 打开当保险，升完再关（§7 说明风险）。

### 3.5 只有桌面客户端时的简化流程

如果你的执行器只有 `executor-desktop`，§3.2（裸机 install.sh）与 §3.3（python 执行器）
都可以跳过，实际只需三步：

1. **中台先升**（§2）——桌面客户端连的是新中台的机器面接口，协议未变，不会断。
2. **桌面升到 1.10.2**：
   - AppImage 形态：`electron-updater` 会拉到新版（`desktop-v1.10.2` tag 触发 `release-desktop.yml` 出包）；
   - deb/rpm 形态：**没有应用内自更新通道**，必须手动下载安装包覆盖安装（`updater.ts` 只在 AppImage 分支挂 `AppImageUpdater`）；
   - 升级后判据：状态页显示协议 v8、心跳正常，跑一条任务成功。
3. **观测一轮**：`journalctl -u autoflow-admin-api --since '30 min ago' | grep -E 'SEC-1|SEC-2|duplicate'`
   应为空；桌面端执行详情里产物（若有）能正常列出。

> 桌面 1.10.0 起内含 `c5d83f8e` 的 EN-01 修复（升级失败会重启旧版本进程）；`1.10.1`/`1.10.2`
> 是随后的补丁版本。不升桌面也能用，但**升级应用时遇到网络失败会停服**这个老行为会保留——
> 这是“建议升”的真实理由。

## 4. 已开发应用是否需要调整

**结论：不需要改应用代码，也不需要重新部署存量应用。** 三条判据如下。

### 4.1 `5c` releases 两段化对**存量**部署的影响

- 两段布局 **v1.15.0 就已上线**（CHANGELOG 1.15.0 Features：「executor: 5c releases 目录两段化——`releases/<version>/<deploymentId>/`」），v2.0.0 只是继续沿用 → 生产上跑的执行器已经在写两段。
- 代码层面**两种布局都认**：`readCurrentTarget()` 把 `current` 软链解析成「相对 `releases/` 的 key」，注释明写「新两段：`<version>/<deploymentId>`；旧单段：`<version>-<deploymentId>`…相对路径无 `/` 时原样返回」（`apps/executor-node/src/routes/deploy.ts:937-953`）；`resolveReleasePaths()` 只在**同名目录已存在**时追加后缀、指向新目录，不迁移旧目录（`deploy.ts:985-1017`）；`pruneOldReleases()` 按「组」删除，两段/单段都自适配（`deploy.ts:1145-1149`）。
- **判据**：`ls -l <WORK_DIR>/apps/<appId>/releases/` 看到的是 `<version>` 目录（两段）或 `1.0.0-<uuid>` 目录（单段）——**两种都不需要动**。
- ⇒ **无需重部署**。若某台执行器的 `current` 是坏软链（`readCurrentTarget` 返回 null，`deploy.ts:944`），那是数据面异常，重部署一次即可，与本次升级无关。

### 4.2 `A-11R` 参数 env 口径（字符串不再 JSON 化）

- **已在 v1.15.0 内**：`A-11R` 的实现提交 `2b4a52f2` 是 `v1.15.0` 的祖先（`git merge-base --is-ancestor 89f4af45 v1.15.0` 成立），协议 v5 起生效（`docs/adr/adr-023-params-env-injection-contract.md`）。
- v2.0.0 里 `apps/executor-node/src/param-env.ts` 的改动是 `c59741fa`（params 折叠冲突两端拒绝 + env 转发清单），不改变「字符串裸值 + `AUTOFLOW_PARAMS_JSON` 类型化通道」这一口径。
- ⇒ 对存量任务/应用**零影响**：已经在 v1.15.0 上跑通的应用，其 `process.env.AUTOFLOW_X` 拿到的仍是裸字符串，`AUTOFLOW_PARAMS_JSON` 仍是精确类型通道。**不需要改应用、不需要重发版**。

### 4.3 本轮产物上传鉴权变化对已部署应用的影响

- 应用**不直接**上传产物：产物由**执行器**在终态回调前收集并 `PUT /api/executions/:execId/artifacts/:name`（`routes/execute.ts:3070` → `artifacts.ts:97`），凭据是执行器的 per-executor 令牌。应用进程只拿到 `AUTOFLOW_ARTIFACTS_DIR` 这个写目录（`routes/execute.ts:2382-2390`），把文件写进去即可。
- ⇒ 应用侧**没有任何凭据/接口变化**。若某应用历史上自己直连中台上传产物（非常规用法），它会走共享令牌 → 本轮会 403；这种应用需要改成「写文件到 `AUTOFLOW_ARTIFACTS_DIR`，由执行器代传」。
- **判据**（确认你的应用没有直连中台传产物）：`grep -rn "artifacts" <你的应用仓库>` 只应命中写文件的路径；若出现 `PUT /api/executions/.../artifacts` 则是直连，需要改。

### 4.4 明确结论

> **应用代码不需要改。** 判据三条同时成立：① 应用与中台的契约面（`AUTOFLOW_*` env + 产物目录 + 回调由执行器代发）在 v1.15.0 → v2.0.0 之间未变（协议仍 8，`A-11R` 早已在 v1.15.0）；② releases 目录布局两种都兼容（`deploy.ts:937-953`）；③ 产物上传凭据只涉及执行器身份，与应用进程无关。
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
| `0081` 建 `webhook_deliveries` + 2 索引（v2.0.0 已生效） | `DROP TABLE` | 投递账本全丢——只影响幂等（重投会被当首投），不影响业务数据 |

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
| `webhook_deliveries`（v2.0.0 已生效：`0081`） | 旧代码不读不写 | ✅ |
| `tasks.name` 唯一索引（`0050`，**v1.15.0 已有**） | 不是本轮引入，不受影响 | — |

唯一要在意的是**旧代码 + 新表结构下的行为差异**：`runOnUpstreamFailure` 之类的字段旧代码不认，界面上会「消失」，但不会报错。

### 5.3 中台回滚步骤

```bash
cd /path/to/AutoCodeFlow
git checkout v1.15.0                       # 回到生产基线（不要动库结构）
sudo ./deploy.sh --mode source --env production --build
curl -s -o /dev/null -w 'live=%{http_code}\n' http://127.0.0.1:3105/api/health/live
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

- [ ] `node scripts/check-migrations.mjs` 通过（**v2.0.0 tag 上应报 126 个迁移**；若你已经跟到 develop，则是 **138 个**，见 §9）
- [ ] `(cd apps/admin-api && npm run migration:run)` 二次执行输出 `No migrations are pending`
- [ ] `node scripts/check-env-drift.mjs` 退出 0
- [ ] `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3105/api/health/live` → `200`
- [ ] `curl -s http://127.0.0.1:3105/api/health/ready` → 200 且 `status:"ready"`
- [ ] 登录成功、`/api/health/detailed` 五组件正常
- [ ] `systemctl is-active autoflow-admin-api` → `active`（`sudo ./deploy.sh status` 同判据）
- [ ] `SELECT ... indisvalid` 无 `false`（§2.4）

### 6.2 执行器

- [ ] 执行器列表里在线数 = 预期台数，无新增 401/409
- [ ] 桌面客户端状态页显示「已连接 / 心跳正常」，无 401/409
- [ ] 从桌面客户端跑一条最小任务，终态 `success` 且执行详情有日志

### 6.3 应用

- [ ] `ls -l <WORK_DIR>/apps/<appId>/releases/` 与 `current` 软链可解析
- [ ] daemon 应用重启后仍在跑（`current` 指向正确、进程在）

### 6.4 三条破坏性改动的专项验证（v2.0.0 已生效）

> 以下命令按 **v2.0.0 已发布实现**写（`artifacts.service.ts`、`executor.controller.ts`、`application.controller.ts` 的 webhook 段）；在 v2.0.0 及之后的版本上都适用。

**① executor artifact 下载：无头 → 401；带 Bearer → 200；`?token=` → 401（默认）**

```bash
A=http://localhost/api/executors/artifact/executor-node.tar.gz
curl -s -o /dev/null -w 'no-auth=%{http_code}\n' "$A"                        # 期望 401
curl -s -o /dev/null -w 'bearer=%{http_code}\n' -H "Authorization: Bearer $EXECUTOR_SECRET" "$A"   # 期望 200（404 = 产物未生成，见 EXECUTOR_ARTIFACT_DIR）
curl -s -o /dev/null -w 'query=%{http_code}\n' "$A?token=$EXECUTOR_SECRET"   # 期望 401（默认）
journalctl -u autoflow-admin-api --since '10 min ago' | grep -c 'SEC-2'     # 期望 0 条（未开兼容模式）
# 打开兼容模式后再验一次：
# 改 .env 的 EXECUTOR_ARTIFACT_QUERY_TOKEN_COMPAT=true → sudo ./deploy.sh restart admin-api
# → query=200 且 journalctl -u autoflow-admin-api | grep 'SEC-2' 出现一条 warn
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
- 兼容模式复验：`EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN=true` → 同一命令 `200`，`journalctl -u autoflow-admin-api --since '5 min ago' | grep 'SEC-1 兼容模式'` 有一行 warn。

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
- 判据②：只产生**一次**版本更新 / 一轮升级（`journalctl -u autoflow-admin-api | grep -c 'duplicate delivery'` = 1）。
- 老集成不传 `x-autoflow-delivery` 时行为不变（`claim` 返回 `no_key`，`webhook-delivery.service.ts:45`），仍由 10 分钟 Redis 签名窗兜底（`deduplicated:true`）。

### 6.5 发版编排（v2.0.0 的决策记录，仍适用于 2.x）

**先纠正一个容易误判的事实**：四个对外发布包**不需要手工 bump**。
`release-please-config.json` 的根条目 `.` 用 `extra-files` 把版本广播到：

- `packages/autocodeflow-node-sdk/{package.json,package-lock.json,README.md}`
- `packages/acf-cli/{package.json,package-lock.json}`
- `packages/mcp-server/{package.json,package-lock.json}`
- `packages/autoflow-sdk/{pyproject.toml,autoflow_sdk/__init__.py,README.md}`
- `packages/docs-site/{sdk-node,sdk-python,getting-started,release,index}.md`、`docs/sdk-guide.md`

所以冒烟流程是：**push develop → 合 main → release-please 出 Release PR（自动把上面所有文件改成同一个版本号）
→ 合并 PR → `git tag v<version>` → `release.yml` 的 version-guard 校验「tag == version.txt == 四个包」
→ 两个 publish job 发 npm/PyPI**。这套模式本身没问题，**不需要改流水线**。

真正受限的是「**平台 2.0.0 + SDK/CLI/MCP 1.16.0**」这种**拆线**：

- `release.yml` 的 version-guard 会在 tag 时逐个比对 5 个事实源（`version.txt` + 四包），不一致直接 fail；
- `scripts/check-release-config.mjs` 的判据 ④ 在本地就先红；
- 根条目只有一个，extra-files 只能把它们改成**同一个**版本。

**本次已定了 A（全 2.0.0）**——下面三条路保留作决策记录，B/C 不再执行。

三条路：

| 方案 | 做法 | 流水线改动 | 适用 |
|---|---|---|---|
| **A. 全 2.0.0**（推荐） | 保留两条 `feat(...)!` 提交（已带 `BREAKING CHANGE`），release-please 自动出 2.0.0，五处一起变 | **无** | 这次就是大改：CLI 的退出码语义（受理≠成功、`--json` 落盘）与管理端鉴权收紧，对下游确实是破坏性的 |
| **B. 全 1.16.0** | 把两条提交的 `!` 与 `BREAKING CHANGE` footer 去掉（破坏性说明仍留在本文档），release-please 出 1.16.0 | **无** | 你更看重「SDK API 没变就不该 major」；代价是 CHANGELOG 不会打 ⚠ 段 |
| **C. 真拆线** | 给 SDK 单独 tag（如 `sdk-v1.16.0`）+ 独立 workflow + 把根条目的 extra-files 拆成两个根条目 + 改 `check-release-config ④` 与 `release.yml` 的 version-guard + 改文档站的 lockstep 表述 | **要**（约 1 天，且以后每次发版两条线各打一个 tag） | 只有当你确实想让 SDK 与平台**不同节奏**发布时 |

**桌面是既有先例**：`desktop-vX.Y.Z` 独立 tag + `release-desktop.yml`，version-guard 只比
`apps/executor-desktop/package.json`，不参与 root lockstep。v2.0.0 发布时桌面是 **1.10.0**；
当前最新是 **1.11.0**（`package.json` + lock 已同步），需要发桌面时直接
`git tag desktop-v1.11.0 && git push origin desktop-v1.11.0`（`desktop-version-guard` 要求
 tag 与 `apps/executor-desktop/package.json` **逐字相等**，写错版本号会被它当场拒掉）。

> 结论：**这次选 A 或 B 都不动流水线**，区别只在 commit 里有没有 `!`。选 C 才需要改造。

**A 方案的发布前检查（合并 Release PR 后、打 tag 前）**

```bash
# 五个事实源必须同为 2.0.0（version.txt 后三个由 Release PR 自动改，确认没漏）
grep -h '^version' version.txt
node -e "console.log(require('./packages/acf-cli/package.json').version)"
node -e "console.log(require('./packages/mcp-server/package.json').version)"
node -e "console.log(require('./packages/autocodeflow-node-sdk/package.json').version)"
grep -h '^version' packages/autoflow-sdk/pyproject.toml
npm run check:release-config   # 六层一致性全绿才打 tag
```

- CHANGELOG 顶部应出现 `⚠ BREAKING CHANGES` 两条（产物上传鉴权 / webhook 投递语义）；
- SDK 的 GitHub Release 会被 `release.yml` 的 `demote-sdk-release` 自动标成 **prerelease**
  （这是刻意的：GitHub `latest` 必须留给 `desktop-v*`，否则桌面自动更新会去比 SDK 版本号）；
- 桌面单独打 `desktop-v1.11.0`（当前桌面最新），与平台 `v2.1.0` 互不影响。

## 7. 已知取舍

1. **为什么 `EXECUTOR_ARTIFACT_QUERY_TOKEN_COMPAT` 默认关**：查询串凭据会进 nginx/ALB access log、shell history、`ps`、Referer，而这里是**机队共享令牌**——一条日志泄露 = 整支机队安装通道泄露（同类通道已在 SSE 面撤除，见 `apps/admin-web/src/api/sse.ts`）。仓库内**零** `?token=` 消费者（`scripts/install.sh:206-209` 早就是 `-H "Authorization: Bearer …"`），所以关掉不打断任何内置链路。
   - **开了的风险**：共享令牌以明文形态出现在访问日志里；`SEC-2` 每次命中打一条 warn，便于你统计欠账，但它不会自动收敛——**开关忘了关就等于把这次收口作废**。
2. **为什么 `EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN` 默认关**：共享令牌不携带执行器身份，持它者只要知道 `execId`（UUID，出现在回调载荷、管理台 URL、日志里）就能：往**别人执行**的产物目录写入任意文件（产物可下载、可被部署消费 ⇒ 替换他人交付物），或用 `MAX_ARTIFACT_COUNT` 把目录灌满让合法执行器后续上传失败（`artifacts.service.ts:279-292`）。
   - **开了的风险**：上述跨执行器写权限完整恢复；日志里每次上传都会有一条 `SEC-1 兼容模式` warn。设计上它只是**过渡**，执行器升完必须关。
   - 注意这条收口**刻意也不放过「自己的执行」**：共享令牌不携带身份，放行「自己」等于放行全部（`artifacts.service.ts:352-354` 注释）。
3. **为什么 webhook 幂等默认就是开**（不需要开关）：默认值即正确值——`deliveryKey` 缺席时退回旧行为（签名窗去重），只有显式带 `x-autoflow-delivery` 才启用 7 天 DB 账本；账本不可达时 **fail-open**（宁可重复一次发布，也不让所有 CI 集成因附属表抖动全挂，`application.controller.ts` webhook 段注释）。
   - **风险**：同一个 delivery id 在 7 天内重投会被判重——如果某个 CI **复用**固定 delivery id 做「多次发布」（错误用法），第 2 次起会被静默跳过。判据：`WEBHOOK_DELIVERY_TTL_DAYS`（默认 7）与 CI 是否生成唯一 id（GitHub Actions 用 `${{ github.run_id }}-${{ github.run_attempt }}` 即天然唯一）。
4. **为什么不把执行器升成硬要求**：协议没 bump，硬要求会让「只升中台」的窗口期无法灰度。代价是你会有一段时间跑「新中台 + 老执行器」，拿不到 `c5d83f8e` EN-01 的修复——即**升级失败时旧 daemon 应用会被留在停服状态**（旧行为：只回滚 `current` 软链、不重启旧进程）。这也是「建议尽快升执行器」的真实理由，而不是协议不兼容。

## 8. 附录：v2.0.0 核实记录（2026-10-30，以代码为准）

发布前写本文时逐条复核，以下 4 处与当时的任务背景表述不符，已按**代码事实**落笔；保留作追溯：

1. **「22 个新增迁移」** → 实际是 **15 个新迁移 + 8 个「已执行过但被修改」的迁移**。`git diff --name-only v1.15.0..v2.0.0 -- 'apps/admin-api/src/migrations/*.ts'` 出 22 个，但 `--diff-filter=A` 只有 14 个，`--diff-filter=M` 有 8 个（`0022/0049/0050/0051/0053/0055/0056/0061`）；再加 `0081`（`webhook_deliveries`）= 15 个待执行。总数 111 → 126，`scripts/check-migrations.mjs` 实测一致。
2. **「三条改动正在落地」** → 核实时刻只在工作区；**现已提交并随 v2.0.0 发布**为 `0389e0c0`（SEC-1/SEC-2）与 `20bec468`（SEC-3），并带 `BREAKING CHANGE` footer。核实方式：`git grep -n EXECUTOR_ARTIFACT_QUERY_TOKEN_COMPAT v2.0.0` 有命中。
3. **webhook 幂等的返回字段**：背景写 `duplicate: true`，代码里实际**同时**返回 `duplicate: true`、`deduplicated: true`、`deliveryKey`、`receivedAt`（后者为兼容既有「同签名去重」的响应形态）。且幂等账本按 `(scope, deliveryKey)` 唯一的 DB 表实现（`0081`），**不是**按签名——签名窗去重（10 分钟 Redis）仍然并存。
4. **桌面端「最小版本要求」不存在**：全仓无桌面最低版本门禁常量；`electron-updater` 只做「远端是否严格新于本地」的 semver 比较（`updater.ts`），不会自动降级，也没有「低于 X 强制升级」的闸。

另有两处值得单独记一笔（不构成冲突，但会影响你的操作）：
- **迁移不是必须先手动跑**：`main.ts` 在非 development 环境会先跑 `runBootstrapMigrations()`。本文仍推荐手动先跑，理由是**失败可见性**（容器崩溃循环 vs 一条 SQL 报错），不是能力缺失。
- **`0061` 的 `up()` 在 v2.0.0 里从 `CREATE INDEX` 改成了 `CREATE INDEX CONCURRENTLY`**，但该迁移在 v1.15.0 已执行过、TypeORM 按 `name` 记账不会重跑 ⇒ 存量库的该索引仍是普通方式建的，**本次升级不会自动重建成 CONCURRENTLY**（无害，仅记录）。

## 9. v2.0.0 → develop（未发布，可选灰度）

**结论：纯增量，**但有 1 条破坏性变更** —— 执行器出站姿态（R05，见 [§11](#11-执行器出站姿态r05-起破坏性)）。
只追稳定版的部署可以停在 v2.0.0；想提前拿安全/可观测性修复的，按本节灰度，并**先读 §11**。

| 项 | v2.0.0 | develop（2026-11-02） | 影响 |
|---|---|---|---|
| 迁移 | 126 | **138**（+12：`0082`–`0093`） | 建表 / 加列 / 建索引；新列可空或有默认值，**不删数据** |
| env 键 | — | **+2**：`AGENT_DEPLOY_APPROVAL_REQUIRED`（默认 `true`）、`SOP_BODY_SCAN_MODE`（默认 `warn`） | 不配也能起来 |
| 线缆协议 | 8 | **9**（heartbeat 新增可选 `taskSandbox`） | `supportedMinProtocolVersion` 仍为 1；老执行器照常注册 |
| 破坏性变更 | — | **1 条**：执行器出站姿态（R05） | 内网执行器需显式开开关；**同机 `127.0.0.1` 执行器不再可用**，见 [§11](#11-执行器出站姿态r05-起破坏性) |

**新增的 12 个迁移（按时间戳）**：

| 迁移 | 内容 |
|---|---|
| `0082` | `audit_logs (createdAt DESC, id DESC)` keyset 翻页索引 |
| `0083` | `agent_tool_calls.stateChangedAt`（状态迁移时刻可判定） |
| `0084` | `execution_finalizations`（僵尸清扫「不得覆盖更新工作」的持久化证据） |
| `0085` | `agent_approvals` 的 `argsDigest` + `preview`（治「盲批」） |
| `0086` | `agent_sessions` 上下文折叠账本（连续不收敛熔断） |
| `0087` | `agent_approvals` 授权范围 + 策略指纹（策略收紧后旧单 fail-closed） |
| `0088` | `executors.taskSandbox`（沙箱姿态在控制面可见；可空、不回填） |
| `0089` | `agent_events`（取证型事件日志，`(sessionId, seq)` 唯一） |
| `0090` | `task_executions.retryKind` + `retryUserCount`（用户失败 / 引擎抖动分账） |
| `0091` | `task_executions.synthetic`（可见性合成行不顶替「最新执行」） |
| `0092` | `task_executions.attemptSeq` |
| `0093` | `agent_events.causedBySeq`（事件流从扁平日志变因果图） |

**灰度步骤**（与 §2 同一流程，只换目标分支）：

```bash
git checkout develop
sudo ./deploy.sh --mode source --env production --build
node scripts/check-migrations.mjs          # 应报 138 个迁移
```

- 回滚：`git checkout v2.0.0` 再跑一次同一条 `deploy.sh` 即可；新表/新列全部向后兼容（旧代码不读不写）。
- 执行器**不需要**跟着升：协议 9 只加了可选字段，协议 8 的执行器仍被接受；想拿到 `taskSandbox` 上报能力再升桌面。
- 迁移里 `0082` 等索引类迁移使用 `CONCURRENTLY`，不锁写；表数据量大的现场仍建议按 §2.3 的方式估算耗时。

**为什么值得跟（安全 / 可观测性修复）**：

- `users.totpSecret`、`event_subscriptions.secret` 补 `select: false`——2FA 种子与订阅密钥不再被默认查询带出；
- 部署事件 `detail` 写前脱敏（把「约定」升级成「机制」）；
- 迁移、审批、事件写入失败等静默降级补了指标计数（可查询，不再「闸门自己失明」）；
- SOP 正文供应链扫描（`SOP_BODY_SCAN_MODE`，默认 `warn`，设 `block` 才拦截发布）。

> 本节是 2026-11-02 的快照；develop 随时前进，升级前以 `version.txt`、`node scripts/check-migrations.mjs` 与实际 tag 为准。

---

## 10. 【行为变更】执行器出站 SSRF 闸收紧（R2-1/P1b·A7）

> **受众**：执行器运维（node）· **影响版本**：develop（未发布）· **可回滚**：是（单 commit revert）

### 10.1 变了什么

`EXECUTOR_ALLOW_PRIVATE_NETWORK` 这个开关，**开启时的行为收紧了**：

| | 升级前 | 升级后 |
|---|---|---|
| 开关**关闭**（默认） | 拒 loopback + RFC1918 私网（**字符串级判定**） | 拒**全部七类**（DNS 级判定，见下） |
| 开关**开启** | **放行一切**（`assertSafeHttpUrl` 里 `if (allow) return;`） | **只放行 `privateIPv4`**；其余六类**仍然全拒** |

七类地址与开关行为（契约 `packages/executor-protocol/protocol.json` 的
`networkPolicy.addresses` / `networkPolicy.switch`）：

| 类别 | 代表地址 | 开关关闭 | 开关开启 |
|---|---|---|---|
| `loopback` | `127.0.0.1`、`[::1]`、`localhost` | 拒 | **拒**（升级前：放行） |
| `privateIPv4` | `10.0.0.1`、`172.16.0.1`、`192.168.1.1` | 拒 | **放行**（不变） |
| `linkLocal` | **`169.254.169.254`**（云元数据）、**`fd00:ec2::254`**（AWS IPv6 元数据）、`fe80::/10` | 拒 | **拒**（升级前：放行） |
| `cgnat` | `100.64.0.0/10` | 拒 | **拒**（升级前：放行） |
| `unspecified` | `0.0.0.0`、`::` | 拒 | **拒**（升级前：放行） |
| `multicast` | `224.0.0.0/4`、`ff00::/8` | 拒 | **拒**（升级前：放行） |
| `reserved` | `240.0.0.0/4` 等 | 拒 | **拒**（升级前：放行） |

**另外两处**：
1. **判定升级为 DNS 级**：主机名会**真实解析**，逐地址校验，**解析失败 fail-closed**（此前只做字符串匹配，`http://internal.corp/` 这类解析到 `10.x` 的名字能溜过去）。
2. **判定层级 = accept 期**：被拒的任务**不会**再「先接单（占容量槽、admin 记 RUNNING）再失败」，而是同步 400 / pull 路径 failed 回调（契约 `errorStatusCodes`）。

### 10.2 谁可能受影响

**只有一种现场**：你的执行器**开了** `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`，**并且**任务真的要去 clone/下载 **`169.254.*` / `fd00:ec2::*` / `100.64.*` / `0.0.0.0` / 组播 / 保留段**的地址。

> 典型合法拓扑（**内网自建 GitLab/Gitea**，地址 `10.x` / `172.16-31.x` / `192.168.x`）**不受影响**——`privateIPv4` 仍然放行。

### 10.3 运维自查命令

```bash
# ① 看当前开关值
grep -n 'EXECUTOR_ALLOW_PRIVATE_NETWORK' .env apps/executor-node/.env 2>/dev/null

# ② 列出所有任务的 gitRepo，筛出会从「放行」变「拒绝」的（升级后这些会 400）
#    判据：命中 169.254.* / fd00:ec2::* / 100.64-127.* / 0.0.0.0 / 224-255.* / [::1]
psql "$DATABASE_URL" -At -c "
  SELECT id, name, config->>'gitRepo'
  FROM tasks
  WHERE config->>'gitRepo' ~ '(169\.254\.|fd00:ec2::|^https?://100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|^https?://0\.0\.0\.0|^https?://2(2[4-9]|3[0-9]|4[0-9]|5[0-5])\.|\[::1\])'
  ORDER BY name;"

# ③ 若上一条有输出且这些任务**确实需要**访问（极少见），先改地址再升级；
#    或在该执行器上保持旧版本不升级。
```

### 10.4 回滚

单 commit revert（A7 是一个独立 commit）：`git revert <A7-commit>`。回滚后开关语义恢复为「开启 ⇒ 放行一切」。

### 10.5 契约落点

- 语义事实源：`packages/executor-protocol/protocol.json` 的 `networkPolicy` 段（`addresses` / `switch` / `resolution` / `enforcement`）；
- 实现：`apps/executor-node/src/git-repo-network-policy.ts`（组合规则）+ `apps/executor-node/src/lib/ssrf-guard.ts`（按位判定与分类）；
- 与本开关相关的既有 ADR/裁定：`docs/PLAN-CLAIMS.md` 的 **SEC-NEW-2** 条目（该条目当时自陈「字符串级判定无 DNS 解析，属已知弱差」——**该已知弱差已由 `networkPolicy` 收口**）。

## 11. 执行器出站姿态（R05 起，破坏性）

> **一句话**：admin-api 发给执行器的 HTTP 请求，现在按**契约**判定目标地址 ——
> `privateIPv4` **默认拒、开关放行**；`loopback` **任何开关状态都拒**。
> 这条改动收口了 `grid:privateIPv4@off:admin` / `grid:loopback@on:admin` 两格
> （此前 admin 是四向检查里唯一的离群者）。**契约是事实源**：
> `packages/executor-protocol/protocol.json` 的 `networkPolicy.addresses` + `switch.semantics`。

### 11.1 谁受影响

| 部署形态 | 升级后行为 | 要不要动 |
|---|---|---|
| **compose 默认栈**（本仓库 `docker-compose.yml`） | **不受影响** —— admin-api 服务已内置 `EXECUTOR_ALLOW_PRIVATE_NETWORK: ${EXECUTOR_ALLOW_PRIVATE_NETWORK:-true}` | 不需要 |
| **裸机 / 自建拓扑：admin-api 与执行器在**同一内网**（`10.x` / `172.16–31.x` / `192.168.x`）** | **全部派发被拒**（除非根 `.env` 里该键已是 `true`） | **要** → 修法① |
| **裸机：执行器就在 admin-api 同一台机器的 `127.0.0.1` 上** | **永远不可用**（开关救不了回环） | **要** → 修法② |
| 执行器在公网地址 | 不受影响（`public` 恒放行） | 不需要 |

### 11.2 症状（真机实测，不是"可能失败"）

升级后 **注册与心跳照常**（执行器列表里仍显示在线），但**每次派发都失败**。
执行行 `failureReason` / `errorMessage` 的实测值（2026-11-05 真机 smoke，`verify-smoke-dispatch-push` B4 步骤）：

```text
status=failed failureReason=script_error errorMessage=URL host 172.27.0.4 在拒绝名单内（私有/回环/链路本地/基准测试/CGNAT）— 已拒绝对外请求
```

两条辅助判据（同一现场）：
- 执行器侧**一次请求都收不到**（守卫在 `axios.post` 之前抛 `SSRF_HOST_DENIED_PINNED`，不是"连不上"、不是网络问题）；
- 占坑已回滚（`runningTaskCount` 回到派发前的值，槽位不泄漏）。

**升级后启动日志里还会有一条可操作告警**（R06 新增，`main.ts` bootstrap 最早处，开关未开时必现）：

```text
[WARN] [Bootstrap] 出站 SSRF 闸（契约口径）：EXECUTOR_ALLOW_PRIVATE_NETWORK 未开启；⇒ 内网执行器（10/8、172.16/12、192.168/16）的派发会被拒绝（EXECUTOR_HOST_BLOCKED / 已拒绝对外请求）；修法①（内网执行器）：给 admin-api 设 EXECUTOR_ALLOW_PRIVATE_NETWORK=true（compose 默认栈已内置该默认值）；修法②（同机执行器）：回环地址 127.0.0.1 / ::1 不受该开关影响（契约：回环恒拒），必须改用内网 IP 或独立机器；升级说明见 docs/UPGRADING.md 的「执行器出站姿态（R05 起）」段
```

### 11.3 修法（二选一，按你的拓扑）

**修法①（内网执行器 —— 最可能命中）**：给 **admin-api** 设开关并重启：

```bash
# 源码部署：编辑仓库根的 .env
EXECUTOR_ALLOW_PRIVATE_NETWORK=true
# 然后重启 admin-api（compose: docker compose up -d admin-api；裸机: 重启进程）
```

> 注意是 **admin-api 侧**的变量（它是发起派发的一方）。执行器自己的同名变量管的是它**出站**拉包
> （`packageUrl`/`gitRepo`），与这条派发闸无关。

**修法②（同机执行器 —— `127.0.0.1`）**：**换地址，不要试图开开关**。回环在契约里恒拒
（原话：「loopback 不随 private-network 开关放行（打自己回环没有合法拓扑）」），
`EXECUTOR_ALLOW_PRIVATE_NETWORK=true` 对它**无效**。两条可行路径：

1. 执行器改注册为**内网 IP**（`EXECUTOR_ADDRESS=192.168.x.y:8002`），admin-api 侧配上修法①的开关；
2. 或把执行器挪到独立机器/容器，用网络可达地址（compose 默认栈就是这个形态）。

### 11.4 升级后自查（两条命令，任一红灯就按 §11.3 处理）

```bash
# ① 四向协议判据：应为 exit 0，且报告里「0 格不一致」
npm run check:protocol-three-way

# ② 造一次派发，看执行行是否还是 SSRF 拒绝
#    （GUI：任务详情 → 执行记录 → failureReason / errorMessage；
#      或 psql 查 task_executions 的 failureReason/errorMessage 两列）
```

### 11.5 回滚

单 commit revert（独立提交 `fbd85d26`，R05）：

```bash
git revert fbd85d26      # 行为恢复到「private-lan 恒放行 + 开关解锁 loopback」
```

回滚后**部署默认值也要一并回退**（`docker-compose.yml` 里 admin-api 的
`EXECUTOR_ALLOW_PRIVATE_NETWORK` 缺省）——两者是同一提交里的成对改动。
无 schema / 迁移变更，回滚不涉及数据。

## 12. 云元数据地址恒拒（R08 起，行为收紧）

> **一句话**：契约新增 `networkPolicy.metadataAddresses`（ADR-029）——列出的云元数据地址
> **任何 posture × 任何开关状态都 DENY**。此前它们落在 `restricted` 类里，会被
> `AI_ALLOW_PRIVATE_NETWORK` / `EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK` / `NOTIF_ALLOW_PRIVATE_NETWORK`
> 这三个开关放行。

### 12.1 谁受影响

| 部署形态 | 影响 |
|---|---|
| 正常部署（webhook / AI / 通知目标都是公网或自建内网服务） | **不受影响** |
| 有人把 webhook/AI/通知目标指向**云元数据端点**（如阿里云 `100.100.100.200`） | **现在恒拒**（任何开关都救不了）——这是**修 bug**，不是兼容性破坏 |
| Tailscale（`100.64/10`）/ RFC2544 基准段用户 | **不受影响**（`restricted` 的非元数据成员语义未变） |
| 内网执行器（`EXECUTOR_ALLOW_PRIVATE_NETWORK`） | **不受影响**（`private-lan` 未动） |

### 12.2 症状

目标地址命中契约元数据表时，出站请求在**风险分类之前**被拒（错误标签为 `reserved` 或对应姿态的禁用文案），
且**把开关设为 `true` 也不放行**。首版表成员：`100.100.100.200/32`（阿里云 ECS 元数据）。

### 12.3 修法

没有"开关"可开：**把目标改成非元数据地址**。若你确实需要访问该地址（极罕见），
只能在**自己的分支**里清空 `packages/executor-protocol/protocol.json` 的
`networkPolicy.metadataAddresses.addresses` 并重新生成（`npm run gen:protocol`），
但那同时会让三端测试红——这是刻意的。

### 12.4 回滚

- 单 commit：`git revert <R08 sha>`（契约段 + 三端生成物 + 三端用法 + 文档 + 测试一次回退）；
- **软回滚**（不改代码）：把 `metadataAddresses.addresses` 改成 `[]` 再 `npm run gen:protocol`
  ⇒ 三端判定恒 false，行为退回 R07 之前；但三端测试会红（它们断言元数据恒拒），
  所以正式回滚仍建议 `git revert`。
- 无 schema / 迁移 / 数据变更；线缆协议版本不变（`currentProtocolVersion` 未 bump）。

## 13. Oracle 元数据地址 `192.0.0.192` 恒拒（R09 起，行为收紧）

> 与 §12 同一机制（契约 `networkPolicy.metadataAddresses`，ADR-029 §7）。
> 一句话：`192.0.0.192`（Oracle Cloud 实例元数据）此前被三端分类器判成 **`public`**
> ⇒ **任何姿态、任何开关都放行**（比 §12 那条更硬：连开关都不需要）；
> 现在它进元数据恒拒表，**任何姿态 × 任何开关都 DENY**。

### 13.1 依据（IANA 事实）

`192.0.0.0/24` = **IETF Protocol Assignments**（RFC 6890 §2.1），整段 Source/Destination/
Forwardable/Globally Reachable **全 False**，脚注[2]「不更具体登记即不可用」。`192.0.0.192`
不在任何"更具体登记"里 ⇒ 应拒。段内**合法例外**（`192.0.0.0/29` 服务连续性前缀、
`192.0.0.9/32` PCP anycast、`192.0.0.10/32` TURN anycast、`192.0.0.8/32` dummy、
`192.0.0.170/31` NAT64 发现）**不受影响**——本轮只拒有证据的 `192.0.0.192`。

### 13.2 谁受影响

| 部署形态 | 影响 |
|---|---|
| 正常部署（目标都是公网/自建内网服务） | **不受影响** |
| 有人把 webhook/AI/通知/gitRepo/执行器地址指向 `192.0.0.192` | **现在恒拒**（任何开关都不放行）——这是**修拒绝清单漏项** |

### 13.3 症状与修法

症状同 §12：出站请求在**风险分类之前**被拒；把任何 `*_ALLOW_PRIVATE_NETWORK` 设为 `true` 也无效。
修法：**把目标改成非元数据地址**（没有"开关"可开）。

### 13.4 回滚

- 单 commit：`git revert <R09 sha>`；
- 软回滚：从 `packages/executor-protocol/protocol.json` 的
  `networkPolicy.metadataAddresses.addresses` 里删掉 `"192.0.0.192/32"`，再 `npm run gen:protocol`
  （三端判定与分类同时回落；三端测试会红，属预期）。
- 无 schema / 迁移 / 数据变更；协议版本不变。

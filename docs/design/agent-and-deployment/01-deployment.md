# 01 · 一键部署：源码模式 + Docker 模式

> 目标：一条命令完成部署，**生产端默认源码模式**（性能考虑），同时保留 Docker 模式供开发/试跑。

## 1. 现状与问题

### 1.1 现在有什么

| 入口 | 能力 | 问题 |
|---|---|---|
| `deploy.sh`（根目录，146 行） | 仅 Docker Compose；`-e/--build/--detach` | 无源码模式；`sleep 30` 硬等；健康检查只探 admin-api 一个点 |
| `docker-compose.yml`（36 KB） | 完整 Docker 编排 | 体量大，源码模式完全用不上 |
| `docs/deployment.md`（76 KB） | 源码部署步骤散落其中 | **靠人手动跟文档**，无脚本化，无法"一键" |
| `scripts/install.sh` | 执行器裸机安装（systemd） | 只装执行器，不装中台 |
| `Makefile` | 常用命令别名 | 无部署编排 |

**核心矛盾**：`deploy.sh` 只会 Docker，而你的生产端要源码部署。源码部署今天等于「照 76 KB 文档手工敲」——这正是要消灭的。

### 1.2 源码部署为什么快（你的判断是对的）

Docker 模式在**生产常驻**场景下的实际开销：

| 开销项 | Docker 模式 | 源码模式 |
|---|---|---|
| 网络 | 用户态 NAT/bridge 转发，每包一次 netfilter 穿越 | 直连 loopback / 同机进程 |
| 文件 IO | overlayfs 双层（lower 只读 + upper 可写），写放大 | 原生文件系统 |
| 构建产物 | 镜像层内 `node_modules`，冷启动要解压层 | 已在磁盘，mmap 直读 |
| 执行器任务 | 任务子进程多走一层容器隔离 | 直接 fork，Python/Node 解释器池可直接预热复用 |
| 内存 | 每容器额外常驻 | 共享宿主页缓存 |

对**高并发短任务**场景（执行器频繁 fork 短命脚本），这层损耗是复利的。保留 Docker 给开发/CI/试跑是对的。

## 2. 设计目标

| # | 目标 | 验收 |
|---|---|---|
| G1 | 一条命令部署，无需读文档 | `sudo ./deploy.sh --mode source --env production` 跑完即可用 |
| G2 | 两种模式**同一套配置来源** | 都读根 `.env`，行为不漂移 |
| G3 | 幂等可重入 | 重复执行不破坏已有数据/配置 |
| G4 | 失败可诊断 | 任一环节失败给出明确原因 + 下一步命令 |
| G5 | 不破坏现有 Docker 用户 | 现有 `./deploy.sh` 调用方式继续可用 |

## 3. 命令面设计

```bash
# ── 主入口（向后兼容：不带 --mode 时默认 docker，与今天行为一致）──
./deploy.sh [--mode source|docker] [--env development|staging|production] [选项]

# ── 源码模式（生产推荐）──
sudo ./deploy.sh --mode source --env production
sudo ./deploy.sh --mode source --env production --with monitoring,backup
sudo ./deploy.sh --mode source --env production --component admin-api    # 只滚动一个组件

# ── Docker 模式（开发/试跑）──
./deploy.sh --mode docker --env staging --build

# ── 运维子命令（两种模式通用）──
./deploy.sh status           # 各组件存活 + 版本 + 端口
./deploy.sh health           # 深度健康（含 DB/Redis/执行器连通性）
./deploy.sh logs admin-api   # 日志（源码=journalctl/file，docker=compose logs）
./deploy.sh restart executor-node
./deploy.sh rollback         # 回滚到上一版本（见 §7）
./deploy.sh doctor           # 只诊断不部署（见 §6）
```

### 3.1 选项表

| 选项 | 默认 | 说明 |
|---|---|---|
| `--mode <source\|docker>` | `docker` | **不带时保持今天的行为**，不破坏现有脚本 |
| `--env <development\|staging\|production>` | `development` | 决定 `NODE_ENV`、必填项校验强度、是否 `synchronize` |
| `--component <name,...>` | 全部 | 只部署指定组件（滚动升级用） |
| `--with <monitoring,backup,jaeger>` | 无 | 附加 profile（复用现有 compose profile 语义） |
| `--dry-run` | 关 | 打印将执行的步骤与命令，不改系统 |
| `--yes` | 关 | 非交互（CI 用）；生产环境额外要求 `--i-know-its-production` |
| `--build` | 关 | Docker 模式强制重建镜像 |
| `--skip-preflight` | 关 | 跳过体检（**不推荐**，仅排障用） |

## 4. 部署流水线（两模式共用的 8 个阶段）

关键设计：**阶段划分与模式无关**，只有「执行器」这一层分叉（Docker → `docker compose`；源码 → systemd/裸进程）。

```
┌─ ① 预检 Preflight ─────────────────────────────────────┐
│  · 平台判定 (Linux/macOS/WSL；Windows 走独立分支)        │
│  · 版本门槛：Node >= 20、Python >= 3.11、npm >= 10       │
│  · 端口占用扫描：3105 / 80 / 8001 / 8002 / 6379 / 5432   │
│  · 磁盘 >= 10 GB、内存 >= 4 GB (warn)                    │
│  · 生产模式额外：systemd 可用？DB 可达？                 │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─ ② 配置解析 Config ────────────────────────────────────┐
│  · 无 .env → 从 .env.example 生成 + 自动填充强随机值      │
│      openssl rand -hex 32  → JWT_SECRET / JWT_REFRESH_   │
│      openssl rand -hex 16  → EXECUTOR_SECRET             │
│  · 生产模式强校验（复用 scripts/verify-config.cjs 口径）：│
│      DB_PASSWORD >= 16、JWT_SECRET >= 32、CORS_ORIGINS    │
│      不得含 localhost                                     │
│  · 校验失败 → 明确报错并退出（不静默降级）                │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─ ③ 依赖准备 Dependencies ──────────────────────────────┐
│  source: npm ci --workspace 逐包 / python -m venv        │
│  docker: 跳过（镜像内完成）                              │
│  · 私有 registry 可达性检测 → 不可达时 warn 并给离线指引  │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─ ④ 构建 Build ─────────────────────────────────────────┐
│  source: npm run build  (admin-api / admin-web /         │
│          executor-node / executor-python 各自构建)        │
│  docker: docker compose build                            │
│  · 构建产物指纹写入 .deploy-manifest.json（供回滚）       │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─ ⑤ 基础设施 Infra ─────────────────────────────────────┐
│  · PostgreSQL + Redis：两种模式都建议容器化（无性能敏感） │
│    —— 这是刻意设计：DB 不是瓶颈，容器化省运维成本         │
│  · 已有外部 DB → 检测 .env 指向外部则跳过                 │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─ ⑥ 迁移 Migration ─────────────────────────────────────┐
│  · npm run migration:run（幂等）                         │
│  · 迁移前**强制**备份：复用 scripts/pg-backup.sh          │
│  · 生产模式：备份失败即中止（不带着未备份的库跑迁移）      │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─ ⑦ 启动 Start ★ 模式分叉点 ────────────────────────────┐
│  source:                                                  │
│    · systemd unit 生成并 enable（admin-api / executor-*） │
│    · nginx 站点配置（admin-web 静态 + /api 反代）         │
│    · 解释器池预热（scripts/warm-interpreters.sh）         │
│  docker:                                                  │
│    · docker compose up -d [--profile ...]                 │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─ ⑧ 验证 Verify ────────────────────────────────────────┐
│  · 轮询健康端点（指数退避，替代 sleep 30）                │
│    admin-api  /api/health/live → /api/health/ready        │
│    admin-web  HTTP 200                                    │
│    executor-* /health/live                                │
│  · 执行器注册断言：GET /api/executors 出现 ≥ 1 台 ONLINE   │
│  · 失败 → 自动倾倒相关组件最近 50 行日志 + 明确下一步      │
└─────────────────────────────────────────────────────────┘
```

### 4.1 为什么 ⑤ 基础设施仍用容器

这是个重要的取舍，明确写出来：**你的性能诉求来自「执行器频繁 fork 短命任务」和「admin-api 高频请求」，不来自 PostgreSQL。**
把 DB 也搬源码（编译安装 PG/Redis）会让部署脚本复杂度爆炸，收益接近零。所以设计是：

- **容器化**：postgres、redis、monitoring、backup —— 低频、长连接、无 fork 风暴
- **源码**：admin-api、admin-web（nginx 静态）、executor-node、executor-python —— 高频、fork 密集、性能敏感

这也让 `--mode source` 仍然依赖 Docker 来跑基础设施。若你要**完全无 Docker 的生产环境**，需要额外一档 `--infra external`（指向已有的外部 PG/Redis）——这点见 §9 待定项。

## 5. 源码模式的 systemd 设计

### 5.1 unit 模板

```ini
# /etc/systemd/system/acf-admin-api.service
[Unit]
Description=AutoCodeFlow admin-api
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=acf
WorkingDirectory=/opt/autocodeflow/apps/admin-api
EnvironmentFile=/opt/autocodeflow/.env
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5
# 优雅退出：现有代码 R-08 已支持，给足排空时间
TimeoutStopSec=60
KillSignal=SIGTERM
# 资源约束（可按机器调）
LimitNOFILE=65535
MemoryMax=2G
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

executor 的 unit 同构，差异只在 `WorkingDirectory` 与 `ExecStart`。

### 5.2 关键细节

| 细节 | 做法 | 原因 |
|---|---|---|
| 进程用户 | 专用 `acf` 系统用户，非 root | 安全；`install.sh` 已是此姿态 |
| 优雅退出 | `TimeoutStopSec=60` + `SIGTERM` | 现有代码有优雅退出逻辑（`docs/deployment.md` R-08），别用 SIGKILL 打断 |
| 崩溃自愈 | `Restart=always` + `RestartSec=5` | 替代容器 `restart: unless-stopped` |
| 日志 | journald，配置 `MaxRetentionSec` | 替代容器的 json-file 驱动 |
| 文件描述符 | `LimitNOFILE=65535` | 高并发执行器必需 |
| 内存上限 | `MemoryMax` | 项目有过 OOM 事故（`docs/INCIDENT-2026-09-23-admin-api-oom.md`），显式设限 + 触顶时 systemd 重启比内核 OOM killer 更可控 |

> ⚠️ **OOM 历史教训**：项目发生过 admin-api OOM 事故。systemd 的 `MemoryMax` 会让进程在触顶时被杀并重启，**优于**内核 OOM killer 随机杀进程。但必须同时确认 `NODE_OPTIONS=--max-old-space-size` 与 `MemoryMax` 匹配，否则 Node 堆上限高于 cgroup 上限时，systemd 先杀、Node 来不及 GC。此处需要一个**一致性校验**写进 `doctor`。

### 5.3 Windows 分支

`scripts/install.sh` 已明确「仅支持 Linux，Windows 请手动部署」。本设计延续该边界但**改善体验**：

- `deploy.sh` 在 Windows/Git-Bash 上检测到后，**不尝试假装支持**，而是：
  1. 打印结构化手动步骤（复用 `docs/deployment.md` 的 Windows 章节要点）
  2. 提供 `--mode docker` 的可用性提示（Windows 上 Docker Desktop 是可行路径）
  3. 生成一份 `.deploy-windows-checklist.md` 到工作目录供人工勾选

这与现有 `install.sh` 的姿态一致：**明确失败好过跑到一半炸**。

## 6. `doctor` 子命令（诊断不部署）

这是给**中台 Agent 用的接口**——见 [03](./03-agent-tools-and-boundary.md)，Agent 排查环境异常时第一个调用的就是它。

```
$ ./deploy.sh doctor

预检项                                              状态
──────────────────────────────────────────────────────────
平台 / 版本            Linux 6.8 · Node 20.11 · Py 3.11   ✔
端口 3105              空闲                              ✔
端口 80                被 nginx (pid 1234) 占用          ✔ 复用
PostgreSQL             可连接 · 72 迁移已应用             ✔
Redis                  可连接 · 密码正确                 ✔
.env 必填项            全部通过（5/5）                   ✔
JWT_SECRET 强度        64 hex chars                      ✔
Node 堆上限 vs cgroup  2G / 2G 一致                       ✔
磁盘可用               42 GB                             ✔
admin-api 最近错误     近 1h 无 ERROR                     ✔
执行器在线数           2 台 ONLINE（1 台 45s 无心跳）     ⚠
私有 registry          可达                              ✔
──────────────────────────────────────────────────────────
结论：可部署。1 项警告（执行器心跳延迟，通常自愈）
```

**输出契约**：`doctor --json` 输出结构化结果，供 Agent 程序化消费。字段设计见 [03 §5](./03-agent-tools-and-boundary.md)。

## 7. 回滚设计

`.deploy-manifest.json`（每次部署写入工作目录）：

```json
{
  "version": "1.2.3",
  "mode": "source",
  "env": "production",
  "deployedAt": "2026-09-24T10:00:00Z",
  "gitCommit": "0ef3bbe",
  "artifacts": {
    "admin-api": { "path": "apps/admin-api/dist", "sha256": "..." },
    "admin-web": { "path": "apps/admin-web/dist", "sha256": "..." }
  },
  "migrationsApplied": ["1790000000039-AddExecutorReservedSlots"],
  "previous": ".deploy-manifest.prev.json"
}
```

`./deploy.sh rollback`：
1. 读 `.deploy-manifest.prev.json`
2. **默认只回滚代码，不回滚迁移**（数据不可逆——与项目 `docs/rollback-semantics.md` 的既有姿态一致，必须先读该文档）
3. 若检测到需回滚的迁移，**中止并要求人工确认**，打印具体迁移名
4. 回滚后跑同一套 ⑧ 验证

## 8. 与既有资产的对接（不重造）

| 既有资产 | 在部署脚本中的角色 |
|---|---|
| `scripts/pg-backup.sh` | ⑥ 迁移前强制备份 |
| `scripts/verify-config.cjs` | ② 配置校验（复用其口径，不重写） |
| `Makefile` | 部署脚本调用它，保持两处行为一致 |
| `scripts/warm-interpreters.sh` | ⑦ 源码模式解释器池预热 |
| `modules/executor/install-script.content.ts` | 生成的执行器安装脚本指向 `deploy.sh` 下发的地址 |
| `docker-compose.yml` profiles | `--with` 选项直接映射需 profile 名 |
| `docs/deployment.md` | **成为唯一事实源**：脚本改动必须同步更新该文档（可加 CI 校验，见 §9） |

## 9. 待你确认的开放项

1. **完全无 Docker 的生产环境**是否需要支持？现在是「源码应用 + 容器 DB」。若需要，加 `--infra external` 档。
2. **systemd 是否可接受**？若有非 systemd 环境（Alpine/OpenRC、或纯容器宿主），需要额外的 supervisor 分支。
3. **多机部署**是否需要？现在设计是单机全栈。多机（中台 1 台 + 执行器 N 台）建议拆成 `deploy.sh --role center|executor` 两个角色——这会显著增加复杂度，建议**放到第二阶段**。
4. **部署脚本的语言**：保持 Bash（与现有 `deploy.sh`/`install.sh` 一致，无额外依赖）还是改 Node（可测性好，但要求 Node 先就绪——鸡生蛋）？我建议 **Bash 主控 + Node 做校验类子命令**，即现在的架构。
5. **CI 校验文档漂移**：可否加 `check:deployment-doc-sync`，像现有 `check:install-script-sync` 那样守卫脚本与文档一致？

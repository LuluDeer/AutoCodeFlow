# 运维手册

## 日常运维

### 查看服务状态

```bash
# 查看所有服务状态
docker compose ps

# 查看资源使用
docker stats

# 健康检查端点
curl http://localhost:3105/health
```

### 查看日志

```bash
# 实时日志（所有服务）
docker compose logs -f

# 单个服务日志
docker compose logs -f admin-api
docker compose logs -f admin-web
docker compose logs -f executor-node
docker compose logs -f executor-python

# 查看最近 100 行
docker compose logs --tail=100 admin-api
```

### 重启服务

```bash
# 重启单个服务（不影响其他服务）
docker compose restart admin-api

# 重启所有服务
docker compose restart

# 强制重新创建容器（配置变更后使用）
docker compose up -d --force-recreate admin-api
```

### 更新到最新版本

```bash
# 拉取最新代码
git pull

# 重新构建并重启
docker compose pull
docker compose up -d --build

# 执行新的数据库迁移（如有）
docker compose exec admin-api npm run migration:run
```

---

## 数据备份与恢复

### 备份 PostgreSQL 数据库

```bash
# 创建备份目录
mkdir -p /backup/autoflow

# 备份数据库（每日建议放入 cron）
docker compose exec -T postgres pg_dump \
  -U autoflow autoflow \
  | gzip > /backup/autoflow/db_$(date +%Y%m%d_%H%M%S).sql.gz

# 验证备份文件
ls -lh /backup/autoflow/
```

### 定时自动备份（Linux cron 示例）

```bash
# 编辑 crontab
crontab -e

# 每天凌晨 2 点备份，保留 30 天
0 2 * * * cd /path/to/AutoCodeFlow && docker compose exec -T postgres pg_dump -U autoflow autoflow | gzip > /backup/autoflow/db_$(date +\%Y\%m\%d).sql.gz && find /backup/autoflow -name '*.sql.gz' -mtime +30 -delete
```

### 恢复数据库

```bash
# 停止依赖数据库的服务
docker compose stop admin-api

# 恢复数据
gunzip -c /backup/autoflow/db_20240101_020000.sql.gz \
  | docker compose exec -T postgres psql -U autoflow autoflow

# 重启服务
docker compose start admin-api
```

### 备份执行器日志文件

执行器日志存储在容器的 `/app/logs` 目录，建议挂载到宿主机：

```yaml
# docker-compose.yml 中已配置 volume
volumes:
  - ./data/executor-logs:/app/logs
```

```bash
# 备份日志
tar -czf /backup/autoflow/logs_$(date +%Y%m%d).tar.gz ./data/executor-logs/
```

### S3/MinIO 日志对象生命周期

`LOG_STORAGE_DRIVER=s3` 时执行日志以对象形式写入 MinIO 的 `execution-logs/` 前缀（桶名默认 `autoflow-logs`）。admin 侧的日志保留期清理只覆盖数据库行，不覆盖外置对象——MinIO 数据卷没有内置过期，必须配置 bucket lifecycle 使对象与 DB 保留期同步到期，否则 `minio_data` 卷会随日志对象无限增长直至磁盘写满：

```bash
# 一次性配置（mc 客户端指向部署的 MinIO）
mc alias set autoflow-minio http://127.0.0.1:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD
mc ilm rule add --expiry-days 30 --prefix "execution-logs/" autoflow-minio/autoflow-logs

# 验证
mc ilm rule ls autoflow-minio/autoflow-logs
```

`--expiry-days` 应与 `LOG_RETENTION_DAYS`（默认 30）保持一致，使对象先于或同步于 DB 行过期。执行器本地 `workDir/logs`（7 天）与死信回调（50 个文件上限）由执行器自身清理，不在本节范围内。

### 备份对象清单

上述 pg_dump 只覆盖数据库。完整备份需包含以下对象：

| 对象 | 内容 | 说明 |
|------|------|------|
| PostgreSQL 全库 | tasks / task_executions / execution_log_lines / 系统配置、用户与审计等全部业务表 | 上文 `pg_dump` 命令（每日 cron）；或对 `postgres_data` 卷做物理快照（见下文 pgBackRest 建议） |
| `.env` secrets | `JWT_SECRET` / `DB_PASSWORD` / `REDIS_PASSWORD` / `EXECUTOR_SECRET` / `MINIO_ROOT_PASSWORD` / `INITIAL_ADMIN_PASSWORD` 等 | 文件级备份并妥善保管权限；丢失后按「安全加固」节重建并轮换 |
| 上传包目录 | admin-api 容器内 `uploads/packages`（应用包）与 `uploads/executor-packages`（执行器包） | **注意**：compose 未为 admin-api 挂载卷，该目录仅存于容器文件系统，容器重建即丢失。备份：`docker compose cp admin-api:/app/uploads /backup/autoflow/uploads_$(date +%F)`；或接受重建后重新上传 |
| S3/MinIO 日志桶 | `LOG_STORAGE_DRIVER=s3` 时 `autoflow-logs` 桶 `execution-logs/` 前缀对象（`minio_data` 卷） | `mc mirror autoflow-minio/autoflow-logs /backup/autoflow/minio/`；MinIO 卷本身无内置备份，仅镜像导出 |
| 包仓库缓存（可选） | `pypi_data`（registry-pypi `/data/packages`）、`npm_data`（registry-npm verdaccio storage） | 仅上游包缓存，可从 PyPI/npm 重建，备份优先级低 |

### 恢复步骤骨架

```bash
# 1. 停止依赖数据库的服务
docker compose stop admin-api

# 2. 恢复 PG 全库（与上文「恢复数据库」一致）
gunzip -c /backup/autoflow/db_20240101_020000.sql.gz \
  | docker compose exec -T postgres psql -U autoflow autoflow

# 3. 按备份对象清单回放其余对象：.env、uploads 包目录（docker compose cp 回灌）、
#    MinIO 对象（mc mirror --overwrite 回放）

# 4. 启动并跑迁移链（幂等，重复执行无副作用，可安全重跑）
docker compose start admin-api
docker compose exec admin-api npm run migration:show
docker compose exec admin-api npm run migration:run

# 5. 健康检查
curl http://localhost:3105/health
```

**迁移链幂等性说明**：全部迁移以 `IF NOT EXISTS` / `IF EXISTS` 编写，重复执行与
revert 重放均无副作用；CI 已有「空库 + 续跑」双轮幂等 job 兜底。恢复点版本落后于
当前代码版本时，`migration:run` 会补齐差异迁移——这正是恢复步骤中总是跑一次
`migration:run` 的原因。存量库跨 3 个版本升级的演练（QA-08 第三态）尚未完成
（见 `docs/DEVELOPMENT-PLAN-2026-09.md` §7），跨大版本升级后的恢复演练应先在
测试环境执行。

### 物理备份建议（pgBackRest）与定期 dump

逻辑备份（上文每日 `pg_dump` cron）适合当前规模。数据量增长后建议引入 pgBackRest
（支持增量与时间点恢复 PITR），骨架如下（未随 compose 交付，落地前需在测试环境验证）：

```ini
# /etc/pgbackrest/pgbackrest.conf 骨架
[global]
repo1-path=/backup/pgbackrest
repo1-retention-full=2

[autoflow]
pg1-port=5432
pg1-user=autoflow
```

```bash
# crontab 示例：每周日全量 + 工作日增量
0 3 * * 0 pgbackrest --stanza=autoflow backup --type=full
0 3 * * 1-6 pgbackrest --stanza=autoflow backup --type=incr
```

### 恢复演练清单

建议每季度演练一次，逐项验证：

- [ ] 恢复后健康检查端点通过：`curl http://localhost:3105/health`、
      `/api/health/services`（各组件 healthy）、`/api/health/metrics`（`queueSize` 可读）
- [ ] 任务列表抽查：`GET /api/tasks` 返回记录数量与备份点一致，抽样任务可查看
      执行记录与日志明细
- [ ] 执行器重注册：`docker compose restart executor-node executor-python` 后约
      10-15 秒心跳出现（见上文「执行器重新注册」），`GET /api/executors` 可见且为
      在线状态
- [ ] 恢复耗时记录归档，作为 QA-08 升级 runbook 的输入

---

## 执行器生命周期管理

### 注销执行器

#### 方法一：管理界面（推荐）

1. 进入 **「执行器」** 列表
2. 选中目标执行器，点击 **「注销」** 或 **「删除」**
3. 系统会将该执行器标记为下线，并从调度队列移除

#### 方法二：API

```bash
# 获取执行器列表，记录 ID
curl -H 'Authorization: Bearer <token>' http://localhost:3105/api/executors

# 注销指定执行器
curl -X DELETE -H 'Authorization: Bearer <token>' \
  http://localhost:3105/api/executors/<executorId>
```

### 执行器重新注册

执行器注销后，下次启动时会自动重新注册。也可以手动重启触发：

```bash
# 重启执行器容器（触发重新注册）
docker compose restart executor-node
docker compose restart executor-python

# 确认重新注册成功（约 10-15 秒后心跳出现）
curl -H 'Authorization: Bearer <token>' http://localhost:3105/api/executors
```

### 执行器重启后的任务恢复

执行器重启后，系统会自动将该执行器上处于 `running` 状态的任务标记为 `failed`，并根据任务的重试配置自动重新调度。无需手动干预。

---

## 横向扩容（多执行器）

### 添加执行器节点

#### 方法一：通过管理界面（推荐）

1. 登录管理后台，进入 **「执行器」→「安装执行器」**
2. 填写新节点的访问地址
3. 复制生成的安装命令
4. 在目标服务器上执行

#### 方法二：Docker Compose 扩展

在同一台机器上启动多个执行器实例：

```bash
# 启动 3 个 executor-node 实例
docker compose up -d --scale executor-node=3
```

注意：每个实例会自动注册到 admin-api，任务调度时会选择空闲的执行器。

#### 方法三：独立服务器部署执行器

```bash
# 在目标服务器上一键安装（脚本由 Admin API 承载，@Public、不含密钥；
# 登录管理后台「执行器 → 安装执行器」或调用
# GET /api/executors/install-cmd 可生成含地址与 token 的完整命令，
# 见 docs/api-reference.md）
curl -fsSL http://your-admin-api-host:3105/api/executors/install.sh \
  | bash -s -- --api-url http://your-admin-api-host:3105 --secret your-executor-secret
```

> 注意：executor-node **不经 npm 分发**——`@autoflow/executor-node` 从未
> 发布，且 `@autoflow` org 已被第三方抢注，切勿照抄 `npm install -g` 该
> 名称（当前 404，将来若被抢注者发布同名包即成供应链投毒面）。真实通道
> 是安装脚本从 Admin API 拉取 artifact tarball
> （`GET /api/executors/artifact/executor-node.tar.gz`，产物由
> `scripts/bundle-executor-artifact.sh` 生成：dist + 生产 node_modules），
> 下载失败时回退项目 checkout 本地复制（开发场景）。

### 执行器负载均衡策略

系统默认采用 **最空闲优先** 策略：
- 优先选择当前运行任务数最少的执行器
- 执行器离线时自动从调度队列中移除
- 超时未响应的执行器会被标记为 `offline`

可在任务设置中指定执行器：
- **不限定**（默认）：由系统自动选择空闲执行器
- **指定执行器**：固定在某台执行器上运行（适合需要特定环境的任务）
- **指定执行器组**（通过标签）：在一组执行器中负载均衡

---

## 容量规划

> 本节为 DOC-02 规划内容：水位指标与告警阈值提炼自
> `docs/observability/README.md` 4.2 节（OBS-05 容量水位四件套）与
> `docs/observability/alerting-rules.yml`。**容量白皮书（QA-05 并发压测专项）尚未产出**：
> 下列阈值均为既有告警配置的既定值，涉及「容量上限」的数字均标注**待压测确认**。

### 容量水位指标清单与建议告警阈值

| 信号 | series（逐字） | 水位读法 / 建议阈值 | 前提与备注 |
|------|----------------|----------------------|------------|
| PG 连接池水位 | `autoflow_db_pool_max_connections` / `autoflow_db_pool_active_connections` / `autoflow_db_pool_idle_connections` / `autoflow_db_pool_waiting_requests` | 利用率 = active/max，**> 0.8（80%）持续 5m 建议告警**；`waiting_requests > 0` 持续 5m = 池饱和（有人在排队等连接），建议告警 | 告警须以 `max_connections > 0` 为前提——`max == 0` 表示池句柄不可读（进程启动早期 / 非 PG 驱动），此时其余三项一并置 0。池上限 = `DB_POOL_SIZE`（默认 20，PERF-04），实际承载能力**待压测确认** |
| SSE 日志流槽位 | `autoflow_sse_streams_active` / `autoflow_sse_streams_limit` | 占用率 = Σ(active)/Σ(limit)，**> 0.8 持续 10m 关注** | 配合 `autoflow_sse_streams_rejected_total` 观察拒绝速率；limit = `SSE_MAX_STREAMS_GLOBAL`（默认 64，进程内计数） |
| 队列积压 | `autoflow_queue_depth{state="waiting"}` | **> 100 持续 10m 告警**（`AUTOFLOW_QUEUE_BACKLOG` 已启用） | Redis 不可读时 `autoflow_queue_up == 0` 且 depth 全部置 0，勿把抓取故障误读为「无积压」 |
| executor 磁盘水位 | `autoflow_executor_disk_usage_percent{executor="<address>"}` | **> 90（90%）持续 10m 建议告警** | 仅在线且心跳上报 `diskUsage` 的执行器有 series（旧版执行器缺席而非 0）；per-executor label，执行器下线/换址后 series 随抓取消失 |

阈值来源：`docs/observability/README.md` 4.2 节与 `alerting-rules.yml`（6 条启用告警）。
series 名已与唯一注册处
`apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts` 逐字核对（见该 README
附录 A）。注意抓取端点 `/api/metrics` 需要 Bearer JWT，抓取配置见该 README 第 1 节。

### 横向扩容要点

- **admin-api 多实例与 SSE 容量**：SSE 流计数为**进程内** gauge（per-instance，进程重启
  归零），多实例 SSE 总容量 = 实例数 × `SSE_MAX_STREAMS_GLOBAL`（默认 64）线性叠加
  （占用率按 Σ(active)/Σ(limit) 计算）——该上限值**待压测确认**。每实例独立抓取
  （`instance` label 由 Prometheus 注入），告警按 `job=autoflow-admin-api` 聚合。
- **Leader Election 双实例语义**：调度扫描由 Redis 锁选主（`lock:scheduler:leader`，锁
  TTL 30s + 竞选重试 15s，接管窗 60s），同一时刻仅 Leader 实例执行调度；任务触发去重的
  唯一跨进程保障也是 Redis 分布式锁——进程内 `runningTasks` Map 不跨实例。Redis 不可用时
  持锁实例 fail-open（保持 `isLeader=true` 继续调度）。双实例滚动重启的行为验证见
  「混沌演练」C 场景。
- **执行器侧并发与派发闸门**：执行器自身并发上限 `MAX_CONCURRENT_TASKS`（compose 缺省
  10；管理界面可调，执行器 `/config/reload` 热更后随下个心跳回传，admin 侧按正整数
  1..10000 校验采纳，非法值视为未上报不改 DB）。admin 派发闸门：候选池先按在线/分组/
  标签/runtime 过滤，再剔除 `runningTaskCount >= maxConcurrentTasks` 的满载执行器，按
  加权分（负载 50% / CPU 25% / 内存 25%）选优；全部满载即抛 `ServiceUnavailableException`
  （"No available executor — all online executors are at maximum capacity"），本次派发
  失败；pin 指定执行器满载时同样派发失败且**不回落**其他实例。全系统执行并发理论值 =
  各执行器上限之和，实际极限**待压测确认**。
- **全局限流**：`THROTTLE_LIMIT` 默认 60 req/min（登录另有 `LOGIN_THROTTLE_LIMIT`
  20/min），是 API 侧最先到达的容量墙；压测前按 `scripts/load-test.README.md` 建议临时
  调高（如 600）并重启 admin-api，避免 429 退避主导吞吐数字。

### 压测与容量基线（占位）

压测工具与用法见 `scripts/load-test.mjs` 与 `scripts/load-test.README.md`（并发创建/触发
glue 任务 → 轮询终态 → 吞吐 / p50/p95 / 429 / 重复执行违规报告，可进 CI/巡检）。注意该
工具刻意**不做执行器饱和打满**（速率压在限流之下），测的是「调度正确性 + 限流内吞吐」，
不是执行器极限容量。

**容量白皮书（QA-05 并发压测专项）尚未产出**：单实例 500 并发执行、1000 任务/分钟入队、
SSE 500 连接、回调风暴等规划目标，以及 PG 连接池 / BullMQ / 回调路由的瓶颈定位，全部
**待压测确认**后再回填本节（规划项见 `docs/DEVELOPMENT-PLAN-2026-09.md` §7 QA-05）。
本节当前不给出任何经验证的容量上限数字。

---

## 混沌演练（chaos-drill）

`scripts/chaos-drill.sh` 对在跑的 compose 栈做受控故障注入，每个场景按
**注入 → 断言 → 恢复 → 二次断言** 推进；退出码 = 失败场景数。场景语义均
已对 `apps/admin-api/src` 实现核实（fail-open 判定、判离线阈值、Leader 锁
TTL），脚本内注释标注了断言窗口与实现常量的对应关系。

### 前置条件

- docker compose 完整栈在跑：admin-api(:3105)、redis、executor-node 至少各一
- 管理员凭据可用（默认 `admin` / `Admin@123456`，即 compose 缺省 `INITIAL_ADMIN_PASSWORD`）
- 容器按 compose label（`com.docker.compose.service=redis/admin-api/executor-node`）自动发现，非标命名用 `CHAOS_*_CONTAINER` 环境变量覆盖

### 运行方式

```bash
bash scripts/chaos-drill.sh --scenario A            # 单场景
bash scripts/chaos-drill.sh --scenario a,b          # 逗号组合
bash scripts/chaos-drill.sh --scenario all          # 默认：全部场景
bash scripts/chaos-drill.sh --scenario B --with-task          # B 场景恢复后加派发验证
bash scripts/chaos-drill.sh --scenario B --pause-seconds 30   # B 短断网变体
```

- 每场景独立日志写入 `mktemp -d` 目录（`CHAOS_LOG_ROOT` 可改根），结束时打印路径
- **Ctrl-C / 退出即恢复**：trap 只做逆操作（unpause/start 还原容器状态），绝不 `rm` 用户容器
- 常用环境变量：`CHAOS_API_URL`（默认 `http://localhost:3105`）、`CHAOS_USERNAME/PASSWORD`、`CHAOS_PAUSE_SECONDS`（默认 150）、`CHAOS_OFFLINE_THRESHOLD_SEC`（默认 90）、`CHAOS_HTTP_TIMEOUT`（默认 10）；完整清单见脚本头注释
- 无 docker 环境的验收路径：`bash scripts/chaos-drill.selftest.sh`（bash -n 语法 + 33 例纯函数自检，覆盖场景名解析 / 断言窗口计算 / 日志路径生成 / JSON 取值助手）

### 四场景说明

| 场景 | 注入 | 核心断言 | 恢复 / 二次断言 |
|------|------|----------|------------------|
| A Redis 宕机 | `docker stop redis` | 观察窗（默认 30s）内 `/api/health` 存活；admin 日志出现 `Redis connection error`（锁客户端感知故障） | `docker start redis` + `redis-cli PONG`；`/api/health/metrics` 的 `queueSize` 恢复可读且 `/api/health/services` 的 queue 组件回 healthy（BullMQ 重连，队列深度 series 回归） |
| B 执行器断网 | `docker pause executor-node`（默认 150s） | 预算窗 = 阈值 90s + 扫描 30s + 缓冲 30s 内 `onlineExecutors` 下降（`markStaleOffline` 每 30s cron，阈值 = `EXECUTOR_HEARTBEAT_INTERVAL` 30s × `EXECUTOR_HEARTBEAT_TIMEOUT_MULTIPLIER` 3 = 90s） | `docker unpause`；默认 90s 内 `onlineExecutors` 回归基线；`--with-task` 再创建/触发任务并等终态 success |
| C admin 双实例滚动重启 | 逐个 `docker restart` 两 admin 容器 | 全程轮询双地址，任一时刻至少一个 `/api/health` 200（容忍 1 次瞬时抖动）；锁在 Redis（`EXISTS lock:scheduler:leader`）前提下，全程日志必现 `leadership acquired`（接管窗 = 锁 TTL 30s + 竞选重试 15s + 缓冲 15s = 60s） | 双实例同时恢复 200 |
| D PG 主从切换 | ——（跳过） | 本机 compose 仅单主 postgres，无从库可注入；脚本保留 TODO 骨架（pg_promote 提升 / 复制流断言 / pg_rewind rejoin），需真机拓扑后补齐 | —— |

注意：**30s 短断网不会触发判离线**（阈值 90s），这是实现语义而非缺陷；
`--pause-seconds 30` 会走反向断言「短断网不误判离线」。

### 已知边界（需真机确认的断言）

- **A 的 fail-open 降级日志**：`degrading to leader` 仅当注入前该实例非 Leader 才出现；已持锁实例的 fail-open 语义是保持 `isLeader=true` 继续调度，不打新日志。脚本把它作为 best-effort 观测落日志，硬断言落在 `/api/health` 存活与队列深度回归上。停机期 `/api/health` 单次响应可能被 BullMQ 重连拖慢（无 commandTimeout），脚本在观察窗内取到一次 200 即判存活
- **C 的双实例拓扑**：compose 里 admin-api 固定映射 `3105:3105`，`--scale admin-api=2` 会端口冲突，需手工起第二实例（同 env、`-p 3106:3105`、加入同一 autoflow internal/public 网络）后用 `CHAOS_ADMIN2_CONTAINER` 指定；接管日志断言的前提是锁确实在 Redis——若两实例都处于 fail-open 降级（锁不在 Redis），该断言自动降级为观测项
- **D 完全依赖真机**：需真实 PG 主从拓扑，脚本只保留骨架与窗口建议（只读窗口 ≤60s、写恢复 ≤120s，受 TypeORM 重连退避影响）
- 开发环境（本机无 docker）无法真跑注入：以上断言设计均已对实现核实，但「真跑通过」需在 docker 环境执行一次确认

---

## 故障排查

### 任务一直处于 `pending` 状态

```bash
# 1. 检查执行器是否在线
curl http://localhost:3105/api/executors

# 2. 检查 Redis 队列
docker compose exec redis redis-cli llen bull:tasks:wait

# 3. 查看 BullMQ 队列状态
docker compose exec admin-api npm run queue:status

# 4. 检查 admin-api 日志中的调度错误
docker compose logs --tail=50 admin-api | grep ERROR
```

常见根因：
- 执行器全部下线或未注册（检查 `EXECUTOR_SECRET` 配置是否一致）
- 执行器类型不匹配（任务指定了 `node` 但只有 `python` 执行器在线）
- Redis 连接中断导致队列不消费（重启 redis 和 admin-api）

### 任务执行失败，报 `timeout`

1. 检查任务脚本是否有死循环或长时间等待
2. 在任务设置中调大 **超时时间**（默认 60 秒）
3. 检查执行器机器的网络连通性

```bash
# 查看执行器资源占用
docker stats executor-node
```

### 数据库连接失败

```bash
# 检查 PostgreSQL 是否正常运行
docker compose ps postgres

# 测试连接
docker compose exec postgres pg_isready -U autoflow

# 查看 PostgreSQL 日志
docker compose logs postgres
```

### Redis 连接失败

```bash
# 检查 Redis 是否正常
docker compose exec redis redis-cli ping
# 应返回 PONG

# 查看内存使用
docker compose exec redis redis-cli info memory
```

### 上传大包报 413 或 /api 请求 404

Admin Web 内置 Nginx 的 `/api/` 前缀 location 承担所有 API 代理：`proxy_pass` 不带 URI，原样保留 `/api` 前缀（与 admin-api 的全局前缀 `api` 对齐），若手工调整配置误加尾斜杠会剥离前缀，导致所有接口 404。`client_max_body_size 510m` 是为上传体积预留的（执行器包最大 500MB、应用包 200MB、PyPI 代理包 50MB，nginx 默认仅 1m），收到 413 时先确认该指令未被移除或被其他 location 覆盖。

### 执行日志实时流中断

执行日志 SSE 流（`/api/tasks/<id>/executions/<execId>/logs/stream`）使用专有正则 location 代理（`proxy_read_timeout 1h`、`proxy_buffering off`），与通用 `/api/` 的 60s 读超时隔离。若实时日志在固定时间点断开，检查两份 nginx 配置（`apps/admin-web/nginx.conf` 与 `infra/nginx/default.conf`）中该 location 是否存在且 `proxy_read_timeout` 未被调小；应用侧另有 15s `": ping"` 保活帧兜底，勿在其之前叠加会缓存响应的代理层。

### 磁盘空间告警

```bash
# 查看磁盘使用
df -h

# 清理 Docker 不再使用的镜像、容器、卷
docker system prune -f

# 清理旧的执行日志（超过 90 天）
find ./data/executor-logs -name '*.log' -mtime +90 -delete
```

---

## 监控与告警

### Prometheus 指标

指标端点：`http://localhost:3105/metrics`

关键指标：

| 指标名 | 说明 |
|--------|------|
| `autoflow_task_executions_total` | 任务执行总次数（按状态分类） |
| `autoflow_task_execution_duration_seconds` | 任务执行耗时分布 |
| `autoflow_executor_online_count` | 在线执行器数量 |
| `autoflow_queue_waiting_count` | 等待执行的任务数 |
| `process_resident_memory_bytes` | API 进程内存占用 |

### 接入 Grafana（示例）

```yaml
# 在 docker-compose.yml 中添加 Grafana
services:
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana
```

然后在 Grafana 中添加 Prometheus 数据源，地址填 `http://admin-api:3105/metrics`。

### 通知告警配置

在管理后台 **「设置 → 通知配置」** 中配置：

- **企业微信**：填写群机器人 Webhook URL
- **钉钉**：填写钉钉机器人 Webhook + Secret
- **Slack**：填写 Incoming Webhook URL
- **邮件**：配置 SMTP 服务器信息

任务执行失败时，系统会自动向已配置的渠道发送告警通知。

---

## 安全加固

### 生产环境必做事项

1. **修改所有默认密码**
   ```bash
   # .env 中必须修改
   JWT_SECRET=<32位以上随机字符串>
   JWT_REFRESH_SECRET=<32位以上随机字符串>
   DB_PASSWORD=<强密码>
   REDIS_PASSWORD=<强密码>
   EXECUTOR_SECRET=<32位以上随机字符串>
   INITIAL_ADMIN_PASSWORD=<强密码>
   ```

2. **不对公网暴露数据库和 Redis 端口**
   ```yaml
   # docker-compose.yml 中去掉 postgres 和 redis 的 ports 配置
   # 或限制绑定地址
   ports:
     - "127.0.0.1:5432:5432"  # 仅本机访问
   ```

3. **配置 HTTPS**
   - 在 Nginx 前置反向代理中配置 SSL 证书
   - 推荐使用 Let's Encrypt + Certbot

4. **定期轮换密钥**
   - JWT_SECRET 轮换后所有用户需重新登录
   - EXECUTOR_SECRET 轮换后所有执行器需重新注册

5. **限制执行器 API 访问**
   - 执行器通信走内网，不对外暴露
   - 设置防火墙规则，只允许 admin-api 访问执行器端口
   - Compose 中两个执行器宿主端口仅回环绑定（`127.0.0.1:8001` / `127.0.0.1:8002`）且 `REQUIRE_TOKEN=true`：宿主机之外的访问被端口绑定挡住，绕过 admin-api 直连执行器接口还需携带与 `EXECUTOR_SECRET` 一致的共享 token；若用 override 改绑到非回环地址，务必确认 token 校验仍开启

6. **回调签名密钥（可选加固）**
   - 设置 `EXECUTION_CALLBACK_SECRET`（≥16 字符，admin-api 与两侧执行器同源）为执行回调启用独立 HMAC 密钥，替代缺省回落到 `EXECUTOR_SECRET` 的行为

7. **压测/巡检限流参数**
   - 使用 `scripts/load-test.mjs` 做压测前，建议临时调高 admin-api 的 `THROTTLE_LIMIT`（如 600）并重启服务，避免 429 退避主导吞吐数字；用法见 `scripts/load-test.README.md`

### 审计防篡改（SEC-10）

审计表 `audit_logs` 为 **append-only**：迁移 `1790000000006` 在 DB 层安装了行级触发器 `trg_audit_logs_append_only`（BEFORE UPDATE OR DELETE → RAISE EXCEPTION），任何 UPDATE/DELETE 都会被拒绝。

- **唯一放行点**：审计保留清理任务（Q7，每日 02:05，清理 180 天前数据）在事务内以 `SET LOCAL app.bypass_audit_guard = 'on'` 放行批量 DELETE，事务提交即失效。应用代码中不存在其他写/删审计行的路径。
- **验证工具**：`node scripts/audit-verify.mjs`（在仓库根或 apps/admin-api 下运行）连库输出验证报告：触发器安装与启用检查、受控 UPDATE/DELETE 写试（ROLLBACK 事务内，不产生持久改动）、行序一致性（id 序 vs createdAt 序）与 7 天窗口行数密度。`--report-only` 跳过写试；退出码非 0 = 发现可篡改面或结构缺失。纯函数自检：`node scripts/audit-verify.selftest.mjs`。
- **限流分域（SEC-09）关联**：`THROTTLE_ENABLED=false` 可全局旁路限流（排障逃生门）；auth 敏写面（refresh/totp*）默认 10 次/分钟/IP、触发/部署干预写面默认 30 次/分钟/IP，SSE 长连接豁免——见 `apps/admin-api/.env.example` 与 `src/config/throttle-profiles.ts` 的分域矩阵。

---

## 数据库维护

### 手动执行迁移

```bash
# 查看迁移状态
docker compose exec admin-api npm run migration:show

# 执行待处理的迁移
docker compose exec admin-api npm run migration:run

# 回滚最后一次迁移（谨慎操作）
docker compose exec admin-api npm run migration:revert
```

### 清理历史执行记录（按需）

```sql
-- 连接到数据库
docker compose exec postgres psql -U autoflow autoflow

-- 删除 90 天前的执行记录（先确认数量）
SELECT COUNT(*) FROM task_executions
WHERE created_at < NOW() - INTERVAL '90 days';

-- 确认后删除
DELETE FROM task_executions
WHERE created_at < NOW() - INTERVAL '90 days';

-- 同步清理关联的日志行
DELETE FROM execution_log_lines
WHERE execution_id NOT IN (SELECT id FROM task_executions);
```

### 执行日志分区表运维（ARCH-22）

`execution_log_lines` 自迁移 `1789900000002-PartitionExecutionLogLines` 起为 **PARTITION BY RANGE (createdAt)** 的按日分区表（UTC 日历日切分，主键为联合主键 `(id, createdAt)`——PG 分区表要求唯一约束必须包含分区键）。保留期清理由每日 03:30 cron（`LogRetentionCleanupService`）执行：

- **分区库主路径**：超期分区（上界 ≤ 保留期截止时刻）整体 `DETACH PARTITION` 后立即 `DROP`——元数据级操作，替代逐行 DELETE，大表清理不再产生 VACUUM 压力（这是 10× 时长改善的来源）；同一 cron 内预建未来 7 天分区（`CREATE TABLE IF NOT EXISTS ... PARTITION OF`，幂等）。
- **fallback 路径**：`LOG_PARTITION_ENABLED=false` 或库仍为普通表（未跑迁移）时，回退为分批 DELETE（每批 5000 行）。开关只影响运行期清理路径，**不改 schema**——重新开启无需再跑迁移。
- **S3 驱动**：`LOG_STORAGE_DRIVER=s3` 上传成功时 DB 不写日志行，分区表常空；完整日志的到期清理仍由上文「S3/MinIO 日志对象生命周期」的 bucket lifecycle 负责。

#### 确认分区状态

```sql
-- 父表是否分区化（relkind 应为 'p'）
SELECT c.relname, c.relkind FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema() AND c.relname = 'execution_log_lines';

-- 现有分区及行数估算
SELECT c.relname AS partition,
       pg_get_expr(c.relpartbound, c.oid) AS bound,
       c.reltuples::bigint AS approx_rows
FROM pg_class c
JOIN pg_inherits i ON i.inhrelid = c.oid
WHERE i.inhparent = 'execution_log_lines'::regclass
ORDER BY c.relname;
```

#### 存量库升级演练（迁移上线前的维护窗口执行）

1. **演练前**：对 `execution_log_lines` 行数与占用做基线（`SELECT COUNT(*), pg_size_pretty(pg_total_relation_size('execution_log_lines'))`；建议在行数 ≥ 100 万的真机库演练，充分暴露搬迁耗时）。
2. **执行**：`docker compose exec admin-api npm run migration:run`。存量库在线搬迁流程（迁移内自动完成，无需人工干预）：rename 原表为 `execution_log_lines_legacy`（瞬时元数据操作）→ 建分区父表（同列 + 联合 PK + 三个读取路径索引）→ `INSERT SELECT` 一次性搬迁存量数据 → 预建 today-1 ~ today+7 分区。
3. **中断可续跑**：搬迁是守卫式分步推进（按 relkind 判定状态），中断后重新 `migration:run` 自动从断点续走，`ON CONFLICT DO NOTHING` 保证不重复插。
4. **验证**：`migration:show` 显示迁移已应用；上方「确认分区状态」查询可见分区表 + 日分区；抽查若干 executionId 的日志读取（管理台执行详情页日志 Tab）与搬迁前一致；新写入的执行产生新日志行且落入当日分区。
5. **验收（10× 时长）**：搬迁完成次日观察 03:30 cron 日志——分区库路径单次清理为 2 条 DDL（毫秒级），对比 legacy DELETE 清理同量级行数（数百万行/数十批）的分钟级时长，差值即为验收依据；如需精确计时可在演练库手动构造 30 天前分区对比两种路径。

#### legacy 表人工清理（迁移完成并观察 ≥ 1 个保留期后）

迁移**不删除** `execution_log_lines_legacy`（保留为人工回退源）。确认新表运行正常（日志读写无异常、清理 cron 正常 DETACH）后，人工清理：

```sql
-- 1. 确认 legacy 无新增依赖：新表数据完整后 legacy 只是只读冗余
SELECT COUNT(*) FROM execution_log_lines_legacy;

-- 2. 一次性释放空间（大表建议分批或 maintenance window）
DROP TABLE execution_log_lines_legacy;
```

如需回滚分区化（罕见：如降级 PG 版本），`npm run migration:revert` 会把分区数据回流 legacy 普通表后再 DROP 分区父表；大表回流耗时长，务必在维护窗口执行。

#### 分区异常兜底

- **预建 job 停摆**（连续多日 cron 失败）：跨过预建窗口的日期没有分区，当日写入会显式报错（无 DEFAULT 分区，故意设计——隐蔽堆积比显式报错危险）。人工补建：

```sql
CREATE TABLE execution_log_lines_20260910
  PARTITION OF execution_log_lines
  FOR VALUES FROM ('2026-09-10 00:00:00') TO ('2026-09-11 00:00:00');
```

- **人工分区命名**：清理 job 按 `pg_get_expr(relpartbound)` 解析分区边界，不依赖命名；人工建的分区即使不符合 `execution_log_lines_YYYYMMDD` 命名规范也会被正常 DETACH（除非边界是不可解析的非常规表达式——那类分区会被跳过并在日志点名，绝不误删）。

---

## 升级注意事项

升级前请确保：

1. 做好数据库备份
2. 阅读 CHANGELOG 中的破坏性变更说明
3. 测试环境先验证
4. 在业务低峰期操作
5. 准备好回滚方案（保留旧镜像或快照）

## Operator 升级 Runbook（DOC-07）

面向运维操作者的标准升级流程。按顺序执行，每步有明确通过判据；
失败即停在当前步，按下文「回滚」一节处理，不要带病继续。

### 前置检查（升级前 1 天）

| # | 检查项 | 通过判据 |
|---|--------|----------|
| 1 | 阅读本版 CHANGELOG（根 `CHANGELOG.md`，release-please 生成） | 破坏性变更（Breaking/⚠️ 标注）逐条列出并确认影响面 |
| 2 | 破坏性变更涉及 env → 对照 `.env.example` 增量 | 新增 env 已登记 configuration.ts + Joi + `.env.example`（PR 模板纪律），生产 `.env` 已补齐 |
| 3 | 破坏性变更涉及迁移 → 在测试环境走完整升级 + 回滚一遍 | 迁移全绿 + 回滚可达 |
| 4 | 数据库备份（上文「备份 PostgreSQL 数据库」） | 备份文件存在且 `pg_restore --list` 可读 |
| 5 | 记录当前版本 | `docker compose images` + `git rev-parse HEAD` 留档 |
| 6 | 容量水位 | 上文「容量水位指标清单」各指标处于正常区间（磁盘余量 ≥30%） |

### 升级步骤（低峰期执行，预计 10~30 分钟）

```bash
# 0. 进入维护窗口前：暂停调度器入队（可选，长迁移时建议）
#    方式：管理台逐个暂停 cron 任务，或直接在低峰期硬切（BullMQ 在途任务重启后恢复）。

# 1. 拉取目标版本
git fetch && git checkout <target-tag>   # 或 git pull（develop 跟踪部署）

# 2. 构建并滚动重启（先 API/后执行器；执行器与 API 版本需同批升级）
docker compose pull
docker compose up -d --build admin-api admin-web
docker compose up -d --build executor-node executor-python

# 3. 数据库迁移（幂等；重复执行为 no-op）
docker compose exec admin-api npm run migration:run

# 4. 通过判据（逐条验证）
curl -fsS http://localhost:<api端口>/api/health   # 健康检查 200（另 /api/health/ready）
docker compose ps                                     # 各服务 Up
docker compose logs admin-api --since 5m | grep -iE "error|warn" || true   # 无新错误刷屏
```

升级后验证（业务面抽样）：

1. 管理台登录 → 任务列表加载 → 手动触发一个 ping 类任务 → 执行成功有日志。
2. 执行器心跳：执行器列表全部「在线」，最后一跳时间在一个心跳间隔内。
3. 若本版含部署/审批流（DEP-02~04）：创建一个测试部署，观察 rollout/审批行为符合预期。

### 回滚

```bash
# 1. 回到旧版本代码/镜像
git checkout <previous-tag>
docker compose up -d --build

# 2. 数据库回滚（仅当本版迁移有破坏性变更且旧代码不兼容新列时才需要；
#    迁移默认只增不改，旧代码通常兼容新 schema，优先跳过此步）
docker compose exec admin-api npm run migration:revert   # 单步回退，逐步执行

# 3. 最坏情况：从备份恢复（上文「恢复步骤骨架」）
```

回滚判据：健康检查 200 + 业务抽样（同升级后验证）通过。

### 已知升级坑（历轮沉淀）

- **迁移链断裂**：2026-09-05 真机曾抓到迁移链断档。防护=CI 月度演练
  （`migration:generate --check` 漂移检查 + revert/re-run 演练，QA-08），
  升级前若 `migration:run` 报「missing migration」先核对迁移目录完整性再操作。
- **迁移时间戳撞号**：多会话并行开发曾有两名并行任务同时抢一段号。防护=CI
  `check-migrations` job（ARCH-29）；升级遇到「重复迁移时间戳」报错说明部署的
  版本混入了撞号 commit，退回上一个 tag 并上报。
- **执行器与 admin-api 版本差**：回调 token/信封契约（第八/九轮）要求双端同批
  升级；旧执行器连新 API 会 401（token 机制不匹配），执行器会自动重新注册对齐
  （BUG-08/SEC-NEW-3 补注册链），但建议不要跨多个版本差升级。
- **`SEC_SECRETS_KEY` 首次配置**：配置后存量任务 secrets 在下次 update 时自然
  转密文（零破坏），无需停机迁移；但密钥一旦配置并加密落库，丢失即不可解密——
  升级前把该 key 纳入备份核对清单。
- **`.env` 增量**：升级后 `diff .env .env.example` 核对新增键；漏配会被 Joi
  启动校验拦截（启动失败报缺哪个键，按提示补齐重启即可）。


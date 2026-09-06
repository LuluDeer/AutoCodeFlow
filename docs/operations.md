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

---

## 升级注意事项

升级前请确保：

1. 做好数据库备份
2. 阅读 CHANGELOG 中的破坏性变更说明
3. 测试环境先验证
4. 在业务低峰期操作
5. 准备好回滚方案（保留旧镜像或快照）

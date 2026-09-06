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

# 部署与运维优化计划

**优先级**: 高  
**预计工作量**: 8-10 人天  
**目标**: 简化部署流程、提升系统稳定性、降低运维成本

> ## ⚠️ 实施前必读（2026-10-17 核验结论）
>
> 本计划编写时对现状有较多误判（例如以为没有多阶段构建、没有定时备份）。
> 核验后的事实：
>
> | 计划条目 | 真实状态 |
> |---|---|
> | §1.1-1.2 容器优化 | ✅ **早已实现**（多阶段 + 非 root + HEALTHCHECK + 优雅关闭） |
> | §1.3 Kubernetes | ⬜ 仓内零清单，需真实集群 |
> | §2.1 迁移自动化 | ✅ **早已实现**（CI 幂等性守卫 + 漂移检查 + revert 演练） |
> | §2.2 定时备份 | ✅ **早已实现**（compose `pg-backup` + crond） |
> | §2.3 备份恢复演练 | ✅ **本次新增**（`pg-restore.sh` + 77 例离线 selftest + CI） |
> | §3.1 AlertManager | ✅ **已完成（本轮）**：加签侧车 `scripts/alertmanager-hmac-proxy.mjs` 落地 + `alertmanager.yml` 默认 receiver 指向它（详见 PLAN-OBSERVABILITY「仍然待办」第 2 条的说明） |
> | §5.1-5.3 灾难恢复 | ⬜ replica 服务存在但无人使用；chaos 场景 D 是 skip 桩 |
> | §7.1 Trivy / §7.2 Vault | ⬜ 零匹配 |
>
> **最重要的一条**：本仓原本**只有备份、没有恢复**——dump 从未被证明可恢复。
> 本次已补齐，详见文末「实施路线图」的「本次新增」小节。

---

## 1. 容器化与编排优化

### 背景
审计发现 deploy.sh 有两个 P1 缺陷（已修复），但容器化还有改进空间。

### 优化方案

#### 1.1 多阶段构建优化（减小镜像体积）
```dockerfile
# apps/admin-api/Dockerfile
# 构建阶段
FROM node:24-alpine AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

# 生产阶段
FROM node:24-alpine
WORKDIR /app
# 只复制必要文件
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./

# 非 root 用户运行
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3105
CMD ["node", "dist/main"]
```

**收益**: 镜像体积从 ~800MB 降至 ~200MB

#### 1.2 健康检查与优雅关闭
```dockerfile
# Dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3105/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"
```

```typescript
// main.ts
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // 优雅关闭
  process.on('SIGTERM', async () => {
    logger.log('SIGTERM received, shutting down gracefully...');
    await app.close();
    process.exit(0);
  });
  
  await app.listen(3105);
}
```

#### 1.3 Kubernetes 部署清单
```yaml
# k8s/admin-api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admin-api
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: admin-api
  template:
    metadata:
      labels:
        app: admin-api
    spec:
      containers:
      - name: admin-api
        image: autocodeflow/admin-api:latest
        ports:
        - containerPort: 3105
        env:
        - name: NODE_ENV
          value: "production"
        - name: DB_HOST
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: host
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "768Mi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 3105
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3105
          initialDelaySeconds: 10
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: admin-api
spec:
  selector:
    app: admin-api
  ports:
  - protocol: TCP
    port: 3105
    targetPort: 3105
  type: ClusterIP
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: admin-api-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: admin-api
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

---

## 2. 数据库运维自动化

### 背景
当前迁移、备份都是手动操作。

### 优化方案

#### 2.1 迁移自动化（CI/CD 集成）
```yaml
# .github/workflows/deploy-production.yml
name: Deploy to Production

on:
  push:
    tags:
      - 'v*'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Run database migrations
        env:
          DB_HOST: ${{ secrets.PROD_DB_HOST }}
          DB_PASSWORD: ${{ secrets.PROD_DB_PASSWORD }}
        run: |
          cd apps/admin-api
          npm run migration:run
          
      - name: Deploy to production
        run: |
          ./scripts/deploy.sh --mode docker --env production
```

#### 2.2 定时备份（Kubernetes CronJob）
```yaml
# k8s/db-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-backup
spec:
  schedule: "0 2 * * *"  # 每天凌晨 2 点
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: postgres:15-alpine
            command:
            - /bin/sh
            - -c
            - |
              BACKUP_FILE="/backup/autocodeflow-$(date +%Y%m%d-%H%M%S).sql.gz"
              pg_dump -h $DB_HOST -U $DB_USER -d $DB_NAME | gzip > $BACKUP_FILE
              
              # 上传到 S3
              aws s3 cp $BACKUP_FILE s3://autocodeflow-backups/db/
              
              # 保留最近 30 天
              find /backup -name "*.sql.gz" -mtime +30 -delete
            env:
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: host
            volumeMounts:
            - name: backup
              mountPath: /backup
          volumes:
          - name: backup
            persistentVolumeClaim:
              claimName: db-backup-pvc
          restartPolicy: OnFailure
```

#### 2.3 备份恢复演练（自动化脚本）
```bash
# scripts/restore-backup.sh
#!/bin/bash

BACKUP_DATE=$1

if [ -z "$BACKUP_DATE" ]; then
  echo "用法: ./restore-backup.sh 20240101"
  exit 1
fi

# 下载备份
aws s3 cp s3://autocodeflow-backups/db/autocodeflow-$BACKUP_DATE*.sql.gz /tmp/

# 创建测试数据库
psql -h localhost -U postgres -c "DROP DATABASE IF EXISTS autocodeflow_restore_test"
psql -h localhost -U postgres -c "CREATE DATABASE autocodeflow_restore_test"

# 恢复
gunzip -c /tmp/autocodeflow-$BACKUP_DATE*.sql.gz | psql -h localhost -U postgres -d autocodeflow_restore_test

# 验证
ROW_COUNT=$(psql -h localhost -U postgres -d autocodeflow_restore_test -t -c "SELECT COUNT(*) FROM tasks")
echo "恢复完成，tasks 表共 $ROW_COUNT 行"
```

---

## 3. 监控告警自动化

### 背景
告警规则已有（PLAN-OBSERVABILITY.md），但需要自动化响应。

### 优化方案

#### 3.1 AlertManager 配置
```yaml
# prometheus/alertmanager.yml
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 12h
  receiver: 'default'
  routes:
  - match:
      severity: critical
    receiver: 'pagerduty'
  - match:
      severity: warning
    receiver: 'slack'

receivers:
- name: 'default'
  webhook_configs:
  - url: 'http://localhost:5001/webhook'

- name: 'slack'
  slack_configs:
  - api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
    channel: '#alerts'
    title: '{{ .GroupLabels.alertname }}'
    text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'

- name: 'pagerduty'
  pagerduty_configs:
  - service_key: 'YOUR_PAGERDUTY_KEY'
```

#### 3.2 自动修复脚本（Runbook Automation）
```typescript
// scripts/auto-remediation.ts
import { WebhookEvent } from './types';

const remediationActions: Record<string, () => Promise<void>> = {
  'DBPoolSaturated': async () => {
    // 自动扩容数据库连接池
    await updateEnvVar('DB_POOL_MAX', String(parseInt(getEnvVar('DB_POOL_MAX')) + 5));
    await restartService('admin-api');
  },
  
  'AllExecutorsOffline': async () => {
    // 尝试重启执行器
    const executors = await getOfflineExecutors();
    for (const executor of executors) {
      await restartExecutor(executor.address);
    }
  },
  
  'HighMemoryUsage': async () => {
    // 触发垃圾回收
    await httpPost('http://admin-api:3105/admin/gc');
  },
};

export async function handleAlert(event: WebhookEvent) {
  const alertName = event.groupLabels.alertname;
  const action = remediationActions[alertName];
  
  if (action) {
    logger.info(`Executing auto-remediation for ${alertName}`);
    try {
      await action();
      logger.info(`Auto-remediation succeeded for ${alertName}`);
    } catch (err) {
      logger.error(`Auto-remediation failed for ${alertName}: ${err}`);
      // 失败时升级告警
      await escalateAlert(alertName);
    }
  }
}
```

---

## 4. 蓝绿部署 / 金丝雀发布

### 背景
当前部署直接替换，风险较高。

### 优化方案

#### 4.1 蓝绿部署（Kubernetes）
```yaml
# k8s/admin-api-blue-green.yaml
# Blue 版本
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admin-api-blue
spec:
  replicas: 3
  selector:
    matchLabels:
      app: admin-api
      version: blue
  template:
    metadata:
      labels:
        app: admin-api
        version: blue
    spec:
      containers:
      - name: admin-api
        image: autocodeflow/admin-api:v1.10.0
---
# Green 版本
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admin-api-green
spec:
  replicas: 3
  selector:
    matchLabels:
      app: admin-api
      version: green
  template:
    metadata:
      labels:
        app: admin-api
        version: green
    spec:
      containers:
      - name: admin-api
        image: autocodeflow/admin-api:v1.11.0
---
# Service（通过 selector 切换流量）
apiVersion: v1
kind: Service
metadata:
  name: admin-api
spec:
  selector:
    app: admin-api
    version: blue  # 修改为 green 切换流量
  ports:
  - port: 3105
```

#### 4.2 金丝雀发布（Istio）
```yaml
# k8s/istio-canary.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: admin-api
spec:
  hosts:
  - admin-api
  http:
  - match:
    - headers:
        x-canary:
          exact: "true"
    route:
    - destination:
        host: admin-api
        subset: v2
  - route:
    - destination:
        host: admin-api
        subset: v1
      weight: 90
    - destination:
        host: admin-api
        subset: v2
      weight: 10  # 10% 流量到新版本
```

---

## 5. 灾难恢复（DR）

### 背景
缺少灾难恢复计划。

### 优化方案

#### 5.1 多区域部署
```yaml
# k8s/multi-region.yaml
# 主区域
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admin-api-us-west
  namespace: us-west
spec:
  replicas: 3
---
# 备用区域
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admin-api-us-east
  namespace: us-east
spec:
  replicas: 1  # 平时保持最小副本
---
# 全局负载均衡
apiVersion: networking.gke.io/v1
kind: MultiClusterService
metadata:
  name: admin-api-global
spec:
  clusters:
  - link: us-west/admin-api
  - link: us-east/admin-api
```

#### 5.2 数据库主从复制
```yaml
# k8s/postgres-replication.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-cluster
spec:
  instances: 3
  primaryUpdateStrategy: unsupervised
  
  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "256MB"
  
  backup:
    barmanObjectStore:
      destinationPath: s3://autocodeflow-backups/pg/
      s3Credentials:
        accessKeyId:
          name: s3-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: s3-credentials
          key: SECRET_ACCESS_KEY
      wal:
        compression: gzip
    retentionPolicy: "30d"
```

#### 5.3 灾难恢复演练脚本
```bash
# scripts/dr-drill.sh
#!/bin/bash

echo "🔴 模拟主区域故障..."

# 1. 关闭主区域
kubectl scale deployment admin-api-us-west --replicas=0 -n us-west

# 2. 扩容备用区域
kubectl scale deployment admin-api-us-east --replicas=3 -n us-east

# 3. 切换数据库主从
kubectl exec -n us-east postgres-0 -- pg_ctl promote

# 4. 验证服务可用性
for i in {1..10}; do
  if curl -sf https://api.autocodeflow.com/health; then
    echo "✅ 服务恢复正常"
    break
  fi
  sleep 5
done

# 5. 记录 RTO（恢复时间目标）
echo "RTO: $SECONDS 秒"
```

---

## 6. 成本优化

### 背景
云资源利用率不高，成本可优化。

### 优化方案

#### 6.1 资源请求/限制调优
```yaml
# 基于实际监控数据调整
resources:
  requests:
    memory: "384Mi"  # P50 使用量 + 20% buffer
    cpu: "300m"      # P50 使用量 + 20% buffer
  limits:
    memory: "512Mi"  # P99 使用量 + 20% buffer
    cpu: "800m"      # P99 使用量 + 50% burst
```

#### 6.2 Spot 实例（非关键工作负载）
```yaml
# k8s/executor-node-spot.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: executor-node
spec:
  template:
    spec:
      nodeSelector:
        node.kubernetes.io/instance-type: spot
      tolerations:
      - key: spot
        operator: Equal
        value: "true"
        effect: NoSchedule
```

**收益**: Spot 实例成本降低 60-70%

#### 6.3 自动扩缩容策略
```yaml
# k8s/keda-scaler.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: admin-api-scaler
spec:
  scaleTargetRef:
    name: admin-api
  minReplicaCount: 2
  maxReplicaCount: 10
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus:9090
      metricName: http_requests_per_second
      threshold: '100'
      query: sum(rate(http_requests_total[1m]))
  - type: cpu
    metadata:
      type: Utilization
      value: "70"
```

---

## 7. 合规与安全

### 背景
缺少安全扫描和合规检查。

### 优化方案

#### 7.1 镜像安全扫描
```yaml
# .github/workflows/security-scan.yml
name: Security Scan

on: [push, pull_request]

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Build image
        run: docker build -t test-image .
      
      - name: Scan with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: test-image
          format: 'sarif'
          output: 'trivy-results.sarif'
      
      - name: Upload to GitHub Security
        uses: github/codeql-action/upload-sarif@v2
        with:
          sarif_file: 'trivy-results.sarif'
```

#### 7.2 Secret 管理（Vault）
```yaml
# k8s/vault-injector.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admin-api
spec:
  template:
    metadata:
      annotations:
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "admin-api"
        vault.hashicorp.com/agent-inject-secret-database: "secret/data/database"
        vault.hashicorp.com/agent-inject-template-database: |
          {{ with secret "secret/data/database" -}}
          export DB_PASSWORD="{{ .Data.data.password }}"
          {{- end }}
```

---

## 实施路线图（2026-10-17 核验后重排）

### ✅ 已完成
- [x] **1.1-1.2 容器优化**——**早已实现**。admin-api 是多阶段构建
      （`node:24-alpine` builder → runtime，`npm ci --omit=dev`，`USER appuser`
      非 root，`HEALTHCHECK` 打 `/api/health/live`）。5 个 Dockerfile 全部存在，
      10 个服务有 healthcheck，优雅关闭（`enableShutdownHooks` + 10s 硬超时）已就位。
- [x] **2.1 迁移自动化**——**早已实现**。CI `admin-api-migrations` job 跑空库全链 +
      **幂等性守卫**（第二次必须是 no-op）+ schedule 轮跑 entity↔migration 漂移检查
      与 `migrate:revert` 演练；`check-migrations.mjs` 强制时间戳全局唯一且登记。
- [x] **2.2 定时备份**——**早已实现**。`pg-backup.sh`（`pg_dump|gzip`，**拒绝 <256
      字节的可疑 dump**，按 `BACKUP_RETENTION_DAYS` 清理）+ `pg-backup-entrypoint.sh`
      （写 crontab 后 `exec crond`），已接线为 compose `pg-backup` 服务（profile
      `backup`），`deploy.sh` 在迁移前也会调用它。
- [x] **2.3 备份恢复演练**——**本次新增**（见下）。

### 🆕 本次新增：备份可恢复性演练

此前仓里只有**备份**脚本，**没有任何恢复脚本**——dump 从未被证明可恢复，也没有
任何 CI 校验。本次补齐：

- `scripts/pg-restore.sh`——**默认恢复到一次性 scratch 库**
  （`restore_drill_<stamp>`），恢复进生产库必须显式 `--force-overwrite-production`
  且目标等于 `$PGDATABASE` 时**在任何 DB 连接之前**就拒绝。
- 归档闸门严格有序：`<256` 字节 → `gzip -t` → `pg_dump` TOC 令牌 → 才
  `createdb`/`psql`。加载用 `-v ON_ERROR_STOP=1 --single-transaction`，
  半截失败整体回滚；EXIT trap 清理 scratch 库。
- 表名**对着迁移核实过**（不是猜的）：交叉检查了 `apps/admin-api/src/migrations/`
  里所有 `DROP TABLE`/`RENAME`，确认 InitialSchema 的表仍然存活。非空断言只用在
  `task_templates` / `projects` / `migrations`（前两者有 `ON CONFLICT DO NOTHING`
  种子，非空由「迁移跑过」推出），`users`/`tasks` 只断言存在——空表是合法状态。
- `scripts/pg-restore.selftest.sh`——77 条断言，**纯离线**：用 PATH shim 桩掉
  `psql`/`createdb`/`dropdb`/`gzip` 并记录调用日志，`PGHOST=stub.invalid`，
  所以「有没有碰过数据库」是**观察到的行为**而不是读源码猜的。
  已做变异测试：删掉两个生产库闸门 → 70 通过 / 7 失败，
  `✘ 目标库 == PGDATABASE 且无 --force 竟被接受（会覆盖生产！）` 如期触发。
- CI 接线：`npm run test:pg-restore` 已进 `selftests` job。

### ⬜ 仍然待办
1. **1.3 Kubernetes / Helm**——仓内零清单（无 `Chart.yaml`/`kustomization.yaml`）。
   需要真实集群才能验证，不宜盲写。
2. ~~**3.1 AlertManager 真实接收端**~~ ✅ **已完成（本轮）**：原来是
   `receiver: 'noop'` + 被 `/api/alerts/webhook` 的 HMAC 要求阻塞。现落地
   零依赖加签侧车 `scripts/alertmanager-hmac-proxy.mjs`（`node:24-alpine` 只读
   挂载，仅 `autoflow-internal` 可达，不映射宿主端口），`alertmanager.yml`
   默认路由指向它。未配置 `ALERT_WEBHOOK_SECRET` 时侧车 fail-closed 退出
   （`restart: 'no'`，不重启刷屏），失败可见。自检 `npm run test:alert-proxy`
   已进 CI；金向量与 admin-api 校验侧双向钉死。
3. **7.1 镜像扫描（Trivy）**——零匹配。现有 `secret-scan` / `npm-audit` /
   `pip-audit` / `lockfile-integrity` 覆盖的是依赖面，不是容器 CVE。
4. **7.2 Vault**——零匹配；当前是 `.env` + compose `${VAR:?}` fail-fast。
5. **4.1-4.2 蓝绿/金丝雀**——`docker-compose.ha.yml` 是 2 副本 + nginx，
   不是流量切分；`deploy.sh` 有 rollback manifest 但无 canary。
6. **5.1-5.3 灾难恢复**——`postgres-replica` 服务存在（profile `replica`）但
   没有任何脚本或演练使用它；`chaos-drill.sh` 的场景 D 是**刻意 skip 的桩**。
7. **6.2-6.3 成本优化 / 自动扩缩容**——无 `deploy.resources` 块，无 HPA/KEDA。
8. **备份未离机**——`backup_data` 是本地 docker volume，宿主丢失则库与备份同时丢失。

## 依赖项（核验后）

- **已用**：Docker Compose（20 服务 / 5 profiles）、Prometheus + Grafana +
  Alertmanager + Loki + Promtail、postgres/redis exporter、nginx。
- **计划中提到但仓内不存在**：Kubernetes、Helm、Istio、KEDA、Trivy、Vault。
  这些都需要外部基础设施，属于「有环境才能落地」的类别，不建议盲写清单。

## 运维指标

| 指标 | 当前 | 目标 |
|---|---|---|
| MTTR（平均恢复时间） | ~30min | < 15min |
| RTO（恢复时间目标） | ~1h | < 30min |
| RPO（恢复点目标） | ~24h | < 1h |
| 部署频率 | 每周 | 每天 |
| 变更失败率 | ~10% | < 5% |
| 可用性 | 99.5% | 99.9% |

> 这些是**目标值**，需真机基线才能填「当前」。本次工作把其中两项从「不可测」
> 变成「可测」：备份可恢复性有了自动化演练，执行器全离线有了告警。

## 验收标准

- [x] 所有部署脚本有回滚机制——`deploy.sh` 有 `.deploy-manifest.json` 回滚，
      `deploy.selftest.sh` 50 例覆盖（含 P1-6 退出码传播、P1-7 mode 恢复）
- [x] 备份可在 30 分钟内恢复——**本次新增可验证路径**（`pg-restore.sh` +
      77 例离线演练）；真机 RTO 仍需实测
- [ ] 告警 95% 可自动修复——未实现（无自动修复 Runbook）
- [ ] DR 演练每季度一次——`chaos-drill.sh` 有 A/B/C 三场景可跑，
      **D（PG 主备切换）是 skip 桩**
- [ ] 成本优化 20% 以上——未实施

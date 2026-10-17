# 部署与运维优化计划

**优先级**: 高  
**预计工作量**: 8-10 人天  
**目标**: 简化部署流程、提升系统稳定性、降低运维成本

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

## 实施路线图

### 阶段 1（本月）
- [ ] 1.1-1.2 容器优化
- [ ] 2.1 迁移自动化
- [ ] 6.1 资源调优

### 阶段 2（下月）
- [ ] 1.3 Kubernetes 部署
- [ ] 2.2 定时备份
- [ ] 3.1 AlertManager 配置
- [ ] 7.1 镜像扫描

### 阶段 3（下季度）
- [ ] 2.3 备份恢复演练
- [ ] 3.2 自动修复
- [ ] 4.1-4.2 蓝绿/金丝雀
- [ ] 5.1-5.3 灾难恢复
- [ ] 6.2-6.3 成本优化
- [ ] 7.2 Secret 管理

## 依赖项

- Kubernetes: 容器编排
- Helm: 包管理
- Istio: 服务网格（金丝雀）
- KEDA: 事件驱动扩缩容
- Trivy: 镜像扫描
- Vault: Secret 管理

## 运维指标

| 指标 | 当前 | 目标 |
|---|---|---|
| MTTR（平均恢复时间） | ~30min | < 15min |
| RTO（恢复时间目标） | ~1h | < 30min |
| RPO（恢复点目标） | ~24h | < 1h |
| 部署频率 | 每周 | 每天 |
| 变更失败率 | ~10% | < 5% |
| 可用性 | 99.5% | 99.9% |

## 验收标准

- [ ] 所有部署脚本有回滚机制
- [ ] 备份可在 30 分钟内恢复
- [ ] 告警 95% 可自动修复
- [ ] DR 演练每季度一次
- [ ] 成本优化 20% 以上

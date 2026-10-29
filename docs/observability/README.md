# AutoCodeFlow 观测性（第十轮）

admin-api 的 Prometheus 指标（`GET /api/metrics`）配套的 Grafana 面板、告警规则与抓取配置。

| 文件 | 内容 |
| --- | --- |
| `grafana-dashboard.json` | Grafana dashboard（schemaVersion 39，uid `autoflow-obs-v1`）：调度健康 / 回调认证 / 进程资源 / 容量水位（OBS-05）/ 调度延迟（CORE-06） 五组共 17 个数据面板；compose monitoring profile 已自动 provisioning（§2），面板 PromQL 受 `npm run test:alerts` 同源守卫 |
| `alerting-rules.yml` | 阅读版 Prometheus rule 文件（6 条启用告警 + 1 条注释预留 ExecutorOffline）：教学/调优思路载体，生效规则以 `config/monitoring/alerts.yml` 为准；受 `test:alerts` 三层对账（存在性 + 指标名 + 语义级：for/severity/expr 空白归一与接线版同名规则逐字一致，2026-10-07 升级） |
| `README.md` | 本文件：抓取配置、导入/挂载步骤、指标字典、series 核对清单 |

指标事实来源（唯一注册处）：
`apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts`（独立 Registry，
`collectDefaultMetrics` + 业务 series，逐字清单见第 4 节指标字典与附录 A）；
SSE 两个 runtime gauge 的声明在同目录 `runtime-metrics.ts`（RUNTIME_GAUGES）。
端点定义在
`apps/admin-api/src/modules/metrics/metrics.controller.ts`（类级 `JwtAuthGuard`，
全局前缀 `api` → 实际路径 `/api/metrics`，默认端口 `PORT=3105`）。

---

## 1. Prometheus 抓取配置

### 1.1 坑：/api/metrics 需要 Bearer JWT

`MetricsController` 类级挂 `JwtAuthGuard`，抓取端点**不是**免认证的：Prometheus
必须带 `Authorization: Bearer <JWT>`。而 access token 默认 TTL 仅
`JWT_EXPIRES_IN=15m`（`src/config/configuration.ts`），Prometheus 自身不会走
登录/刷新流程——**直接写死一个 token 的 scrape 配置会在 15 分钟后开始 401**。
另有两个相关开关：

- `METRICS_PROMETHEUS_ENABLED=false` → 端点返回 404（多实例去重/安全收紧场景）；
- `METRICS_PROMETHEUS_DEFAULT_METRICS_ENABLED=false` → 关闭进程默认指标（裁剪抓取体积）。

### 1.2 解法 A：反向代理注入静态 Bearer（推荐，改动最小）

Prometheus 抓 nginx（免认证、仅限内网），nginx 注入长期有效的 metrics 专用
token 后转发 admin-api：

```nginx
# nginx 片段：仅监听内网；token 由专用 metrics 用户签发（见 1.4）
server {
  listen 9105;                      # 内网 Prometheus 抓这个端口
  location = /api/metrics {
    proxy_set_header Authorization "Bearer $AUTOFLOW_METRICS_TOKEN";
    proxy_pass http://admin-api:3105;
  }
  location / { return 404; }        # 只放行 metrics 路径
}
```

token 仍会过期（JWT 无永不过期配置），用 systemd timer / cron 每 10 分钟重新
登录并 `nginx -s reload` 注入新值即可。Prometheus 侧：

```yaml
scrape_configs:
  - job_name: autoflow-admin-api
    metrics_path: /api/metrics
    scheme: http
    static_configs:
      - targets: ["metrics-proxy.internal:9105"]   # 无鉴权，代理已注入
```

### 1.3 解法 B：独立 metrics 用户 + credentials_file 自动刷新

给抓取方建一个低权限专用账号（仅可读 metrics），Prometheus 用
`authorization.credentials_file` 读 token 文件，sidecar 定期刷新文件并触发
Prometheus 重载（`credentials_file` 只在 config reload 时重读）：

```yaml
scrape_configs:
  - job_name: autoflow-admin-api
    metrics_path: /api/metrics
    scheme: http
    static_configs:
      - targets: ["admin-api:3105"]     # 默认 PORT=3105
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/autoflow-metrics-token
```

```bash
# sidecar（cron 每 10 分钟）：登录取新 token → 原子写文件 → 触发 reload
tok=$(curl -fsS -X POST http://admin-api:3105/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$METRICS_USER\",\"password\":\"$METRICS_PASS\"}" \
  | jq -r .data.accessToken)
printf '%s' "$tok" > /etc/prometheus/secrets/autoflow-metrics-token.tmp
mv /etc/prometheus/secrets/autoflow-metrics-token.tmp /etc/prometheus/secrets/autoflow-metrics-token
curl -fsS -X POST http://prometheus:9090/-/reload     # 需 --web.enable-lifecycle
```

> 多实例部署：每个实例暴露自己的进程内计数（per-target 抓取天然区分），
> `instance` label 由 Prometheus 注入；`job` 固定为 `autoflow-admin-api`
> （告警规则按此 job 聚合，改名需同步 `alerting-rules.yml`）。

## 2. Grafana dashboard 加载（自动 provisioning，审计批次 A 起）

**自动 provisioning 已启用，仓库 dashboard 变更随部署生效**：compose
monitoring profile 的 grafana 服务把 provider 声明
（`config/monitoring/grafana/provisioning/dashboards/dashboards.yml`）与本
目录 `grafana-dashboard.json` 原件分别挂载到容器
`/etc/grafana/provisioning/dashboards/`（JSON 放其 `autoflow/` 子目录，
provider 的 `options.path` 指向该子目录）。`docker compose --profile
monitoring up -d` 启动即注册，无需手工导入；容器重建时确定生效（git pull
换 inode 的 bind-mount 场景以重建为准），原地同 inode 编辑另有
`updateIntervalSeconds: 30` 轮询兜底。看板在 UI 上只读
（`allowUiUpdates: false`，文件即真相，防止容器卷内改动与仓库漂移）。

要求 Grafana ≥ 11（schemaVersion 39；Grafana 10.x 加载会提示版本较新，多数
面板仍可用）。

- uid 固定为 `autoflow-obs-v1`：provisioning 按 uid 同步，此前人工导入过的
  同 uid 看板会在首轮同步被仓库版本接管（原「重复导入覆盖」约定的延续；
  如需并存请先改 uid）。
- 手工导入（备用路径，仅用于不跑本仓 compose 的自带 Grafana）：Dashboards
  → **Import** → Upload JSON / 粘贴文件内容 → 在「数据源」下拉选择
  Prometheus 数据源 → Import。
- 顶部变量：`datasource`（数据源选择器）、`instance`（多选 + All，取自
  `label_values(autoflow_queue_up, instance)`，所有面板按其过滤）。
- 面板分组：
  1. **调度健康**：ticks rate；tick 耗时（如实标注——源码无 histogram，
     **p95 不可推导**，面板为窗口均值 `rate(duration_total)/rate(ticks_total)`
     + last tick gauge）；skipped by reason 堆叠；queue depth by state 堆叠；
     queue_up stat（1=绿 UP / 0=红 DOWN）。
  2. **回调认证**：auth rate by result 表格（instant）；七分类占比饼图
     （`increase(...[$__range])`）；非 ok 分类累计绝对值时序。
  3. **进程资源**：CPU（单核 %）、内存（RSS / V8 heap）、event loop lag。
  4. **容量水位（OBS-05）**：PG 连接池水位四 series（max/active/idle/waiting
     + 利用率 ratio stat，告警阈值 0.8）；executor 磁盘水位 per-executor
     （阈值 90%）；SSE 流水位（active/limit + 占用率 stat，阈值 0.8）。
  5. **调度延迟（CORE-06）**：P99 / 窗口均值时序
     （`histogram_quantile(0.99, sum by (le, instance) (rate(bucket[5m])))`，
     阈值 250ms 黄 / 1000ms 红；avg = `rate(sum)/rate(count)`）+ P99 区间
     累计瞬时值 stat。数据源 = `autoflow_scheduler_trigger_latency_ms_bucket`
     （直方图桶 10/50/100/250/500/1000/2500/5000ms，+Inf 收口）；仅
     fixed_rate/cron 触发计入。lastTriggerLatencyMs 未导出 prom series
     （附录 A 纪律：不确定的 series 不做面板），故不设「最近一次延迟」stat。

## 3. 告警规则挂载

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/rules/autoflow-alerting.yml   # 即本目录 alerting-rules.yml
```

规则清单（阈值调优思路见文件内注释）：

| alert | severity | 一句话 |
| --- | --- | --- |
| `AUTOFLOW_SCHEDULER_DOWN` | critical | `queue_up==0` 或 ticks rate 5m 为 0：调度停摆 |
| `AUTOFLOW_METRICS_TARGET_DOWN` | critical | `absent(autoflow_queue_up)`：抓取目标全失联（含 token 过期 401） |
| `AUTOFLOW_QUEUE_BACKLOG` | warning | `queue_depth{state="waiting"} > 100` 持续 10m：积压 |
| `AUTOFLOW_CALLBACK_AUTH_EXPIRED_ELEVATED` | warning | `v1_expired` 速率 > 0.05/s 持续 15m（宽松：可能是超时后迟到的合法回调） |
| `AUTOFLOW_CALLBACK_AUTH_SIGNATURE_CRITICAL` | critical | `v1_bad_signature\|legacy_shared_invalid` 速率 > 0.01/s 持续 5m（严格：应≈0，secret 漂移/伪造信号） |
| `AUTOFLOW_CALLBACK_AUTH_MISUSE` | warning | `v1_binding_mismatch\|missing_token\|bad_address` 合计 > 0.1/s（配置错误类） |
| `AUTOFLOW_EXECUTOR_OFFLINE` | —（注释预留） | admin-api **无**执行器在线 Prometheus series（状态在 DB `Executor.status/lastHeartbeat`，仅 JSON 端点暴露）；建议走现有 notification 渠道（`apps/admin-api/src/modules/notification`），待未来补 gauge 后启用 |

> **接线版告警规则（可观测性纵深轮）**：compose monitoring profile 实际挂载的规则文件是
> `config/monitoring/alerts.yml`（prometheus.yml `rule_files: /etc/prometheus/alerts.yml`，
> job 名 `admin-api`）——在上述 6 条的基础上扩展为 26 条业务级规则集（执行结果失败率/
> killed 风暴/通知投递/AI 分析连续失败/SSE 槽位/agent 预算与边界拦截/executor 磁盘水位/
> PG 连接池/Redis 内存 noeviction 防线/配置推送鉴权 + 本节回调认证三条的接线版）。
> 语义差异点：接线版 `AUTOFLOW_SCHEDULER_DOWN` 用 `sum(rate(...)) == 0` 对全体实例求和
> （tick 仅 leader 递增——本文件的单实例 `rate(...) == 0` 写法在多实例下会把 follower
> 误报成停摆）；两处规则语义冲突时以接线版为准。运维侧速查表与 runbook 见
> `docs/operations.md`「告警规则与 Runbook」；规则文件结构守卫：`npm run test:alerts`
> （`scripts/check-alerts-rules.mjs`，指标名必须存在于 metrics 源码声明清单）。
> 审计批次 A 起，同一守卫也扫 dashboard 面板/模板变量的 PromQL 指标名，并对本
> 文件做存在性与指标名对账（语义仍以接线版 alerts.yml 为准）。
> 第 4 轮审计 T1 起，同一守卫另做一层**expr 静态体检**（不引 PromQL 解析器）：
> 括号/引号配平与截断、恒真恒假（`0 == 0`、`vector(1) > 2`）、对 gauge 用
> rate/increase、`histogram_quantile` 输入缺 `*_bucket`、全式没有比较运算符——
> 这几种「永远不会响」的写法都会红并点名 `告警名:行号`；`for` 小于 2×抓取间隔
> 只 warn（短 `for` 合法，但通常意味着抖动告警）。

## 3.5 Alertmanager → 平台通知渠道路由（OBS-02，第十六轮）

第十六轮起，Alertmanager 的告警可以直接接入平台既有通知渠道（企业微信 /
钉钉 / Slack / 邮件），打通「Grafana 规则已有、告警通知与平台通知渠道割裂」
的缺口。

### 3.5.1 端点与鉴权

- `POST /api/alerts/webhook`（`@Public`，无 JWT；机器对机器调用）。
- HMAC-SHA256 签名，与发版 webhook（`POST /api/applications/webhook`）同一
  约定：header `X-AutoCodeFlow-Timestamp`（毫秒时间戳，±5 分钟窗）+
  `X-Hub-Signature-256: sha256=<hex>`，其中
  `<hex> = HMAC_SHA256(secret, "${timestamp}.${rawBody}")`。
- secret 走环境变量 `ALERT_WEBHOOK_SECRET`；**未配置时端点返回 503（安全
  缺省——绝不退化为无鉴权接收）**。鉴权失败统一 401，不区分具体原因。

### 3.5.2 Alertmanager 侧配置（v2，**已接线**）

Alertmanager 原生 `webhook_configs` **不支持自定义签名头**，故链路里必须有一个
加签转发件。该件已在仓库内落地为 **`scripts/alertmanager-hmac-proxy.mjs`**
（零依赖，只用 `node:http` / `node:crypto`；compose 内以 `node:24-alpine`
只读挂载运行，不映射宿主端口），`config/monitoring/alertmanager.yml` 的默认
`route.receiver` 已指向它。

启用只需两步（`ALERT_WEBHOOK_SECRET` 是**同一个** secret：侧车签、admin-api 验）：

```bash
# 1) .env：ALERT_WEBHOOK_SECRET=<随机串>
# 2) 拉起 monitoring profile
docker compose --profile monitoring up -d
```

```yaml
# config/monitoring/alertmanager.yml（节选，实际文件即如此）
route:
  receiver: 'hmac-proxy'
  group_by: [alertname]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
  - name: 'hmac-proxy'
    webhook_configs:
      - url: http://alertmanager-hmac-proxy:9099/
        send_resolved: true   # resolved 恢复通知也发（level=info）
        max_alerts: 0         # 不截断（侧车有 1 MiB 上限兜底）
  - name: 'noop'            # 兜底：只收集不推送时把 route.receiver 改成它
```

侧车的四条关键设计（改它之前先读 `scripts/alertmanager-hmac-proxy.mjs` 头部注释）：

1. **body 逐字节直通**，不做 `JSON.parse`→`JSON.stringify` 往返；
2. **时间戳用侧车本进程 `now()`**，接收侧窗口 ±5 分钟（跨机部署须 NTP 对齐）；
3. **上游状态码原样回传**——admin-api 在「一个渠道都没送到」时**刻意**返回 502，
   抹成 200 就等于让 Alertmanager 永不重试（告警被静默吞掉）；
4. **secret 缺失即拒绝启动**（exit 1），不降级为无鉴权转发。

> 自检：`npm run test:alert-proxy` —— 金向量（接收侧用 WebCrypto 独立复核）+
> 与 `webhook-hmac.util.ts` 的源码级契约对账 + 真实 HTTP 端到端（含上游 4xx/5xx
> 原样回传、不可达/超时 → 502、超限 → 413、secret 不外泄）+ fail-closed 退出码。
> 同一组金向量也钉在 `apps/admin-api/src/common/utils/__tests__/webhook-hmac.util.spec.ts`
> ——两侧各钉一次，单侧算法漂移必然让另一侧变红。

### 3.5.3 告警消息形态（含 runbook 链接）

映射为单条通知（多条告警合并，title = `[Alert] <alertname> <firing|resolved>`，
content = labels / annotations 摘要 + startsAt；任一 firing → level=error，
全部 resolved → level=info）：

- **annotations.runbook_url**：Grafana/Alertmanager 规则的 annotations 惯例
  字段，命中时消息追加 `Runbook: <url>` 段。接线版 `config/monitoring/alerts.yml`
  的 **31 条规则全部**写有绝对 URL 的 `runbook_url`（锚点见 §3.6）；本目录
  `alerting-rules.yml` 同时保留旧的相对路径 `runbook:` 与新的 `runbook_url:`
  ——映射层两个都认（`runbook_url` 优先，`runbook` 为回退），这是 OBS3-06 的
  兼容面。
- **labels.taskId**：告警 labels 带平台任务 ID 时，端点会查 `tasks.runbook`
  （FEAT-11 字段）并把内容拼接为 `Runbook:` 段——任务级排障知识随告警直达
  值班渠道。查询失败降级为无该段，不阻断外发。

### 3.5.4 验收路径（真机轮）

PG 宕机告警 5 分钟内到企业微信：Prometheus 抓 admin-api `GET /api/metrics`
（`AUTOFLOW_METRICS_TARGET_DOWN` / `AUTOFLOW_SCHEDULER_DOWN` 即覆盖 PG 不可
读场景）→ Alertmanager 触发 → **`alertmanager-hmac-proxy` 加签转发** →
`POST /api/alerts/webhook` → `notificationService.sendAll` 全渠道扇出
（企业微信渠道需已配置 `WECOM_WEBHOOK` 或管理台渠道配置）。

## 3.6 Runbook：逐条告警的锚点

本节是**告警消息里 runbook 链接的落点**（OBS3-06 收口）：`config/monitoring/alerts.yml`
的每条规则都带

```
annotations.runbook_url = https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/observability/README.md#<锚点>
```

锚点在下面各小节里逐条给出（一条告警一个，取告警名小写），由
`npm run test:alerts`（`scripts/check-alerts-rules.mjs`）机械校验：**必须是
http(s) 绝对 URL，且 `#锚点` 必须在本文件里真的存在**——所以「通道建好、数据
没填」（31 条规则 0 条 `runbook_url`）和「链接指向不存在的锚点」两种形态都会
变红，不会再有说明书式的「建议你加一行」。

> **改仓库地址 / 分支名 / 小节标题时要同步两处**：`config/monitoring/alerts.yml`
> 的 31 处 `runbook_url` 与本节的小节标题（标题即锚点）。守卫只校验「绝对
> URL + 锚点存在」，域名/分支对不对它看不出来。

下面每条只列**首响**要做的两三步；完整判据与长文排查以规则文件的
`description`、`docs/operations.md`「告警规则与 Runbook」表为准。

前三小节是 2026-10-17 优化计划轮新增的四条告警的详细处置（`http-red` 覆盖
5xx 与 P99 两条，故这两条规则的 `runbook_url` 都指向 `#http-red`）。

### http-red

**触发**：`AUTOFLOW_HTTP_5XX_RATE_HIGH` / `AUTOFLOW_HTTP_LATENCY_P99_HIGH`。

数据源是本轮新增的 RED 指标（`autoflow_http_requests_total` /
`autoflow_http_request_duration_ms_{bucket,sum,count}`，标签 `method` /
`route` / `status_class`）。`route` 是 **Express 路由模板**（`/tasks/:id`），
未匹配固定 `unmatched`。

排查顺序：

1. **先按 route 分组**看是单路由还是全局。Grafana「HTTP RED」行有分路由表格；
   单路由 → 查该 handler；多路由同时 5xx → 查存储层（伴生看
   `AUTOFLOW_DB_POOL_WAITING` / `AUTOFLOW_QUEUE_UNREADABLE`）。
2. `route="unmatched"` 的 5xx 来自**全局中间件/异常过滤器**而非具体处理器
   ——查 admin-api 日志的启动段与 `HttpExceptionFilter`。
3. **P99 被 SSE 带偏的情况不存在**：拦截器按 `isSsePath` + `text/event-stream`
   双判据跳过，长连接不入账。若 P99 突然飙到小时级，那是真异常，不是埋点问题。
4. 注意 `_bucket` 是**手写直方图**（三个 Counter + `doRender` 里 reset+inc
   重建），与 `autoflow_scheduler_trigger_latency_ms_*` 同一形态；桶上界见
   `HTTP_DURATION_BUCKETS_MS`。

### autoflow_all_executors_offline

**触发**：`sum(autoflow_executors_online) == 0 and sum(autoflow_executors_total) > 0`
持续 10 分钟。

`autoflow_executors_online` / `autoflow_executors_total` 是本轮新增的 Gauge，
数据源是 DB 的 `Executor.status` 计数。

**关键前提**：`renderExecutorFleetGauges` 在 **DB 查询失败时保留上一轮值**，
不会把 online 打成 0。因此若本条与 PG 告警同时出现，**先确认 DB 是否真的可查**
——PG 抖动本身不会触发本条。

`and sum(autoflow_executors_total) > 0` 是全新部署的守卫：一台执行器都没注册时
不告警。处置见 `docs/operations.md` 的执行器离线章节；速查：
`GET /api/metrics/executors` 看 `lastHeartbeat` 与 `offlineReason`
（`manual` = 被手动下线，`stale_timeout` = 心跳超时）。

### autoflow_sse_ticket_rejected

**触发**：`sum(increase(autoflow_sse_ticket_rejected_total{reason="wrong_path"}[15m])) > 0`。

**这是安全告警，正常恒为 0。** 合法前端只会在三条 `/stream` 路由的 `?ticket=`
上传票据（EventSource 无法设请求头），access 令牌走 `Authorization` 头、
不受影响。因此任何一次拒绝都意味着**票据已从 URL、浏览器历史或反代日志泄漏，
且有人正在尝试把它当全权令牌复用**。

处置：

1. 按 admin-api 日志定位该票据的 `sub`（用户）与来源 IP。
2. **立即 revoke 该用户全部会话并强制改密**
   （`POST /api/auth/sessions/revoke-others`）。
3. 检查反代 access log 是否记录了 `?ticket=`——应在 nginx 侧对该查询参数脱敏
   （票据 30 秒有效且路径受限，但日志里的票据在有效期内仍可用）。
4. 票据本身无 `jti` 黑名单（见 `issueSseTicket` 的残差注释），故**不能**
   单枚吊销，只能靠 30 秒 TTL 与用户级 revoke。

### 可达性与调度（`AUTOFLOW_*` 的 6 条）

#### instance_down

**触发**：`up == 0` 持续 5m（per-target）。

- `docker compose ps` 看目标容器是否存活；存活则查容器网络、端口与抓取配置
  （`prometheus.yml` 的 targets）。
- 容器在重启循环 → 直接看该服务日志的退出原因，别只盯告警。

#### autoflow_metrics_target_down

**触发**：`absent(autoflow_scheduler_ticks_total)` 持续 5m（整组 admin-api target 都没 series）。

- 进程挂死 → `docker compose ps` + admin-api 日志启动段。
- 端点被关 → 确认 `METRICS_PROMETHEUS_ENABLED` 未被设成 `false`。
- 抓取 401 → `/api/metrics` 需要 Bearer JWT，按 §1.1~§1.3 配反代注入或
  `credentials_file` 轮换。

#### autoflow_scheduler_down

**触发**：`sum(rate(autoflow_scheduler_ticks_total[10m])) == 0` 持续 5m（集群级）。

- tick 只有 leader 递增：先确认**有没有实例赢得 leader**（日志
  「Scheduler leadership acquired」），再看 Redis（leader 锁 `lock:scheduler:leader`）。
- 全体无样本（series 消失）不是本条，是 `AUTOFLOW_METRICS_TARGET_DOWN`。

#### autoflow_scheduler_slot_missed

**触发**：`increase(autoflow_scheduler_cron_slots_missed_total[10m]) > 0` 持续 1m。

- 该计数来自 node-cron 的 `execution:missed`：进程当时没能在计划时刻跑 tick。
- 常见原因：事件循环长阻塞（看 `autoflow_metrics_render_error_total` 与
  admin-api 的 event-loop 日志）、容器 CPU 被节流（`docker stats` throttling）、
  系统时钟跳变。
- **丢拍不会自动补发**：确认受影响的 cron 任务后手工补跑；连续出现时优先排查
  阻塞源，而不是调大 `for`。

#### autoflow_queue_unreadable

**触发**：`autoflow_queue_up == 0` 持续 5m。

- 先看 `redis_up`（redis-exporter）区分「Redis 挂了」还是「admin-api 连不上」。
- admin-api 侧核 `REDIS_HOST` / `REDIS_PASSWORD` 与 compose 是否同源。

#### autoflow_queue_backlog

**触发**：`autoflow_queue_depth{state="waiting"} > 100` 持续 10m。

- 对比 `active` 曲线：waiting 高 + active 低 = 消费端停摆（重启执行器）；
  waiting 高 + active 满 = 容量不足（扩容或错峰 cron）。
- 执行器在线情况看 `GET /api/metrics/executors`。

#### autoflow_scheduler_trigger_failures

**触发**：`increase(autoflow_scheduler_triggers_total{result="failed"}[15m]) > 0`。

- 触发领取依赖 PG（db claim 窗口）：查 admin-api 触发异常栈、PG 连通与连接池
  （伴生 `AUTOFLOW_DB_POOL_WAITING`）。
- 失败会在下个 tick 重试，处置完确认最终入队。

### 执行结果（`autoflow_execution_result_total` 的 3 条）

#### autoflow_execution_failure_rate_high

**触发**：`sum(rate(autoflow_execution_result_total{status=~"failed|timeout"}[5m])) > 0.01`。

- 管理台按 `failureReason` 分组看最近失败执行；单类任务失败查脚本/依赖，
  普遍失败查执行器资源与网络出口（伴生磁盘水位告警）。

#### autoflow_execution_failure_storm

**触发**：同上但 `> 0.05`（critical）。

- 系统性故障口径：失败原因是否集中（集中 → 先熔断该下游依赖）、执行器是否
  批量离线、最近是否发版（回滚边界见 `docs/operations.md`「升级 runbook」）。

#### autoflow_execution_killed_spike

**触发**：`increase(autoflow_execution_result_total{status="killed"}[15m]) > 5`。

- `killed` 只来自人工 kill 路径：查审计/操作记录确认是哪个用户或哪段自动化
  在批量终止；误触 → 评估重跑，主动止损 → 确认根因故障已另行告警。

### 通知投递（`autoflow_notification_delivery_total` 的 3 条）

#### autoflow_notification_failure_rate_high

**触发**：`sum by (channel) (increase(...{result="failure"}[15m])) > 3`。

- 该渠道凭据/地址是否失效（企微/钉钉 webhook 过期、SMTP 口令轮换）；
- admin-api 出网是否受限；管理台「设置 → 通知配置」发测试通知复现。

#### autoflow_notification_failure_storm

**触发**：全渠道 `failure` 合计 `> 10` / 15m。

- 多渠道同时失败 = admin-api 出网故障（DNS/防火墙/代理）而非单渠道配置；
  恢复前告警外发链路不可用，需人工盯 Alertmanager UI。

#### autoflow_notification_blocked_spike

**触发**：`increase(...{result="blocked"}[15m]) > 0`（正常应恒为 0）。

- ① 配置错误：渠道 URL 被改成内网/回环/云元数据地址（检查
  `NOTIF_ALLOW_PRIVATE_NETWORK` 是否被误开）；
- ② 安全事件：查审计日志里最近改通知配置的操作人与来源 IP。

### 其余业务信号

#### autoflow_ai_analysis_continuous_fail

**触发**：30m 内 `fail ≥ 3` 且 `ok == 0`。

- fail-open 生效中：失败执行将以**无 AI 分析**的状态落库。查 provider 配置
  （key/额度/网络出口）与 `scripts/check-env-drift.mjs`；恢复后历史执行不会自动补分析。

#### autoflow_sse_streams_rejected

**触发**：`increase(autoflow_sse_streams_rejected_total[10m]) > 0` 持续 10m。

- 槽位已饱和（用户侧 503）：先查前端是否泄漏 EventSource（未关连接），
  确属并发增长 → 调大 `SSE_MAX_STREAMS_GLOBAL`（容量 = 实例数 × 上限）。

#### autoflow_sse_stream_capacity_high

**触发**：`sum(autoflow_sse_streams_active) / sum(autoflow_sse_streams_limit) > 0.8`。

- 拒绝发生前的先行水位：定位哪类页面/用户在长挂日志流、是否有重复订阅标签页；
  必要时提前扩容或引导关闭闲置流。

#### autoflow_agent_budget_exceeded_spike

**触发**：`sum by (reason) (increase(autoflow_agent_budget_exceeded_total[30m])) > 5`。

- 按 reason 分辨：`max_tokens`/`max_tool_calls` 频发 = 会话循环空转或工具结果
  膨胀（查会话轨迹）；`wall_clock` 频发 = 模型/网络变慢；确属大任务 → 调预算。

#### autoflow_agent_denied_spike

**触发**：`sum by (reason) (increase(autoflow_agent_denied_total[15m])) > 10`。

- 安全信号：`out_of_scope`/`needs_approval` 突增 → 会话可能被诱导越权（保留轨迹
  取证）；`rate_limited`/`circuit_open` → 下游过载；`not_in_toolset` → 工具集配置漂移。

#### autoflow_executor_disk_usage_high

**触发**：`autoflow_executor_disk_usage_percent > 85` 持续 10m（per-executor）。

- 登录该执行器 `du` 逐层定位（任务产物/日志/解释器缓存池），清理策略见
  `docs/operations.md`「磁盘空间告警」与「解释器缓存池运维」。

#### autoflow_executor_disk_usage_critical

**触发**：`> 95` 持续 5m。

- 立即清理，必要时摘除该节点（写满会把执行打成 FAILED，伴生失败风暴）；
  摘除步骤见 `docs/operations.md`「注销执行器」。

#### autoflow_db_pool_waiting

**触发**：`autoflow_db_pool_waiting_requests > 0` 持续 5m。

- 看利用率 `active/max`（`max==0` = 池句柄不可读，不代表容量为 0）、
  `pg_stat_activity` 找长事务、查连接泄漏；确属并发增长 → 调 `DB_POOL_SIZE`。

#### autoflow_redis_memory_high

**触发**：`used/maxmemory > 0.9` 持续 10m（noeviction 防线）。

- `redis-cli --bigkeys` 定位大 key、查未设 TTL 的集合；评估扩容 `--maxmemory`
  （同步确认宿主内存余量）。触顶前处置，避免写入被 OOM 拒绝。

#### autoflow_redis_memory_critical

**触发**：`used/maxmemory > 0.95` 持续 5m。

- 写入拒绝临界（BullMQ 入队 / leader 锁 / 心跳都会开始失败）：立即清理可丢数据
  （已完成任务的 job 数据）并扩容 `--maxmemory`；确认 `AUTOFLOW_QUEUE_UNREADABLE`
  是否伴生。

#### autoflow_redis_unreachable

**触发**：`redis_up == 0` 持续 2m（exporter 活着但连不上 Redis）。

- 典型是密码轮换后 `REDIS_PASSWORD` 不同源，或 Redis 容器假死；
  查 `docker compose ps redis` 与容器网络（同在 `autoflow-internal`）。

#### autoflow_push_auth_still_unauthorized

**触发**：`increase(autoflow_push_auth_retry_total{result="still_unauthorized"}[15m]) > 0`。

- 执行器与控制面 token 顽固失配、自愈失效：管理台执行器详情 **rotate-token**
  重新下发，并查执行器侧 token 文件权限。
- 用 `reissued_success` 与 `still_unauthorized` 的比值判断是个别执行器还是全 fleet。

#### autoflow_callback_auth_expired_elevated

**触发**：`sum by (job) (rate(autoflow_execution_callback_auth_total{result="v1_expired"}[5m])) > 0.05`。

- 多为任务超时后执行端迟到的合法回调；若伴生执行超时告警，核对 token TTL 与
  任务最长运行时间配置是否匹配。

#### autoflow_callback_auth_signature_critical

**触发**：`result=~"v1_bad_signature|legacy_shared_invalid"` 速率 `> 0.01/s`（应≈0）。

- 立即核对：fleet / per-executor secret 是否轮换不同步（rotate 后未全量下发）；
  回调来源 IP 是否异常（安全事件口径，保留日志取证）；legacy 共享 token 客户端
  是否未迁移完。

#### autoflow_callback_auth_misuse

**触发**：`result=~"v1_binding_mismatch|missing_token|bad_address"` 合计 `> 0.1/s`。

- 集成配置错误：执行端复用其他 execution 的 token、未带 `Authorization` 头、
  legacy 回调缺 `executorAddress`。按 `result` 拆开定位到具体执行器。

## 4. 指标字典

业务 series（注册于 `prometheus-metrics.service.ts`；均为 per-process 计数，
进程重启归零；`job`/`instance` label 由 Prometheus 抓取注入，代码不设置）：| series | 类型 | labels | 语义 |
| --- | --- | --- | --- |
| `autoflow_scheduler_ticks_total` | counter | — | 本进程执行的调度扫描 tick（reload）次数；停增 = 调度停摆 |
| `autoflow_scheduler_tick_duration_ms_total` | counter | — | tick 累计耗时（毫秒）；与 ticks 相除得窗口均值 |
| `autoflow_scheduler_last_tick_duration_ms` | gauge | — | 最近一次 tick 耗时（毫秒），毛刺观测 |
| `autoflow_scheduler_triggers_total` | counter | `result=claimed\|failed` | cron 触发入队结果分类 |
| `autoflow_scheduler_triggers_skipped_total` | counter | `reason=lock_held\|db_claim\|inactive\|block_strategy` | 触发被跳过原因（多实例去重锁 / DB claim 窗口 / 任务非 ACTIVE / 阻塞策略） |
| `autoflow_scheduler_dependency_triggers_total` | counter | `result=claimed\|skipped` | 依赖扇出触发：claim 赢家 / 短窗去重跳过 |
| `autoflow_scheduler_cron_slots_missed_total` | counter | — | node-cron 报 `execution:missed` 的次数；**任何增长都代表一个计划落点被丢弃**（第 6 轮审计补导出） |
| `autoflow_scheduler_misfires_skipped_dependencies_total` | counter | — | misfire 补偿因依赖未满足而跳过的次数 |
| `autoflow_queue_depth` | gauge | `state=waiting\|active\|delayed\|failed\|completed` | BullMQ 队列各状态 job 数；Redis 不可读时全部置 0 |
| `autoflow_queue_up` | gauge | — | 1=BullMQ 计数可从 Redis 读取；0=Redis 不可读 |
| `autoflow_execution_callback_auth_total` | counter | `result=ok\|v1_expired\|v1_binding_mismatch\|v1_bad_signature\|legacy_shared_invalid\|missing_token\|bad_address` | `POST /executions/callback` 认证结果七分类（第九轮 N32）；七个 series 恒在、未计数时为 0 |

### 4.1 运行时计数器与 gauge（可观测性补齐轮 + BUG-05 补录）

> 本节补录字典缺口的 4 个 runtime counter（埋点在 TaskService /
> NotificationService，经 runtime-metrics-entry 模块级注册表交接）与 BUG-05
> 新增的 2 个 runtime gauge。声明处：`runtime-metrics.ts`（RUNTIME_COUNTERS /
> RUNTIME_GAUGES），渲染处：`prometheus-metrics.service.ts`。

| series | 类型 | labels | 语义 |
| --- | --- | --- | --- |
| `autoflow_execution_result_total` | counter | `status=success\|failed\|timeout\|killed\|cancelled` | 回调终态唯一赢家 UPDATE 命中后的执行结果分类。**取值是小写枚举**（`ExecutionStatus`，登记在 `RUNTIME_EXECUTION_RESULT_LABELS`）：看板/告警的 label filter 必须逐字小写，写 `status="SUCCESS"` 会匹配空集（OBS3-01） |
| `autoflow_sse_streams_rejected_total` | counter | — | SSE 日志流因 per-execution / global 并发上限被拒次数（TASK-008） |
| `autoflow_notification_delivery_total` | counter | `channel=email\|slack\|dingtalk\|wecom\|webhook` × `result=success\|failure\|blocked\|skipped` | 通知扇出投递结果（R33-A1 起四值：`success` = 真的投出；`failure` = 传输/API 故障，含渠道自报 `failed` 与 promise rejected；`blocked` = 被 SSRF 策略拦截；`skipped` = 渠道未配置、零次尝试。四值均在 `RUNTIME_NOTIFICATION_RESULTS` 登记并铺 0 值基线，否则新值在首次命中前是「无数据」而非 0，告警会漏） |
| `autoflow_callback_business_total` | counter | `result=accepted\|duplicate\|not_found\|address_mismatch\|address_mismatch_missing_address\|error` | 回调业务结果分类（终态重复/地址不符等） |
| `autoflow_scheduler_trigger_latency_ms_bucket` | counter/hist | `le=10\|50\|100\|250\|500\|1000\|2500\|5000\|+Inf` | CORE-06：定时触发（fixed_rate/cron）fire→入队延迟累计桶（毫秒）；与 scheduler-metrics.service.ts 的 TRIGGER_LATENCY_BUCKETS_MS 逐字对齐 |
| `autoflow_scheduler_trigger_latency_ms_sum` / `_count` | counter | — | 延迟累计和 / 样本数（avg = sum/count） |

> CORE-06 消费注记：P99 = `histogram_quantile(0.99, sum by (le, instance) (rate(autoflow_scheduler_trigger_latency_ms_bucket[5m])))`（区间线性插值，落在空桶时取桶上界）；avg = `rate(sum[5m])/clamp_min(rate(count[5m]), 1e-9)`。Grafana row 5（面板 501/502）已按此查询渲染；无样本时 P99 曲线缺席（rate 无增量），属正常态而非断线。
| `autoflow_sse_streams_active` | gauge | — | 本进程当前持有的 SSE 日志流连接数（占用/释放两点同步写，BUG-05）；多实例容量 = Σ(instance) |
| `autoflow_sse_streams_limit` | gauge | — | 本实例全局 SSE 并发上限（SSE_MAX_STREAMS_GLOBAL，默认 64，BUG-05）；占用率 = active/limit |
| `autoflow_metrics_render_error_total` | counter | `query=executor_disk\|executor_fleet` | 指标**渲染期取数失败**次数（OBS3-05）：`/api/metrics` 每次抓取时 `renderExecutorDiskWaterLevel` 的 `find()` / `renderExecutorFleetGauges` 的 `count()` 抛错就 +1，该轮对应 gauge 保留上一轮值（`autoflow_executor_disk_usage_percent` / `autoflow_executors_online|_total`）。`query` 取值是固定枚举（`RUNTIME_METRICS_RENDER_QUERIES`），每条渲染路径一个值、均铺 0 值基线——**恒为 0 才是健康态**；`increase(autoflow_metrics_render_error_total[10m]) > 0` 表示这段时间内抓取面上有陈旧水位，配合日志 `Metrics render-time query failed: query=<…>`（同一 query 每分钟最多 1 条 warn，逐次事实只在这里的计数里）判断是「DB 短抖」还是「DB 长时间不可查」。池水位不在此列：池句柄不可读由 `autoflow_db_pool_max_connections == 0` 表达，取数路径不抛错（见 §4.2）。 |

### 4.2 容量水位 Gauge 四件套（OBS-05）

> 目标：把四个容量关键信号统一为"水位"语义（当前用量 / 上限，一眼可读），
> help 文案均内嵌告警建议阈值。运维侧的水位清单 / 告警阈值 / 横向扩容要点见
> `docs/operations.md`「容量规划」一节。落点矩阵：

| 信号 | 状态 | series | 水位读法 |
| --- | --- | --- | --- |
| BullMQ 队列深度 | 已有（本轮 help 升级为水位语义） | `autoflow_queue_depth{state}` | 积压水位 = `waiting`；告警 `waiting > 100` 持续 10m（AUTOFLOW_QUEUE_BACKLOG 已启用） |
| SSE 流槽位 | 已有（BUG-05 落地，本轮 help 升级） | `autoflow_sse_streams_active` / `autoflow_sse_streams_limit` | 占用率 = Σ(active)/Σ(limit)（per-instance 线性叠加）；建议 > 0.8 持续 10m 关注 |
| PG 连接池水位 | **本轮新增** | `autoflow_db_pool_max_connections` / `autoflow_db_pool_active_connections` / `autoflow_db_pool_idle_connections` / `autoflow_db_pool_waiting_requests` | 利用率 = active/max；**建议 active/max > 0.8 持续 5m 告警**；waiting > 0 持续 5m = 饱和（有人在排队等连接），建议告警 |
| executor 磁盘水位 | **本轮新增**（数据源已有：心跳字段） | `autoflow_executor_disk_usage_percent{executor="<address>"}` | 每执行器磁盘百分数（0-100）；**建议 > 90 持续 10m 告警** |

PG 连接池取数路径（已在依赖源码逐层核实，无新增 DI token）：
`Repository<Executor>`（MetricsModule 既有 `forFeature` 注入，与 MetricsService
同模式）→ `manager.connection`（typeorm 0.3.31 `EntityManager.connection`，
即 app.module `TypeOrmModule.forRootAsync` 建立的默认 DataSource）→
`driver.master`（PostgresDriver `connect()` 后挂载的 node-pg Pool）→
`totalCount / idleCount / waitingCount / options.max`（pg Pool 实时字段，
`options.max` 即 PERF-04 `extra.max` = `DB_POOL_SIZE`，默认 20）。
语义：`active = totalCount - idleCount`（已借出连接数）。

PG 池 series 的可读性约定：**`max_connections == 0` 表示池句柄不可读**
（未完成连接 / 非 PG 驱动 / 进程启动早期），此时其余三项一并置 0——
与 `autoflow_queue_up == 0` 同一姿态，利用率告警须以 `max > 0` 为前提。

executor 磁盘 series 的呈现约定（如实，不强造数据）：

- 仅产出**在线**（`Executor.status=online`）且心跳上报了 `diskUsage`
  的执行器（`executor.controller.ts` heartbeat 白名单字段，落
  `executors.diskUsage` 列）；旧版执行器未上报 → **series 缺席而非 0**；
- 每次抓取 reset+set 重建：执行器下线/换址后其 series 随抓取消失
  （Prometheus staleness 收口）；DB 查询失败时保留上一轮值（略陈旧
  好过整组消失），不会让 `/api/metrics` 因该可选项失败而 500；
- 该 series 为 per-executor label（label 值 = 唯一 `address`），执行器
  数量级为个位~十位，cardinality 可控。

进程默认指标（`collectDefaultMetrics`，prom-client ^15.1.3；面板用到以下
名称，已在 `node_modules/prom-client/lib/metrics/` 核对）：

| series | 类型 | 语义 |
| --- | --- | --- |
| `process_cpu_seconds_total` | counter | user+system CPU 累计秒（面板 ×rate×100 得单核 %） |
| `process_cpu_user_seconds_total` / `process_cpu_system_seconds_total` | counter | user / system 分量 |
| `process_resident_memory_bytes` | gauge | RSS |
| `process_virtual_memory_bytes` / `process_heap_bytes` | gauge | 虚拟内存 / 进程堆 |
| `nodejs_heap_size_total_bytes` / `nodejs_heap_size_used_bytes` | gauge | V8 堆容量 / 已用 |
| `nodejs_external_memory_bytes` | gauge | V8 外部内存 |
| `nodejs_eventloop_lag_seconds` | gauge | 事件循环延迟（最近采样）；另有 `_p50/_p90/_p99/_mean/_min/_max/_stddev` 窗口统计 |
| `nodejs_gc_duration_seconds` | histogram | GC 耗时（可按 kind 聚合） |
| `nodejs_active_handles_total` / `nodejs_active_requests_total` | gauge | libuv handles / requests |
| `process_open_fds` / `process_max_fds` | gauge | 文件描述符（Linux） |
| `process_start_time_seconds` / `nodejs_version_info` | gauge/info | 启动时间 / 版本 |

## 5. 验证记录（2026-09-03）

```bash
python3 -c "import json; json.load(open('docs/observability/grafana-dashboard.json'))"   # OK
python3 -c "import yaml; yaml.safe_load(open('docs/observability/alerting-rules.yml'))"  # OK
# promtool：本机未安装，未跑 `promtool check rules`（yml 按官方 rule 语法编写）
```

### 5.1 OBS-05 容量水位轮验证（2026-09-06）

```bash
# dashboard JSON 追加 row 4 + 面板 401~404 后语法校验
node -e "JSON.parse(require('fs').readFileSync('docs/observability/grafana-dashboard.json','utf8'))"  # OK
cd apps/admin-api && npx tsc --noEmit -p tsconfig.json   # exit 0
cd apps/admin-api && npx jest --silent
#   Test Suites: 66 passed, 66 total
#   Tests:       1258 passed, 1258 total（含 OBS-05 新增 7 例：池水位取数/
#   句柄不可读置 0/active 钳 0/磁盘 per-executor 与 stale 收口/查询失败保留
#   旧值/未上报不造 0/where 查询契约）
cd apps/admin-api && npm run lint   # 0 问题
```

新增 series 取数路径已在依赖源码/运行时核实：pg.Pool 的
`totalCount/idleCount/waitingCount` 为实时 number（node 运行时验证），
`options.max` 反映 PERF-04 `extra.max`；typeorm 0.3.31
`EntityManager.connection: DataSource`；PostgresDriver `connect()` 后
`driver.master` 挂载 pg.Pool。

面板 PromQL 中出现的全部 series 名与 label 值均已与附录 A 清单逐一比对，
无对不上的项；不确定的 series 一律未做成面板（见附录 A 备注）。

### 5.2 OBS3-01 / OBS3-06 收口验证（2026-10-29，第三轮审计）

OBS3-01（看板 label 取值大小写）与 OBS3-06（31 条告警 0 条 `runbook_url`）
的落地验证——两处都是「守卫看不见的维度」，所以修完必须同时把守卫补上：

```bash
npm run test:alerts
#   ✓ selftest 全绿（13 个 alerts fixture + 11 个阅读版 fixture …）
#   ✓ config/monitoring/alerts.yml：31 条规则全部通过结构、指标名与
#     runbook_url 守卫（绝对 URL + 锚点存在）
cd apps/admin-api && npx --node-options=--experimental-vm-modules jest src/modules/metrics --silent
#   Test Suites: 9 passed / Tests: 122 passed（含新增 dashboard-label-values.spec.ts 12 例）
cd apps/admin-api && npx --node-options=--experimental-vm-modules jest src/modules/notification --silent
#   Test Suites: 15 passed / Tests: 370 passed（含 extractRunbookUrl 兼容面 7 例）
cd apps/admin-api && npm run typecheck:specs   # exit 0
```

反证（两条都实测过、随后还原）：

- 把面板 702 的 `status="success"` 改回 `status="SUCCESS"` →
  `dashboard-label-values.spec.ts` 红，报错逐字给出
  `docs/observability/grafana-dashboard.json:702: … 合法取值只有 [success, failed, timeout, killed, cancelled]`；
- 把一条 `runbook_url` 改成相对路径 → `npm run test:alerts` 红（「必须是
  http(s) 绝对 URL」）；把锚点写错 → 红（「锚点 … 不存在（死链 = 值班人点进去
  看不到处置口径）」）。

---

## 附录 A：series 核对清单（dashboard/告警 ↔ 源码）

核对方法：

```bash
grep -rn 'name: "autoflow' apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts
grep -rn 'EXECUTION_CALLBACK_AUTH_RESULTS' apps/admin-api/src/modules/task/execution-callback-metrics.service.ts
grep -rn 'QUEUE_STATES' apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts
```

| # | series（逐字） | label 取值（逐字） | 源码位置 | 面板/规则引用 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | `autoflow_scheduler_ticks_total` | — | prometheus-metrics.service.ts L72 | 101、102、SCHEDULER_DOWN | ✅ |
| 2 | `autoflow_scheduler_tick_duration_ms_total` | — | 同上 L77 | 102 | ✅ |
| 3 | `autoflow_scheduler_last_tick_duration_ms` | — | 同上 L82 | 102 | ✅ |
| 4 | `autoflow_scheduler_triggers_total` | `claimed`/`failed`（L162-163） | 同上 L87 | 未单独成板（信息量低，见备注①） | ✅ |
| 5 | `autoflow_scheduler_triggers_skipped_total` | `lock_held`/`db_claim`/`inactive`/`block_strategy`（L166-175） | 同上 L93 | 103 | ✅ |
| 6 | `autoflow_scheduler_dependency_triggers_total` | `claimed`/`skipped`（L181-185） | 同上 L99 | 未单独成板（备注①） | ✅ |
| 7 | `autoflow_queue_depth` | `waiting`/`active`/`delayed`/`failed`/`completed`（L12-18 QUEUE_STATES） | 同上 L110 | 104、QUEUE_BACKLOG | ✅ |
| 8 | `autoflow_queue_up` | — | 同上 L105 | 105、SCHEDULER_DOWN、TARGET_DOWN、$instance 变量 | ✅ |
| 9 | `autoflow_execution_callback_auth_total` | `ok`/`v1_expired`/`v1_binding_mismatch`/`v1_bad_signature`/`legacy_shared_invalid`/`missing_token`/`bad_address`（execution-callback-metrics.service.ts L25-40） | prometheus-metrics.service.ts L118 | 201、202、203、三条 AUTH 告警 | ✅ |
| 10 | `process_cpu_seconds_total` 等默认指标 | — | prom-client ^15.1.3 `lib/metrics/`（processCpuTotal.js 等） | 301、302、303 | ✅ |
| 11 | `autoflow_sse_streams_active` / `autoflow_sse_streams_limit` | — | runtime-metrics.ts `RUNTIME_GAUGES`（渲染于 prometheus-metrics.service.ts） | 404 | ✅ |
| 12 | `autoflow_db_pool_max_connections` / `autoflow_db_pool_active_connections` / `autoflow_db_pool_idle_connections` / `autoflow_db_pool_waiting_requests` | — | prometheus-metrics.service.ts（OBS-05，取数路径见 4.2） | 401、402 | ✅ |
| 14 | `autoflow_scheduler_cron_slots_missed_total` | — | prometheus-metrics.service.ts（第 6 轮审计补导出） | SCHEDULER_SLOT_MISSED | ✅ |
| 15 | `autoflow_scheduler_misfires_skipped_dependencies_total` | — | prometheus-metrics.service.ts（同批） | 未单独成板（备注①） | ✅ |
| 13 | `autoflow_executor_disk_usage_percent` | `executor=<address>`（动态集合：在线且上报 diskUsage 的执行器，见 4.2 呈现约定） | prometheus-metrics.service.ts（OBS-05） | 403 | ✅ |
| 14 | `autoflow_scheduler_trigger_latency_ms_bucket` | `le=10/50/100/250/500/1000/2500/5000/+Inf`（prometheus-metrics.service.ts L219-224 与 TRIGGER_LATENCY_BUCKETS_MS 逐字对齐） | 同上 L219-360（渲染）← scheduler-metrics.service.ts L48-50（桶定义） | 501、502（CORE-06 row 5） | ✅ |
| 15 | `autoflow_scheduler_trigger_latency_ms_sum` / `_count` | — | 同上 L225-233 / L357-360 | 501（avg = rate(sum)/rate(count)） | ✅ |
| — | 执行器在线 series | — | 全库 grep `autoflow_` 仍无在线状态 series（OBS-05 的 disk series 是心跳上报的磁盘水位数值，**不是**在线状态） | EXECUTOR_OFFLINE 注释预留 | ✅（按任务要求注释说明） |

备注：

- ① `triggers_total` / `dependency_triggers_total` 与 skipped 面板信息重叠且
  无独立排障价值，本轮未做面板（series 本身核对无误，随时可加）。
- ② tick 耗时 p95：源码只有 counter（累计）+ gauge（最近一次），**无
  histogram bucket**，任何 p95 表达式都不可实现；面板 102 以「窗口均值 +
  last tick」如实替代并标注。
- ③ `docs/api-reference.md` L302 的 series 清单与第十轮源码一致；**OBS-05
  新增的 5 个 series（4.2 节）尚未回补该文件**（本轮改动范围限定
  docs/observability/，回补待办）。
- ④ CORE-06 lastTriggerLatencyMs：scheduler-metrics snapshot 里有，但未导出 prom series（prometheus-metrics.service.ts 无对应 Gauge 声明）——遵守「不确定的 series 不做面板」纪律，row 5 未设「最近一次延迟」stat，P99 瞬时值（区间累计）代替。
- ⑤ 端点路径：`main.ts` `setGlobalPrefix("api")` + `@Controller("metrics")`
  → `/api/metrics`；默认端口 3105（`main.ts` L319）。

# AutoCodeFlow 观测性（第十轮）

admin-api 的 Prometheus 指标（`GET /api/metrics`）配套的 Grafana 面板、告警规则与抓取配置。

| 文件 | 内容 |
| --- | --- |
| `grafana-dashboard.json` | 可导入的 Grafana dashboard（schemaVersion 39，uid `autoflow-obs-v1`）：调度健康 / 回调认证 / 进程资源 三组共 11 个数据面板 |
| `alerting-rules.yml` | Prometheus rule 文件：6 条启用告警 + 1 条注释预留（ExecutorOffline） |
| `README.md` | 本文件：抓取配置、导入/挂载步骤、指标字典、series 核对清单 |

指标事实来源（唯一注册处）：
`apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts`（独立 Registry，
`collectDefaultMetrics` + 9 个业务 series）；端点定义在
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

## 2. Grafana dashboard 导入

要求 Grafana ≥ 11（schemaVersion 39；Grafana 10.x 导入会提示版本较新，多数
面板仍可用）。步骤：Dashboards → **Import** → Upload JSON / 粘贴文件内容 →
在「数据源」下拉选择 Prometheus 数据源 → Import。

- uid 固定为 `autoflow-obs-v1`：重复导入会**覆盖**同名 dashboard（适合 GitOps
  式更新；如需并存请先改 uid）。
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

## 4. 指标字典

业务 series（注册于 `prometheus-metrics.service.ts`；均为 per-process 计数，
进程重启归零；`job`/`instance` label 由 Prometheus 抓取注入，代码不设置）：

| series | 类型 | labels | 语义 |
| --- | --- | --- | --- |
| `autoflow_scheduler_ticks_total` | counter | — | 本进程执行的调度扫描 tick（reload）次数；停增 = 调度停摆 |
| `autoflow_scheduler_tick_duration_ms_total` | counter | — | tick 累计耗时（毫秒）；与 ticks 相除得窗口均值 |
| `autoflow_scheduler_last_tick_duration_ms` | gauge | — | 最近一次 tick 耗时（毫秒），毛刺观测 |
| `autoflow_scheduler_triggers_total` | counter | `result=claimed\|failed` | cron 触发入队结果分类 |
| `autoflow_scheduler_triggers_skipped_total` | counter | `reason=lock_held\|db_claim\|inactive\|block_strategy` | 触发被跳过原因（多实例去重锁 / DB claim 窗口 / 任务非 ACTIVE / 阻塞策略） |
| `autoflow_scheduler_dependency_triggers_total` | counter | `result=claimed\|skipped` | 依赖扇出触发：claim 赢家 / 短窗去重跳过 |
| `autoflow_queue_depth` | gauge | `state=waiting\|active\|delayed\|failed\|completed` | BullMQ 队列各状态 job 数；Redis 不可读时全部置 0 |
| `autoflow_queue_up` | gauge | — | 1=BullMQ 计数可从 Redis 读取；0=Redis 不可读 |
| `autoflow_execution_callback_auth_total` | counter | `result=ok\|v1_expired\|v1_binding_mismatch\|v1_bad_signature\|legacy_shared_invalid\|missing_token\|bad_address` | `POST /executions/callback` 认证结果七分类（第九轮 N32）；七个 series 恒在、未计数时为 0 |

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

面板 PromQL 中出现的全部 series 名与 label 值均已与附录 A 清单逐一比对，
无对不上的项；不确定的 series 一律未做成面板（见附录 A 备注）。

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
| — | 执行器在线 series | — | 全库 grep `autoflow_` 仅命中 metrics 模块 → **不存在** | EXECUTOR_OFFLINE 注释预留 | ✅（按任务要求注释说明） |

备注：

- ① `triggers_total` / `dependency_triggers_total` 与 skipped 面板信息重叠且
  无独立排障价值，本轮未做面板（series 本身核对无误，随时可加）。
- ② tick 耗时 p95：源码只有 counter（累计）+ gauge（最近一次），**无
  histogram bucket**，任何 p95 表达式都不可实现；面板 102 以「窗口均值 +
  last tick」如实替代并标注。
- ③ `docs/api-reference.md` L302 的 series 清单与源码一致（含第九轮新增的
  callback auth 七分类），无出入。
- ④ 端点路径：`main.ts` `setGlobalPrefix("api")` + `@Controller("metrics")`
  → `/api/metrics`；默认端口 3105（`main.ts` L319）。

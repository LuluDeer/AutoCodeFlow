# 教程 04 · 告警接入值班

> 目标：任务失败、执行器掉线这类事件能在 5 分钟内出现在值班群
> （企业微信/钉钉/Slack/邮件），Prometheus/Alertmanager 告警也能汇入同一
> 套通知渠道，且每条告警自带 runbook。
> 前提：已完成[教程 03](./03-multi-executor-scaling)；有 ADMIN 角色。

## 0. 通知体系一张图

```
┌ 平台事件（任务失败/超时/执行器离线…）──┐
│                                        ├→ NotificationService.sendAll
┌ Alertmanager ─→ POST /api/alerts/webhook ┘        │ 全渠道扇出
│ Prometheus/Alertmanager 规则                       ├→ 企业微信
└───────────────────────────────────────────────────┼→ 钉钉
                                                     ├→ Slack
                                                     └→ 邮件
```

两条入路、五个出渠道，静默窗口对两条入路统一生效。

## 1. 配置通知渠道（五选一即可起步）

**方式 A：管理台**（推荐）——「设置 → 通知渠道」，选择渠道填 webhook/SMTP
等配置、`enabled` 开启，可点「发送测试」即时验证（`POST
/api/notification/channels/:key/test`）。配置保存在 ChannelConfigStore，
**保存的配置优先于 env 回退**。

**方式 B：环境变量**——`.env` 中至少配一个：

| 渠道 | 变量 |
|------|------|
| 企业微信 | `WECOM_WEBHOOK`（群机器人 webhook 地址） |
| 钉钉 | `DINGTALK_WEBHOOK` |
| Slack | `SLACK_WEBHOOK` |
| 邮件 | `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_USER` / `EMAIL_PASS`… |
| webhook | 渠道 config `{ url }`（N32 起可在管理台配置） |

> 通知可配**渠道级模板**（FEAT-10）：`titleTemplate` / `contentTemplate`
> 支持 `{{taskName}}` / `{{failedReason}}` / `{{runbook}}` 等变量，
> 语法与变量集见 [API 参考·FEAT-10](../api-reference.md)。

## 2. 配置静默窗口（FEAT-01）

发版夜/计划停机不想被告警轰炸？「设置 → 通知渠道」页的**「静默规则」Tab**：

| 字段 | 说明 |
|------|------|
| `scope` | `global`（全部）/ `task`（指定任务）/ `application`（指定应用） |
| `channelType` | 空=全渠道；指定=仅该渠道 |
| `level` | 可按级别收窄（error/warning/info） |
| `durationMinutes` | 静默时长，到期自动失效 |

对应 API（ADMIN）：

```bash
# 全局静默 error 级通知 60 分钟
curl -X POST -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"scope":"global","level":"error","durationMinutes":60,"reason":"发版窗口"}' \
  http://<admin>:3105/api/notification/silences
```

静默命中时**全渠道抑制**；过期规则列表里仍可见（`isSilenced=false`），
可手动删除（`DELETE /api/notification/silences/:id`）。

## 3. 接入 Alertmanager（OBS-02）

平台暴露 `POST /api/alerts/webhook`，把 Alertmanager v2 载荷映射为平台
通知并走第 1 步配置的全渠道扇出。

### 3.1 开启端点

端点带 HMAC 鉴权，**secret 未配置时返回 503（安全缺省，绝不无鉴权接收）**：

```bash
# .env
ALERT_WEBHOOK_SECRET=$(openssl rand -hex 32)
```

配置后重启 admin-api。签名约定与发版 webhook 一致：
`X-AutoCodeFlow-Timestamp`（毫秒，±5 分钟窗）+
`X-Hub-Signature-256: sha256=hex(HMAC(secret, "${timestamp}.${rawBody}"))`。

### 3.2 Alertmanager 侧路由

```yaml
# alertmanager.yml —— 完整样例见 docs/observability/README.md §3.5.2
route:
  receiver: autoflow-webhook
  group_by: [alertname, instance]
  group_wait: 30s
  repeat_interval: 4h

receivers:
  - name: autoflow-webhook
    webhook_configs:
      - url: http://<加签代理>/api/alerts/webhook
        send_resolved: true   # resolved 恢复也发（level=info）
```

> **加签**：原生 Alertmanager 不带 HMAC 头，需要一个轻量反代（nginx njs /
> 10 行 node 脚本）计算并注入两个签名头后转发。平台侧测试向量见
> `apps/admin-api/src/modules/notification/__tests__/alerts.controller.spec.ts`。

### 3.3 告警规则从哪来

仓库已内置一套与源码逐字核对的告警规则
[docs/observability/alerting-rules.yml](../observability/alerting-rules.yml)：
调度器停摆（`AUTOFLOW_SCHEDULER_DOWN`）、指标目标失联、队列积压、回调鉴权
异常等。Prometheus 抓取配置（含 JWT 鉴权两个解法）与 Grafana 导入见
[可观测性指南](../observability/README.md)。

## 4. 让告警带上 runbook（FEAT-11 / OBS-02）

值班最痛的是「收到告警不知道干嘛」。两条通路把排障知识接到告警消息里：

1. **任务级 runbook**：任务表单的 `runbook` 字段（Markdown，迁移
   1789400000000）展示在任务详情页；告警 `labels.taskId` 命中时，平台查
   `tasks.runbook` 把内容拼成消息的 `Runbook:` 段——查询失败降级不阻断外发；
2. **规则级 runbook_url**：Alertmanager 规则的
   `annotations.runbook_url` 命中时直接追加链接。内置规则文件里的
   `runbook` annotation 是 Grafana 相对路径，**接值班时把规则加一行
   `runbook_url:`（绝对 URL）** 即可直达。

## 5. 端到端验收（值班演练）

> 想跳过手工造数据？`pnpm demo:failure:seed` 一键预置故障演练四件套
> （失败任务 / runbook 任务 / 死信订阅 / 审批待办各一例，全部
> `demo-failure-` 前缀、幂等可重跑，`--clean` 一键清理），详见
> [运维手册·故障演练演示包](../operations.md#故障演练演示包demo-failure-seed)。
> 下面手工路径与脚本预置等价，可用于理解每一步的机制。

1. 停掉 Redis：`docker compose stop redis`；
2. 等 Prometheus 抓取 + 规则评估（默认 1-2 个评估周期）；
3. 预期链路：`AUTOFLOW_SCHEDULER_DOWN` firing → Alertmanager → 加签代理 →
   `POST /api/alerts/webhook` → 值班群收到 `[Alert] AUTOFLOW_SCHEDULER_DOWN
   firing` 消息；
4. `docker compose start redis` → 收到 `resolved`（level=info）恢复通知。

平台事件侧验收：把某任务改为必失败（如脚本 `throw new Error("drill")`）
触发一次，确认失败通知带 `{{failedReason}}` 渲染内容与 runbook 段。

## 6. 下一步

至此「从 0 到生产」四篇走完。更多运维主题（备份恢复、容量规划、升级
runbook）见 [运维手册](../operations.md)；监控细节见
[可观测性指南](../observability/README.md)。

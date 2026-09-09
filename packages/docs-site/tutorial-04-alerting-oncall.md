# 教程 04 · 告警接入值班

> 重组自 [docs/tutorials/04-alerting-oncall.md](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/tutorials/04-alerting-oncall.md)（DOC-06）。
> 目标：平台事件与 Alertmanager 告警统一汇入值班群，每条告警自带 runbook。

## 0. 通知体系一张图

```
┌ 平台事件（任务失败/超时/执行器离线…）──┐
│                                        ├→ NotificationService.sendAll
┌ Alertmanager ─→ POST /api/alerts/webhook ┘        │ 全渠道扇出
└───────────────────────────────────────────────────┼→ 企业微信
                                                     ├→ 钉钉
                                                     ├→ Slack
                                                     └→ 邮件
```

两条入路、五个出渠道，静默窗口对两条入路统一生效。

## 1. 配置通知渠道

**管理台**（推荐）：「设置 → 通知渠道」填配置、开启 `enabled`、点「发送测试」。
保存的配置优先于 env 回退。或 `.env` 至少配一个：
`WECOM_WEBHOOK` / `DINGTALK_WEBHOOK` / `SLACK_WEBHOOK` / `EMAIL_*`。

> 渠道级**通知模板**（FEAT-10）：`titleTemplate`/`contentTemplate` 支持
> `{{taskName}}`/`{{failedReason}}`/`{{runbook}}` 等变量。

## 2. 配置静默窗口（FEAT-01）

「设置 → 通知渠道」页的**「静默规则」Tab**：`scope`（global/task/
application）+ 可选 `channelType`/`level` + `durationMinutes`（到期自动失效）。

```bash
# 全局静默 error 级通知 60 分钟
curl -X POST -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"scope":"global","level":"error","durationMinutes":60,"reason":"发版窗口"}' \
  http://<admin>:3105/api/notification/silences
```

静默命中时全渠道抑制；规则可删（`DELETE /api/notification/silences/:id`）。

## 3. 接入 Alertmanager（OBS-02）

### 3.1 开启端点

`POST /api/alerts/webhook` 带 HMAC 鉴权，**secret 未配置时 503（安全缺省）**：

```bash
# .env
ALERT_WEBHOOK_SECRET=$(openssl rand -hex 32)
```

签名约定：`X-AutoCodeFlow-Timestamp`（毫秒，±5 分钟窗）+
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

> **加签**：原生 Alertmanager 不带 HMAC 头，需轻量反代（nginx njs / 10 行
> node 脚本）注入两个签名头后转发。测试向量见
> `apps/admin-api/src/modules/notification/__tests__/alerts.controller.spec.ts`。

### 3.3 告警规则从哪来

仓库内置 [alerting-rules.yml](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/observability/alerting-rules.yml)
（调度器停摆/指标目标失联/队列积压/回调鉴权异常等，series 与源码逐字核对）。
Prometheus 抓取（含 JWT 鉴权两个解法）与 Grafana 导入见
[可观测性指南](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/observability/README.md)。

## 4. 让告警带上 runbook（FEAT-11 / OBS-02）

1. **任务级 runbook**：任务表单 `runbook` 字段（Markdown）展示在详情页；
   告警 `labels.taskId` 命中时平台查 `tasks.runbook` 拼成消息 `Runbook:` 段
   （查询失败降级不阻断）；
2. **规则级 runbook_url**：Alertmanager 规则 `annotations.runbook_url`
   命中时直接追加链接。内置规则的 `runbook` annotation 是 Grafana 相对路径，
   **接值班时加一行 `runbook_url:`（绝对 URL）** 即可直达。

## 5. 端到端验收（值班演练）

1. `docker compose stop redis`；
2. 等 Prometheus 抓取 + 规则评估（1-2 个评估周期）；
3. 预期：`AUTOFLOW_SCHEDULER_DOWN` firing → Alertmanager → 加签代理 →
   `POST /api/alerts/webhook` → 值班群收到告警消息；
4. `docker compose start redis` → 收到 `resolved`（level=info）恢复通知。

平台事件侧：脚本 `throw new Error("drill")` 触发一次失败，确认失败通知带
`{{failedReason}}` 渲染与 runbook 段。

## 6. 下一步

「从 0 到生产」四篇至此走完。更多运维主题见
[运维手册](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/operations.md)。

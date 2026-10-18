# AutoCodeFlow 第七轮真机 E2E 验证报告（VERIFY-round7-e2e）

- 验证人：第七轮真机验证 agent V
- 日期：2026-09-03
- 代码基线：`develop` 工作树（含全部未提交第七轮改动；验证对象即当前工作树，未做任何 git commit）
- 环境：Docker 26.1.4，Linux 宿主（node v24.13.0，python 3.12.3）
- 隔离方式：沿用 round6 端口规划，不使用 compose 编排，一次性容器 + 宿主进程直跑：
  - `acf-r7-postgres`（postgres:16-alpine，宿主 `25432`）、`acf-r7-redis`（redis:7-alpine，宿主 `26379`），全新空卷
  - admin-api：`apps/admin-api` `npx nest build` 后 `node dist/main.js`，宿主 `3105`，日志 `/tmp/acf-r7-admin*.log`
  - 迁移先手动 `npm run migration:run`（25/25 成功、`select count(*) from migrations` = 25）再起服
  - **本轮未启动 executor**（验证项不依赖真实执行；fixed_rate 任务触发后 execution 因无在线执行器全部 failed，属预期，且恰好驱动了失败告警链路，见 §1.6）
- mock 接收端（均为 `/tmp` 下临时脚本，验证后删除）：
  - HTTP receiver：`/tmp/acf-r7-receiver.py`（python http.server，记录 method/path/headers/body 到 `/tmp/acf-r7-receiver.log`，应答 200 `{"ok":true}`），监听 `0.0.0.0:9999`
  - SMTP mock：`/tmp/acf-r7-smtp.py`（python3.12 已移除 `smtpd` 且无 aiosmtpd，自写最小 socket 服务器：220/EHLO/250/354/250/221，不广告 AUTH，全量会话记录到 `/tmp/acf-r7-smtp.log`），监听 `127.0.0.1:1025`
- admin-api 启动 env（关键项）：`NODE_ENV=production`、`DB_SYNCHRONIZE=false`、DB/Redis 指向 25432/26379、`JWT_SECRET/JWT_REFRESH_SECRET`（≥32 字符）、`EXECUTOR_SECRET/EXECUTOR_SHARED_TOKEN`、`INITIAL_ADMIN_PASSWORD`、`CORS_ALLOWED_ORIGINS=http://r7verify.local`、`LOG_STORAGE_DRIVER=db`、`ADMIN_API_URL=http://localhost:3105`，以及本轮通知验证专用：
  - `WECOM_WEBHOOK=http://198.18.0.1:9999/wecom`、`DINGTALK_WEBHOOK=http://198.18.0.1:9999/dingtalk`、`SLACK_WEBHOOK=http://198.18.0.1:9999/slack`
  - `EMAIL_HOST=127.0.0.1 EMAIL_PORT=1025 EMAIL_SECURE=false EMAIL_USER/EMAIL_PASS/EMAIL_FROM/EMAIL_TO`
  - `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`（刻意开启，用于实证该开关**不**影响通知外发 SSRF，见 §1.4）
- **mock 接收端地址选型（如实声明）**：`assertSafeHttpUrl`（safe-http.util.ts:14-58）对通知渠道 URL 无 env 放行条件（`EXECUTOR_ALLOW_PRIVATE_NETWORK` 仅作用于 `assertSafeExecutorUrl`），loopback/RFC1918 一律拦截。为在不改仓库代码、不绕过守卫的前提下取证"请求到达 mock"，选用宿主机 `Meta` TUN 接口地址 `198.18.0.1`（RFC 2544 基准测试段 198.18.0.0/15，不在守卫 deny 列表内，`isBlockedAddress` 判为放行）。该段被放行本身作为遗留观察记录（§6.3），不判本轮失败。

## 0. 验证项总览

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 通知渠道五渠道外发（webhook/wecom/dingtalk/slack/email + SSRF 分级） | ✅ 通过（五渠道全部到达 mock、payload 形状与 channels/*.channel.ts 实现一致；SSRF 拦截 loopback/RFC1918 有明确日志反馈） |
| 2 | `GET /api/metrics` Prometheus 端点 | ✅ 通过（200 + `text/plain; version=0.0.4` + `autoflow_scheduler_*` series；触发执行后 counters 增长；`METRICS_PROMETHEUS_ENABLED=false` 重启 → 404 实测） |
| 3 | N17 PATCH 互斥 | ✅ 通过（4 分支全中：双向 PATCH 400 / `executorId:null` 清除 200 / create 回归 400） |
| 4 | `POST /api/notification/send` 新端点 | ✅ 通过（sendAll / channels 子集 / webhookUrl 自动追加 / 401 / DTO 400 全验） |
| 5 | `/metrics/scheduler` JSON 回归 | ✅ 通过（结构完整，prom-client 改动未破坏旧端点） |

## 1. 通知渠道五渠道外发（验证项 1）—— ✅

### 1.1 webhook 渠道（请求体 webhookUrl → mock 到达）

`POST /api/notification/send`（JWT）`{"channels":["webhook"],"webhookUrl":"http://198.18.0.1:9999/webhook-a",...}` → 201 `{"success":true}`；receiver 记录：

```json
{"method":"POST","path":"/webhook-a",
 "headers":{"Content-Type":"application/json","User-Agent":"axios/1.19.0",...},
 "body":"{\"title\":\"R7-A webhook reach\",\"content\":\"hello from round7 verify A\",\"level\":\"info\",\"timestamp\":\"2026-09-03T01:07:35.742Z\"}"}
```

payload 形状与 `webhook.channel.ts:33-38`（title/content/level/timestamp）逐字段一致 ✅。admin-api 日志：`[Webhook] sent: ... → http://198.18.0.1:9999/webhook-auto`。

### 1.2 wecom / dingtalk / slack 渠道（env 配置 URL → mock 到达，格式对照实现）

`POST /api/notification/send` `{"channels":["wecom","dingtalk","slack"],...}` 一次触发，receiver 三条记录，body 与各 channel 源码逐字段一致：

| 渠道 | receiver 收到 body（摘录） | 对照实现 |
|---|---|---|
| `/wecom` | `{"msgtype":"markdown","markdown":{"content":"## R7-C im channels\nline1\nline2..."}}` | wecom.channel.ts:29-36 ✅ |
| `/dingtalk` | `{"msgtype":"markdown","markdown":{"title":"R7-C im channels","text":"## ..."}}` | dingtalk.channel.ts:31-38 ✅ |
| `/slack` | `{"text":"*R7-C im channels*","blocks":[{"type":"header",...},{"type":"section","text":{"type":"mrkdwn","text":"line1\nline2..."}}]}` | slack.channel.ts:31-44 ✅ |

admin-api 日志对应 `[Wecom] sent` / `[Dingtalk] sent` / `[Slack] sent`。

### 1.3 email 渠道（mock SMTP 会话捕获）

`POST /api/notification/send` `{"channels":["email"],...}` → `/tmp/acf-r7-smtp.log` 完整会话：

```
S: 220 acf-r7-mocksmtp ESMTP ready
C: EHLO [127.0.0.1]
C: MAIL FROM:<verify@example.com>
C: RCPT TO:<ops@example.com>
C: DATA ... Subject: R7-D email / Content-Type: text/plain; charset=utf-8
C: smtp session capture
C: .
S: 250 OK message accepted
```

admin-api 日志：`[Email] sent: R7-D email -> ops@example.com` ✅（nodemailer 对无 AUTH 广告的服务器自动跳过认证，`EMAIL_SECURE=false` 走明文 25）。

### 1.4 SSRF 分级（如实记录）

- **loopback 拦截**：`webhookUrl=http://127.0.0.1:9999/...` → receiver 零记录，admin-api 日志：
  `[Webhook] SSRF-blocked URL http://127.0.0.1:9999/webhook-blocked: URL host 127.0.0.1 is on the deny list (private/loopback/link-local)` ✅
- **RFC1918 拦截**：`webhookUrl=http://192.168.3.47:9999/x` → 同样 WARN 拦截 ✅
- **`EXECUTOR_ALLOW_PRIVATE_NETWORK=true` 对通知外发不生效**：本轮全程开启该 env，上述两条拦截仍发生——代码层证实（safe-http.util.ts:174-175 该开关只被 `assertSafeExecutorUrl` 读取；通知渠道走 `assertSafeHttpUrl`，无任何放行条件）。**判定：无法放行，按任务书"被拦且有明确错误反馈"记 PASS。**
- **fail-open 语义**：被 SSRF 拦截时渠道 `logger.warn` 后静默 return（webhook.channel.ts:24-31），API 仍返回 `{"success":true}`——调用方只能从服务端日志感知失败，见 §6.2。

### 1.5 渠道配置面（PATCH/GET，N11 脱敏）

- `PATCH /api/notification/channels/slack` `{enabled:true,config:{webhookUrl:...,token:"super-secret-xyz"}}` → 200，响应中 `token:"***"`；`GET /notification/channels` 同样脱敏 ✅（N11 读面脱敏兑现）
- **观察（解耦）**：PATCH 保存的 config 与实际外发 URL 是两套——渠道 send() 读 `ConfigService`（env），`NotificationConfigService.channelConfigs` 仅内存且只被 `sendTest` 的 enabled 门使用。实证：PATCH slack webhookUrl 为 `/slack-patched` 后 `POST /notification/test`，receiver 收到的仍是 env 配置的 `/slack` 路径。见 §6.1。
- **观察（500）**：`PATCH /notification/channels/webhook` → HTTP 500（`notification-config.service.ts:155` 对未知 key `throw new Error`，未映射 4xx；webhook 不在 channelDefaults 列表）。见 §6.4。

### 1.6 附带证据：任务失败告警链路

fixed_rate 任务因无在线 executor 持续 failed，admin-api 日志出现 `[sendAll] channels=email,slack,dingtalk,wecom,webhook title=Task failed: r7-metrics-fixed15 level=error ...`，且 mock 同步收到对应告警（email/slack/dingtalk/wecom 四路）——告警触发 → sendAll 扇出 → 真实外发全链在真机成立。

## 2. GET /api/metrics Prometheus 端点（验证项 2）—— ✅

### 2.1 主路径（enabled 默认）

`curl -H "Authorization: Bearer <JWT>" /api/metrics`：

```
HTTP/1.1 200 OK
Content-Type: text/plain; version=0.0.4; charset=utf-8
```

- `autoflow_scheduler_*` 8 条 series 全在（ticks/tick_duration_ms_total/last_tick_duration_ms/triggers{result}/triggers_skipped{reason}×4/dependency_triggers{result}）+ `autoflow_queue_up` + `autoflow_queue_depth{state}×5`，HELP/TYPE 注释齐全
- 进程默认指标（`collectDefaultMetrics`）：`nodejs_*/process_*` 共 78 行 ✅
- 未带 JWT → 401（类级 JwtAuthGuard，与 §4.4 同路径验证）

### 2.2 counters 增长（触发任务执行前后）

| 采样点 | ticks_total | triggers_total{result="claimed"} |
|---|---|---|
| 基线（启动后、触发前） | 0 | 0 |
| 手动 `POST /tasks/:id/trigger` + fixed_rate 15s 任务运行 ~20s 后 | 1 | 1 |
| 再等 ~45s（tick 周期推进） | 2 | 5 |

单调递增成立（reset+inc 快照同步策略未破坏 counter 语义）。

### 2.3 开关路径（实测，非仅单测）

`METRICS_PROMETHEUS_ENABLED=false` 重启后：

```
GET /api/metrics → HTTP 404
{"code":404,"message":"Prometheus metrics endpoint is disabled (METRICS_PROMETHEUS_ENABLED=false)",...}
GET /api/metrics/scheduler → 200（旧端点不受开关影响）
```

## 3. N17 PATCH 互斥（验证项 3）—— ✅

| # | 操作 | 结果 |
|---|---|---|
| 1 | 建 `executeMode=broadcast` 任务 → `PATCH {executorId:<uuid>}` | **400** `executorId (pinned executor) is mutually exclusive with executeMode=broadcast` |
| 2 | 建 `single+executorId` 任务 → `PATCH {executeMode:"broadcast"}` | **400** 同消息 |
| 3 | 对已 pin 任务 `PATCH {executorId:null}` | **200**，响应 `executorId=null`、`executeMode=single`（pin 清除成功） |
| 4 | 回归：create 同传 broadcast+executorId | **400** 同消息（R6 写入边界未回退） |

PATCH 合并态校验（task.service.ts:327-335 `assertPinBroadcastExclusive(updated.executorId, updated.executeMode)`）在两个"请求体只带一半"的场景均正确兜底，消息与 create 路径逐字一致。

## 4. POST /api/notification/send 新端点（验证项 4）—— ✅

| 场景 | 请求 | 结果 |
|---|---|---|
| sendAll | `{content, level:"critical"}`（无 channels） | 201；`[sendAll] channels=email,slack,dingtalk,wecom,webhook` 日志 + mock 收到 wecom/dingtalk/slack/email 四路（webhook 无 URL 静默跳过，见 §6.5）；默认 title `[CRITICAL] task` |
| sendToChannels | `{channels:["wecom","dingtalk","slack"]}` | 201；仅三路到达 mock（email 未触发）✅ |
| webhookUrl 自动追加 | `{channels:["slack"], webhookUrl:".../webhook-auto"}` | 201；receiver 同时收到 `/slack` 与 `/webhook-auto` 两条 ✅（controller:87-89 追加逻辑兑现） |
| 无 token | 不带 Authorization | **401** ✅ |
| 非法渠道 | `channels:["sms"]` | 400 `each value in channels must be one of the following values: email, dingtalk, wecom, slack, webhook` |
| 缺 content | `{title:...}` | 400 `content must be a string` |
| 非法 level | `level:"fatal"` | 400 枚举校验 |
| NOTIF-002 脱敏 | content 含 `SECRET_TOKEN=abc123def456` | 日志摘要落 `SECRET_TOKEN=[REDACTED]`，原文未入日志 ✅ |

## 5. /metrics/scheduler JSON 回归（验证项 5）—— ✅

`GET /api/metrics/scheduler`（JWT）→ 200，四段结构完整：

```json
{"counters":{"ticks":2,"triggersClaimed":5,"triggersSkippedLockHeld":0,...,"startedAt":"..."},
 "derived":{"avgTickDurationMs":2.5,"tickRatePerSec":0.014,...},
 "queue":{"waiting":0,"active":0,"delayed":0,"failed":6,"completed":0},
 "scheduler":{"healthy":true,"isLeader":true,"activeTimers":1,"totalScheduledTasks":1,...},
 "instance":{"pid":1699634}}
```

计数与 prom 端点同源自洽（ticks/triggersClaimed 两端口一致）；`failed=6` 为无 executor 的预期失败。prom-client 引入未破坏旧端点。

## 6. 遗留观察（不判失败）

1. **渠道配置面与外发链路解耦**（§1.5）：`PATCH /notification/channels/:key` 保存的 webhookUrl/SMTP 参数不影响实际 send() 读取的 env 配置（`notification-config.service.ts:48` 注释 "in production, persist to database" 仍未兑现）；admin-web 表单保存后"测试"能过（enabled 门 + env URL）但改 URL 不生效，易误导运维。建议后续轮次把 channelConfigs 接入 DB 持久化并让渠道 send() 优先读动态配置。
2. **SSRF 拦截对 API 调用方不可见**（§1.4）：fail-open 设计（渠道 warn 后 return），`/send` 恒返 `{"success":true}`。安全语义正确，但建议响应体带 per-channel 投递结果（或至少 blocked 标记）。
3. **`assertSafeHttpUrl` deny 列表缺口**：198.18.0.0/15（RFC 2544 benchmarking，本机 TUN 占用）与 100.64.0.0/10（CGNAT，Tailscale 常用）不在拦截范围——本轮正是借 198.18.0.1 取证"到达 mock"。内网探测/元数据场景风险有限，但严格 SSRF 守卫应一并覆盖，建议补 `isBlockedAddress`。
4. **`PATCH /notification/channels/webhook` → 500**（§1.5）：未知 key 抛裸 `Error` 未映射 `BadRequestException`；且 webhook 渠道不在 channelDefaults，前端若展示五渠道会踩此坑。
5. **webhook 渠道无 env 配置面**：`webhook.channel.ts:18` 回退读 `notification.webhookUrl`，但 `configuration.ts` 的 notification 段从未定义该键（只有 wecom/dingtalk/slack/email）——webhook 渠道实际仅支持逐请求 `webhookUrl`（`/send`、任务级 alarmWebhook）。行为可用，但配置面命名易误导。
6. **email 渠道无 SSRF 检查**：SMTP host 直连任意地址（本轮即 127.0.0.1:1025）。SMTP 非 http 语义下 `assertSafeHttpUrl` 不适用，但 host 同样来自运维配置，风险可控，如实记录。
7. **启动 env 校验细节**：`EMAIL_FROM/EMAIL_TO` 走 class-validator email 格式校验，`verify@acf.local` 这类非规范 TLD 会被 fail-fast 拒绝（本轮改用 example.com）；另 `apps/admin-api/.env` 是指向仓库根 `.env` 的符号链接，手动起服时其 `REDIS_PASSWORD` 会渗入环境（显式置空可覆盖）——与代码无关的部署摩擦。

## 7. 结论

第七轮 5 项真机闭环全部 **PASS**：五渠道外发首次实现端到端可证（webhook/wecom/dingtalk/slack payload 形状与渠道实现逐字段一致、email 完整 SMTP 会话落 mock），SSRF 守卫按设计拦截 loopback/RFC1918 且 `EXECUTOR_ALLOW_PRIVATE_NETWORK` 确认不影响通知链路（放行条件代码+真机双重证实）；prom `/api/metrics` 端点主路径与开关路径均实测通过，counters 单调增长语义成立；N17 PATCH 合并态互斥四分支全中；`/api/notification/send` 的 sendAll/子集/webhookUrl 自动追加/401/DTO 校验/日志脱敏兑现；`/metrics/scheduler` 无回归。遗留 7 项观察以配置面解耦（§6.1）与 SSRF deny 列表缺口（§6.3）最值得后续跟进。

## 8. 环境清理确认

- [x] `docker rm -f acf-r7-postgres acf-r7-redis`（含匿名卷随容器删除）
- [x] kill admin-api（node dist/main.js）、python receiver（:9999）、python SMTP（:1025）全部进程
- [x] 删除 `/tmp/acf-r7-*` 临时文件（脚本/日志/pid/token）
- [x] `ss -tln` 确认 25432/26379/3105/9999/1025 全部释放；未触碰 metabase/flow2api 等他人容器
- [x] 仓库除本报告外零改动，未执行任何 git commit

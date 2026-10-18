# AutoCodeFlow 第七轮修复复验报告 V2（VERIFY-round7v2-fixes）

- 验证人：第七轮真机复验 agent V2
- 日期：2026-09-03
- 代码基线：`develop` 工作树（含全部未提交第七轮 V1–V5 修复；未做任何 git commit）
- 环境：Docker 一次性容器 + 宿主进程直跑（沿用 round6/round7 端口规划）：
  - `acf-r7v2-postgres`（postgres:16-alpine，宿主 25432）、`acf-r7v2-redis`（redis:7-alpine，宿主 26379），全新空卷；`migration:run` 先行，25/25 成功（`select count(*) from migrations` = 25）
  - admin-api：`npx nest build` 后 `node dist/main.js`，宿主 3105，日志 `/tmp/acf-r7v2/admin.log`
  - env 关键项同 round7（`WECOM/DINGTALK/SLACK_WEBHOOK` 指向 mock 的 `-env` 路径、`EMAIL_HOST=127.0.0.1:1025` 明文 mock SMTP）；**未设置** `EXECUTOR_ALLOW_PRIVATE_NETWORK`
- **mock 可达手段（如实声明，与首轮的差异）**：V3 收紧后 198.18.0.0/15 也被 `assertSafeHttpUrl` 拦截，且 loopback/RFC1918 一贯全拦、通知链路无任何放行 env——首轮借以取证的 198.18.0.1 已不可用。本轮改用 **docker 自定义桥接网 `acf-r7v2-net`（TEST-NET-3 文档段 203.0.113.0/28）**，receiver 容器固定 IP `203.0.113.2:9999`（node:22-alpine 跑 `/tmp/acf-r7v2/receiver.js`，全量记录 method/path/headers/body 到 `/tmp/acf-r7v2/receiver.log`）。203.0.113.x 不在守卫 deny 列表（非 private/loopback/link-local/benchmark/CGNAT/multicast），守卫按真实语义放行，未改仓库代码、未绕过任何检查。email 渠道无 SSRF 检查（首轮 §6.6 既有行为，非回归），SMTP mock 仍绑 `127.0.0.1:1025`。

## 0. 总览

| # | 复验项 | 结果 |
|---|---|---|
| V1 | 渠道 config-first（ChannelConfigStore） | ✅ PASS（四渠道实证；任务书"PATCH /channels/webhook"措辞与实现不符，见 §1.4） |
| V2 | send 响应 per-channel results | ✅ PASS（sent/blocked/skipped/failed 四语义全实测） |
| V3 | SSRF deny 补 198.18.0.0/15 + 100.64.0.0/10 | ✅ PASS（sendWebhook 400 仅 service 层+单测，无 HTTP 端点，见 §3.3） |
| V4 | 未知 channel key → 400 | ✅ PASS（此前 500） |
| 回归 | 五渠道 mock 全收到 + metrics 两端点 | ✅ PASS |
| N17 | PATCH 互斥快速回归 | ✅ PASS |

## 1. V1 config-first —— ✅

### 1.1 基线（无保存配置 → env 兜底）

`POST /api/notification/send {"channels":["slack"]}` → 201，receiver 收到 **`/slack-env`**（env `SLACK_WEBHOOK` 路径）——env 兜底语义保留。

### 1.2 保存配置优先于 env（首轮 §6.1 解耦缺陷的闭环）

- `PATCH /channels/slack {enabled:true,config:{webhookUrl:"http://203.0.113.2:9999/slack-configfirst"}}` → 200；再 send → receiver 收到 **`/slack-configfirst`**（不再是 `/slack-env`）✅
- wecom/dingtalk 同法 → receiver 收到 `/wecom-configfirst`、`/dingtalk-configfirst` ✅
- email：`PATCH /channels/email {config:{to:"ops2@example.com",password:"super-secret-xyz"}}` → send → SMTP mock 会话 `RCPT TO:<ops2@example.com>`（env `EMAIL_TO=ops@example.com` 被保存配置覆盖）✅；读面 `GET /channels` 中 `password:"***"`（N11 脱敏不回退，store 持原值供发送路径）✅

### 1.3 与首轮差异

首轮 §1.5/§6.1：PATCH 保存的 config 与实际外发 URL 两套并行（send() 只读 env）。本轮四渠道全部改为 **saved config first, env fallback**（`*.channel.ts` 读 `ChannelConfigStore.get(key)`），真机证实生效。

### 1.4 措辞偏差（如实记录，不判 FAIL）

任务书 V1 写"PATCH /channels/webhook 配置 mock receiver URL"——实现中 **webhook 渠道刻意不在配置面**（`channelDefaults` 仅 email/slack/dingtalk/wecom；`notification-config.service.ts:174-176` 注释明示 "webhook is per-request only and intentionally absent"），实测 `PATCH /channels/webhook` → **400** `Unknown notification channel: webhook. Valid channels: email, slack, dingtalk, wecom`（即 V4 行为，非 500）。连带观察：`webhook.channel.ts:24` 的 `this.store.get("webhook")?.webhookUrl` 回退分支实际不可达（store 只被四键 syncStore 写入），属轻微死代码/命名误导，建议后续轮次二选一：把 webhook 纳入配置面，或删除该回退。webhook 渠道的 config-first 语义以"逐请求 webhookUrl"兑现（见 §5 回归，receiver 收到 `/webhook-final`）。

## 2. V2 per-channel results —— ✅

`POST /api/notification/send` 响应体（201）：`{"success":true,"results":{"slack":"sent"}}`——首轮恒返 `{"success":true}`（§6.2 观察）已闭环。四语义实测：

| 场景 | results | HTTP |
|---|---|---|
| 正常投递（config-first URL） | `sent` | 201 |
| 渠道配置 loopback URL（`http://127.0.0.1:9999/loopback-test`） | **`dingtalk:"blocked"`** | **201（整体仍 2xx）** ✅ |
| webhook 无任何 URL | `skipped` | 201 |
| 目标不可达（203.0.113.9 无监听，3 次重试 ~12s） | `failed` | 201 |

`sendAll`（不带 channels）响应含全五键：`{"email":"sent","slack":"sent","dingtalk":"sent","wecom":"sent","webhook":"skipped"}`。blocked 时服务端另有 `WARN ... blocked by SSRF guard` 日志。

## 3. V3 SSRF deny 补段 —— ✅

### 3.1 198.18.0.0/15（首轮借以绕过取证的段）

`PATCH /channels/wecom {webhookUrl:"http://198.18.0.1:9999/wecom"}` → send → `results.wecom:"blocked"`；receiver 零新增记录；admin-api 日志：
`[Wecom] SSRF-blocked URL http://198.18.0.1:9999/wecom: URL host 198.18.0.1 is on the deny list` ✅（首轮该 URL 是**可达 mock** 的——决定性反转）

### 3.2 100.64.0.0/10（CGNAT）

`PATCH /channels/dingtalk {webhookUrl:"http://100.64.0.1:9999/dt"}` → `results.dingtalk:"blocked"` + 同款 WARN ✅。`/send` 逐请求 `webhookUrl=http://198.18.0.1:9999/x` → `results.webhook:"blocked"` ✅。

### 3.3 sendWebhook 直调 400（如实记录：无 HTTP 端点）

全仓 grep + 真机路由表证实：`NotificationService.sendWebhook` **无任何 controller 调用**（notification 模块仅映射 channels GET/PATCH、channels/:key/test、test、send 五路由；`POST /api/notification/sendWebhook` → 404）。任务书"找 controller 端点"的直调路径在本代码库不存在。400 语义以单测兑现并实测通过：`notification.service.spec.ts` "should throw BadRequestException when the SSRF-blocked"（`npx jest src/modules/notification src/common/utils/__tests__/safe-http.util.spec.ts` → **5 suites / 108 tests 全 PASS**）。fail-open 扇出路径（/send）对 blocked URL 返 2xx + `results:"blocked"`（§3.2），与代码注释的双轨设计一致。

## 4. V4 未知 channel key 400 —— ✅

`PATCH /api/notification/channels/notakey` → **400**（首轮 §6.4 为 500）：
`{"code":400,"message":"Unknown notification channel: notakey. Valid channels: email, slack, dingtalk, wecom",...}`
大小写变体 `WEBHOOK` 同样 400。裸 `Error` 已映射 `BadRequestException`（`notification-config.service.ts:177-180`）。

## 5. 回归 —— ✅

- **五渠道 mock 全收到**（手段见页首声明）：`sendAll` 一次触发 → receiver 依次记录 `/slack-final`、`/dingtalk-final`、`/wecom-final`（config-first URL），SMTP mock 完整会话（`Subject: R7V2-REG-five`，`RCPT TO:<ops2@example.com>`）；webhook 经逐请求 URL → `/webhook-final`，body `{title,content,level,timestamp}` 形状与 `webhook.channel.ts` 一致。五渠道 results 全 `sent`（webhook 单发）/四 `sent`+一 `skipped`（sendAll 无 URL，语义正确）。
- **`GET /api/metrics`**（JWT）→ 200 `text/plain; version=0.0.4`，`autoflow_*` 17 条 series，`autoflow_scheduler_ticks_total 7` 与调度实况自洽。
- **`GET /api/metrics/scheduler`** → 200，五段结构完整（counters/derived/queue/scheduler/instance），`ticks=7` 与 prom 端点同源，`healthy=true`。
- 通知模块 + safe-http 单测 108/108 通过（含 V1–V5 新增用例）。

## 6. N17 PATCH 互斥快速回归 —— ✅

建 `executeMode=broadcast` 任务（201）→ `PATCH {executorId:<合法 uuid v4>}` → **400** `executorId (pinned executor) is mutually exclusive with executeMode=broadcast`（消息与 create 路径逐字一致）；同任务 `PATCH {description}` → 200（无误伤）。附带：非法 UUID 形态的 executorId 被 DTO 层先拦（400 `executorId must be a UUID`），写入边界双层防御均在位。

## 7. 遗留观察（不判失败）

1. §1.4：webhook 渠道配置面缺席与 `store.get("webhook")` 不可达回退并存，建议后续统一。
2. §3.3：`sendWebhook`（含其 400 语义）无 HTTP 消费方，若 SDK 计划使用需补端点，否则可视作预留 API。
3. blocked 的异常消息文案仍为 "private/loopback/link-local"，未列出新增的 benchmark/CGNAT 段（`safe-http.util.ts:33`），排障时略有误导。
4. email 渠道 SMTP host 仍无 SSRF 检查（127.0.0.1:1025 直连成功即本轮取证手段本身），与首轮 §6.6 相同，非回归。

## 8. 结论

第七轮 V1–V5 五项修复真机复验**全部通过**：渠道配置面从"写-only 摆设"变为 send 路径唯一优先源（四渠道逐路实证，env 退为兜底）；`/send` 响应体兑现 per-channel results 四语义且 blocked 不再伪装成功、整体保持 2xx；SSRF deny 补齐 198.18.0.0/15 与 100.64.0.0/10——首轮赖以绕过取证的 198.18.0.1 本轮实测被拦（决定性反转），mock 可达改经 TEST-NET-3 docker 网段取证；未知 channel key 500→400；webhook 死 env 引用删除后逐请求 URL 路径行为不变。五渠道外发、prom/JSON 双 metrics、N17 互斥均无回归。两处措辞级偏差（webhook 不在 PATCH 面、sendWebhook 无 HTTP 端点）如实记录，不构成功能缺陷。

## 9. 环境清理确认

- [x] `docker rm -f acf-r7v2-postgres acf-r7v2-redis acf-r7v2-receiver`；`docker network rm acf-r7v2-net`
- [x] kill admin-api（`node dist/main.js`）与 SMTP mock（python）宿主进程
- [x] 删除 `/tmp/acf-r7v2/` 全部临时文件（脚本/日志/env/token）
- [x] `ss -tln` 确认 25432/26379/3105/1025 释放；未触碰 metabase/flow2api 等他人容器
- [x] 仓库除本报告外零改动，未执行任何 git commit

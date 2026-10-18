# 通知、AI 与应用部署模块审查报告

**审查时间**: 2025-07
**审查范围**: notification.service.ts, webhook.channel.ts, ai.service.ts, application.controller.ts, app-deployment.service.ts

---

## 问题列表

### NOTIF-001 [High] Webhook URL 无 SSRF 防护

**文件**: `apps/admin-api/src/modules/notification/channels/webhook.channel.ts`, 行 15-39
**函数**: `send()`

**问题描述**:
```typescript
await axios.post(webhookUrl, body, { timeout: 10_000, ... });
```
`webhookUrl` 直接由用户配置或 per-task 配置提供，没有任何 SSRF（Server-Side Request Forgery）防护：
- 可以指向内网服务（`http://169.254.169.254/` AWS metadata、`http://localhost:6379` Redis 等）
- 可以探测内网端口
- 无 URL scheme 白名单（file:// 等）
- 无域名/IP 黑名单

相同问题也存在于 DingTalk、WeCom、Slack channel 的 URL 配置，以及 `executor-package.service.ts` 中的 `pushToExecutors()` 里对 executor.address 的直接使用。

**修复建议**:
```typescript
import { URL } from 'url';
import { isIPv4, isIPv6 } from 'net';

function validateWebhookUrl(url: string): void {
  const parsed = new URL(url); // 抛出异常如果 URL 无效
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BadRequestException('Webhook URL must use http or https');
  }
  // 检查是否为私有 IP
  const { hostname } = parsed;
  if (isPrivateHost(hostname)) {
    throw new BadRequestException('Webhook URL must not point to private network');
  }
}
```

---

### NOTIF-002 [Medium] sendAll() 日志记录 payload content——可能泄露敏感告警内容到日志

**文件**: `apps/admin-api/src/modules/notification/notification.service.ts`, 行 48-50
**函数**: `sendAll()`

**问题描述**:
```typescript
this.logger.log(
  `[sendAll] title=${payload.title} level=${payload.level} content=${payload.content}`
);
```
通知 `content` 字段被完整记录到日志，而 content 可能包含任务日志片段、错误堆栈、甚至 AI 分析结果（`notifyFailureWithConfig` 传入 aiAnalysis）。敏感业务数据可能通过日志被意外暴露。

**修复建议**:
```typescript
this.logger.log(
  `[sendAll] title=${payload.title} level=${payload.level} content=[${payload.content?.length ?? 0} chars]`
);
```

---

### NOTIF-003 [Medium] AlertSilence 存储在内存中，重启后丢失且无大小限制

**文件**: `apps/admin-api/src/modules/notification/notification.service.ts`, 行 37-38, 123-147
**函数**: `addSilence()`, `cleanExpiredSilences()`

**问题描述**:
- `silences` Map 存储在进程内存中，服务重启后所有静默规则丢失
- 多实例水平扩展时各实例的静默状态不一致
- `addSilence()` 没有对 Map 大小做限制，攻击者可通过 API 无限添加静默规则导致内存泄漏
- `cleanExpiredSilences()` 只在外部调用时触发，没有定时清理

**修复建议**:
- 将静默规则持久化到 Redis 或数据库
- 限制最大静默规则数量（如 100 条）
- 添加定期清理的 @Cron 任务

---

### AI-001 [Medium] AI 服务的 Ollama host URL 来自数据库配置，可被 SSRF 利用

**文件**: `apps/admin-api/src/modules/ai/ai.service.ts`, 行 202-210
**函数**: `callOllama()`

**问题描述**:
```typescript
const host = await this.getAiConfig('ollamaHost', 'http://localhost:11434');
const r = await axios.post(`${host}/api/generate`, ...);
```
`ollamaHost` 可以通过系统配置 API 修改（存储在数据库），修改后 AI 服务会向攻击者指定的 URL 发送包含任务日志的请求。这是存储型 SSRF——恶意管理员可以通过修改配置将所有 AI 分析请求重定向到外部服务器，泄露任务日志。

**同样的风险**: `openaiBaseUrl` 字段也可以被覆盖指向恶意服务器。

**修复建议**:
- 对 `ollamaHost` 和 `openaiBaseUrl` 应用与 webhook URL 相同的 SSRF 检查
- 或者限制这些配置只能由 ADMIN 角色修改，并要求 URL 必须通过白名单验证

---

### AI-002 [Low] AI 响应未验证格式——suggestSchedule 解析失败后返回当前 cron 无通知

**文件**: `apps/admin-api/src/modules/ai/ai.service.ts`, 行 96-116
**函数**: `suggestSchedule()`

**问题描述**:
```typescript
try {
  const parsed = JSON.parse(jsonStr);
  if (parsed.suggestedCron && parsed.reasoning) return parsed;
} catch (e) {
  this.logger.warn(`suggestSchedule parse error: ...`);
}
// 解析失败时静默返回当前 cron
return { suggestedCron: currentCron || '0 * * * *', reasoning: 'AI returned unparseable response.' };
```
AI 返回无法解析的 JSON 时，系统静默降级，用户界面会显示"AI 建议"实际上是当前值，可能造成用户误解（以为 AI 分析过并维持了当前计划）。

**修复建议**:
明确区分"AI 建议"和"回退到当前值"的响应，在 API 响应中添加 `source: 'ai' | 'fallback'` 字段。

---

### APP-001 [Medium] webhook 端点返回 200 即使找不到应用，可被用于应用名枚举

**文件**: `apps/admin-api/src/modules/application/application.controller.ts`, 行 174-176
**函数**: `webhook()`

**问题描述**:
```typescript
if (!targetApp) {
  logger.warn(`Webhook: no application found with name "${dto.appName}"`);
  return { ok: true, message: 'No matching application' };
}
```
当应用不存在时返回 `{ ok: true }` 而非 4xx 错误。这意味着攻击者可以通过 webhook 接口枚举已存在的应用名称（存在时触发签名验证失败 401，不存在时返回 200）。

**修复建议**:
- 返回固定的模糊响应，不区分"应用不存在"和"签名无效"
- 或者对不存在的应用也返回 401

---

### APP-002 [Low] 应用包 URL 使用 API_BASE_URL 环境变量，fallback 为 localhost

**文件**: `apps/admin-api/src/modules/application/application.controller.ts`, 行 133-135

**问题描述**:
```typescript
const apiBase = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3105}`;
```
如果生产环境未设置 `API_BASE_URL`，包下载 URL 会包含 `localhost`，executor 节点无法访问，导致部署失败但不会立即报错。

**修复建议**:
在生产环境（`NODE_ENV=production`）中，若 `API_BASE_URL` 未设置，应抛出启动错误或在 Joi schema 中标记为 required。

---

## 正面发现

- ✅ 通知发送使用 Promise.allSettled()——单个渠道失败不影响其他渠道
- ✅ Webhook 有 10 秒超时防止长时间挂起
- ✅ Webhook channel 有 withRetry() 重试机制
- ✅ AI 日志净化（sanitizeLogs）——剥离密钥、Bearer token、长十六进制字符串
- ✅ AI 日志截断到 3000 字符防止超大 payload
- ✅ OpenAI 调用 max_tokens: 500 防止超长响应
- ✅ 应用 webhook 使用 HMAC-SHA256 + timestamp 防重放（5 分钟窗口）
- ✅ timingSafeEqual 防止签名时序攻击
- ✅ webhookSecret 字段 select: false 防止普通查询泄露
- ✅ 文件上传：ZIP magic number 检查 + 扩展名白名单

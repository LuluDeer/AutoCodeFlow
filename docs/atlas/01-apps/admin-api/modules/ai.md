# ai 模块 — AI 辅助（失败分析 / 排程建议，OpenAI / Ollama）

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/ai

## 职责

对接可选的 AI 提供商（OpenAI 兼容 API 或本地 Ollama），提供三类能力：执行失败根因分析（`analyzeFailure`）、Cron 排程建议（`suggestSchedule`）、应用部署健康分析（`analyzeAppHealth`）。provider 可 `disabled`（默认）——所有入口 fail-open，AI 不可用绝不影响任务主链。

## 目录结构与关键文件

```
modules/ai/
├── ai.module.ts              装配：SystemConfigModule + 两个 service + controller
├── ai.controller.ts          @Controller("ai") 全路由 ADMIN-only（N11/R11）
├── ai.service.ts             提示词构造 / 脱敏 / callOpenAI / callOllama / 配置解析
├── ai-analysis.service.ts    ARCH-30 包装层：重试 + autoflow_ai_analysis_total 指标 + fail-open
└── __tests__/                三组单测
```

## 路由（controller 前缀 `ai`，实际路径 `/api/ai`；三条均 `@Roles(ADMIN)`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/config` | 当前生效配置（DB `ai.*` 键 + env 兜底），`hasApiKey` 布尔（永不回显 key 值） |
| POST | `/config` | 保存配置到 system_configs（`batchUpsert`）；key 仅在传非空值时更新 |
| POST | `/test` | 用固定样例报错真实调一次 provider，返回 `{ok, message}` |

配置键与默认值：`ai.provider`（`disabled | openai | ollama`）、`ai.openaiModel`（`gpt-4o-mini`）、`ai.openaiBaseUrl`（`https://api.openai.com/v1`）、`ai.ollamaHost`（`http://localhost:11434`）、`ai.ollamaModel`（`llama3`）、`ai.openaiApiKey`（`isSecret`）。env 兜底同名：`AI_PROVIDER` / `OPENAI_API_KEY` / `OPENAI_MODEL` / `OLLAMA_HOST` / `OLLAMA_MODEL`（`configuration.ts` 的 `ai` 段）。

## 关键机制

### 失败分析链（ARCH-30 分层）

```
TaskProcessor（派发失败最后一次尝试）/ TaskService.analyzeExecution（手动触发端点）
  → AiAnalysisService.analyzeFailure(task, logs)     ← 永不抛错（fail-open 契约）
      ├─ 重试 1 次封装 + autoflow_ai_analysis_total 指标（outcome 标签）
      └─ 内部调 AiService.analyzeFailure
           ├─ provider=disabled → 返回 ""（调用方视为无分析）
           ├─ sanitizeLogs：env 赋值 KEY=xxx、Bearer token、≥32 位 hex、
           │   ≥40 位 base64 全部 REDACTED，再截断 3000 字符（S-10，防泄密外发）
           └─ callProvider → callOpenAI（axios，Bearer）/ callOllama（/api/generate）
```

- provider 未知/调用出错 → 返回 `""`，主链无感。
- 分析结果落库到 `task_executions.aiAnalysis`，并随终态事件载荷（`ExecutionTerminalEventPayload.aiAnalysis`）透传给通知侧。

### 排程建议（suggestSchedule）

`TaskService.suggestSchedule` 聚合执行统计（成功率、均值/P95 时长、成功率最高的 UTC 小时）→ AiService 构造 prompt 要求**只回 JSON** `{suggestedCron, reasoning}` → 剥 markdown 围栏后解析。JSON 解析失败或字段缺失：记 warn 并返回 `{suggestedCron: 当前值或 "0 * * * *", fallback: true}`（AI-002：显式 fallback 标记，前端可区分「AI 建议」与「回退」）。AI 返回的 `suggestedCron` 在服务层经 `node-cron.validate` 前置校验（WIKI-OPT-3，与调度器注册 / maintenance-window util 同一实现）：非法（如 "every 5 minutes"）→ 记 warn 并回退当前值（`fallback: true`，reasoning 为 "AI returned invalid cron expression."），非法 cron 永不透出落库。暴露为 `POST /api/tasks/:id/suggest-schedule`（见 [task](task.md)）。

## 配置解析优先级（getAiConfig）

```
system_configs 表中 ai.<key>（DB，POST /api/ai/config 写入）
        │ 命中且非空 → 采用
        ▼ 未命中 / 抛错（键不存在）
ConfigService `ai.<key>`（env：AI_PROVIDER / OPENAI_* / OLLAMA_*，configuration.ts ai 段）
        │
        ▼
defaultValue（如 provider 默认 "disabled"）
```

每次调用实时解析（不缓存进程内状态）——DB 改配置立即对下一次调用生效；`callOpenAI` / `callOllama` 同样逐次取 `openaiBaseUrl` / `ollamaHost`，出站前过 `assertSafeHttpUrl` SSRF 守卫（ai.service.ts 头部 import）。

## 与其他模块的关系

- 依赖 config 模块：`SystemConfigService`（DB 配置优先，env 兜底）。
- 被 [task](task.md) 依赖（`forwardRef` 于 task.module 装配）：processor 自动分析 / `analyzeExecution` / `suggestSchedule` 三个消费点。
- 被 application 模块消费：部署健康分析（`analyzeAppHealth`）。
- 数据出口：`task_executions.aiAnalysis` 列、通知载荷 `aiAnalysis` 字段（[notification](notification.md) 消费）。

## 常见改动场景

- 接入新 provider：`callProvider` switch 加分支 + `SaveAiConfigDto`/`getEffectiveConfig` 加键 + `SaveAiConfigDto.provider` 的 `@IsIn` 枚举同步。
- 调整脱敏规则：`sanitizeLogs`（ai.service.ts）——注意 notification 的 `buildContentDigest` 有一份独立但同思路的实现（NOTIF-002），安全口径变化需两侧同步。
- 关闭 AI：`ai.provider=disabled`（DB 或 env `AI_PROVIDER`）——所有入口零副作用，无需改代码。
- API key 轮换：`POST /api/ai/config` 传新值即覆盖；GET 永不回显。

## 相关文档

- [task](task.md)（三个消费端点）· [notification](notification.md)（aiAnalysis 透传）
- [系统配置](config.md)（system_configs 存储机制，同应用内模块）

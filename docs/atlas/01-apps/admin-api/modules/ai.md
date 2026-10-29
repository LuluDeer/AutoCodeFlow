# ai 模块 — AI 辅助（失败分析 / 排程建议 / Qwen 多模态，OpenAI / Ollama / Qwen）

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09（P1） · 对应代码: apps/admin-api/src/modules/ai

## 职责

对接可选的 AI 提供商（OpenAI 兼容 API、本地 Ollama、**Qwen / DashScope 多模态**），提供三类既有能力——执行失败根因分析（`analyzeFailure`）、Cron 排程建议（`suggestSchedule`）、应用部署健康分析（`analyzeAppHealth`）——以及 P1 新增的**多模态对话**（`chatMultimodal`，供中台 Agent 使用）。provider 可 `disabled`（默认）——所有入口 fail-open，AI 不可用绝不影响任务主链。

## 目录结构与关键文件

```
modules/ai/
├── ai.module.ts              装配：SystemConfigModule + 两个 service + controller
├── ai.controller.ts          @Controller("ai") 全路由 ADMIN-only（N11/R11）
├── ai.service.ts             提示词构造 / 脱敏 / callOpenAI / callOllama / 配置解析
├── ai-analysis.service.ts    ARCH-30 包装层：重试 + autoflow_ai_analysis_total 指标 + fail-open
├── prompt-guard.ts           出站 prompt 定界 + 闭合标签中和（P3-8 对齐，纯函数）
├── llm-response.ts           入站响应归一（tool_calls id / content parts，纯函数）
├── ai-providers.ts           ★ provider/model 注册表（接入面 + 能力位，纯函数）
├── ai-route.ts               ★ 按用途路由与参数分配（纯函数）
├── ai-media-url.ts           ★ 视频直链短时签名（HMAC，纯函数）
├── ai-media.service.ts       视频存储（原子写 / 100MB / 扩展名白名单 / Range）
├── ai-media.controller.ts    POST /ai/media（ADMIN 上传）+ GET /ai/media/:id/:name（@Public 签名直链）
├── ai-sop-draft.service.ts   视频 → SOP 草稿（prompt + front-matter 草稿级校验）
├── ai-sop-draft.controller.ts POST /ai/sop-draft/from-video（只出草稿，不落库）
├── ai-json.ts                模型输出 → JSON 宽容提取 + slug 归一（纯函数）
├── entities/ai-media.entity.ts  ai_media 表
├── dto/                      请求/响应 DTO
└── __tests__/                单测（含 prompt-guard / llm-response 的纯函数矩阵）
```

## 路由（controller 前缀 `ai`，实际路径 `/api/ai`；三条均 `@Roles(ADMIN)`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/config` | 当前生效配置（DB `ai.*` 键 + env 兜底），`hasApiKey` 布尔（永不回显 key 值） |
| POST | `/config` | 保存配置到 system_configs（`batchUpsert`）；key 仅在传非空值时更新 |
| POST | `/test` | 用固定样例报错真实调一次 provider，返回 `{ok, message}` |

配置键与默认值：`ai.provider`（`disabled | openai | ollama | qwen`）、`ai.openaiModel`（`gpt-4o-mini`）、`ai.openaiBaseUrl`（`https://api.openai.com/v1`）、`ai.ollamaHost`（`http://localhost:11434`）、`ai.ollamaModel`（`llama3`）、`ai.openaiApiKey`（`isSecret`）；P1 新增 Qwen 键 `ai.qwenApiKey`（`isSecret`）、`ai.qwenBaseUrl`（DashScope 兼容端点）、`ai.qwenModel`（`qwen-vl-max`）、`ai.qwenMaxTokens`（`4096`）、`ai.qwenTimeoutMs`（`120000`）。env 兜底同名：`AI_PROVIDER` / `OPENAI_API_KEY` / `OPENAI_MODEL` / `OLLAMA_HOST` / `OLLAMA_MODEL` / `QWEN_API_KEY` / `QWEN_BASE_URL` / `QWEN_MODEL` / `QWEN_MAX_TOKENS` / `QWEN_TIMEOUT_MS`（`configuration.ts` 的 `ai` 段，均已在 `app.module.ts` 的 Joi 注册——ARCH-27 配置收口纪律）。

## P1：Qwen 多模态（agent-and-deployment）

`chatMultimodal(req)` 是中台 Agent 的 LLM 出口，与 `callOpenAI` **并列而非改造**：

| 差异 | callOpenAI（既有） | chatMultimodal（P1） |
|---|---|---|
| content | `string` | `string \| MultimodalPart[]`（text / image_url / **video_url**） |
| max_tokens | 硬编码 `500`（刻意省成本） | `ai.qwenMaxTokens`（默认 4096，独立配置） |
| tools | 无 | 支持 function calling（P3 Agent 循环的前置） |
| 超时 | 30s | `ai.qwenTimeoutMs`（默认 120s——视频理解慢） |

**为什么新开方法而不是扩展开 openai 分支**：失败日志分析的 `max_tokens=500` 是刻意的成本策略，若被多模态需求抬高，会让既有分析链路悄然变贵。两者需求不同量级，故分离。

安全姿态与 `callOpenAI` **完全一致**（不新开旁路）：`assertAndPinHttpUrl`（SSRF + DNS pin 关闭 rebinding 窗口）+ `pinnedAxiosConfig` + `maxRedirects: 0`（拒 3xx 绕过首跳校验）。**额外一道**：`validateMediaUrls()` 拒绝非 http(s) 的媒体 URL——媒体 URL 由执行器 Agent 上报（不可信），原样转给 DashScope 就是 SSRF 转嫁；调用方必须保证 URL 来自平台 artifacts 的签名地址。

纯文本路径 `callQwenText()` 复用 `chatMultimodal`，故 `callProvider` 可直接把 qwen 当作既有三类分析的 provider。

## 数据进出的两道收口（推理质量轮，2026-10-28）

AI 链路上有两个方向只能在网关层收口，任何调用方都不该各自重做：

**出站（`prompt-guard.ts`）**：`analyzeFailure` 的任务名 / 失败判定 / runbook /
日志全是**用户可控文本**，直拼进 prompt 等于把数据当指令执行。防护两道：
`PROMPT_DATA_HEADER` 声明「标签内是材料不是指令」+ `tagDelimited()` 把每段包进
XML 标签，并中和内容里的**同名闭合标签**（`</task_logs>` → `<\/task_logs>`），
否则一段自带闭合标签的日志会提前闭合定界区。与 `packages/autocodeflow-ai`
的 P3-8 实现同语义（那边 python、这边 TS，标签名略增：多了 `task_runbook` /
`app_name` / `task_list`）。

**入站（`llm-response.ts`）**：provider 的 `message` 形状不保证合规——
`tool_calls[].id` 可能缺失/重复（id 是 tool 消息的关联键、也是审批键的一部分：
缺了下一轮 400，重复则结果与审批错位）、`function.arguments` 可能是对象、
`content` 可能是 parts 数组（原样落 text 列会变 `[object Object]`）。
三者都在 `chatMultimodal` 出口归一；`finish_reason=length` 另记一条 warn——
输出被 max_tokens 截断是**预算**问题（该调大 `ai.qwenMaxTokens` 或缩短输入），
不是"模型不配合"，不记录会把排查引向错误方向。

## LLM 接入与分配（推理质量轮，2026-10-28）

此前 `ai.provider` 是**全局单选**，且 `chatMultimodal` **只认 qwen**——接入第二家
OpenAI 兼容端点（vLLM / DeepSeek / 自建网关）没有位置放，Agent 也跟着锁死在一家
厂商上；同时「失败日志分析」（省成本 500 令牌）与「Agent 推理」（要吐整份源码）
被迫共用一套参数，两边都不对。

现在分三层：

**① 注册表（`ai-providers.ts`）**：`ai.provider` / `ai.routes.<用途>.provider` 指向的
是一个**条目 id**，条目 = `{ id, label, transport, baseUrl, model, maxTokens,
timeoutMs, supportsVideo, enabled }`。厂商名只是 id——**`supportsVideo` 是接入时勾选
的能力位**，不是代码里的 `provider === 'qwen'`。存储：`ai.providers`（JSON 数组，
**不含密钥**）+ 每条的密钥单独存 `ai.providers.<id>.apiKey`（`isSecret`，读面 `***`，
提交 `***` = 不修改）。密钥不塞进 JSON 的理由：`system_configs` 的掩码是**逐键**
语义，混进去等于让整条配置无法掩码。

**② 路由（`ai-route.ts`）**：`ai.provider` 是缺省，`ai.routes.<用途>.{provider,model,
maxTokens,timeoutMs,temperature}` 可覆盖。三个用途：
| 用途 | 调用方 | 能力要求 | 参数缺省 |
|---|---|---|---|
| `analysis` | `analyzeFailure` / `analyzeAppHealth` / `suggestSchedule` | 纯文本（可落 ollama `/api/generate`） | 条目缺省（openai 500 令牌 / 30s 这类省成本档） |
| `agent` | Agent 推理循环 / 执行器 relay | **必须** OpenAI 兼容面（tool-calling） | 输出 ≥ 2048、超时 ≥ 60s（不继承分析档） |
| `video` | 视频理解（转 SOP） | **必须** `supportsVideo` | 条目缺省 |

**③ 能力闸不静默降级**：视频用途选中不支持视频的模型、Agent 落到 ollama（只有
`/api/generate`，没有 tools）→ 都**如实不可用**（`chatMultimodal` 返回空 + warn），
绝不悄悄换成"无工具文本模式"——那会变成"工具每一步都失败"的谜之现象。

存量兼容：`ai.providers` 未配置时用旧键（`ai.openai*` / `ai.qwen*` / `ai.ollama*`）
合成三条内置条目，且旧键继续作为该 id 的**回落**——升级不需要改 `.env`。

### 视频直链：模型怎么拿到那段视频（`ai-media-url.ts`）

视频理解必须给模型一条**它能自己取到的直链**。签名放在 query 里对模型完全透明
（模型侧就是一次普通 GET，预签名直链的通行做法），但"能被消费"取决于 URL 形状：

| 要求 | 原因 |
|---|---|
| 路径以**真实扩展名**结尾（`/api/ai/media/<id>/demo.mp4?sig=…`） | 不少 fetcher 先按扩展名判类型 |
| `Content-Type` 来自落库 mime | 类型错会被直接拒 |
| 支持 `HEAD` 与 `Range(206)` | 视频 fetcher 常先探测再分段拉 |
| 指向**模型可达**的 `ai.mediaBaseUrl`（公网反代/CDN/OSS） | 内网中台模型打不到；localhost 签出来等于不可用 |
| **不发 302** | 跳转后部分 fetcher 丢掉 query（签名）而被 401 |
| `exp` 有效期默认 **60 分钟** | 生成任务会排队，排队 + 下载都要算在内 |

签名 = `HMAC-SHA256(secret, mediaId + exp + fileName)`，覆盖文件名（防换路径取别的
文件）与 exp（能力型 URL 的自然收敛），常量时间比较；`AI_MEDIA_URL_SECRET` 未配置
或过短 → **fail-closed**（签不出就明确拒绝，绝不发一条取不到的链接）。
注意这条 URL 是**针对单个文件的 bearer 能力**：有效期内谁拿到谁能取那段视频。

### 视频转 SOP（2026-10-28，员工入口）

**流程**：`POST /api/ai/media`（ADMIN，multipart，mp4/webm/mov/m4v，≤100MB，原子写）
→ `POST /api/ai/sop-draft/from-video {mediaId, providerId?, hint?}` → 返回
`{title, slug, frontMatterYaml, bodyMarkdown, provider, model, warnings}` → 页面里
员工改完 → 走既有 `POST /api/sop` 起草 → 发布。

**为什么只出草稿不落库**：模型看录屏看不出「什么算成功」（acceptance 是发布闸门）。
让它猜一个验收项再自动发布，等于把"没达标"写成"已达标"；草稿交回页面补验收项，
复用既有校验链，不新开旁路。

**三个实现细节值得记**：
- 模型常有 `"acceptance": []`，而 front-matter 校验把**空数组**判为非法——
  service 里归一成"未填"（删键）而不是报错，否则一次生成白跑；
- `slug` 会做 kebab-case 归一（非字母数字折叠为 `-`、限长 128），模型给中文标题也不怕；
- front-matter 过的是**草稿级**校验（`strict: false`），结构性错误仍然 502 并带上具体原因。

#### 会话式编写（交互式，2026-10-28）

单轮"一次喂料、一次出稿"只适合流程简单、录屏完整的场景。真实业务里录屏常漏拍
（弹窗一闪而过、参数在哪配的没拍到），而"什么算做完了"更是录屏证不出来的——
让模型**猜**一个验收项再发布，等于把"没达标"写成"已达标"。故补了会话：
模型可以 `ask`（追问一个阻塞性缺口）或 `needsVideo`（要求补录），用户随时补文字、
随时再传一段录屏。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/ai/sop-sessions` | 用一段录屏开会话并跑第一轮（可能追问，也可能直接出稿） |
| GET | `/api/ai/sop-sessions/:id` | 读会话（messages / media / draft / 剩余追问次数） |
| POST | `/api/ai/sop-sessions/:id/turns` | 补一句话或一段录屏，继续下一轮 |
| POST | `/api/ai/sop-sessions/:id/saved` | 标记已保存（前端 `POST /sop` 成功后调用） |

### 前缀缓存友好（2026-10-28）

视频对话能不能命中 provider 的缓存，取决于**前缀是否逐字节相同**。原实现恰好把
前缀打碎了两次，现已修掉：

| 破坏前缀的写法 | 现在 |
|---|---|
| 每轮重签直链（`?exp=…&sig=…` 每轮都变 → 同一段视频成了不同字符串） | 直链**会话内复用**（落 `mediaJson[].url/expiresAt`，离过期 <5 分钟才重签） |
| 视频统一塞在 system 之后的固定块（补录第二段时"共 N 段"+清单变化 → 从第一个 token 起失效） | **append-only**：视频挂在"引入它的那条 user 消息"里，补录落在会话尾部，老前缀不动 |

`usage.cachedTokens`（OpenAI 兼容 `prompt_tokens_details.cached_tokens` /
`usage.cached_tokens`）已透出到会话轮的 `lastTurnUsage` 并逐轮打日志，用来**验证**
命中与否——它只是"我们这侧可测"，provider 是否真的缓存视频输入取决于厂商
（自动前缀缓存 / 显式上下文缓存 / 无，三类的支持面按模型确认才能写死）。

#### 并发、保留期错配与命中率（2026-10-28 加固）

| 问题 | 处理 |
|---|---|
| **并发提交同一轮**（双击发送/刷新重发/两个标签页） | 每轮都是全量视频推理，并发跑两次=成本翻倍 + 消息交错。锁落 **DB**（`turnLockedAt` + 条件 UPDATE 抢锁，命中 0 行 → 409），5 分钟自动过期——进程崩溃不留死锁，也无需额外清理任务；进程内 Set 在多副本下等于没有，故不采用 |
| **保留期错配**（媒体 7 天 / 会话 30 天） | 老会话引用的录屏可能已被清掉。每轮**逐条**确认存在性：缺的从本轮剔除并在上下文里留一句「N 段已过保留期」，其余照常推理；**全缺**时才报 `AI_MEDIA_NOT_FOUND`（带着空上下文让模型"继续编"比失败更糟） |
| **缓存到底有没有省到钱** | 新计数器 `autoflow_ai_cache_lookup_total{result=hit\|miss}`（同步/流式两路都埋）：比值即前缀缓存命中率。刻意**不加 provider 维度**——`labelValueSets` 需要固定枚举，provider 是用户自定义的，动态维度会让 series 爆炸；按厂商看时读日志里的 `cachedTokens` |

#### 流式与运维（2026-10-28 收尾）

| 能力 | 实现要点 |
|---|---|
| **流式一轮** | `POST /ai/sop-sessions/:id/turns/stream`（SSE：`delta` / `done` / `error`）。`@SkipTimeout()` 豁免全局 30s 请求超时；15s 心跳注释帧（`: ping`）防反代空闲断连；`X-Accel-Buffering: no` 防 nginx 缓冲把逐字效果吃掉。服务端 `ai-sse.ts` 是**纯函数**分帧器（半帧留缓冲、`\r\n` 混用、注释行忽略、流内错误帧抛出），因为这类 bug 只在慢网络分片时出现。客户端用 `fetch` + `reader`（`EventSource` 只能 GET，带不了 body；axios 浏览器端拿不到增量），认证沿用同一个 Bearer token。 |
| **保留期** | `AiMediaRetentionService` 每日 `@Cron`（leader 门禁）：媒体按 `ai.mediaRetentionDays`（默认 7 天）**目录粒度**回收（整目录删 + DB 行删，不留 404 僵尸行），会话按 `ai.sessionRetentionDays`（默认 30 天）删行。按 `createdAt` 而非 `updatedAt`——素材寿命从产生算起，否则"刚保存的草稿对应的会话"会被提前删。 |
| **会话切换器** | `GET /ai/sop-sessions`（只列本人：会话含录屏与业务细节，跨用户可见即越权；精简视图不含 messages）。前端页头下拉切换 `?session=`。 |

三道成本闸（都在 `ai-sop-session.protocol.ts` 里统一）：
- **每轮全量重发视频**：无状态 API 没有跨轮记忆，只发新增那段会让模型丢失前因；
  因此 `MAX_SESSION_VIDEOS=3`（会话视频上限）、每轮重签直链（60 分钟 TTL 会过期）；
- **追问预算**：`SOFT_QUESTION_LIMIT=3` 后 prompt 明确"优先出草稿"，
  `MAX_SESSION_QUESTIONS=6` 后仍追问 → 如实报 `AI_SOP_QUESTIONS_EXHAUSTED`；
- **会话落库**：刷新/换设备可续（`?session=` 写进 URL），`questionsAsked` 一并落盘
  ——否则续跑会把提问预算清零，变成无限追问。

协议仍是严格 JSON（`{"action":"ask"|"draft",…}`）；缺 `action` 但带 `bodyMarkdown`
的按草稿处理并补一条"未显式声明动作"的假设提示（模型常忘写 action）。

**直链下载端点**（`GET /api/ai/media/:mediaId/:fileName?exp&sig`）：
`@Public()` + 短时 HMAC 签名（见上一节），支持 `HEAD`/`Range(206)`，`Cache-Control: no-store`；
签名无效 403 / 过期 410 / 不存在 404 / Range 越界 416。该公开路由已在
`route-authz-matrix.spec.ts` 的 `OPEN_ROUTE_REGISTRY` 与**条数钉死清单**里显式登记
（新增公开读面必须过一次人工复核）。

### 模型接入的写面（2026-10-28，设置页数据源）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ai/providers` | 注册表 + 每个条目 `hasApiKey`/`legacy` + 各用途当前指向（ADMIN） |
| PUT | `/api/ai/providers` | 新增/更新一个接入（密钥 `***`/空 = 不修改，空串 = 清除） |
| DELETE | `/api/ai/providers/:id` | 删条目 + 清它的密钥行（不留孤儿密钥） |
| PUT | `/api/ai/routes` | 把某用途指向某 provider（空 = 跟随全局） |

两个刻意的语义：
- **首次保存物化缺省条目**：`ai.providers` 为空时读面来自旧键合成的三条；保存任意
  条目会把它们一并写入注册表（此后以注册表为准，`legacy` 标记消失）。否则会出现
  "设置页显示 A、实际生效 B"——比"旧 env 键不再生效"更难排查。
- **删除即删密钥**：孤儿密钥没有任何用途，留着只是负债；重新接入需要重填密钥，
  这是可以接受的一次性成本。

前端：设置 → AI Tab 内的「模型接入与分配」（ADMIN-only），以及
`/sops/from-video`「按录屏生成 SOP」页（上传 → 选视频模型 → 生成草稿 → 编辑 → 保存草稿）。

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

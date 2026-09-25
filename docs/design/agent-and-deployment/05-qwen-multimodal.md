# 05 · Qwen / DashScope 多模态接入

> 要求：「中台 agent 必须接 qwen 这种支持视频理解的模型和接口」。本文给出对 `ai.service.ts` 的最小侵入改造。

## 1. 现状（改造对象）

`apps/admin-api/src/modules/ai/ai.service.ts` 的关键约束：

| 现状 | 行 | 对多模态的影响 |
|---|---|---|
| `provider` 枚举 `disabled \| openai \| ollama` | `callProvider` L203-214 | 需加 `qwen` |
| 请求体 `messages: [{ role: "user", content: prompt }]` | `callOpenAI` L241 | **`content` 是 string，必须升级为数组** |
| `max_tokens: 500` **硬编码** | L242 | 多模态推理 500 令牌远不够，需可配 |
| `response_format` 未用 | — | tool-calling 需要新的请求能力 |
| SSRF 守卫 `assertAndPinHttpUrl` + `pinnedAxiosConfig` | L231-235 | **必须保留**，见 §3 |
| `sanitizeLogs()` 截断 3000 字符 | L39-52 | 文本场景适用；多模态路径不适用 |

**重要**：现有 `callOpenAI` 是给「分析失败日志」用的，`max_tokens=500` 是刻意的（省成本）。**改造时不能让 Agent 的需求污染这条既有路径**——否则日志分析会突然变贵。设计上必须**新增独立方法**，而非修改 `callOpenAI`。

## 2. 设计：新增 `qwen` provider + 独立多模态方法

### 2.1 配置键

沿用 `getAiConfig()` 的「DB 优先，env 兜底」模式：

| 键 | 默认 | 说明 |
|---|---|---|
| `ai.provider` | `disabled` | 枚举加 `qwen` |
| `ai.qwenApiKey` | `""` | `isSecret: true`，永不回显 |
| `ai.qwenBaseUrl` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | DashScope OpenAI 兼容端点 |
| `ai.qwenModel` | `qwen-vl-max` | 文本+图片+视频理解 |
| `ai.qwenMaxTokens` | `4096` | **独立配置**，不碰 openai 的 500 |
| `ai.qwenTimeoutMs` | `120000` | 视频理解慢，默认 2 分钟 |

env 兜底：`QWEN_API_KEY` / `QWEN_BASE_URL` / `QWEN_MODEL`（`configuration.ts` 的 `ai` 段加字段）。

### 2.2 为什么走「OpenAI 兼容模式」而不是 DashScope 原生 API

DashScope 提供 `https://dashscope.aliyuncs.com/compatible-mode/v1`，请求/响应结构与 OpenAI 一致。好处：

- **复用 `callOpenAI` 的骨架**（axios + Bearer + pin 守卫 + `maxRedirects: 0`）
- 未来换模型（通义/其他兼容供应商）只改 baseUrl，不改代码
- 测试可以复用现有 OpenAI mock 模式

代价：兼容层可能滞后于原生 API 的新特性。**当前需求（文本+图片+视频理解）兼容层已完全覆盖**，不构成障碍。

### 2.3 新增方法（不动既有方法）

```typescript
/**
 * 多模态对话（Agent 专用路径）。
 * 与 callOpenAI 的关键差异：
 *  - content 支持数组（text / image_url / video_url）
 *  - max_tokens 来自 ai.qwenMaxTokens，不共享 openai 的 500
 *  - 支持 tools（function calling），供 Agent 推理循环使用
 *  - 不做 sanitizeLogs 截断（由调用方按需脱敏）
 */
async chatMultimodal(req: {
  messages: MultimodalMessage[];
  tools?: ToolSchema[];
  toolChoice?: "auto" | "none";
  maxTokens?: number;      // 覆盖 ai.qwenMaxTokens
}): Promise<{
  content: string;
  toolCalls?: ToolCall[];
  usage: { tokensIn: number; tokensOut: number };
  model: string;
}> 
```

### 2.4 多模态消息契约

```typescript
type MultimodalPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }        // https URL 或 data:base64
  | { type: "video_url"; video_url: { url: string } };       // Qwen 视频理解

interface MultimodalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MultimodalPart[];
  tool_call_id?: string;      // role=tool 时
  tool_calls?: ToolCall[];    // role=assistant 时
}
```

> ⚠️ `video_url` 是 Qwen 的扩展（OpenAI 无此类型）。类型定义里标注为「provider 扩展」，避免误以为可移植到 openai provider。

### 2.5 视频输入的实际约束（需实测确认）

| 约束 | 说明 | 应对 |
|---|---|---|
| 视频必须**公网可访问 URL** | DashScope 服务端拉取，不能传本地文件 | 需对象存储或临时签名 URL |
| 支持的格式 | 常见 mp4 等（以官方文档为准） | 上传时校验 |
| 帧率/时长限制 | 通常有上限（如 ≤ 2 分钟、按帧采样） | **`sop_clarifications` 的录屏要限制时长**（建议 ≤ 60s） |
| 计费 | 按视频时长/帧数，显著高于纯文本 | 严格预算控制（[02 §5.3](./02-agent-architecture.md)） |
| 延迟 | 上传 + 推理可能 30-90s | 异步化，不能让会话同步等 |

> **待办**：这些参数需在实现前用真实账号实测确认。设计文档中标为「待实测」的部分，实现时先写一个 spike 脚本验证，再定默认值。

## 3. 安全：SSRF 守卫必须保留（关键）

多模态路径引入了**新的出站面**，必须复用既有防御：

| 出站目标 | 守卫 |
|---|---|
| DashScope API (`qwenBaseUrl`) | `assertAndPinHttpUrl` + `pinnedAxiosConfig` + `maxRedirects: 0` |
| **媒体 URL 拉取**（若需下载视频再转 base64） | **同样必须走 `assertAndPinHttpUrl`** |
| 媒体 URL 直接传给 DashScope（服务端拉取） | ⚠️ **无法用本地守卫保护**——见下 |

### 3.1 媒体 URL 的额外风险（新问题）

若把媒体 URL 直接给 DashScope（服务端拉取），存在 **SSRF 转嫁**：模型输出/执行器上报的 URL 若指向内网，DashScope 会去请求它。

虽然 DashScope 在阿里云侧、大概率打不到你的内网，但**不能依赖这个假设**。设计：

```
① 媒体上传走平台自己的 artifacts 模块（既有，已有鉴权 + 大小限制 + 保留策略）
② 传给 DashScope 的是平台自己的 URL（不可猜测的签名 URL）
③ 对执行器上报的媒体 URL：先由平台拉取（走 assertAndPinHttpUrl）→ 存 artifacts → 再用平台 URL
```

**绝不允许执行器 Agent 直接指定任意 URL 给中台 Agent 转给 DashScope。**

### 3.2 媒体内容本身的敏感信息

录屏可能含：内部系统界面、客户数据、**凭据输入过程**。设计：

- 上传时提示「请勿录制密码输入过程」
- artifacts 模块的**保留策略**（`artifacts-retention.service.ts` 已有）应覆盖媒体：建议澄清类媒体 **7 天**过期
- 访问需鉴权（artifacts 已有 `verifyUploadAuth` / download 鉴权）
- **送模型前**：可选加人工确认（首次启用视频理解时建议开，稳定后关）

## 4. 使用边界：只在澄清循环启用（重要）

视频理解**成本高、延迟大**，绝不能作为通用能力。设计上限定为**一条窄路径**：

### 4.1 唯一启用场景

```
执行器 Agent 在网页操作卡住
    → 上传录屏（≤ 60s）+ 截图
    → 发起澄清
    → 中台 Agent 调 chatMultimodal 分析
    → 产出结论（SOP 缺细节 / 页面变了 / 环境问题）
```

### 4.2 明确不启用

| 场景 | 用什么 |
|---|---|
| 日常运维排障 | 纯文本 + 日志 + 指标（便宜、快） |
| SOP 起草/复核（纯文字） | 纯文本模型 |
| 执行失败根因分析 | 现有 `analyzeFailure`（不动） |
| 监控截图巡检 | 不做（成本不可控） |

### 4.3 闸门

| 闸门 | 默认 |
|---|---|
| 单次视频时长上限 | 60s |
| 单会话视频分析次数 | 3 次 |
| 全局每日视频分析次数 | 50 次 |
| 单次视频分析令牌上限 | 32k |
| 超限行为 | 拒绝并要求人工介入 |

## 5. 改造清单（实现时按此执行）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `modules/ai/ai.service.ts` | `callProvider` 加 `qwen` 分支；新增 `chatMultimodal()`；新增 `callQwen()` |
| 2 | `modules/ai/ai.controller.ts` | `SaveAiConfigDto.provider` 的 `@IsIn` 加 `"qwen"`；加 qwen 配置字段；`getEffectiveConfig` 键列表加 qwen 键 |
| 3 | `modules/ai/ai.controller.ts` | `hasApiKey` 判定需区分 provider（现在是硬编码查 `ai.openaiApiKey`） |
| 4 | `config/configuration.ts` | `ai` 段加 `qwen*` env 兜底 |
| 5 | `modules/ai/__tests__/` | 三组单测：新增 provider 分支测试、多模态请求体构造、SSRF 守卫生效 |
| 6 | `apps/admin-web/src/locales/{zh,en}.ts` | provider 下拉加 Qwen 选项（已有 `sysSettings.ai.provider.openaiOption` 提到 Qwen，需拆出独立选项） |
| 7 | `docs/atlas/01-apps/admin-api/modules/ai.md` | 同步文档（项目有文档同步纪律） |

> ⚠️ 注意 #3：现有 `getConfig` 里 `hasApiKey` 是硬编码 `systemConfig.findOne("ai.openaiApiKey")`。加 provider 后这会导致「选了 qwen 但 hasApiKey 显示 false」。需按 provider 动态查询。

## 6. 待你确认的开放项

1. **DashScope 账号与配额**：是否已有？视频理解是否已开通？（这决定 §2.5 的「待实测」能否落地）
2. **媒体存储**：用现有 `artifacts` 模块（100 MB/文件，20 个/执行，有保留策略），还是需要独立的对象存储？录屏可能超出 artifacts 的语义（它是「执行产物」）。
3. **媒体送模型是否要人工确认**（§3.2）？我建议**首次启用时开**，稳定后关。
4. **`qwen-vl-max` 是否合适**？还是 `qwen-vl-plus`（更便宜）？需按实测效果定。
5. **视频理解是否需要在 Admin Web 里可视化**（让人能看到 Agent 看了什么录屏）？这对建立信任很重要，但增加前端工作量。

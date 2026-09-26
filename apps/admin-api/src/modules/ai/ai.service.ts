import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import * as nodeCron from "node-cron";
import { SystemConfigService } from "../config/config.service";
import {
  assertAndPinHttpUrl,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";

// ═══════════════════════════════════════════════════════════════════
// P1（agent-and-deployment）：多模态消息契约
//
// 为什么需要独立类型而不是复用 string prompt：Qwen 的视频理解要求
// content 是**数组**（text + image_url + video_url），而既有 callOpenAI
// 固定传 `content: prompt`（string）。两者请求体形状不兼容，故新增独立
// 方法（chatMultimodal）而非改造 callOpenAI——后者是给「失败日志分析」
// 用的，max_tokens=500 是刻意的省成本策略，不能被多模态需求污染。
// ═══════════════════════════════════════════════════════════════════

/** 多模态消息的一个片段。 */
export type MultimodalPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  // ⚠️ video_url 是 **Qwen/DashScope 的扩展**，OpenAI 官方 API 无此类型。
  // 标注在此以免误以为可移植到 openai provider。
  | { type: "video_url"; video_url: { url: string } };

export interface MultimodalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MultimodalPart[];
  /** role=tool 时必填，关联此前的 tool_call。 */
  tool_call_id?: string;
  /** role=assistant 且要求调用工具时使用。 */
  tool_calls?: ToolCall[];
}

/** LLM 请求的工具调用（function calling）。 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** 暴露给 LLM 的工具 schema（P3 的 Agent 工具集用）。 */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface MultimodalRequest {
  messages: MultimodalMessage[];
  tools?: ToolSchema[];
  toolChoice?: "auto" | "none";
  /** 覆盖 ai.qwenMaxTokens。 */
  maxTokens?: number;
}

export interface MultimodalResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: { tokensIn: number; tokensOut: number };
  model: string;
}

/** 媒体 URL 的允许协议（拒绝 file:// / data: 之外的怪协议）。 */
const MEDIA_URL_RE = /^https?:\/\//i;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private config: ConfigService,
    private systemConfig: SystemConfigService,
  ) {}

  /**
   * Resolve an AI config value: DB record (ai.<key>) takes precedence over
   * the environment-backed ConfigService value, which acts as a fallback.
   */
  private async getAiConfig(key: string, defaultValue = ""): Promise<string> {
    try {
      const record = await this.systemConfig.findOne(`ai.${key}`);
      if (record?.value != null && record.value !== "") return record.value;
    } catch {
      // not in DB — fall through to env
    }
    return this.config.get<string>(`ai.${key}`, defaultValue);
  }

  /**
   * S-10: sanitize logs before sending to external AI service.
   * Strips common secret patterns (env var assignments, Bearer/API tokens,
   * long hex/base64 strings) to reduce data-leakage risk.
   */
  private sanitizeLogs(raw: string): string {
    return (
      raw
        // env var assignments: KEY=value or KEY=VALUE
        .replace(/([A-Z_]{3,}\s*=\s*)[^\s\n]+/g, "$1[REDACTED]")
        // Bearer / token headers
        .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]")
        // long hex strings (>=32 chars — likely keys/tokens)
        .replace(/[0-9a-fA-F]{32,}/g, "[REDACTED_HEX]")
        // long base64-like strings (>=40 chars)
        .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[REDACTED_B64]")
        .slice(0, 3000)
    );
  }

  async analyzeFailure(
    task: Pick<{ name: string; runtime: string }, "name" | "runtime">,
    logs: string,
  ): Promise<string> {
    const provider = await this.getAiConfig("provider", "disabled");
    if (provider === "disabled") return "";
    const sanitized = this.sanitizeLogs(logs);
    const prompt = `You are an automated task analysis assistant. Task "${task.name}" (runtime: ${task.runtime}) failed. Analyze the root cause and suggest a fix.\n\nError logs:\n${sanitized}\n\nRespond in this format:\n**Failure reason:** ...\n**Fix suggestion:** ...`;
    return this.callProvider(prompt);
  }

  /**
   * Dedicated prompt for schedule suggestion.
   * Returns a JSON object: { suggestedCron: string, reasoning: string }
   * so the caller can reliably parse it without regex hacks.
   * WIKI-OPT-3: the AI-returned cron is validated with node-cron.validate
   * (same implementation as scheduler registration); an invalid suggestion
   * never leaves this method — it falls back to the current cron (or the
   * default "0 * * * *") with `fallback: true`, so an unparseable /
   * hallucinated expression cannot reach the DB and crash scheduling.
   */
  async suggestSchedule(
    taskName: string,
    currentCron: string | null,
    stats: {
      total: number;
      successes: number;
      failures: number;
      avgDurationMs: number;
      p95DurationMs: number;
      bestHoursUtc: number[];
    },
  ): Promise<{ suggestedCron: string; reasoning: string; fallback?: boolean }> {
    const provider = await this.getAiConfig("provider", "disabled");
    if (provider === "disabled") {
      return {
        suggestedCron: currentCron || "0 * * * *",
        reasoning: "AI provider not configured.",
        // AI-002: 显式标记这是回退结果而非 AI 建议
        fallback: true,
      };
    }
    const prompt = [
      `You are a cron scheduling expert. Suggest the optimal cron schedule for the following task.`,
      `Task name: ${taskName}`,
      `Current cron: ${currentCron || "(none)"}`,
      `Execution history (last ${stats.total} runs):`,
      `  Successes: ${stats.successes}, Failures: ${stats.failures}`,
      `  Avg duration: ${stats.avgDurationMs}ms, P95 duration: ${stats.p95DurationMs}ms`,
      `  UTC hours with most successes: ${stats.bestHoursUtc.join(", ") || "(no data)"}`,
      ``,
      `Respond ONLY with a JSON object, no markdown, no extra text:`,
      `{ "suggestedCron": "<5-field cron>", "reasoning": "<1-3 sentence explanation>" }`,
    ].join("\n");
    try {
      const raw = await this.callProvider(prompt);
      // strip optional markdown code fences before parsing
      const jsonStr = raw
        .replace(/^```[\s\S]*?\n/, "")
        .replace(/\n?```$/, "")
        .trim();
      const parsed = JSON.parse(jsonStr) as {
        suggestedCron: string;
        reasoning: string;
      };
      if (parsed.suggestedCron && parsed.reasoning) {
        // WIKI-OPT-3: cron 校验前置到服务层——AI 偶发返回非 5 字段 cron
        // （如 "every 5 minutes"）若原样透出，前端采纳落库后调度注册会
        // 崩溃。用 node-cron.validate 把关（与 scheduler 注册 /
        // maintenance-window util 同一实现，行为不漂移）；非法 → warn +
        // 回退当前值，并保留 fallback 标记语义（调用方据此区分 AI 建议与回退）。
        if (!nodeCron.validate(parsed.suggestedCron)) {
          this.logger.warn(
            `suggestSchedule: AI returned invalid cron expression: "${parsed.suggestedCron}"`,
          );
          return {
            suggestedCron: currentCron || "0 * * * *",
            reasoning: "AI returned invalid cron expression.",
            fallback: true,
          };
        }
        return parsed;
      }
      // AI-002: JSON 合法但字段缺失——同样视为解析失败并记 warn
      this.logger.warn(
        `suggestSchedule: AI response missing required fields (suggestedCron/reasoning)`,
      );
    } catch (e: unknown) {
      // AI-002: 解析失败不再静默降级——记 warn 日志并在响应中携带
      // fallback 标记，让调用方/前端能区分"AI 建议"与"回退到当前值"。
      this.logger.warn(
        `suggestSchedule parse error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return {
      suggestedCron: currentCron || "0 * * * *",
      reasoning: "AI returned unparseable response.",
      fallback: true,
    };
  }

  /**
   * Dedicated prompt for application health analysis.
   */
  async analyzeAppHealth(
    appName: string,
    stats: {
      totalTasks: number;
      avgSuccessRate: number;
      avgDurationMs: number;
      criticalTasks: string[];
      perTask: Array<{
        name: string;
        successRate: number;
        avgDuration: number;
        totalRuns: number;
      }>;
    },
  ): Promise<string> {
    const provider = await this.getAiConfig("provider", "disabled");
    if (provider === "disabled") return "";
    const perTaskLines = stats.perTask
      .map(
        (t) =>
          `  - ${t.name}: successRate=${t.successRate}%, avgDuration=${t.avgDuration}ms, runs=${t.totalRuns}`,
      )
      .join("\n");
    const prompt = [
      `You are an operations analyst. Assess the health of the following application and provide actionable recommendations.`,
      `Application: ${appName}`,
      `Total tasks: ${stats.totalTasks}`,
      `Average success rate: ${stats.avgSuccessRate}%`,
      `Average execution duration: ${stats.avgDurationMs}ms`,
      stats.criticalTasks.length
        ? `Critical tasks (success rate < 50%): ${stats.criticalTasks.join(", ")}`
        : `No critical tasks detected.`,
      ``,
      `Per-task breakdown:`,
      perTaskLines || "  (no tasks)",
      ``,
      `Respond in this format:`,
      `**Health status:** (Healthy / Warning / Critical)`,
      `**Key findings:** ...`,
      `**Recommendations:** ...`,
    ].join("\n");
    return this.callProvider(prompt);
  }

  /** Dispatch a prompt to the configured provider. Returns "" on error or if provider unknown. */
  private async callProvider(prompt: string): Promise<string> {
    const provider = await this.getAiConfig("provider", "disabled");
    try {
      if (provider === "openai") return await this.callOpenAI(prompt);
      if (provider === "ollama") return await this.callOllama(prompt);
      // P1: qwen 走纯文本时复用 OpenAI 兼容分支的骨架，但用 qwen 自己的
      // 模型/密钥/令牌上限——不作为 openai 的别名，否则「切到 qwen」会意外
      // 带上 gpt-4o-mini 与 500 令牌上限。
      if (provider === "qwen") return await this.callQwenText(prompt);
    } catch (e: unknown) {
      this.logger.warn(
        `AI error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return "";
  }

  /**
   * P1: Qwen 纯文本路径（供既有三类分析复用：失败分析 / 排程建议 / 应用健康）。
   *
   * 与 chatMultimodal 的分工：本方法只处理 string prompt、返回 string，
   * 与 callOpenAI 契约逐一对应（故可被 callProvider 直接替换使用）；
   * 多模态与 tool-calling 走 chatMultimodal。
   */
  private async callQwenText(prompt: string): Promise<string> {
    const res = await this.chatMultimodal({
      messages: [{ role: "user", content: prompt }],
    });
    return res.content;
  }

  /**
   * P1: 多模态对话（Qwen / DashScope OpenAI 兼容端点）。
   *
   * 与 callOpenAI 的关键差异：
   *  - content 支持数组（text / image_url / video_url）；
   *  - max_tokens 来自 ai.qwenMaxTokens，**不共享** openai 的 500；
   *  - 支持 tools（function calling），供 P3 的 Agent 推理循环使用；
   *  - 不做 sanitizeLogs 截断（多模态载荷不该被 3000 字符截断；
   *    脱敏责任在调用方，见设计文档 05 §3）。
   *
   * 安全：出站走与 callOpenAI 完全相同的守卫——assertAndPinHttpUrl
   * （SSRF + DNS pin）+ maxRedirects:0（拒 3xx 绕过）。**不新开旁路**。
   */
  async chatMultimodal(req: MultimodalRequest): Promise<MultimodalResponse> {
    const provider = await this.getAiConfig("provider", "disabled");
    if (provider !== "qwen") {
      // fail-open：与既有 analyzeFailure 一致的姿态——未启用即返回空，
      // 调用方按「无结果」降级，绝不抛错影响主链。
      return {
        content: "",
        usage: { tokensIn: 0, tokensOut: 0 },
        model: "",
      };
    }

    const apiKey = await this.getAiConfig("qwenApiKey", "");
    if (!apiKey) {
      this.logger.warn("chatMultimodal: qwen provider enabled but no API key");
      return { content: "", usage: { tokensIn: 0, tokensOut: 0 }, model: "" };
    }

    const model = await this.getAiConfig("qwenModel", "qwen-vl-max");
    const baseUrl = await this.getAiConfig(
      "qwenBaseUrl",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
    const maxTokens = req.maxTokens ?? (await this.getQwenMaxTokens());
    const timeoutMs = await this.getQwenTimeoutMs();

    // F-3（SEC-NEW）: 与 callOpenAI 同款——校验同时把目标 pin 到通过的 IP
    // （Host/SNI 保留），关闭 DNS rebinding 窗口。
    const pinned = await assertAndPinHttpUrl(baseUrl, {
      allowPrivateNetwork:
        this.config.get<boolean>("ai.allowPrivateNetwork") === true,
    });
    const pinCfg = pinnedAxiosConfig(pinned);

    this.validateMediaUrls(req.messages);

    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      max_tokens: maxTokens,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? "auto";
    }

    const r = await axios.post(`${baseUrl}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: timeoutMs,
      // R3: maxRedirects=0 —— 3xx 不得绕过首跳 SSRF 校验（同 callOpenAI）。
      maxRedirects: 0,
      ...pinCfg,
    });

    const choice = r.data?.choices?.[0];
    const usage = r.data?.usage ?? {};
    return {
      content: choice?.message?.content ?? "",
      toolCalls: choice?.message?.tool_calls ?? undefined,
      usage: {
        tokensIn: usage.prompt_tokens ?? 0,
        tokensOut: usage.completion_tokens ?? 0,
      },
      model,
    };
  }

  /**
   * 媒体 URL 校验（P1 安全）。
   *
   * 威胁：媒体 URL 由**执行器 Agent 上报**，属于不可信输入。若原样转给
   * DashScope（服务端拉取），就是 SSRF 转嫁——模型/上报方指定的 URL 会被
   * 第三方服务请求。虽然 DashScope 在阿里云侧大概率打不到内网，但**不能
   * 依赖这个假设**（设计文档 05 §3.1）。
   *
   * 因此：只接受 http(s)，且调用方必须保证 URL 来自平台 artifacts
   * （不可猜测的签名 URL），而不是执行器直接给的外部地址。
   */
  private validateMediaUrls(messages: MultimodalMessage[]): void {
    for (const msg of messages) {
      if (typeof msg.content === "string") continue;
      for (const part of msg.content) {
        const url =
          part.type === "image_url"
            ? part.image_url?.url
            : part.type === "video_url"
              ? part.video_url?.url
              : undefined;
        if (url === undefined) continue;
        if (!MEDIA_URL_RE.test(url)) {
          throw new Error(
            `Refusing non-http(s) media URL (scheme not allowed): ${url.slice(0, 64)}`,
          );
        }
      }
    }
  }

  private async getQwenMaxTokens(): Promise<number> {
    const raw = await this.getAiConfig("qwenMaxTokens", "4096");
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 4096;
  }

  private async getQwenTimeoutMs(): Promise<number> {
    const raw = await this.getAiConfig("qwenTimeoutMs", "120000");
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 120000;
  }

  private async callOpenAI(prompt: string) {
    const model = await this.getAiConfig("openaiModel", "gpt-4o-mini");
    const apiKey = await this.getAiConfig("openaiApiKey", "");
    const baseUrl = await this.getAiConfig(
      "openaiBaseUrl",
      "https://api.openai.com/v1",
    );
    // AI-001: refuse SSRF (private/loopback/link-local/cloud-metadata) for
    // admin-configured AI base URLs. The check is the same as the webhook
    // channel — both stem from config-driven outbound HTTP.
    // ARCH-31（2026-09-13）: AI_ALLOW_PRIVATE_NETWORK=true 时放开内网目标
    // （同姿态：link-local 云元数据恒拒），默认 false 零行为变化。
    // F-3（SEC-NEW）: 校验同时把目标 pin 到通过的 IP（Host/SNI 保留），
    // 关闭 DNS rebinding 窗口——AI 配置可含自定义域名，逐查询 rebind 可把
    // 请求打到云元数据/内网。
    const pinned = await assertAndPinHttpUrl(baseUrl, {
      allowPrivateNetwork:
        this.config.get<boolean>("ai.allowPrivateNetwork") === true,
    });
    const pinCfg = pinnedAxiosConfig(pinned);
    // 原始 baseUrl 原样拼路径（new URL 归一化会改字节形态）；pin 由 agent.lookup 完成。
    const r = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 30_000,
        // R3: assertSafeHttpUrl only validates the first-hop URL; refuse
        // 3xx so a redirect cannot bypass the SSRF guard into a private
        // target.
        maxRedirects: 0,
        ...pinCfg,
      },
    );
    return r.data.choices[0].message.content;
  }

  private async callOllama(prompt: string) {
    const host = await this.getAiConfig("ollamaHost", "http://localhost:11434");
    // AI-001: SSRF guard for self-hosted Ollama.
    // ARCH-31（2026-09-13）: 默认姿态拒一切非 public——本地 Ollama 的默认
    // localhost:11434 也被拒（历史缺口：文档宣称支持本地 Ollama 但闸门不放行）。
    // AI_ALLOW_PRIVATE_NETWORK=true 显式放开 loopback/restricted/private-lan
    // （同机自建部署），link-local 云元数据仍恒拒。开关为 env 级部署配置，
    // 不进 DB 系统配置（与 EXECUTOR_ALLOW_PRIVATE_NETWORK 同形态）。
    // F-3（SEC-NEW）: 同 callOpenAI，pin 到校验通过的 IP。
    const pinned = await assertAndPinHttpUrl(host, {
      allowPrivateNetwork:
        this.config.get<boolean>("ai.allowPrivateNetwork") === true,
    });
    const pinCfg = pinnedAxiosConfig(pinned);
    const model = await this.getAiConfig("ollamaModel", "llama3");
    const r = await axios.post(
      `${host}/api/generate`,
      { model, prompt, stream: false },
      // R3: maxRedirects=0 — see callOpenAI comment. Ollama is
      // self-hosted; a redirect to a private host would still slip past
      // the first-hop check, so we refuse 3xx outright.
      {
        timeout: 60_000,
        maxRedirects: 0,
        ...pinCfg,
      },
    );
    return r.data.response;
  }

  /** Return current effective AI config (for the settings page to display). */
  async getEffectiveConfig(): Promise<Record<string, string>> {
    const keys = [
      "provider",
      "openaiModel",
      "openaiBaseUrl",
      "ollamaHost",
      "ollamaModel",
      // P1: Qwen 生效配置（密钥除外——单独以 hasApiKey 语义暴露）
      "qwenModel",
      "qwenBaseUrl",
      "qwenMaxTokens",
      "qwenTimeoutMs",
    ];
    const result: Record<string, string> = {};
    for (const k of keys) {
      result[k] = await this.getAiConfig(
        k,
        k === "openaiBaseUrl"
          ? "https://api.openai.com/v1"
          : k === "qwenBaseUrl"
            ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
            : "",
      );
    }
    // Never return the API key value — caller requests it separately if needed
    return result;
  }

  /**
   * P2: 当前生效的 provider / model（供 Agent 逐条记录「这一步是谁答的」）。
   *
   * 为什么由 AiService 暴露而不是调用方自己猜：路由是 AiService 的内部
   * 决策（provider 枚举 + 各 provider 的默认模型），调用方复制一份解析逻辑
   * 必然漂移——而 steps.provider/model 正是排查与成本归因的依据，错了会
   * 把排查引向错误方向。
   */
  async getActiveRoute(): Promise<{ provider: string; model: string }> {
    const provider = await this.getAiConfig("provider", "disabled");
    if (provider === "qwen") {
      return {
        provider,
        model: await this.getAiConfig("qwenModel", "qwen-vl-max"),
      };
    }
    if (provider === "openai") {
      return {
        provider,
        model: await this.getAiConfig("openaiModel", "gpt-4o-mini"),
      };
    }
    if (provider === "ollama") {
      return {
        provider,
        model: await this.getAiConfig("ollamaModel", "llama3"),
      };
    }
    return { provider, model: "" };
  }

  /**
   * P1: 按 provider 返回「该 provider 是否已配置密钥」。
   *
   * 为什么需要这个方法：既有 AiController.getConfig 硬编码查
   * `ai.openaiApiKey`，加了 qwen 之后会让「选了 qwen 但 API Key 显示未配置」
   * ——前端据此误判为不可用（设计文档 05 §5 改造清单 #3）。
   */
  async hasApiKeyForProvider(): Promise<boolean> {
    const provider = await this.getAiConfig("provider", "disabled");
    const keyName =
      provider === "qwen"
        ? "qwenApiKey"
        : provider === "openai"
          ? "openaiApiKey"
          : null;
    if (!keyName) return false;
    try {
      const rec = await this.systemConfig.findOne(`ai.${keyName}`);
      if (rec?.value) return true;
    } catch {
      // not in DB — fall through to env
    }
    // env 兜底：未在 DB 配置时，看 env 注入的同名键（configuration.ts ai 段）
    const envVal = this.config.get<string>(`ai.${keyName}`, "");
    return !!envVal;
  }
}

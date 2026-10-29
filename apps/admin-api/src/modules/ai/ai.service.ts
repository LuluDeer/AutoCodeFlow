import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import * as nodeCron from "node-cron";
import { SystemConfigService } from "../config/config.service";
// 与任务写边界同一份 cron 规范化（裸 n/step 等价改写），语法口径不漂移
import { normalizeCron5Field } from "../task/cron-normalize.util";
import {
  assertAndPinHttpUrl,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。⚠️ 媒体 URL 校验原为**裸 Error**（对外 500），迁码时 status
// 取 500 保持对外状态码不变。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { PROMPT_DATA_HEADER, tagDelimited } from "./prompt-guard";
import { parseSseFrames, parseStreamDelta } from "./ai-sse";
import { recordRuntime } from "../metrics/runtime-metrics-entry";
import {
  isTruncatedFinish,
  normalizeAssistantContent,
  normalizeToolCalls,
} from "./llm-response";
import {
  legacyProviders,
  normalizeProviderEntry,
  parseProvidersJson,
  removeProviderEntry,
  serializeProviders,
  upsertProviderEntry,
  type AiProviderEntry,
  type AiPurpose,
} from "./ai-providers";
import {
  DEFAULT_MEDIA_URL_TTL_MS,
  buildSignedMediaUrl,
  type SignResult,
} from "./ai-media-url";
import {
  resolveAiRoute,
  type ResolvedRoute,
  type RouteOverride,
  type RouteResolution,
} from "./ai-route";

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
  /**
   * 用途 → 决定路由与参数（注册表 + `ai.routes.<purpose>.*`）：
   *   · `agent`（默认）——Agent 推理 / 执行器 relay，要求 tool-calling 面；
   *   · `video`——视频理解（转 SOP），要求该 provider 声明支持视频。
   */
  purpose?: "agent" | "video";
  /**
   * 覆盖本次调用的 provider id（设置页"用这个模型做视频分析"的直接选择）。
   * 只影响这一次调用，不改 `ai.routes.*` 的持久化配置。
   */
  provider?: string;
  /** 覆盖路由的 maxTokens（不配则用路由分配值）。 */
  maxTokens?: number;
  /**
   * 要求严格 JSON 输出（执行器 plan/diagnose 协议用）。
   * 只在调用方明确需要时下发——强制 JSON 会毁掉"给结论"的自由文本输出。
   */
  responseFormat?: "json_object";
}

export interface MultimodalResponse {
  content: string;
  toolCalls?: ToolCall[];
  /**
   * `cachedTokens` = 上游报告的**命中缓存**的输入 token（OpenAI 兼容端点
   * `usage.prompt_tokens_details.cached_tokens`；部分厂商放在 `usage.cached_tokens`）。
   * 只有 >0 时才出现——既有断言/存储形状不受影响，同时让"这次有没有命中"可见。
   */
  usage: { tokensIn: number; tokensOut: number; cachedTokens?: number };
  model: string;
  /** 实际命中的 provider id（多 provider 下"这一步是谁答的"必须可归因）。 */
  provider?: string;
}

/** 媒体 URL 的允许协议（拒绝 file:// 等怪协议）。 */
const MEDIA_URL_RE = /^https?:\/\//i;
/**
 * Inline data-image（执行器把本地截图直接 base64 附进 relay）。
 *
 * 为什么允许：实测该 provider 接受 `data:image/png;base64,...`（真实截图
 * 720x320 可识别），这样私有化部署不必为了「模型看截图」把中台媒体目录
 * 暴露到公网。data URL 不会触发服务端出站抓取，SSRF 面为零；风险只剩体积，
 * 故按字节数硬上限（单图 3MB base64 串）。
 */
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i;
const MAX_INLINE_IMAGE_CHARS = 3 * 1024 * 1024;

/** 路由参数解析：空串/非法值 → undefined（表示"未覆盖"）。 */
function numOrUndefined(
  raw: string | number | undefined | null,
): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 未启用/不可用时的统一空响应（fail-open：调用方按"无结果"降级）。 */
function emptyResponse(): MultimodalResponse {
  return { content: "", usage: { tokensIn: 0, tokensOut: 0 }, model: "" };
}

/** 消息里是否含 video_url 片段（能力闸的判据）。 */
function hasVideoPart(messages: MultimodalMessage[]): boolean {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    if (m.content.some((p) => p?.type === "video_url")) return true;
  }
  return false;
}

/**
 * B-4：上游 usage 收敛——provider 返回的 prompt_tokens/completion_tokens
 * 可能是字符串甚至畸形值，原样透传会让下游（agent-session 的用量累加）
 * 拿到非 number；收敛为有限非负数后再出本模块。
 */
export function usageCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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
    // 契约是"永远返回字符串"：ConfigService 的 `get(key, default)` 在少数实现/
    // 测试替身里可能返回 undefined（不认第二个参数），下游 `.trim()` 会当场炸。
    // 收敛在这里，路由解析就永远拿到字符串（空串 = 未配置）。
    const envValue = this.config.get<string | number>(
      `ai.${key}`,
      defaultValue,
    );
    if (typeof envValue === "string") return envValue;
    // 数值型 env（configuration.ts 里 parseInt 过的项）也要能透传
    if (typeof envValue === "number" && Number.isFinite(envValue)) {
      return String(envValue);
    }
    return defaultValue ?? "";
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

  /**
   * Analyze a failed execution. FIX-6.2：prompt 上下文扩充（可选参数，向后
   * 兼容）——此前只有任务名 + runtime + 净化日志，AI 拿不到平台已判定的
   * failureReason / exitCode，也看不到任务级 runbook（运维沉淀的排障知识，
   * 通知链路一直在带、唯独 AI 不带），结论质量受损且可能与 runbook 冲突。
   * 现把三者在 prompt 中显式注入（runbook 截 2000 字符防 prompt 膨胀；
   * 其余长文本仍由 sanitizeLogs 收口）。日志净化/脱敏行为不变。
   */
  async analyzeFailure(
    task: Pick<{ name: string; runtime: string }, "name" | "runtime">,
    logs: string,
    context?: {
      failureReason?: string | null;
      exitCode?: number | null;
      runbook?: string | null;
    },
  ): Promise<string> {
    const provider = await this.getAiConfig("provider", "disabled");
    if (provider === "disabled") return "";
    const sanitized = this.sanitizeLogs(logs);
    const runtime = task.runtime || "unknown";
    // P3-8 对齐：三段用户可控内容全部定界（声明见 PROMPT_DATA_HEADER）。
    // 顺序仍是「先 sanitizeLogs 脱敏 → 再定界」，两者职责不重叠：前者防
    // 凭据外泄，后者防「数据被当指令执行」。
    const lines: string[] = [
      PROMPT_DATA_HEADER,
      `You are an automated task analysis assistant. A task failed (runtime: ${runtime}). Analyze the root cause and suggest a fix.`,
      tagDelimited("task_name", task.name, 200),
    ];
    if (context?.failureReason) {
      lines.push(tagDelimited("task_error", context.failureReason, 500));
    }
    if (typeof context?.exitCode === "number") {
      lines.push(`Process exit code: ${context.exitCode}`);
    }
    if (context?.runbook && context.runbook.trim()) {
      lines.push(tagDelimited("task_runbook", context.runbook, 2000));
    }
    lines.push(tagDelimited("task_logs", sanitized, 4000));
    lines.push(
      `\nRespond in this format:\n**Failure reason:** ...\n**Fix suggestion:** ...`,
    );
    return this.callProvider(lines.join("\n"));
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
      PROMPT_DATA_HEADER,
      `You are a cron scheduling expert. Suggest the optimal cron schedule for the following task.`,
      tagDelimited("task_name", taskName, 200),
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
        // 崩溃。先与任务写边界同一份 normalizeCron5Field 规范化（AI 也可能
        // 产出 POSIX 裸 n/step 形态，如 "12/20 * * * *"），再以 node-cron
        // .validate 把关（与 scheduler 注册同一实现，行为不漂移）；
        // 非法 → warn + 回退当前值，并保留 fallback 标记语义（调用方据此
        // 区分 AI 建议与回退）。
        const canonical = normalizeCron5Field(parsed.suggestedCron);
        if (canonical === null || !nodeCron.validate(canonical)) {
          this.logger.warn(
            `suggestSchedule: AI returned invalid cron expression: "${parsed.suggestedCron}"`,
          );
          return {
            suggestedCron: currentCron || "0 * * * *",
            reasoning: "AI returned invalid cron expression.",
            fallback: true,
          };
        }
        return { ...parsed, suggestedCron: canonical };
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
      PROMPT_DATA_HEADER,
      `You are an operations analyst. Assess the health of the following application and provide actionable recommendations.`,
      tagDelimited("app_name", appName, 200),
      `Total tasks: ${stats.totalTasks}`,
      `Average success rate: ${stats.avgSuccessRate}%`,
      `Average execution duration: ${stats.avgDurationMs}ms`,
      stats.criticalTasks.length
        ? // 名字逐个 JSON 引号化：任务名是用户可控文本，逗号拼接时一个含
          // 换行的名字就能伪造出「下一段指令」的行结构（定界标签在这里不适用
          // ——它们本就属于下面 task_list 的子集，重复定界只会让模型分不清）
          `Critical tasks (success rate < 50%): ${stats.criticalTasks
            .map((n) => JSON.stringify(n))
            .join(", ")}`
        : `No critical tasks detected.`,
      ``,
      `Per-task breakdown:`,
      perTaskLines
        ? tagDelimited("task_list", perTaskLines, 4000)
        : "  (no tasks)",
      ``,
      `Respond in this format:`,
      `**Health status:** (Healthy / Warning / Critical)`,
      `**Key findings:** ...`,
      `**Recommendations:** ...`,
    ].join("\n");
    return this.callProvider(prompt);
  }

  // ── provider 注册表与按用途路由（推理质量轮：LLM 接入与分配）──────────

  /**
   * 读取 provider 注册表。
   *
   * 三级来源，优先级从高到低：
   *   ① DB `ai.providers`（JSON 数组，**不含密钥**）——设置页写入的形态；
   *   ② 旧配置键合成（`ai.openai*` / `ai.qwen*` / `ai.ollama*`）——存量部署
   *      升级后零行为变化，且**旧键继续作为该 id 的回落**（所以升级不必改 .env）；
   *   ③ `LEGACY_DEFAULTS` 的内置缺省。
   *
   * 密钥单独取 `ai.providers.<id>.apiKey`（DB，isSecret），未配置时回落到
   * `ai.<id>ApiKey` 旧键。注册表 JSON 里**永不存密钥**——`system_configs` 的
   * 掩码是逐键语义，把 key 混进 JSON 等于让整条记录无法掩码。
   */
  private async loadProviders(): Promise<{
    entries: AiProviderEntry[];
    keys: Record<string, string>;
    legacy: boolean;
    errors: string[];
  }> {
    const raw = await this.getAiConfig("providers", "");
    const parsed = parseProvidersJson(raw);

    const [
      openaiBaseUrl,
      openaiModel,
      openaiMaxTokens,
      qwenBaseUrl,
      qwenModel,
      qwenMaxTokens,
      qwenTimeoutMs,
      ollamaHost,
      ollamaModel,
    ] = await Promise.all([
      this.getAiConfig("openaiBaseUrl", "https://api.openai.com/v1"),
      this.getAiConfig("openaiModel", "gpt-4o-mini"),
      this.getAiConfig("openaiMaxTokens", "500"),
      this.getAiConfig(
        "qwenBaseUrl",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ),
      this.getAiConfig("qwenModel", "qwen-vl-max"),
      this.getAiConfig("qwenMaxTokens", "4096"),
      this.getAiConfig("qwenTimeoutMs", "120000"),
      this.getAiConfig("ollamaHost", "http://localhost:11434"),
      this.getAiConfig("ollamaModel", "llama3"),
    ]);

    const legacyEntries = legacyProviders({
      openai: {
        baseUrl: openaiBaseUrl,
        model: openaiModel,
        maxTokens: Number(openaiMaxTokens),
      },
      qwen: {
        baseUrl: qwenBaseUrl,
        model: qwenModel,
        maxTokens: Number(qwenMaxTokens),
        timeoutMs: Number(qwenTimeoutMs),
      },
      ollama: { baseUrl: ollamaHost, model: ollamaModel },
    });

    const fromJson = parsed.configured && parsed.entries.length > 0;
    const entries = fromJson ? parsed.entries : legacyEntries;

    const keys: Record<string, string> = {};
    await Promise.all(
      entries.map(async (entry) => {
        const scoped = await this.getAiConfig(
          `providers.${entry.id}.apiKey`,
          "",
        );
        if (scoped) {
          keys[entry.id] = scoped;
          return;
        }
        // 旧键回落（只对三个内置 id 有意义）
        if (entry.id === "qwen")
          keys[entry.id] = await this.getAiConfig("qwenApiKey", "");
        else if (entry.id === "openai")
          keys[entry.id] = await this.getAiConfig("openaiApiKey", "");
      }),
    );

    return { entries, keys, legacy: !fromJson, errors: parsed.errors };
  }

  /** 解析某个用途的生效路由（未启用/能力不符都如实返回原因）。 */
  private async routeFor(
    purpose: AiPurpose,
    providerOverride?: string,
  ): Promise<RouteResolution> {
    const [{ entries, keys }, globalProvider, prefix] = await Promise.all([
      this.loadProviders(),
      this.getAiConfig("provider", "disabled"),
      Promise.resolve(`routes.${purpose}`),
    ]);

    const [provider, model, maxTokens, timeoutMs, temperature] =
      await Promise.all([
        this.getAiConfig(`${prefix}.provider`, ""),
        this.getAiConfig(`${prefix}.model`, ""),
        this.getAiConfig(`${prefix}.maxTokens`, ""),
        this.getAiConfig(`${prefix}.timeoutMs`, ""),
        this.getAiConfig(`${prefix}.temperature`, ""),
      ]);

    const requested = (providerOverride ?? "").trim();
    const override: RouteOverride = {
      // 请求级覆盖 > 配置覆盖 > 全局缺省（顺序即优先级）
      ...(requested
        ? { provider: requested }
        : provider.trim()
          ? { provider: provider.trim() }
          : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(numOrUndefined(maxTokens) !== undefined
        ? { maxTokens: numOrUndefined(maxTokens) }
        : {}),
      ...(numOrUndefined(timeoutMs) !== undefined
        ? { timeoutMs: numOrUndefined(timeoutMs) }
        : {}),
      ...(numOrUndefined(temperature) !== undefined
        ? { temperature: numOrUndefined(temperature) }
        : {}),
    };

    return resolveAiRoute({
      purpose,
      globalProvider,
      providers: entries,
      keys,
      override,
    });
  }

  /** 供设置页显示：注册表条目 + 每个条目是否已配密钥（永不回传密钥值）。 */
  async listProviderViews(): Promise<{
    providers: Array<AiProviderEntry & { hasApiKey: boolean; legacy: boolean }>;
    errors: string[];
  }> {
    const { entries, keys, legacy, errors } = await this.loadProviders();
    return {
      providers: entries.map((e) => ({
        ...e,
        hasApiKey: !!keys[e.id],
        legacy,
      })),
      errors,
    };
  }

  /**
   * 设置页读面：注册表 + 每个用途当前指向 + 解析错误。
   *
   * `routes[purpose].provider` 为空串表示"跟随全局 `ai.provider`"——
   * 前端据此刻画"继承/覆盖"两种状态，而不是自己猜。
   */
  async providerAdminView(): Promise<{
    providers: Array<AiProviderEntry & { hasApiKey: boolean; legacy: boolean }>;
    errors: string[];
    routes: Record<
      AiPurpose,
      { provider: string; model: string; maxTokens: string; timeoutMs: string }
    >;
  }> {
    const { providers, errors } = await this.listProviderViews();
    const purposes: AiPurpose[] = ["analysis", "agent", "video"];
    const entries = await Promise.all(
      purposes.map(async (purpose) => {
        const [provider, model, maxTokens, timeoutMs] = await Promise.all([
          this.getAiConfig(`routes.${purpose}.provider`, ""),
          this.getAiConfig(`routes.${purpose}.model`, ""),
          this.getAiConfig(`routes.${purpose}.maxTokens`, ""),
          this.getAiConfig(`routes.${purpose}.timeoutMs`, ""),
        ]);
        return [purpose, { provider, model, maxTokens, timeoutMs }] as const;
      }),
    );
    return { providers, errors, routes: Object.fromEntries(entries) as never };
  }

  /**
   * 新增/更新一个 provider 条目（设置页"接入端点"）。
   *
   * **首次保存会物化缺省条目**：`ai.providers` 为空时读面是旧键合成的三条
   * （见 `loadProviders`），这里把它们**一并写入**注册表——从此以注册表为准。
   * 这是刻意的：否则"存了一条却仍在读 env"会让设置页显示与实际生效不一致
   * （改了模型不生效、怀疑平台坏了）。代价是旧 env 键对这些 id 不再生效，
   * 由设置页接管（页面上会摘掉 `legacy` 标记）。
   *
   * 密钥语义与 `system_configs` 一致：不传或传 `***` = 保持原值（前端回显
   * 掩码，不该因为"没改密钥"就把密钥清空）；传空串 = 清除。
   */
  async saveProvider(input: {
    id: string;
    label?: string;
    transport?: string;
    baseUrl: string;
    model: string;
    maxTokens?: number;
    timeoutMs?: number;
    supportsVideo?: boolean;
    enabled?: boolean;
    apiKey?: string;
  }): Promise<void> {
    const normalized = normalizeProviderEntry(
      {
        id: input.id,
        label: input.label,
        transport: input.transport,
        baseUrl: input.baseUrl,
        model: input.model,
        maxTokens: input.maxTokens,
        timeoutMs: input.timeoutMs,
        supportsVideo: input.supportsVideo,
        enabled: input.enabled,
      },
      input.id,
    );
    if (normalized.status === "error") {
      throw new AppError(ErrorCode.AI_PROVIDER_INVALID, {
        detail: normalized.message,
      });
    }
    if (!/^https?:\/\//i.test(normalized.entry.baseUrl)) {
      throw new AppError(ErrorCode.AI_PROVIDER_INVALID, {
        detail: "baseUrl 必须是 http(s) 地址",
      });
    }
    if (!normalized.entry.model.trim()) {
      throw new AppError(ErrorCode.AI_PROVIDER_INVALID, {
        detail: "模型名不能为空",
      });
    }

    const { entries } = await this.loadProviders();
    await this.systemConfig.upsert({
      key: "ai.providers",
      value: serializeProviders(upsertProviderEntry(entries, normalized.entry)),
      description: "AI provider 注册表（不含密钥）",
    });

    // 「未提供」与「显式清空」必须分开：apiKey 是可选字段，省略它的 PUT
    // （只想改 model / baseUrl / maxTokens）过去会因 `?? ""` 走进下面的清空
    // 分支，把真密钥覆盖成空串——HTTP 200、响应正常，而该 provider 上的三个
    // 用途一起回落「密钥未配置」。DTO 注释与 openapi 承诺「不传 = 保持原值」，
    // 实现必须同口径。
    if (input.apiKey === undefined) return;
    const key = input.apiKey.trim();
    if (key === "***") return; // 保持原值
    if (key === "") {
      // 显式清空：写空串而不是删行（保留 isSecret 元数据，历史可追溯）
      await this.systemConfig.upsert({
        key: `ai.providers.${normalized.entry.id}.apiKey`,
        value: "",
        description: `provider ${normalized.entry.id} 的 API Key`,
        isSecret: true,
      });
      return;
    }
    await this.systemConfig.upsert({
      key: `ai.providers.${normalized.entry.id}.apiKey`,
      value: key,
      description: `provider ${normalized.entry.id} 的 API Key`,
      isSecret: true,
    });
  }

  /** 删除一个 provider 条目（连同它的密钥行——孤儿密钥是纯负债）。 */
  async deleteProvider(id: string): Promise<void> {
    const { entries } = await this.loadProviders();
    const next = removeProviderEntry(entries, id);
    if (next.length === entries.length) {
      throw new AppError(ErrorCode.AI_PROVIDER_NOT_FOUND, { id });
    }
    await this.systemConfig.upsert({
      key: "ai.providers",
      value: serializeProviders(next),
      description: "AI provider 注册表（不含密钥）",
    });
    try {
      await this.systemConfig.remove(`ai.providers.${id}.apiKey`);
    } catch {
      // 删除密钥失败不阻塞条目删除（下次覆盖写入时会被覆盖）；
      // 但服务日志里应能看到——这里交给上层 upsert 的成功路径，不额外抛。
    }
  }

  /**
   * 把某个用途指向某个 provider（空串 = 跟随全局）。
   *
   * 只写 `ai.routes.<purpose>.provider/.model` 两键：maxTokens/timeoutMs/
   * temperature 属于"细调"，由环境变量或系统配置直接设置，不在这条
   * "选模型"的主路径上增加字段（少一个必填项就少一类填错）。
   */
  async assignRoute(
    purpose: AiPurpose,
    providerId: string,
    model: string,
  ): Promise<void> {
    await Promise.all([
      this.systemConfig.upsert({
        key: `ai.routes.${purpose}.provider`,
        value: providerId.trim(),
        description: `${purpose} 用途使用的 provider（空=跟随全局）`,
      }),
      this.systemConfig.upsert({
        key: `ai.routes.${purpose}.model`,
        value: model.trim(),
        description: `${purpose} 用途覆盖的模型名（空=用条目缺省）`,
      }),
    ]);
  }

  /**
   * 为一段已落库的视频签发**给模型用的直链**（视频转 SOP 的前置）。
   *
   * 为什么由 AiService 提供而不是端点自己拼：签名密钥/可达 base/TTL 是 AI 侧
   * 配置（`ai.mediaUrlSecret` / `ai.mediaBaseUrl` / `ai.mediaUrlTtlMs`），
   * 端点只该拿到"能用/不能用 + URL"。未配置时返回可读原因，让端点把它翻译成
   * 用户提示，而不是发一条模型取不到的链接（那会表现为"生成卡住"）。
   */
  async signedVideoUrl(mediaId: string, fileName: string): Promise<SignResult> {
    const [secret, baseUrl, ttlRaw] = await Promise.all([
      this.getAiConfig("mediaUrlSecret", ""),
      this.getAiConfig("mediaBaseUrl", ""),
      this.getAiConfig("mediaUrlTtlMs", String(DEFAULT_MEDIA_URL_TTL_MS)),
    ]);
    const ttl = Number(ttlRaw);
    return buildSignedMediaUrl(
      { mediaId, fileName },
      {
        secret,
        baseUrl,
        ttlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_MEDIA_URL_TTL_MS,
      },
    );
  }

  /**
   * 校验视频直链用的签名密钥（下载端与签发端**必须**同源：都是 DB 优先 +
   * env 兜底，任何一边读错都会变成"链接永远验不过"）。
   */
  async signingSecret(): Promise<string> {
    return this.getAiConfig("mediaUrlSecret", "");
  }

  /** Dispatch a prompt to the **analysis** route. Returns "" when unavailable. */
  private async callProvider(prompt: string): Promise<string> {
    const resolved = await this.routeFor("analysis");
    if (resolved.status === "error") {
      // fail-open：与既有姿态一致——未启用/不可用即返回空，调用方按「无结果」
      // 降级。debug 级：默认 disabled 的部署不该被这条刷屏。
      this.logger.debug(`AI analysis 跳过：${resolved.message}`);
      return "";
    }
    const route = resolved.route;
    for (const note of route.notes)
      this.logger.debug(`AI route(${route.purpose}): ${note}`);
    try {
      if (route.transport === "ollama") {
        return await this.callGenerate(route, prompt);
      }
      const res = await this.callCompatible(route, {
        messages: [{ role: "user", content: prompt }],
      });
      return res.content;
    } catch (e: unknown) {
      this.logger.warn(
        `AI error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return "";
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
  /**
   * 多模态 / tool-calling 对话（Agent 与视频理解共用）。
   *
   * **不再按厂商分派**：`qwen` 只是注册表里的一条（`supportsVideo: true`），
   * 任何 OpenAI 兼容端点都能承载 Agent。用途（`req.purpose`）决定走哪条路由：
   *   · `agent`（默认）→ 支持 tool-calling 的端点，输出/超时按 Agent 下限抬；
   *   · `video` → **必须** `supportsVideo` 的端点，否则如实不可用（不静默降级）。
   *
   * 安全：出站仍走与既有分支完全相同的守卫——`assertAndPinHttpUrl`（SSRF +
   * DNS pin）+ `maxRedirects: 0`（拒 3xx 绕过）+ `validateMediaUrls`
   * （媒体 URL 只接受 http(s) / 受限 inline 图片）。**不新开旁路**。
   */
  async chatMultimodal(req: MultimodalRequest): Promise<MultimodalResponse> {
    const purpose: AiPurpose = req.purpose ?? "agent";
    const resolved = await this.routeFor(purpose, req.provider);
    if (resolved.status === "error") {
      this.logger.warn(
        `chatMultimodal(${purpose}) 不可用：${resolved.message}`,
      );
      return emptyResponse();
    }
    const route = resolved.route;
    for (const note of route.notes)
      this.logger.debug(`AI route(${purpose}): ${note}`);

    if (route.transport !== "openai") {
      // 到这里只可能是配置指错（路由层已拒 agent 走 generate 面）
      this.logger.warn(
        `chatMultimodal(${purpose}) 选中的 provider「${route.provider}」只有 /api/generate 面，无法承载多模态/tool-calling`,
      );
      return emptyResponse();
    }
    if (!route.supportsVideo && hasVideoPart(req.messages)) {
      // 路由层对 video 用途已拒；这里是防御性兜底（例如 agent 用途误传视频）
      this.logger.warn(
        `chatMultimodal(${purpose}) 收到 video_url，但 provider「${route.provider}」未声明支持视频——已忽略本次调用`,
      );
      return emptyResponse();
    }

    return this.callCompatible(route, req);
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
        // inline 图片：只允许 image/png|jpeg|webp 的 base64，且限长。
        if (
          part.type === "image_url" &&
          DATA_IMAGE_RE.test(url) &&
          url.length <= MAX_INLINE_IMAGE_CHARS
        ) {
          continue;
        }
        if (!MEDIA_URL_RE.test(url)) {
          // 原实现截断到 64 字符——URL 由执行器上报，整串进日志/响应的收益
          // 低于其体积与潜在敏感信息（签名 query）成本，故保持截断语义。
          throw new AppError(ErrorCode.AI_MEDIA_URL_SCHEME_NOT_ALLOWED, {
            url: url.slice(0, 64),
          });
        }
      }
    }
  }

  /**
   * OpenAI 兼容调用（analysis / agent / video 共用**同一条**实现）。
   *
   * 为什么能共用：三者的差别只有「模型 / 令牌上限 / 超时 / 要不要 tools」，
   * 而这些都是路由的一部分；HTTP 形状、SSRF 守卫、响应归一三件事完全相同。
   * 按用途复制三份实现只会让守卫与归一在某一份里悄悄漂移（历史上 qwen 分支
   * 就是因为"另抄一份"而漏掉过校验）。
   */
  private async callCompatible(
    route: ResolvedRoute,
    req: MultimodalRequest,
  ): Promise<MultimodalResponse> {
    // AI-001 / F-3：SSRF 守卫 + DNS pin（Host/SNI 保留），关闭 rebinding 窗口。
    // ARCH-31：AI_ALLOW_PRIVATE_NETWORK=true 时放开内网（link-local 恒拒）。
    const pinned = await assertAndPinHttpUrl(route.baseUrl, {
      allowPrivateNetwork:
        this.config.get<boolean>("ai.allowPrivateNetwork") === true,
    });
    const pinCfg = pinnedAxiosConfig(pinned);

    this.validateMediaUrls(req.messages);

    const body: Record<string, unknown> = {
      model: route.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? route.maxTokens,
    };
    // 只在显式配置时下发温度——不猜 provider 的默认值
    if (route.temperature !== undefined) body.temperature = route.temperature;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? "auto";
    }
    if (req.responseFormat) {
      body.response_format = { type: req.responseFormat };
    }

    const r = await axios.post(`${route.baseUrl}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${route.apiKey}` },
      timeout: route.timeoutMs,
      // R3: maxRedirects=0 —— 3xx 不得绕过首跳 SSRF 校验。
      maxRedirects: 0,
      ...pinCfg,
    });

    const choice = r.data?.choices?.[0];
    const usage = r.data?.usage ?? {};
    const cachedTokens = usageCount(
      usage.prompt_tokens_details?.cached_tokens ??
        usage.input_tokens_details?.cached_tokens ??
        usage.cached_tokens,
    );

    // 上游响应是**不可信输入**（见 llm-response.ts 的三种畸形形状）。
    const content = normalizeAssistantContent(choice?.message?.content);
    const toolCalls = normalizeToolCalls(choice?.message?.tool_calls);

    // 命中率只统计"有输入"的调用（tokensIn>0），避免把空响应算成 miss
    if (usageCount(usage.prompt_tokens) > 0) {
      recordRuntime("autoflow_ai_cache_lookup_total", {
        result: cachedTokens > 0 ? "hit" : "miss",
      });
    }

    if (isTruncatedFinish(choice?.finish_reason)) {
      this.logger.warn(
        `chatMultimodal: output truncated by max_tokens (provider=${route.provider}, ` +
          `model=${route.model}, maxTokens=${body.max_tokens}, ` +
          `toolCalls=${toolCalls?.length ?? 0})`,
      );
    }

    return {
      content,
      toolCalls,
      usage: {
        tokensIn: usageCount(usage.prompt_tokens),
        tokensOut: usageCount(usage.completion_tokens),
        ...(cachedTokens > 0 ? { cachedTokens } : {}),
      },
      model: route.model,
      provider: route.provider,
    };
  }

  /**
   * 流式版本（SSE）：给"看视频出草稿"这类**慢轮次**用。
   *
   * 与 `chatMultimodal` 的差别只在传输：同样的路由/守卫/媒体校验，`stream: true`
   * 后逐帧解析 `data:`，每段增量回调 `onDelta`。返回的仍是**完整**响应（内容 +
   * usage），调用方照旧做协议解析与落库——流只是"让人先看到"。
   *
   * `stream_options.include_usage` 是 OpenAI 的扩展：不支持的 provider 会忽略它，
   * 此时 usage 为空（下游按 0 记），不影响正文。
   */
  async chatMultimodalStream(
    req: MultimodalRequest,
    handlers: { onDelta?: (text: string) => void; signal?: AbortSignal } = {},
  ): Promise<MultimodalResponse> {
    const purpose: AiPurpose = req.purpose ?? "agent";
    const resolved = await this.routeFor(purpose, req.provider);
    if (resolved.status === "error") {
      this.logger.warn(
        `chatMultimodalStream(${purpose}) 不可用：${resolved.message}`,
      );
      return emptyResponse();
    }
    const route = resolved.route;
    if (route.transport !== "openai") return emptyResponse();
    if (!route.supportsVideo && hasVideoPart(req.messages))
      return emptyResponse();

    const pinned = await assertAndPinHttpUrl(route.baseUrl, {
      allowPrivateNetwork:
        this.config.get<boolean>("ai.allowPrivateNetwork") === true,
    });
    const pinCfg = pinnedAxiosConfig(pinned);
    this.validateMediaUrls(req.messages);

    const body: Record<string, unknown> = {
      model: route.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? route.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (route.temperature !== undefined) body.temperature = route.temperature;
    if (req.responseFormat) body.response_format = { type: req.responseFormat };

    const r = await axios.post(`${route.baseUrl}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${route.apiKey}` },
      // 流式下 timeout 是"整条连接"的上限；视频推理本来慢，取路由分配值
      timeout: route.timeoutMs,
      responseType: "stream",
      maxRedirects: 0,
      ...(handlers.signal ? { signal: handlers.signal } : {}),
      ...pinCfg,
    });

    let content = "";
    let usage: { tokensIn: number; tokensOut: number; cachedTokens?: number } =
      {
        tokensIn: 0,
        tokensOut: 0,
      };

    await new Promise<void>((resolve, reject) => {
      const stream = r.data as NodeJS.ReadableStream;
      let buffer = "";
      const onData = (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let parsedFrames: ReturnType<typeof parseSseFrames>;
        try {
          parsedFrames = parseSseFrames(buffer);
        } catch (err) {
          reject(err);
          return;
        }
        buffer = parsedFrames.rest;
        for (const frame of parsedFrames.frames) {
          let delta: ReturnType<typeof parseStreamDelta>;
          try {
            delta = parseStreamDelta(frame.data);
          } catch (err) {
            // 流内错误帧：如实上抛（调用方据此报错，而不是当成"模型没说话"）
            reject(err);
            return;
          }
          if (!delta) continue;
          if (delta.usage) usage = delta.usage;
          if (delta.text) {
            content += delta.text;
            try {
              handlers.onDelta?.(delta.text);
            } catch {
              // 下游（HTTP 连接）断了不该中断已产生的推理——继续收完
            }
          }
        }
      };
      stream.on("data", onData);
      stream.on("end", () => resolve());
      stream.on("error", (err: Error) => reject(err));
    });

    if (usage.tokensIn > 0) {
      recordRuntime("autoflow_ai_cache_lookup_total", {
        result: usage.cachedTokens ? "hit" : "miss",
      });
    }

    return {
      content,
      usage: {
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        ...(usage.cachedTokens ? { cachedTokens: usage.cachedTokens } : {}),
      },
      model: route.model,
      provider: route.provider,
    };
  }

  /**
   * ollama 的 `/api/generate`（只有纯文本分析用途走这里）。
   *
   * Agent / 视频用途在路由层就被拒（该面没有 tools，也不接受多模态片段）——
   * 静默降级成"无工具文本模式"会让 Agent 每一步工具调用都失败。
   */
  private async callGenerate(
    route: ResolvedRoute,
    prompt: string,
  ): Promise<string> {
    const pinned = await assertAndPinHttpUrl(route.baseUrl, {
      allowPrivateNetwork:
        this.config.get<boolean>("ai.allowPrivateNetwork") === true,
    });
    const pinCfg = pinnedAxiosConfig(pinned);
    const r = await axios.post(
      `${route.baseUrl}/api/generate`,
      { model: route.model, prompt, stream: false },
      // R3: maxRedirects=0 —— 自建服务的 3xx 同样不得绕过首跳校验。
      { timeout: route.timeoutMs, maxRedirects: 0, ...pinCfg },
    );
    return typeof r.data?.response === "string" ? r.data.response : "";
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
   * 当前生效路由（供 Agent 逐条记录「这一步是谁答的」）。
   *
   * 为什么由 AiService 暴露而不是调用方自己猜：路由是内部决策（注册表 +
   * 用途覆盖 + 参数下限），调用方复制一份解析逻辑必然漂移——而
   * `steps.provider/model` 正是排查与成本归因的依据，错了会把排查引向错误方向。
   */
  async getActiveRoute(
    purpose: AiPurpose = "agent",
  ): Promise<{ provider: string; model: string }> {
    const resolved = await this.routeFor(purpose);
    if (resolved.status === "error") return { provider: "disabled", model: "" };
    return {
      provider: resolved.route.provider,
      model: resolved.route.model,
    };
  }

  /**
   * 「当前生效 provider 是否已配置密钥」（设置页展示用，永不回传密钥值）。
   *
   * 语义变化（推理质量轮）：不再按 `ai.provider` 手写 qwen/openai 分支——
   * 注册表里任何 OpenAI 兼容条目都算，密钥来源统一（scoped key → 旧键）。
   */
  async hasApiKeyForProvider(): Promise<boolean> {
    const { entries, keys } = await this.loadProviders();
    const global = (
      await this.getAiConfig("provider", "disabled")
    ).toLowerCase();
    const entry = entries.find((e) => e.id === global);
    if (!entry || entry.transport !== "openai") return false;
    return !!keys[entry.id]?.trim();
  }
}

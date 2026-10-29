/**
 * 推理质量轮（2026-10-28）：**按用途路由 + 参数分配**。
 *
 * ## 现状里真正的问题
 * `ai.provider` 是**全局单选**，于是三件互相冲突的事共用一套参数：
 *
 * | 用途 | 真实需求 | 全局单选下的结果 |
 * |---|---|---|
 * | 失败日志分析 | 便宜、快、输出短（500 令牌够） | 与 Agent 共用 |
 * | Agent 推理 | 强模型、长输出（整份源码）、tool-calling | 与日志分析共用 |
 * | 视频理解（转 SOP） | **必须**支持 video_url 的多模态模型 | 没有位置放，且代码只认 qwen |
 *
 * 两边都不对：换成便宜档，Agent 只剩 500 输出令牌（一份 `main.py` 都放不下）；
 * 为了 Agent 换贵模型，每条失败日志分析都按 Agent 价目计费。
 *
 * ## 解法
 * 「全局 provider 是缺省，**用途可覆盖**」，且 provider 由**注册表**（
 * `ai-providers.ts`）定义，不是代码分支：
 *
 * ```
 * ai.provider                    = qwen            # 缺省
 * ai.routes.agent.provider       = qwen-vl         # 覆盖：Agent 用多模态强模型
 * ai.routes.agent.maxTokens      = 8192
 * ai.routes.analysis.provider    = cheap-gpt       # 覆盖：分析用便宜档
 * ai.routes.video.provider       = qwen-vl         # 视频理解（必须 supportsVideo）
 * ```
 *
 * ## 三条分配纪律
 * ① **Agent 输出/等待预算不继承分析档**：分析档的 500 令牌与 30s 是刻意省成本，
 *    Agent 一次要吐整份文件——未显式配置时按 `AGENT_MIN_OUTPUT_TOKENS`（2048）
 *    与 `AGENT_MIN_TIMEOUT_MS`（60s）兜底。
 * ② **能力不匹配就如实拒绝，不静默降级**：视频用途选中不支持视频的模型 → 拒；
 *    Agent 选中 ollama（只有 `/api/generate`，无 tool-calling 面）→ 拒。静默降级
 *    会变成"工具全部失败"的谜之现象，比直接报不可用更难查。
 * ③ **纯函数**：配置读取在 AiService（DB 优先 + env 兜底），这里只判定，故单测
 *    可以逐条钉住"哪个用途拿到哪套参数"。
 */

import type { AiProviderEntry, AiPurpose } from "./ai-providers";

/**
 * Agent 路由的输出令牌下限。
 *
 * 为什么是 2048：一次 plan 要给出「文件全文 + 入口 + notes」，小文件也在千级
 * 令牌；500（分析档）会让模型每次都把 JSON 说一半被截断——下游表现为"输出
 * 不是合法 JSON"，排查方向完全错。
 */
export const AGENT_MIN_OUTPUT_TOKENS = 2_048;

/** Agent 路由的等待下限：长输出 + 慢 provider，30s 不够。 */
export const AGENT_MIN_TIMEOUT_MS = 60_000;

/** 用途级覆盖（未填 = 跟随全局 / 注册表缺省）。 */
export interface RouteOverride {
  provider?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** 只在**显式配置**时下发（不猜 provider 的默认温度）。 */
  temperature?: number;
}

export interface RouteContext {
  purpose: AiPurpose;
  /** `ai.provider`（缺省 provider id）。 */
  globalProvider: string;
  providers: readonly AiProviderEntry[];
  /** provider id → apiKey（注册表不存密钥）。 */
  keys: Readonly<Record<string, string | undefined>>;
  override?: RouteOverride;
}

export interface ResolvedRoute {
  purpose: AiPurpose;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
  transport: "openai" | "ollama";
  /** 该条目是否声明支持视频（视频用途必然为 true）。 */
  supportsVideo: boolean;
  /** 便于排查的说明（例如"按下限抬到 8192"）。 */
  notes: string[];
}

export type RouteResolution =
  | { status: "ok"; route: ResolvedRoute }
  | {
      status: "error";
      reason:
        | "disabled"
        | "unknown_provider"
        | "provider_disabled"
        | "capability_missing"
        | "missing_key"
        | "invalid_config";
      message: string;
    };

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 解析一次路由（纯函数；配置脏值一律回落或如实拒绝，绝不抛）。 */
export function resolveAiRoute(ctx: RouteContext): RouteResolution {
  const override = ctx.override ?? {};
  const providerId = (override.provider?.trim() || ctx.globalProvider || "")
    .trim()
    .toLowerCase();

  if (providerId === "" || providerId === "disabled") {
    return {
      status: "error",
      reason: "disabled",
      message: `AI 未启用（ai.provider / ai.routes.${ctx.purpose}.provider 为空或 disabled）`,
    };
  }

  const entry = ctx.providers.find((p) => p.id === providerId);
  if (!entry) {
    const known = ctx.providers.map((p) => p.id).join(" / ");
    return {
      status: "error",
      reason: "unknown_provider",
      message: `未知 provider「${providerId}」（已注册：${known || "无"}）——请在 AI 设置里先接入该端点`,
    };
  }
  if (!entry.enabled) {
    return {
      status: "error",
      reason: "provider_disabled",
      message: `provider「${providerId}」已被禁用`,
    };
  }

  // ── 能力闸（不静默降级）────────────────────────────────────────
  if (ctx.purpose === "video" && !entry.supportsVideo) {
    return {
      status: "error",
      reason: "capability_missing",
      message:
        `provider「${providerId}」未标记「支持视频」——视频理解必须选支持 video 的模型` +
        `（在 AI 设置里勾选该模型的支持视频能力）`,
    };
  }
  if (ctx.purpose === "agent" && entry.transport !== "openai") {
    return {
      status: "error",
      reason: "capability_missing",
      message:
        `provider「${providerId}」只有 /api/generate（无 tool-calling 面），不能承载 Agent 推理；` +
        `请选一个 OpenAI 兼容端点（/chat/completions）`,
    };
  }

  // ── 端点/凭据 ─────────────────────────────────────────────────
  if (!/^https?:\/\//i.test(entry.baseUrl)) {
    return {
      status: "error",
      reason: "invalid_config",
      message: `provider「${providerId}」的 baseUrl 不是 http(s) URL：${entry.baseUrl || "(空)"}`,
    };
  }
  const apiKey = (ctx.keys[providerId] ?? "").trim();
  if (entry.transport === "openai" && !apiKey) {
    return {
      status: "error",
      reason: "missing_key",
      message: `provider「${providerId}」未配置 API Key`,
    };
  }

  const model = override.model?.trim() || entry.model.trim();
  if (!model) {
    return {
      status: "error",
      reason: "invalid_config",
      message: `provider「${providerId}」未配置模型名`,
    };
  }

  // ── 参数分配（Agent 下限）──────────────────────────────────────
  const notes: string[] = [];
  const overrideMax =
    typeof override.maxTokens === "number" && override.maxTokens > 0
      ? Math.floor(override.maxTokens)
      : undefined;
  let maxTokens = overrideMax ?? entry.maxTokens;
  if (ctx.purpose === "agent" && overrideMax === undefined) {
    const raised = Math.max(maxTokens, AGENT_MIN_OUTPUT_TOKENS);
    if (raised !== maxTokens) {
      notes.push(
        `输出预算按下限抬到 ${raised}（provider 缺省 ${maxTokens} 是分析档语义）`,
      );
      maxTokens = raised;
    }
  }

  const overrideTimeout =
    typeof override.timeoutMs === "number" && override.timeoutMs > 0
      ? Math.floor(override.timeoutMs)
      : undefined;
  let timeoutMs = overrideTimeout ?? entry.timeoutMs;
  if (ctx.purpose === "agent" && overrideTimeout === undefined) {
    const raised = Math.max(timeoutMs, AGENT_MIN_TIMEOUT_MS);
    if (raised !== timeoutMs) {
      notes.push(
        `超时按下限抬到 ${raised}ms（provider 缺省 ${timeoutMs}ms 是分析档语义）`,
      );
      timeoutMs = raised;
    }
  }
  maxTokens = positiveInt(maxTokens, entry.maxTokens);
  timeoutMs = positiveInt(timeoutMs, entry.timeoutMs);

  if (override.provider && providerId !== ctx.globalProvider.toLowerCase()) {
    notes.push(
      `路由覆盖：${ctx.purpose} 用 ${providerId}（全局缺省 ${ctx.globalProvider}）`,
    );
  }

  const temperature =
    typeof override.temperature === "number" &&
    Number.isFinite(override.temperature) &&
    override.temperature >= 0 &&
    override.temperature <= 2
      ? override.temperature
      : undefined;

  return {
    status: "ok",
    route: {
      purpose: ctx.purpose,
      provider: providerId,
      model,
      baseUrl: entry.baseUrl,
      apiKey,
      maxTokens,
      timeoutMs,
      ...(temperature !== undefined ? { temperature } : {}),
      transport: entry.transport,
      supportsVideo: entry.supportsVideo,
      notes,
    },
  };
}

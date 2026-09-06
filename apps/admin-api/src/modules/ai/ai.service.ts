import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { SystemConfigService } from "../config/config.service";
import { assertSafeHttpUrl } from "../../common/utils/safe-http.util";

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
      if (parsed.suggestedCron && parsed.reasoning) return parsed;
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
    } catch (e: unknown) {
      this.logger.warn(
        `AI error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return "";
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
    await assertSafeHttpUrl(baseUrl);
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
        // target. (See common/utils/safe-http.util.ts for the rebinding
        // residual risk note — DNS pinning is left as a follow-up.)
        maxRedirects: 0,
      },
    );
    return r.data.choices[0].message.content;
  }

  private async callOllama(prompt: string) {
    const host = await this.getAiConfig("ollamaHost", "http://localhost:11434");
    // AI-001: SSRF guard for self-hosted Ollama.
    await assertSafeHttpUrl(host);
    const model = await this.getAiConfig("ollamaModel", "llama3");
    const r = await axios.post(
      `${host}/api/generate`,
      { model, prompt, stream: false },
      // R3: maxRedirects=0 — see callOpenAI comment. Ollama is
      // self-hosted; a redirect to a private host would still slip past
      // the first-hop check, so we refuse 3xx outright.
      { timeout: 60_000, maxRedirects: 0 },
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
    ];
    const result: Record<string, string> = {};
    for (const k of keys) {
      result[k] = await this.getAiConfig(
        k,
        k === "openaiBaseUrl" ? "https://api.openai.com/v1" : "",
      );
    }
    // Never return the API key value — caller requests it separately if needed
    return result;
  }
}

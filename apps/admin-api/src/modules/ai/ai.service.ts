import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  constructor(private config: ConfigService) {}

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
        // long hex strings (≥32 chars — likely keys/tokens)
        .replace(/[0-9a-fA-F]{32,}/g, "[REDACTED_HEX]")
        // long base64-like strings (≥40 chars)
        .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[REDACTED_B64]")
        .slice(0, 3000)
    );
  }

  async analyzeFailure(task: Pick<{ name: string; runtime: string }, 'name' | 'runtime'>, logs: string): Promise<string> {
    const provider = this.config.get<string>("ai.provider", "disabled");
    if (provider === "disabled") return "";
    const sanitized = this.sanitizeLogs(logs);
    const prompt = `You are an automated task analysis assistant. Task "${task.name}" (runtime: ${task.runtime}) failed. Analyze the root cause and suggest a fix.\n\nError logs:\n${sanitized}\n\nRespond in this format:\n**Failure reason:** ...\n**Fix suggestion:** ...`;
    try {
      if (provider === "openai") return await this.callOpenAI(prompt);
      if (provider === "ollama") return await this.callOllama(prompt);
    } catch (e: unknown) {
      this.logger.warn(`AI error: ${e instanceof Error ? e.message : String(e)}`);
    }
    return "";
  }

  private async callOpenAI(prompt: string) {
    // Q4: add timeout so a non-responsive LLM doesn't block the BullMQ worker indefinitely
    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: this.config.get("ai.openaiModel", "gpt-4o-mini"),
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${this.config.get("ai.openaiApiKey")}`,
        },
        timeout: 30_000,
      },
    );
    return r.data.choices[0].message.content;
  }

  private async callOllama(prompt: string) {
    // Q4: add timeout
    const r = await axios.post(
      `${this.config.get("ai.ollamaHost", "http://localhost:11434")}/api/generate`,
      {
        model: this.config.get("ai.ollamaModel", "llama3"),
        prompt,
        stream: false,
      },
      { timeout: 60_000 },
    );
    return r.data.response;
  }
}

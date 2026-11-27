/**
 * 工作台 AI 辅助方案规划。
 *
 * 只在 `preview?useAi=true` 时调用：把**确定性的**方案卡作为锚，向模型要
 * 「步骤 / 风险 / 建议能力」等展示增强字段。契约边界：
 *
 * - 输出**只能**影响 `plannerMode` / `aiSuggestions`，绝不进入 card / cardHash /
 *   eligible / checks —— 确定性闸门与留痕 hash 的语义一字不改；
 * - 15s 硬超时：模型不可用 / 超时 / JSON 解析失败一律回落 deterministic，
 *   不把 preview 从「纯本地纯内存」升级成「依赖外部模型」；
 * - `@Optional()` 注入 AiService：裁剪部署 / 老单测没有 AI 模块时直接 deterministic。
 */
import { Injectable, Logger, Optional } from "@nestjs/common";

import { AiService } from "../ai/ai.service";
import type {
  PlanCardAiSuggestionsDto,
  PreviewPlanCardRequestDto,
} from "./dto/preview-plan-card.dto";
import type { PlanCardDto } from "./dto/preview-plan-card.dto";
import { PREVIEW_CAPABILITY_WHITELIST } from "./preview-validator";

/** 模型调用硬超时（毫秒）——超过即回落，不让 preview 无限等外部 provider。 */
export const WORKBENCH_PLANNER_TIMEOUT_MS = 15_000;

export interface WorkbenchPlanSuggestion {
  /** `useAi` 未开启时字段完全缺席（保持既有 preview 响应形状不变）。 */
  plannerMode?: "ai" | "deterministic";
  aiSuggestions?: PlanCardAiSuggestionsDto;
}

interface RawSuggestion {
  title?: unknown;
  summary?: unknown;
  suggestedSteps?: unknown;
  capabilityHints?: unknown;
  acceptanceText?: unknown;
  riskNotes?: unknown;
}

/** 从可能带 markdown 代码围栏的模型输出里取出第一个 `{...}` 对象。 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenced ? fenced[1] : text;
  const open = body.indexOf("{");
  const close = body.lastIndexOf("}");
  if (open < 0 || close <= open) return null;
  try {
    const parsed: unknown = JSON.parse(body.slice(open, close + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function cleanStringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const cleaned = cleanString(item, maxChars);
    if (cleaned && !result.includes(cleaned)) {
      result.push(cleaned);
      if (result.length >= maxItems) break;
    }
  }
  return result;
}

@Injectable()
export class WorkbenchAiPlannerService {
  private readonly logger = new Logger(WorkbenchAiPlannerService.name);

  constructor(
    @Optional()
    private readonly ai?: AiService | null,
  ) {}

  /**
   * 生成展示增强建议。任何失败都返回 `deterministic`（不抛）。
   */
  async enhance(
    dto: PreviewPlanCardRequestDto,
    card: PlanCardDto,
  ): Promise<WorkbenchPlanSuggestion> {
    if (!this.ai || dto.useAi !== true) return {};
    try {
      const response = await this.withTimeout(
        this.ai.chatMultimodal({
          purpose: "agent",
          messages: [
            {
              role: "system",
              content:
                "你是工作台方案规划助手。只输出一个 JSON 对象，字段：" +
                "title, summary, suggestedSteps, capabilityHints, acceptanceText, riskNotes。" +
                "suggestedSteps 与 riskNotes 是字符串数组；capabilityHints 只允许以下值：" +
                `${PREVIEW_CAPABILITY_WHITELIST.join(", ")}。` +
                "不要输出 JSON 以外的文字。",
            },
            {
              role: "user",
              content: JSON.stringify({
                goal: dto.goal,
                cadence: dto.cadence,
                card: {
                  title: card.title,
                  triggerText: card.triggerText,
                  capabilityHints: card.capabilityHints,
                  acceptanceText: card.acceptanceText,
                },
              }),
            },
          ],
          responseFormat: "json_object",
          maxTokens: 600,
        }),
      );
      if (!response || typeof response.content !== "string" || !response.content.trim()) {
        return { plannerMode: "deterministic" };
      }
      const parsed = extractJsonObject(response.content);
      if (!parsed) return { plannerMode: "deterministic" };
      const steps = cleanStringArray(parsed.suggestedSteps, 8, 240);
      const risks = cleanStringArray(parsed.riskNotes, 6, 200);
      const summary = cleanString(parsed.summary, 800);
      if (!summary && steps.length === 0 && risks.length === 0) {
        return { plannerMode: "deterministic" };
      }
      const hints = cleanStringArray(parsed.capabilityHints, 6, 32).filter((value) =>
        (PREVIEW_CAPABILITY_WHITELIST as readonly string[]).includes(value),
      );
      const suggestions: PlanCardAiSuggestionsDto = {
        summary: summary ?? "已给出步骤与风险建议。",
        suggestedSteps: steps,
        riskNotes: risks,
        ...(cleanString(parsed.title, 120) ? { title: cleanString(parsed.title, 120)! } : {}),
        ...(hints.length > 0 ? { capabilityHints: hints } : {}),
        ...(cleanString(parsed.acceptanceText, 400)
          ? { acceptanceText: cleanString(parsed.acceptanceText, 400)! }
          : {}),
        ...(response.model ? { model: response.model } : {}),
        ...(response.provider ? { provider: response.provider } : {}),
      };
      return { plannerMode: "ai", aiSuggestions: suggestions };
    } catch (err: unknown) {
      this.logger.warn(
        `workbench AI planner fallback to deterministic: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { plannerMode: "deterministic" };
    }
  }

  /**
   * 15s 硬超时：超时即 reject 走统一兜底。无论成功/失败都清掉定时器，
   * 不让一个已结束的请求留下悬挂的 timer。
   */
  private withTimeout<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`workbench AI planner timed out after ${WORKBENCH_PLANNER_TIMEOUT_MS}ms`));
      }, WORKBENCH_PLANNER_TIMEOUT_MS);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

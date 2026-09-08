import { Injectable, Logger } from "@nestjs/common";
import { AiService } from "./ai.service";
// ARCH-30: AI 分析失败可观测性——复用「可观测性补齐轮」建立的模块级纯内存
// 计数通道（runtime-metrics-entry），埋点零模块环，PrometheusMetricsService
// 每次 render 读快照 reset+inc 渲染为 autoflow_ai_analysis_total series。
import { recordRuntime } from "../metrics/runtime-metrics-entry";

/**
 * ARCH-30: AI 分析服务化。
 *
 * 处理前的问题（H2 计划 ARCH-30 行 + ARCH-21 范围注记收口）：
 * - task.processor / task.service 里直调 AiService.analyzeFailure——AI 调用
 *   失败只有一行 warn 日志，零指标、零重试，aiAnalysis 落库率不可观测；
 * - 调用点散在 processor 与 service 两处，重试/降级策略无处统一收口。
 *
 * 本服务的最小正确形态：
 * - 封装 AI 调用（AiService.analyzeFailure——admin-api 侧对
 *   packages/autocodeflow-ai 同语义能力的 TS 消费面，AI-001 SSRF 守卫与
 *   S-10 日志脱敏均在 AiService 内保持不变）；
 * - 失败重试：1 次重试 + 立即重发（与既有渠道/通知 fail-open 先例一致，
 *   不做指数退避——执行失败分析是尽力而为的旁路，不值得阻塞终态落库）；
 * - 降级跳过：provider 未配置（analyzeFailure 返回空串，确定性判定，不烧
 *   重试预算）→ result=skipped；瞬时异常重试 1 次仍失败 → result=fail；
 *   任一成功 → result=ok。全程永不抛错（fail-open 不变——AI 失败不影响
 *   任务主链，空串结果原样落库，前端按「无分析」降级渲染）；
 * - 落库率指标：autoflow_ai_analysis_total{result=ok|fail|skipped}，
 *   模块级 recordRuntime 通道（同 runtime-metrics.ts 其余 5 计数器）。
 *
 * 落点裁定（ai 模块而非 notification）：唯一分析输入是执行日志、唯一产出是
 * aiAnalysis 字段，消费方全在 task 模块（processor + analyzeExecution），
 * 与通知扇出无耦合；AiService 同模块注入零 forwardRef，语义上也是「AI 分析
 * 的编排层」而非「通知的一种」。ARCH-30 描述中的「事件监听器」落点经复核
 * 不采纳：handleCallback 的终态事件载荷无重试上下文（attempt 信息在
 * processor 侧），且 notification listener 已有明确单一职责（告警扇出），
 * 塞入 AI 调用会引入 notification→ai 新模块依赖。
 */
export type AiAnalysisResult = "ok" | "fail" | "skipped";

/** 失败后立即重试次数（总尝试 = 1 + retries）。 */
export const AI_ANALYSIS_RETRIES = 1;

@Injectable()
export class AiAnalysisService {
  private readonly logger = new Logger(AiAnalysisService.name);

  constructor(private readonly aiService: AiService) {}

  /**
   * Analyze failed execution logs with one immediate retry on failure.
   * Never throws: any AI-side failure degrades to "" (no analysis) after
   * recording the outcome — identical fail-open posture to the previous
   * inline try/catch in TaskProcessor, now centralized and counted.
   *
   * @param task minimal task identity for the prompt
   * @param logs raw execution logs (sanitization happens inside AiService)
   * @returns analysis text, or "" when the provider is disabled / unavailable
   */
  async analyzeFailure(
    task: Pick<{ name: string; runtime: string }, "name" | "runtime">,
    logs: string,
  ): Promise<string> {
    for (let attempt = 0; attempt <= AI_ANALYSIS_RETRIES; attempt++) {
      try {
        const analysis = await this.aiService.analyzeFailure(task, logs);
        if (analysis && analysis.length > 0) {
          recordRuntime("autoflow_ai_analysis_total", { result: "ok" });
          return analysis;
        }
        // provider disabled / returned empty — deterministic, no retry value
        recordRuntime("autoflow_ai_analysis_total", { result: "skipped" });
        return "";
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < AI_ANALYSIS_RETRIES) {
          this.logger.warn(
            `AI analysis attempt ${attempt + 1} failed for task ${task.name}: ${msg} — retrying once`,
          );
          continue;
        }
        this.logger.warn(
          `AI analysis failed for task ${task.name} after ${AI_ANALYSIS_RETRIES + 1} attempt(s): ${msg}`,
        );
      }
    }
    recordRuntime("autoflow_ai_analysis_total", { result: "fail" });
    return "";
  }
}

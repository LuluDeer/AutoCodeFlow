import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { AiService } from "../ai.service";
import {
  AiAnalysisService,
  AI_ANALYSIS_RETRIES,
} from "../ai-analysis.service";
// ARCH-30: 指标断言入口（模块级快照，与本文件用例内 reset 配对）
import {
  getRuntimeCountersSnapshot,
  resetRuntimeMetrics,
} from "../../metrics/runtime-metrics-entry";

/** 读取 autoflow_ai_analysis_total 某标签组合的累计值 */
const aiCount = (result: "ok" | "fail" | "skipped"): number =>
  getRuntimeCountersSnapshot()
    .get("autoflow_ai_analysis_total" as never)
    ?.get(JSON.stringify({ result })) ?? 0;

describe("AiAnalysisService (ARCH-30)", () => {
  let service: AiAnalysisService;
  let aiService: { analyzeFailure: jest.Mock };

  beforeEach(async () => {
    resetRuntimeMetrics();
    aiService = { analyzeFailure: jest.fn().mockResolvedValue("") };
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [AiAnalysisService, { provide: AiService, useValue: aiService }],
    }).compile();

    service = module.get(AiAnalysisService);
  });

  afterEach(() => {
    resetRuntimeMetrics();
    jest.restoreAllMocks();
  });

  const task = { name: "nightly", runtime: "node" };

  it("returns the analysis and counts result=ok on first success", async () => {
    aiService.analyzeFailure.mockResolvedValue("**Failure reason:** boom");
    await expect(service.analyzeFailure(task, "logs")).resolves.toBe(
      "**Failure reason:** boom",
    );
    expect(aiService.analyzeFailure).toHaveBeenCalledTimes(1);
    expect(aiCount("ok")).toBe(1);
    expect(aiCount("fail")).toBe(0);
    expect(aiCount("skipped")).toBe(0);
  });

  it("retries once and counts result=ok when the first attempt throws", async () => {
    aiService.analyzeFailure
      .mockRejectedValueOnce(new Error("provider 503"))
      .mockResolvedValueOnce("analysis after retry");
    await expect(service.analyzeFailure(task, "logs")).resolves.toBe(
      "analysis after retry",
    );
    expect(aiService.analyzeFailure).toHaveBeenCalledTimes(2);
    expect(aiCount("ok")).toBe(1);
    expect(aiCount("fail")).toBe(0);
  });

  it("fail-open: returns '' and counts result=fail when retries are exhausted", async () => {
    aiService.analyzeFailure.mockRejectedValue(new Error("provider down"));
    await expect(service.analyzeFailure(task, "logs")).resolves.toBe("");
    // 1 initial + AI_ANALYSIS_RETRIES attempts total — never throws
    expect(aiService.analyzeFailure).toHaveBeenCalledTimes(
      AI_ANALYSIS_RETRIES + 1,
    );
    expect(aiCount("fail")).toBe(1);
    expect(aiCount("ok")).toBe(0);
  });

  it("skips (result=skipped, no retry) when the provider is disabled / returns empty", async () => {
    aiService.analyzeFailure.mockResolvedValue("");
    await expect(service.analyzeFailure(task, "logs")).resolves.toBe("");
    // Empty result is a deterministic "not configured" verdict — exactly one
    // call, no retry burn, counted as skipped (not fail).
    expect(aiService.analyzeFailure).toHaveBeenCalledTimes(1);
    expect(aiCount("skipped")).toBe(1);
    expect(aiCount("fail")).toBe(0);
    expect(aiCount("ok")).toBe(0);
  });

  it("accumulates the counter monotonically across calls (counter semantics)", async () => {
    aiService.analyzeFailure
      .mockResolvedValueOnce("first")
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(""); // skipped

    await service.analyzeFailure(task, "a");
    await service.analyzeFailure(task, "b");
    await service.analyzeFailure(task, "c");

    expect(aiCount("ok")).toBe(1);
    expect(aiCount("fail")).toBe(1);
    expect(aiCount("skipped")).toBe(1);
  });

  it("forwards the task identity and raw logs to AiService untouched", async () => {
    aiService.analyzeFailure.mockResolvedValue("ok-text");
    const logs = "Error: ECONNREFUSED\nKEY=hunter2";
    await service.analyzeFailure({ name: "etl", runtime: "python" }, logs);
    // Sanitization stays AiService's responsibility (single-pass down the
    // existing path); the wrapper only orchestrates retry/metrics.
    expect(aiService.analyzeFailure).toHaveBeenCalledWith(
      { name: "etl", runtime: "python" },
      logs,
    );
  });

  it("retry constant contract: exactly one immediate retry (ARCH-30 spec)", () => {
    // 重试预算钉死为 1——防后续误调成多级退避（AI 分析是旁路，不值得阻塞
    // 终态落库），也与既有渠道 withRetry 的 fail-open 先例对齐。
    expect(AI_ANALYSIS_RETRIES).toBe(1);
  });
});

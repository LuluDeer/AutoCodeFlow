import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiService } from "../ai.service";
import { SystemConfigService } from "../../config/config.service";
import axios from "axios";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// V3 (round-7): AiService validates provider URLs through assertSafeHttpUrl,
// which resolves hostnames via real DNS. Dev machines behind a TUN/proxy
// stack hand out 198.18.0.0/15 answers (now on the SSRF deny list), which
// would make these tests environment-dependent — pin the resolver to a
// public address instead.
jest.mock("node:dns/promises", () => ({
  lookup: jest.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

describe("AiService", () => {
  let service: AiService;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
    configService = module.get(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("analyzeFailure", () => {
    it("should return empty string when provider is disabled", async () => {
      configService.get.mockReturnValue("disabled");
      const result = await service.analyzeFailure(
        { name: "test", runtime: "python" },
        "error log",
      );
      expect(result).toBe("");
    });

    it("should call OpenAI and return response when provider is openai", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "openai";
        if (key === "ai.openaiModel") return "gpt-4o-mini";
        if (key === "ai.openaiApiKey") return "test-key";
        return defaultVal;
      });

      mockedAxios.post = jest.fn().mockResolvedValue({
        data: { choices: [{ message: { content: "AI analysis result" } }] },
      });

      const result = await service.analyzeFailure(
        { name: "my-task", runtime: "node" },
        "Some error log",
      );
      expect(result).toBe("AI analysis result");
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://api.openai.com/v1/chat/completions",
        expect.objectContaining({ model: "gpt-4o-mini" }),
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it("should call Ollama and return response when provider is ollama", async () => {
      // AI-001: SSRF guard rejects loopback/private hosts; use a public
      // IP literal so the test exercises the full analyzeFailure path.
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "ollama";
        if (key === "ai.ollamaHost") return "http://93.184.216.34:11434";
        if (key === "ai.ollamaModel") return "llama3";
        return defaultVal;
      });

      mockedAxios.post = jest.fn().mockResolvedValue({
        data: { response: "Ollama analysis" },
      });

      const result = await service.analyzeFailure(
        { name: "task", runtime: "python" },
        "traceback error",
      );
      expect(result).toBe("Ollama analysis");
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "http://93.184.216.34:11434/api/generate",
        expect.objectContaining({ model: "llama3", stream: false }),
        expect.objectContaining({ timeout: 60_000 }),
      );
    });

    it("should return empty string when AI call throws", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "openai";
        if (key === "ai.openaiApiKey") return "bad-key";
        return defaultVal;
      });

      mockedAxios.post = jest
        .fn()
        .mockRejectedValue(new Error("Network error"));

      const result = await service.analyzeFailure(
        { name: "task", runtime: "node" },
        "error log",
      );
      expect(result).toBe("");
    });
  });

  describe("SSRF guard (AI-001)", () => {
    it("refuses loopback Ollama host", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "ollama";
        if (key === "ai.ollamaHost") return "http://127.0.0.1:11434";
        return defaultVal;
      });
      const result = await service.analyzeFailure(
        { name: "t", runtime: "python" },
        "err",
      );
      expect(result).toBe("");
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("refuses AWS metadata URL", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "ollama";
        if (key === "ai.ollamaHost") return "http://169.254.169.254/";
        return defaultVal;
      });
      const result = await service.analyzeFailure(
        { name: "t", runtime: "python" },
        "err",
      );
      expect(result).toBe("");
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    // ARCH-31（2026-09-13）: AI_ALLOW_PRIVATE_NETWORK=true 显式放开内网目标
    // （历史缺口：文档宣称支持本地 Ollama，但默认 SSRF 姿态把 localhost 也拒了）。
    it("ai.allowPrivateNetwork=true 放行 loopback Ollama（本地自建部署）", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "ollama";
        if (key === "ai.ollamaHost") return "http://127.0.0.1:11434";
        if (key === "ai.ollamaModel") return "llama3";
        if (key === "ai.allowPrivateNetwork") return true;
        return defaultVal;
      });

      mockedAxios.post = jest
        .fn()
        .mockResolvedValue({ data: { response: "Ollama analysis" } });

      await service.analyzeFailure({ name: "t", runtime: "python" }, "err");
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "http://127.0.0.1:11434/api/generate",
        expect.anything(),
        expect.objectContaining({ maxRedirects: 0 }),
      );
    });

    it("ai.allowPrivateNetwork=true 时云元数据地址仍恒拒", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "ollama";
        if (key === "ai.ollamaHost") return "http://169.254.169.254/";
        if (key === "ai.allowPrivateNetwork") return true;
        return defaultVal;
      });
      const result = await service.analyzeFailure(
        { name: "t", runtime: "python" },
        "err",
      );
      expect(result).toBe("");
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  // R3: assertSafeHttpUrl only validates the first hop — both provider
  // call sites must pin maxRedirects: 0 so a 3xx cannot reroute the
  // (Bearer-credentialed) request into a private/metadata target.
  describe("R3: provider calls refuse redirects (maxRedirects: 0)", () => {
    it("OpenAI call sends maxRedirects: 0", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "openai";
        if (key === "ai.openaiApiKey") return "test-key";
        return defaultVal;
      });
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: { choices: [{ message: { content: "ok" } }] },
      });
      await service.analyzeFailure({ name: "t", runtime: "node" }, "err");
      const config = (mockedAxios.post as jest.Mock).mock.calls[0][2];
      expect(config).toEqual(expect.objectContaining({ maxRedirects: 0 }));
    });

    it("Ollama call sends maxRedirects: 0", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "ollama";
        if (key === "ai.ollamaHost") return "http://93.184.216.34:11434";
        return defaultVal;
      });
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: { response: "ok" },
      });
      await service.analyzeFailure({ name: "t", runtime: "node" }, "err");
      const config = (mockedAxios.post as jest.Mock).mock.calls[0][2];
      expect(config).toEqual(expect.objectContaining({ maxRedirects: 0 }));
    });
  });

  describe("suggestSchedule", () => {
    it("should return default cron when provider is disabled", async () => {
      configService.get.mockReturnValue("disabled");
      const result = await service.suggestSchedule("my-task", "0 * * * *", {
        total: 10,
        successes: 8,
        failures: 2,
        avgDurationMs: 500,
        p95DurationMs: 900,
        bestHoursUtc: [2, 3],
      });
      expect(result.suggestedCron).toBe("0 * * * *");
      expect(result.reasoning).toContain("not configured");
      // AI-002: 未配置 provider 也属于回退，显式携带 fallback 标记
      expect(result.fallback).toBe(true);
    });

    it("should parse valid JSON response from provider", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "openai";
        if (key === "ai.openaiApiKey") return "test-key";
        return defaultVal;
      });
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                content:
                  '{"suggestedCron":"0 2 * * *","reasoning":"Best hours are 2-3 UTC"}',
              },
            },
          ],
        },
      });
      const result = await service.suggestSchedule("my-task", null, {
        total: 20,
        successes: 18,
        failures: 2,
        avgDurationMs: 400,
        p95DurationMs: 800,
        bestHoursUtc: [2, 3],
      });
      expect(result.suggestedCron).toBe("0 2 * * *");
      expect(result.reasoning).toBe("Best hours are 2-3 UTC");
      // AI-002: 真正的 AI 建议不携带 fallback 标记
      expect(result.fallback).toBeUndefined();
    });

    it("should fall back to current cron when AI returns invalid JSON", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "openai";
        if (key === "ai.openaiApiKey") return "test-key";
        return defaultVal;
      });
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: { choices: [{ message: { content: "not valid json at all" } }] },
      });
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      const result = await service.suggestSchedule("my-task", "*/5 * * * *", {
        total: 5,
        successes: 3,
        failures: 2,
        avgDurationMs: 200,
        p95DurationMs: 400,
        bestHoursUtc: [],
      });
      expect(result.suggestedCron).toBe("*/5 * * * *");
      expect(result.reasoning).toContain("unparseable");
      // AI-002: 回退结果显式携带 fallback 标记，且记录了 warn 日志
      expect(result.fallback).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("suggestSchedule"),
      );
      warnSpy.mockRestore();
    });

    it("should fall back with warn when JSON is valid but missing required fields (AI-002)", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "openai";
        if (key === "ai.openaiApiKey") return "test-key";
        return defaultVal;
      });
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: { choices: [{ message: { content: '{"cron":"0 2 * * *"}' } }] },
      });
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      const result = await service.suggestSchedule("my-task", "*/10 * * * *", {
        total: 5,
        successes: 3,
        failures: 2,
        avgDurationMs: 200,
        p95DurationMs: 400,
        bestHoursUtc: [],
      });
      expect(result.suggestedCron).toBe("*/10 * * * *");
      expect(result.fallback).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("missing required fields"),
      );
      warnSpy.mockRestore();
    });

    // WIKI-OPT-3: cron 校验前置——AI 返回的 suggestedCron 非法时不得透出，
    // 服务层直接回退并标记 fallback（防止前端采纳落库后调度注册崩溃）。
    describe("cron validation (WIKI-OPT-3)", () => {
      const stats = {
        total: 10,
        successes: 8,
        failures: 2,
        avgDurationMs: 500,
        p95DurationMs: 900,
        bestHoursUtc: [2, 3],
      };

      function mockOpenAiJsonResponse(content: string) {
        configService.get.mockImplementation(
          (key: string, defaultVal?: any) => {
            if (key === "ai.provider") return "openai";
            if (key === "ai.openaiApiKey") return "test-key";
            return defaultVal;
          },
        );
        mockedAxios.post = jest.fn().mockResolvedValue({
          data: { choices: [{ message: { content } }] },
        });
      }

      it("should fall back to currentCron with fallback flag when AI returns invalid cron", async () => {
        mockOpenAiJsonResponse(
          '{"suggestedCron":"every 5 minutes","reasoning":"Runs often"}',
        );
        const warnSpy = jest
          .spyOn(Logger.prototype, "warn")
          .mockImplementation(() => {});
        const result = await service.suggestSchedule(
          "my-task",
          "*/10 * * * *",
          stats,
        );
        expect(result.suggestedCron).toBe("*/10 * * * *");
        expect(result.reasoning).toBe("AI returned invalid cron expression.");
        expect(result.fallback).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("invalid cron"),
        );
        warnSpy.mockRestore();
      });

      it("should fall back to default hourly cron when AI returns invalid cron and there is no currentCron", async () => {
        mockOpenAiJsonResponse(
          '{"suggestedCron":"every 5 minutes","reasoning":"Runs often"}',
        );
        const warnSpy = jest
          .spyOn(Logger.prototype, "warn")
          .mockImplementation(() => {});
        const result = await service.suggestSchedule("my-task", null, stats);
        expect(result.suggestedCron).toBe("0 * * * *");
        expect(result.fallback).toBe(true);
        warnSpy.mockRestore();
      });

      it("should return AI suggestion as-is when the cron is valid", async () => {
        mockOpenAiJsonResponse(
          '{"suggestedCron":"0 * * * *","reasoning":"Hourly is fine"}',
        );
        const warnSpy = jest
          .spyOn(Logger.prototype, "warn")
          .mockImplementation(() => {});
        const result = await service.suggestSchedule(
          "my-task",
          "*/5 * * * *",
          stats,
        );
        expect(result.suggestedCron).toBe("0 * * * *");
        expect(result.reasoning).toBe("Hourly is fine");
        expect(result.fallback).toBeUndefined();
        warnSpy.mockRestore();
      });
    });
  });

  describe("analyzeAppHealth", () => {
    it("should return empty string when provider is disabled", async () => {
      configService.get.mockReturnValue("disabled");
      const result = await service.analyzeAppHealth("my-app", {
        totalTasks: 3,
        avgSuccessRate: 95,
        avgDurationMs: 300,
        criticalTasks: [],
        perTask: [
          { name: "task1", successRate: 95, avgDuration: 300, totalRuns: 10 },
        ],
      });
      expect(result).toBe("");
    });

    it("should return AI analysis string when provider is configured", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "openai";
        if (key === "ai.openaiApiKey") return "test-key";
        return defaultVal;
      });
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                content:
                  "**Health status:** Healthy\n**Key findings:** All tasks running fine.",
              },
            },
          ],
        },
      });
      const result = await service.analyzeAppHealth("my-app", {
        totalTasks: 2,
        avgSuccessRate: 98,
        avgDurationMs: 250,
        criticalTasks: [],
        perTask: [
          { name: "task1", successRate: 98, avgDuration: 250, totalRuns: 50 },
        ],
      });
      expect(result).toContain("Healthy");
    });

    it("should mention critical tasks in prompt when present", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "openai";
        if (key === "ai.openaiApiKey") return "test-key";
        return defaultVal;
      });
      let capturedPrompt = "";
      mockedAxios.post = jest.fn().mockImplementation((_url, body: any) => {
        capturedPrompt = body.messages[0].content;
        return Promise.resolve({
          data: { choices: [{ message: { content: "analysis" } }] },
        });
      });
      await service.analyzeAppHealth("my-app", {
        totalTasks: 2,
        avgSuccessRate: 40,
        avgDurationMs: 1000,
        criticalTasks: ["bad-task"],
        perTask: [
          {
            name: "bad-task",
            successRate: 30,
            avgDuration: 1000,
            totalRuns: 10,
          },
        ],
      });
      expect(capturedPrompt).toContain("bad-task");
      expect(capturedPrompt).toContain("Critical tasks");
    });
  });

  describe("sanitizeLogs (via analyzeFailure)", () => {
    it("should redact environment variable assignments from logs", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "openai";
        if (key === "ai.openaiApiKey") return "test-key";
        return defaultVal;
      });

      let capturedPrompt = "";
      mockedAxios.post = jest.fn().mockImplementation((_url, body: any) => {
        capturedPrompt = body.messages[0].content;
        return Promise.resolve({
          data: { choices: [{ message: { content: "ok" } }] },
        });
      });

      await service.analyzeFailure(
        { name: "task", runtime: "node" },
        "DB_PASSWORD=supersecret API_KEY=abc123xyz",
      );

      expect(capturedPrompt).not.toContain("supersecret");
      expect(capturedPrompt).toContain("[REDACTED]");
    });

    it("should redact Bearer tokens from logs", async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === "ai.provider") return "openai";
        if (key === "ai.openaiApiKey") return "test-key";
        return defaultVal;
      });

      let capturedPrompt = "";
      mockedAxios.post = jest.fn().mockImplementation((_url, body: any) => {
        capturedPrompt = body.messages[0].content;
        return Promise.resolve({
          data: { choices: [{ message: { content: "ok" } }] },
        });
      });

      await service.analyzeFailure(
        { name: "task", runtime: "node" },
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      );

      expect(capturedPrompt).not.toContain("eyJhbGci");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// P1（agent-and-deployment）：Qwen / DashScope 多模态接入
// ═══════════════════════════════════════════════════════════════════
describe("P1: qwen provider (multimodal)", () => {
  let service: AiService;
  let systemConfig: { findOne: jest.Mock };
  let configService: { get: jest.Mock };

  /** 让 getAiConfig 解析到给定键值（DB 优先路径）。 */
  function withQwenConfig(overrides: Record<string, string> = {}) {
    const values: Record<string, string> = {
      "ai.provider": "qwen",
      "ai.qwenApiKey": "sk-test-qwen",
      "ai.qwenModel": "qwen-vl-max",
      "ai.qwenBaseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "ai.qwenMaxTokens": "4096",
      "ai.qwenTimeoutMs": "120000",
      ...overrides,
    };
    systemConfig.findOne.mockImplementation(async (key: string) =>
      key in values ? { value: values[key] } : null,
    );
  }

  beforeEach(async () => {
    systemConfig = { findOne: jest.fn().mockResolvedValue(null) };
    configService = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: ConfigService, useValue: configService },
        { provide: SystemConfigService, useValue: systemConfig },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
  });

  afterEach(() => jest.clearAllMocks());

  it("provider 非 qwen 时返回空结果且不发出请求（fail-open）", async () => {
    systemConfig.findOne.mockResolvedValue({ value: "openai" });
    mockedAxios.post = jest.fn();

    const res = await service.chatMultimodal({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.content).toBe("");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("qwen 启用但无 API key 时返回空结果且不发出请求", async () => {
    withQwenConfig({ "ai.qwenApiKey": "" });
    mockedAxios.post = jest.fn();

    const res = await service.chatMultimodal({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.content).toBe("");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("文本路径：把 prompt 原样送到 qwen 的 /chat/completions", async () => {
    withQwenConfig();
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    mockedAxios.post = jest.fn().mockImplementation((url, body, cfg) => {
      capturedUrl = url;
      capturedBody = body;
      capturedHeaders = cfg?.headers;
      return Promise.resolve({
        data: {
          choices: [{ message: { content: "分析结果" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      });
    });

    const res = await service.chatMultimodal({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(capturedUrl).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(capturedBody.model).toBe("qwen-vl-max");
    expect(capturedBody.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(capturedHeaders.Authorization).toBe("Bearer sk-test-qwen");
    expect(res.content).toBe("分析结果");
    expect(res.usage).toEqual({ tokensIn: 10, tokensOut: 5 });
  });

  it("max_tokens 来自 ai.qwenMaxTokens，而非 openai 的硬编码 500", async () => {
    withQwenConfig({ "ai.qwenMaxTokens": "8192" });
    let capturedBody: any = null;
    mockedAxios.post = jest.fn().mockImplementation((_u, body) => {
      capturedBody = body;
      return Promise.resolve({
        data: { choices: [{ message: { content: "" } }] },
      });
    });

    await service.chatMultimodal({
      messages: [{ role: "user", content: "x" }],
    });

    expect(capturedBody.max_tokens).toBe(8192);
    expect(capturedBody.max_tokens).not.toBe(500);
  });

  it("多模态：content 数组（text + image_url）原样透传", async () => {
    withQwenConfig();
    let capturedBody: any = null;
    mockedAxios.post = jest.fn().mockImplementation((_u, body) => {
      capturedBody = body;
      return Promise.resolve({
        data: { choices: [{ message: { content: "ok" } }] },
      });
    });

    await service.chatMultimodal({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "这张图有什么问题？" },
            {
              type: "image_url",
              image_url: { url: "https://cdn.example.com/a.png" },
            },
          ],
        },
      ],
    });

    expect(Array.isArray(capturedBody.messages[0].content)).toBe(true);
    expect(capturedBody.messages[0].content[1].type).toBe("image_url");
  });

  it("视频理解：接受 video_url 扩展片段", async () => {
    withQwenConfig();
    let capturedBody: any = null;
    mockedAxios.post = jest.fn().mockImplementation((_u, body) => {
      capturedBody = body;
      return Promise.resolve({
        data: { choices: [{ message: { content: "看懂了" } }] },
      });
    });

    const res = await service.chatMultimodal({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "分析这段录屏" },
            {
              type: "video_url",
              video_url: { url: "https://cdn.example.com/r.mp4" },
            },
          ],
        },
      ],
    });

    expect(capturedBody.messages[0].content[1].video_url.url).toBe(
      "https://cdn.example.com/r.mp4",
    );
    expect(res.content).toBe("看懂了");
  });

  it("拒绝非 http(s) 媒体 URL（防 SSRF 转嫁）", async () => {
    withQwenConfig();
    mockedAxios.post = jest.fn().mockResolvedValue({
      data: { choices: [{ message: { content: "x" } }] },
    });

    await expect(
      service.chatMultimodal({
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "file:///etc/passwd" } },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/non-http\(s\) media URL/);

    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("tool-calling：请求带 tools 时下发 tool_choice 并回传 tool_calls", async () => {
    withQwenConfig();
    let capturedBody: any = null;
    mockedAxios.post = jest.fn().mockImplementation((_u, body) => {
      capturedBody = body;
      return Promise.resolve({
        data: {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "list_tasks", arguments: '{"page":1}' },
                  },
                ],
              },
            },
          ],
        },
      });
    });

    const res = await service.chatMultimodal({
      messages: [{ role: "user", content: "列出任务" }],
      tools: [
        {
          type: "function",
          function: {
            name: "list_tasks",
            description: "列出任务",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tool_choice).toBe("auto");
    expect(res.toolCalls?.[0].function.name).toBe("list_tasks");
  });

  it("不传 tools 时请求体不含 tools/tool_choice 键", async () => {
    withQwenConfig();
    let capturedBody: any = null;
    mockedAxios.post = jest.fn().mockImplementation((_u, body) => {
      capturedBody = body;
      return Promise.resolve({
        data: { choices: [{ message: { content: "" } }] },
      });
    });

    await service.chatMultimodal({
      messages: [{ role: "user", content: "x" }],
    });

    expect("tools" in capturedBody).toBe(false);
    expect("tool_choice" in capturedBody).toBe(false);
  });

  it("安全：出站走 SSRF pin 且 maxRedirects=0（不新开旁路）", async () => {
    withQwenConfig();
    let capturedCfg: any = null;
    mockedAxios.post = jest.fn().mockImplementation((_u, _b, cfg) => {
      capturedCfg = cfg;
      return Promise.resolve({
        data: { choices: [{ message: { content: "" } }] },
      });
    });

    await service.chatMultimodal({
      messages: [{ role: "user", content: "x" }],
    });

    expect(capturedCfg.maxRedirects).toBe(0);
    expect(capturedCfg.timeout).toBe(120000);
    // pin 由 pinnedAxiosConfig 注入（httpAgent/httpsAgent + lookup）
    expect(
      capturedCfg.httpAgent !== undefined ||
        capturedCfg.httpsAgent !== undefined,
    ).toBe(true);
  });

  it("hasApiKeyForProvider：按 provider 判定，且 env 可兜底", async () => {
    // qwen + DB 有 key → true
    systemConfig.findOne.mockImplementation(async (k: string) =>
      k === "ai.provider"
        ? { value: "qwen" }
        : k === "ai.qwenApiKey"
          ? { value: "sk-x" }
          : null,
    );
    await expect(service.hasApiKeyForProvider()).resolves.toBe(true);

    // qwen + DB 无 key + env 有 → true
    systemConfig.findOne.mockImplementation(async (k: string) =>
      k === "ai.provider" ? { value: "qwen" } : null,
    );
    configService.get.mockImplementation((k: string) =>
      k === "ai.qwenApiKey" ? "sk-from-env" : undefined,
    );
    await expect(service.hasApiKeyForProvider()).resolves.toBe(true);

    // provider=disabled → false（无密钥概念）
    systemConfig.findOne.mockImplementation(async (k: string) =>
      k === "ai.provider" ? { value: "disabled" } : null,
    );
    configService.get.mockReturnValue(undefined);
    await expect(service.hasApiKeyForProvider()).resolves.toBe(false);
  });

  it("getEffectiveConfig 含 qwen 键（密钥不在其中）", async () => {
    withQwenConfig();
    const cfg = await service.getEffectiveConfig();

    expect(cfg.qwenModel).toBe("qwen-vl-max");
    expect(cfg.qwenBaseUrl).toContain("dashscope.aliyuncs.com");
    expect(cfg.qwenMaxTokens).toBe("4096");
    // 密钥永不回显
    expect(JSON.stringify(cfg)).not.toContain("sk-test-qwen");
  });
});

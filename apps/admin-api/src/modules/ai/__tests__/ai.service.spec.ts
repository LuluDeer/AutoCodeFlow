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

/**
 * 流式工具调用 / 思考链 / 中断 / 连通性自检回归面。
 *
 * 与 ai-sse.spec.ts（只钉纯分帧）不同，这里验证的是**聚合层**：
 *  - delta.tool_calls 按 index 拼回完整 ToolCall（并行调用不能串台）；
 *  - reasoning_content 独立回调，不混进正文；
 *  - AbortSignal 触发后立刻以 AbortError 结束，不吞成"空响应"；
 *  - POST /ai/test 的 testProvider 真发请求，错误如实分类、不伪装成功。
 */
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { PassThrough, Readable } from "node:stream";
import { AiService } from "../ai.service";
import { SystemConfigService } from "../../config/config.service";
import {
  consumeOpenAiSseStream,
  type StreamedCompletionResult,
} from "../ai-stream.util";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// SSRF 守卫会做真实 DNS 解析；钉住解析器让用例与环境无关。
jest.mock("node:dns/promises", () => ({
  lookup: jest.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

describe("consumeOpenAiSseStream —— 流式工具调用聚合", () => {
  it("按 index 拼装分片 arguments；并行调用互不串台", async () => {
    const stream = Readable.from([
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  function: { name: "get_weather", arguments: "" },
                },
                {
                  index: 1,
                  id: "call_b",
                  function: { name: "get_time", arguments: "" },
                },
              ],
            },
          },
        ],
      }),
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"city":' } },
                { index: 1, function: { arguments: '{"tz":' } },
              ],
            },
          },
        ],
      }),
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"北京"}' } },
                { index: 1, function: { arguments: '"UTC"}' } },
              ],
            },
          },
        ],
      }),
      frame({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
    ]);

    const deltas: number[] = [];
    const result: StreamedCompletionResult = await consumeOpenAiSseStream(
      stream,
      { onToolCallDelta: (d) => deltas.push(d.index) },
    );

    expect(result.finishReason).toBe("tool_calls");
    expect(deltas).toContain(0);
    expect(deltas).toContain(1);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls?.[0]).toMatchObject({
      id: "call_a",
      function: { name: "get_weather", arguments: '{"city":"北京"}' },
    });
    expect(result.toolCalls?.[1]).toMatchObject({
      id: "call_b",
      function: { name: "get_time", arguments: '{"tz":"UTC"}' },
    });
  });

  it("reasoning_content 独立聚合与回调，不污染正文", async () => {
    const stream = Readable.from([
      frame({ choices: [{ delta: { reasoning_content: "让我" } }] }),
      frame({ choices: [{ delta: { reasoning: "想想" } }] }),
      frame({ choices: [{ delta: { content: "答案是 42" } }] }),
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ]);
    const reasoningParts: string[] = [];
    const textParts: string[] = [];

    const result = await consumeOpenAiSseStream(stream, {
      onReasoningDelta: (text) => reasoningParts.push(text),
      onDelta: (text) => textParts.push(text),
    });

    expect(result.reasoning).toBe("让我想想");
    expect(result.content).toBe("答案是 42");
    expect(reasoningParts).toEqual(["让我", "想想"]);
    expect(textParts).toEqual(["答案是 42"]);
  });

  it("AbortSignal 在流中途触发 → 以 AbortError 拒绝，不返回空成功", async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const pending = consumeOpenAiSseStream(stream, {
      signal: controller.signal,
    });

    stream.write(frame({ choices: [{ delta: { content: "已经开始" } }] }));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("进入前已 abort → 立即抛 AbortError 并销毁底层流", async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = Readable.from([frame({ choices: [] })]);

    await expect(
      consumeOpenAiSseStream(stream, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.destroyed).toBe(true);
  });
});

describe("AiService.testProvider —— 连通性自检", () => {
  let service: AiService;
  let systemConfig: { findOne: jest.Mock };

  async function build(provider = "openai"): Promise<void> {
    systemConfig = {
      findOne: jest.fn(async (key: string) => {
        if (key === "ai.provider") return { value: provider };
        if (key === "ai.openaiApiKey") return { value: "sk-test" };
        return null;
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
          },
        },
        { provide: SystemConfigService, useValue: systemConfig },
      ],
    }).compile();
    service = module.get<AiService>(AiService);
  }

  afterEach(() => jest.clearAllMocks());

  it("空参数向后兼容：真实请求默认路由并返回结构化成功回执", async () => {
    await build();
    mockedAxios.post = jest.fn().mockResolvedValue({
      data: { choices: [{ message: { content: "OK" } }] },
    });

    const result = await service.testProvider();

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.purpose).toBe("agent");
    expect(result.preview).toBe("OK");
    expect(result.errorCode).toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("testTools 透传 tools/tool_choice，且流式路径由 testStreaming 选择", async () => {
    await build();
    mockedAxios.post = jest.fn().mockImplementation((_url: string, body: any) => {
      if (body.stream) {
        return Promise.resolve({
          data: Readable.from([
            frame({ choices: [{ delta: { content: "流式 OK" } }] }),
            frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          ]),
        });
      }
      return Promise.resolve({
        data: { choices: [{ message: { content: "OK" } }] },
      });
    });

    const result = await service.testProvider({ testTools: true, testStreaming: true });

    expect(result.ok).toBe(true);
    expect(result.preview).toBe("流式 OK");
    const body = mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tool_choice).toBe("auto");
    expect(body.stream).toBe(true);
  });

  it("上游 401 如实分类为 AI_HTTP_401_UNAUTHORIZED，不伪装成功", async () => {
    await build();
    mockedAxios.post = jest.fn().mockRejectedValue({
      response: { status: 401, data: { error: { message: "bad key" } } },
    });

    const result = await service.testProvider({ providerId: "openai" });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AI_HTTP_401_UNAUTHORIZED");
    expect(result.message).toContain("鉴权失败");
    expect(result.message).toContain("bad key");
  });

  it("路由被禁用时返回 AI_ROUTE_DISABLED 与中文说明", async () => {
    await build("disabled");
    mockedAxios.post = jest.fn();

    const result = await service.testProvider({ purpose: "analysis" });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AI_ROUTE_DISABLED");
    expect(result.message).toContain("AI 未启用");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

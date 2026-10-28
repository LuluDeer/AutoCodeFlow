/**
 * LLM 接入与分配（2026-10-28）：**注册表 → 按用途路由 → 参数分配** 的服务级断言。
 *
 * 这里钉的是四件「一改就会悄悄错」的事：
 *  ① 存量兼容：只有旧键（`ai.provider=qwen` + `ai.qwen*`）时，行为与改造前一致；
 *  ② 分配生效：`ai.routes.<用途>.provider/model` 覆盖全局，**且不影响其它用途**；
 *  ③ 参数下限：Agent 不继承分析档的 500 令牌 / 30s（否则吐半份 JSON）；
 *  ④ 能力闸：视频用途只能选「勾了支持视频」的模型；Agent 不能落到 ollama
 *     （只有 `/api/generate`，没有 tool-calling 面）。
 */
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { AiService } from "../ai.service";
import { SystemConfigService } from "../../config/config.service";

jest.mock("axios");
jest.mock("node:dns/promises", () => ({
  lookup: jest.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
const mockedAxios = axios as jest.Mocked<typeof axios>;

interface Harness {
  service: AiService;
  set: (values: Record<string, string | number>) => void;
  calls: Array<{ url: string; body: any; cfg: any }>;
}

async function harness(
  values: Record<string, string | number>,
): Promise<Harness> {
  const store: Record<string, string | number> = { ...values };
  const systemConfig = {
    findOne: jest.fn(async (key: string) =>
      key in store ? { value: String(store[key]) } : null,
    ),
  };
  const configService = {
    get: jest.fn((_key: string, def?: unknown) => def),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AiService,
      { provide: ConfigService, useValue: configService },
      { provide: SystemConfigService, useValue: systemConfig },
    ],
  }).compile();
  const service = module.get<AiService>(AiService);

  const calls: Harness["calls"] = [];
  mockedAxios.post = jest
    .fn()
    .mockImplementation((url: string, body: any, cfg: any) => {
      calls.push({ url, body, cfg });
      return Promise.resolve({
        data: {
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      });
    });

  return {
    service,
    calls,
    set: (next) => {
      Object.assign(store, next);
      systemConfig.findOne.mockImplementation(async (key: string) =>
        key in store ? { value: String(store[key]) } : null,
      );
    },
  };
}

const QWEN_LEGACY = {
  "ai.provider": "qwen",
  "ai.qwenApiKey": "sk-qwen",
  "ai.qwenModel": "qwen-vl-max",
  "ai.qwenMaxTokens": 4096,
  "ai.qwenTimeoutMs": 120_000,
};

const OPENAI_LEGACY = {
  "ai.provider": "openai",
  "ai.openaiApiKey": "sk-openai",
  "ai.openaiModel": "gpt-4o-mini",
  "ai.openaiMaxTokens": 500,
};

afterEach(() => jest.clearAllMocks());

describe("存量兼容：只有旧键时行为不变", () => {
  it("provider=qwen → Agent 仍走 DashScope，参数来自旧键", async () => {
    const h = await harness(QWEN_LEGACY);
    await h.service.chatMultimodal({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(h.calls[0].body.model).toBe("qwen-vl-max");
    expect(h.calls[0].body.max_tokens).toBe(4096);
    expect(h.calls[0].cfg.timeout).toBe(120_000);
    expect(h.calls[0].cfg.headers.Authorization).toBe("Bearer sk-qwen");
  });

  it("未启用（disabled）→ 不发请求、返回空（fail-open）", async () => {
    const h = await harness({ "ai.provider": "disabled" });
    const res = await h.service.chatMultimodal({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.content).toBe("");
    expect(h.calls).toHaveLength(0);
    expect(await h.service.getActiveRoute()).toEqual({
      provider: "disabled",
      model: "",
    });
  });
});

describe("按用途分配：覆盖全局，且互不影响", () => {
  const withRegistry = {
    ...OPENAI_LEGACY,
    "ai.providers": JSON.stringify([
      {
        id: "qwen-vl",
        label: "通义千问 VL",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-vl-max",
        maxTokens: 8192,
        timeoutMs: 120_000,
        supportsVideo: true,
      },
      {
        id: "cheap",
        label: "便宜档",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        maxTokens: 500,
        timeoutMs: 30_000,
      },
    ]),
    "ai.providers.qwen-vl.apiKey": "sk-qwen-vl",
    "ai.providers.cheap.apiKey": "sk-cheap",
    "ai.routes.agent.provider": "qwen-vl",
    "ai.routes.analysis.provider": "cheap",
  };

  it("Agent 用 qwen-vl（8192 令牌），分析用 cheap（500）", async () => {
    const h = await harness(withRegistry);

    await h.service.chatMultimodal({
      messages: [{ role: "user", content: "规划" }],
    });
    expect(h.calls[0].body.model).toBe("qwen-vl-max");
    expect(h.calls[0].body.max_tokens).toBe(8192);
    expect(h.calls[0].cfg.headers.Authorization).toBe("Bearer sk-qwen-vl");

    await h.service.analyzeFailure({ name: "t", runtime: "node" }, "boom");
    expect(h.calls[1].body.model).toBe("gpt-4o-mini");
    expect(h.calls[1].body.max_tokens).toBe(500);
    expect(h.calls[1].cfg.headers.Authorization).toBe("Bearer sk-cheap");
  });

  it("getActiveRoute(purpose) 反映真实路由（步骤记账据此归因）", async () => {
    const h = await harness(withRegistry);
    expect(await h.service.getActiveRoute("agent")).toEqual({
      provider: "qwen-vl",
      model: "qwen-vl-max",
    });
    expect(await h.service.getActiveRoute("analysis")).toEqual({
      provider: "cheap",
      model: "gpt-4o-mini",
    });
  });

  it("Agent 输出预算按下限抬到 2048（不继承分析档的 500）", async () => {
    const h = await harness({
      ...OPENAI_LEGACY,
      "ai.routes.agent.provider": "openai",
    });
    await h.service.chatMultimodal({
      messages: [{ role: "user", content: "x" }],
    });
    expect(h.calls[0].body.max_tokens).toBe(2048);
    expect(h.calls[0].cfg.timeout).toBe(60_000);
  });

  it("显式 maxTokens/timeoutMs 覆盖下限", async () => {
    const h = await harness({
      ...OPENAI_LEGACY,
      "ai.routes.agent.provider": "openai",
      "ai.routes.agent.maxTokens": 9000,
      "ai.routes.agent.timeoutMs": 300_000,
    });
    await h.service.chatMultimodal({
      messages: [{ role: "user", content: "x" }],
    });
    expect(h.calls[0].body.max_tokens).toBe(9000);
    expect(h.calls[0].cfg.timeout).toBe(300_000);
  });

  it("temperature 只在显式配置时下发（不猜 provider 默认）", async () => {
    const h = await harness({ ...QWEN_LEGACY });
    await h.service.chatMultimodal({
      messages: [{ role: "user", content: "x" }],
    });
    expect("temperature" in h.calls[0].body).toBe(false);

    const h2 = await harness({
      ...QWEN_LEGACY,
      "ai.routes.agent.temperature": 0.2,
    });
    await h2.service.chatMultimodal({
      messages: [{ role: "user", content: "x" }],
    });
    expect(h2.calls[0].body.temperature).toBe(0.2);
  });
});

describe("能力闸：不支持就如实不可用，不静默降级", () => {
  const textOnly = {
    "ai.provider": "qwen",
    ...QWEN_LEGACY,
    "ai.providers": JSON.stringify([
      {
        id: "text-only",
        label: "纯文本模型",
        baseUrl: "https://api.example.com/v1",
        model: "text-model",
        supportsVideo: false,
        enabled: true,
      },
      {
        id: "local",
        label: "本地 Ollama",
        transport: "ollama",
        baseUrl: "http://localhost:11434",
        model: "llama3",
        supportsVideo: false,
        enabled: true,
      },
    ]),
    "ai.providers.text-only.apiKey": "sk-text",
    "ai.routes.video.provider": "text-only",
  };

  it("视频用途选中「不支持视频」的模型 → 不发请求", async () => {
    const h = await harness(textOnly);
    const res = await h.service.chatMultimodal({
      purpose: "video",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "把这段录屏转成 SOP" },
            {
              type: "video_url",
              video_url: { url: "https://cdn.example.com/v.mp4" },
            },
          ],
        },
      ],
    });
    expect(res.content).toBe("");
    expect(h.calls).toHaveLength(0);
  });

  it("视频用途选中支持视频的模型 → video_url 原样透传", async () => {
    const h = await harness({
      ...QWEN_LEGACY,
      "ai.routes.video.provider": "qwen",
    });
    await h.service.chatMultimodal({
      purpose: "video",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "转 SOP" },
            {
              type: "video_url",
              video_url: { url: "https://cdn.example.com/v.mp4" },
            },
          ],
        },
      ],
    });
    expect(h.calls).toHaveLength(1);
    expect(JSON.stringify(h.calls[0].body.messages)).toContain("v.mp4");
  });

  it("Agent 用途落到 ollama（无 tool-calling 面）→ 不发请求", async () => {
    const h = await harness({
      "ai.provider": "ollama",
      "ai.routes.agent.provider": "local",
      "ai.providers": JSON.stringify([
        {
          id: "local",
          transport: "ollama",
          baseUrl: "http://localhost:11434",
          model: "llama3",
        },
      ]),
    });
    const res = await h.service.chatMultimodal({
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.content).toBe("");
    expect(h.calls).toHaveLength(0);
  });

  it("分析用途可以落到 ollama（/api/generate 纯文本面）", async () => {
    const h = await harness({
      "ai.provider": "ollama",
      "ai.ollamaHost": "http://93.184.216.34:11434",
      "ai.ollamaModel": "llama3",
    });
    mockedAxios.post = jest
      .fn()
      .mockResolvedValue({ data: { response: "分析" } });
    const out = await h.service.analyzeFailure(
      { name: "t", runtime: "node" },
      "err",
    );
    expect(out).toBe("分析");
    const call = (mockedAxios.post as jest.Mock).mock.calls[0];
    expect(call[0]).toBe("http://93.184.216.34:11434/api/generate");
  });

  it("禁用条目不可被选中", async () => {
    const h = await harness({
      "ai.provider": "off",
      "ai.providers": JSON.stringify([
        {
          id: "off",
          baseUrl: "https://api.example.com/v1",
          model: "m",
          enabled: false,
        },
      ]),
      "ai.providers.off.apiKey": "sk",
    });
    expect(
      (
        await h.service.chatMultimodal({
          messages: [{ role: "user", content: "x" }],
        })
      ).content,
    ).toBe("");
    expect(h.calls).toHaveLength(0);
  });
});

describe("注册表视图（设置页数据源）", () => {
  it("旧键合成时标记 legacy=true，且不回传密钥值", async () => {
    const h = await harness({ ...QWEN_LEGACY });
    const { providers, errors } = await h.service.listProviderViews();
    expect(errors).toEqual([]);
    expect(providers.map((p) => p.id)).toEqual(["openai", "qwen", "ollama"]);
    expect(providers.every((p) => p.legacy)).toBe(true);
    expect(providers.find((p) => p.id === "qwen")?.hasApiKey).toBe(true);
    expect(JSON.stringify(providers)).not.toContain("sk-qwen");
    // 能力位来自注册表（qwen 缺省支持视频），不是代码里的厂商判断
    expect(providers.find((p) => p.id === "qwen")?.supportsVideo).toBe(true);
  });

  it("JSON 写坏时回落旧键并把错误暴露给设置页", async () => {
    const h = await harness({ ...QWEN_LEGACY, "ai.providers": "{broken" });
    const { providers, errors } = await h.service.listProviderViews();
    expect(errors[0]).toContain("不是合法 JSON");
    expect(providers.every((p) => p.legacy)).toBe(true);
  });
});

describe("视频直链签发（视频转 SOP 的前置）", () => {
  it("配置齐全 → 返回带扩展名与签名的直链", async () => {
    const h = await harness({
      ...QWEN_LEGACY,
      "ai.mediaBaseUrl": "https://acf.example.com",
      "ai.mediaUrlSecret": "0123456789abcdef0123456789abcdef",
    });
    const res = await h.service.signedVideoUrl("m-1", "demo.mp4");
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.url).toMatch(
        /^https:\/\/acf\.example\.com\/api\/ai\/media\/m-1\/demo\.mp4\?exp=\d+&sig=/,
      );
    }
  });

  it("没配 base/secret → 可读原因（端点据此提示用户，而不是发无效链接）", async () => {
    const h = await harness({ ...QWEN_LEGACY });
    const res = await h.service.signedVideoUrl("m-1", "demo.mp4");
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.reason).toBe("no_secret");
  });
});

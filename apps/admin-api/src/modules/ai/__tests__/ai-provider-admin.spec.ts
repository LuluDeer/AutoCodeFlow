/**
 * 模型接入的**写面**（设置页"接入端点 / 按用途分配"）。
 *
 * 这里的每条断言都对应一个"写错了不报错、只会悄悄坏"的形态：
 *  · 密钥 `***` 被当成真实密钥写库 → 用户下次调用 401；
 *  · 清空密钥时把整条配置删掉 → 历史不可追溯（应写空串）；
 *  · 删除条目留下孤儿密钥 → 纯负债；
 *  · 用途分配写错键名（routes.xxx）→ 路由静默不生效。
 */
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { AiService } from "../ai.service";
import { SystemConfigService } from "../../config/config.service";

jest.mock("axios");

interface Harness {
  service: AiService;
  store: Map<string, string>;
  upserts: Array<Record<string, unknown>>;
  removes: string[];
}

async function harness(values: Record<string, string> = {}): Promise<Harness> {
  const store = new Map<string, string>(Object.entries(values));
  const upserts: Array<Record<string, unknown>> = [];
  const removes: string[] = [];
  const systemConfig = {
    findOne: jest.fn(async (key: string) =>
      store.has(key) ? { key, value: store.get(key) } : null,
    ),
    upsert: jest.fn(async (dto: Record<string, unknown>) => {
      upserts.push(dto);
      store.set(String(dto.key), String(dto.value ?? ""));
      return dto;
    }),
    remove: jest.fn(async (key: string, opts?: unknown) => {
      removes.push(key);
      store.delete(key);
      return { deleted: true, key, opts };
    }),
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AiService,
      {
        provide: ConfigService,
        useValue: { get: (_k: string, def?: unknown) => def },
      },
      { provide: SystemConfigService, useValue: systemConfig },
    ],
  }).compile();
  return { service: module.get(AiService), store, upserts, removes };
}

const validProvider = {
  id: "qwen-vl",
  label: "通义千问 VL",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen-vl-max",
  maxTokens: 8192,
  timeoutMs: 120_000,
  supportsVideo: true,
};

afterEach(() => jest.clearAllMocks());

describe("saveProvider", () => {
  it("写入注册表 JSON（**不含密钥**）", async () => {
    const h = await harness();
    await h.service.saveProvider(validProvider);

    const registry = JSON.parse(h.store.get("ai.providers") ?? "[]");
    const saved = registry.find((e: { id: string }) => e.id === "qwen-vl");
    expect(saved).toMatchObject({ supportsVideo: true, maxTokens: 8192 });
    // 首次保存会把旧键合成的三条一并物化（此后以注册表为准，见 service 注释）
    expect(registry.map((e: { id: string }) => e.id).sort()).toEqual([
      "ollama",
      "openai",
      "qwen",
      "qwen-vl",
    ]);
    expect(JSON.stringify(registry)).not.toContain("apiKey");
  });

  it("apiKey 传 *** → 不写密钥（回显掩码不该覆盖真密钥）", async () => {
    const h = await harness();
    await h.service.saveProvider({ ...validProvider, apiKey: "***" });
    expect(h.upserts.map((u) => u.key)).toEqual(["ai.providers"]);
  });

  it("apiKey 传真实值 → 单独写 isSecret 键", async () => {
    const h = await harness();
    await h.service.saveProvider({ ...validProvider, apiKey: "sk-real" });
    const keyDto = h.upserts.find(
      (u) => u.key === "ai.providers.qwen-vl.apiKey",
    );
    expect(keyDto).toMatchObject({ value: "sk-real", isSecret: true });
  });

  it("apiKey 传空串 → 写空值（保留 isSecret 元数据，不删行）", async () => {
    const h = await harness();
    await h.service.saveProvider({ ...validProvider, apiKey: "" });
    const keyDto = h.upserts.find(
      (u) => u.key === "ai.providers.qwen-vl.apiKey",
    );
    expect(keyDto).toMatchObject({ value: "", isSecret: true });
    expect(h.removes).toHaveLength(0);
  });

  it("apiKey 省略（undefined）→ 不触碰密钥行（PUT 只改 model 不得清空凭据）", async () => {
    const h = await harness();
    await h.service.saveProvider({ ...validProvider, apiKey: undefined });
    // 只写注册表，不得出现 apiKey 的 upsert（否则等于把真密钥写成空串）
    expect(h.upserts.map((u) => u.key)).toEqual(["ai.providers"]);
    expect(h.upserts.some((u) => u.key === "ai.providers.qwen-vl.apiKey")).toBe(
      false,
    );
  });

  it("非法 id / 非 http baseUrl / 空模型名 → 400 语义的可读错误", async () => {
    const h = await harness();
    await expect(
      h.service.saveProvider({ ...validProvider, id: "Bad ID" }),
    ).rejects.toThrow(/模型接入配置不合法/);
    await expect(
      h.service.saveProvider({ ...validProvider, baseUrl: "ftp://x" }),
    ).rejects.toThrow(/baseUrl/);
    await expect(
      h.service.saveProvider({ ...validProvider, model: "  " }),
    ).rejects.toThrow(/模型名/);
    expect(h.upserts).toHaveLength(0);
  });

  it("同名重复保存 = 覆盖（不是重复追加）", async () => {
    const h = await harness();
    await h.service.saveProvider(validProvider);
    await h.service.saveProvider({ ...validProvider, model: "qwen-vl-plus" });
    const registry = JSON.parse(h.store.get("ai.providers") ?? "[]");
    const same = registry.filter((e: { id: string }) => e.id === "qwen-vl");
    expect(same).toHaveLength(1);
    expect(same[0].model).toBe("qwen-vl-plus");
  });
});

describe("deleteProvider", () => {
  it("删除条目并清掉它的密钥行（孤儿密钥是纯负债）", async () => {
    const h = await harness();
    await h.service.saveProvider({ ...validProvider, apiKey: "sk-real" });
    await h.service.deleteProvider("qwen-vl");

    const ids = JSON.parse(h.store.get("ai.providers") ?? "[]").map(
      (e: { id: string }) => e.id,
    );
    expect(ids).not.toContain("qwen-vl");
    expect(h.removes).toEqual(["ai.providers.qwen-vl.apiKey"]);
  });

  it("删除不存在的 id → 404 语义", async () => {
    const h = await harness();
    await expect(h.service.deleteProvider("nope")).rejects.toThrow(/不存在/);
  });
});

describe("assignRoute", () => {
  it("写 purpose 的 provider/model 两个键（空 = 跟随全局）", async () => {
    const h = await harness();
    await h.service.assignRoute("video", "qwen-vl", "qwen-vl-max");

    expect(h.store.get("ai.routes.video.provider")).toBe("qwen-vl");
    expect(h.store.get("ai.routes.video.model")).toBe("qwen-vl-max");
  });

  it("清空分配 = 写空串（回到跟随全局）", async () => {
    const h = await harness({ "ai.routes.agent.provider": "cheap" });
    await h.service.assignRoute("agent", "", "");
    expect(h.store.get("ai.routes.agent.provider")).toBe("");
  });
});

describe("providerAdminView", () => {
  it("回带注册表 + 各用途当前指向（前端据此画「继承/覆盖」）", async () => {
    const h = await harness({
      "ai.providers": JSON.stringify([{ ...validProvider, enabled: true }]),
      "ai.providers.qwen-vl.apiKey": "sk-x",
      "ai.routes.video.provider": "qwen-vl",
    });
    const view = await h.service.providerAdminView();
    expect(view.providers).toHaveLength(1);
    expect(view.providers[0].hasApiKey).toBe(true);
    expect(view.routes.video.provider).toBe("qwen-vl");
    expect(view.routes.agent.provider).toBe("");
    expect(JSON.stringify(view)).not.toContain("sk-x");
  });
});

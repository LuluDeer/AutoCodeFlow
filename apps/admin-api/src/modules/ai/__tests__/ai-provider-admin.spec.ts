/**
 * 模型接入的**写面**（设置页"接入端点 / 按用途分配"）。
 *
 * 这里的每条断言都对应一个"写错了不报错、只会悄悄坏"的形态：
 *  · 密钥 `***` 被当成真实密钥写库 → 用户下次调用 401；
 *  · 清空密钥时把整条配置删掉 → 历史不可追溯（应写空串）；
 *  · 删除条目留下孤儿密钥 → 纯负债；
 *  · 用途分配写错键名（routes.xxx）→ 路由静默不生效；
 *  · 配了 `SEC_SECRETS_KEY` 却仍把 apiKey 明文落库（= C4 没生效）；
 *  · 没配 `SEC_SECRETS_KEY` 却写不进明文（= 降级面被改坏，存量部署升级即坏）。
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

async function harness(
  values: Record<string, string> = {},
  /**
   * SEC-02：配置即模拟 env `SEC_SECRETS_KEY`（配置键 `secrets.key`）。缺省
   * 不配置 ⇒ 降级模式（明文落库）——既有用例全部走的正是这条路径，所以它们
   * 同时是「无 key 时行为逐字节不变」的回归证据。
   */
  secretsKey?: string,
): Promise<Harness> {
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
        useValue: {
          // 只有 `secrets.key` 需要真实回值；其余键沿用既有「回落缺省」替身。
          get: (key: string, def?: unknown) =>
            key === "secrets.key" ? (secretsKey ?? def ?? "") : def,
        },
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

/**
 * C4（ADR-028 的窄口径收窄）：provider apiKey 落库前套仓库既有的 SEC-02
 * `enc:v1:` AES-256-GCM 信封。
 *
 * 这里钉的是「加密生效 + 降级面不变」两侧：
 *  ① 配 key ⇒ 库里是信封、明文不落盘；
 *  ② 读回真值（路由拿到的必须是明文，否则 Bearer 直接 401）；
 *  ③ 不配 key ⇒ 逐字节仍是明文（存量部署升级零破坏）；
 *  ④ `***` 哨兵仍「保持原值」，绝不把哨兵或空值写进去；
 *  ⑤ 存量明文行在配 key 后仍读得回（零迁移、双读共存）。
 */
describe("provider apiKey 的 SEC-02 信封", () => {
  /** 64 hex = 32 字节，parseSecretsKey 认的规范形态之一。 */
  const SEC_KEY =
    "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

  const readKeys = (service: AiService): Promise<Record<string, string>> =>
    (
      service as unknown as {
        loadProviders(): Promise<{ keys: Record<string, string> }>;
      }
    )
      .loadProviders()
      .then((r) => r.keys);

  it("① 配了 SEC_SECRETS_KEY：保存后 system_configs 的值以 enc:v1: 开头", async () => {
    const h = await harness({}, SEC_KEY);
    await h.service.saveProvider({
      ...validProvider,
      apiKey: "sk-real-secret",
    });

    const stored = h.store.get("ai.providers.qwen-vl.apiKey") ?? "";
    expect(stored.startsWith("enc:v1:")).toBe(true);
    // 明文绝不出现在落库值里；isSecret 元数据不变（读面仍掩码 ***）
    expect(stored).not.toContain("sk-real-secret");
    expect(
      h.upserts.find((u) => u.key === "ai.providers.qwen-vl.apiKey"),
    ).toMatchObject({ isSecret: true });
  });

  it("② 读回真值：解密结果与写入的明文完全一致", async () => {
    const h = await harness({}, SEC_KEY);
    await h.service.saveProvider({
      ...validProvider,
      apiKey: "sk-real-secret",
    });

    const keys = await readKeys(h.service);
    expect(keys["qwen-vl"]).toBe("sk-real-secret");
  });

  it("③ 无 SEC_SECRETS_KEY：落明文、读回明文（降级面逐字节不变）", async () => {
    const h = await harness(); // 不配 key
    await h.service.saveProvider({
      ...validProvider,
      apiKey: "sk-real-secret",
    });

    const stored = h.store.get("ai.providers.qwen-vl.apiKey");
    expect(stored).toBe("sk-real-secret");
    expect(stored?.startsWith("enc:v1:")).toBe(false);
    expect(await readKeys(h.service)).toMatchObject({
      "qwen-vl": "sk-real-secret",
    });
  });

  it("③b 降级写明文时 warn 一次（与 SEC-02 一次性告警同口径）", async () => {
    const h = await harness();
    const logger = (
      h.service as unknown as { logger: { warn: (m: string) => void } }
    ).logger;
    const warn = jest.spyOn(logger, "warn");

    await h.service.saveProvider({ ...validProvider, apiKey: "sk-1" });
    await h.service.saveProvider({ ...validProvider, apiKey: "sk-2" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("SEC_SECRETS_KEY");
  });

  it("④ 提交 ***：不覆盖真值（密文原样保留，读回仍是原值）", async () => {
    const h = await harness({}, SEC_KEY);
    await h.service.saveProvider({ ...validProvider, apiKey: "sk-original" });
    const before = h.store.get("ai.providers.qwen-vl.apiKey");
    expect(before?.startsWith("enc:v1:")).toBe(true);

    await h.service.saveProvider({ ...validProvider, apiKey: "***" });

    // 没有新的密钥 upsert，库里的密文逐字节不变，读回仍是原始明文
    expect(h.store.get("ai.providers.qwen-vl.apiKey")).toBe(before);
    expect((await readKeys(h.service))["qwen-vl"]).toBe("sk-original");
  });

  it("⑤ 存量明文行：配了 key 也能原样读回（零迁移、不报错）", async () => {
    const h = await harness(
      {
        "ai.providers": JSON.stringify([{ ...validProvider, enabled: true }]),
        "ai.providers.qwen-vl.apiKey": "sk-legacy-plain",
      },
      SEC_KEY,
    );

    expect(await readKeys(h.service)).toMatchObject({
      "qwen-vl": "sk-legacy-plain",
    });
    // 且读路径不写库（双读是只读的：不会把存量明文顺手加密）
    expect(h.upserts).toHaveLength(0);
  });
});

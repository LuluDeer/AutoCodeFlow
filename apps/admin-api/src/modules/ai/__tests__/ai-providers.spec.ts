/**
 * `ai-providers` 单测：provider / model 注册表（LLM 接入面）。
 *
 * 三条要钉的性质：
 *  ① **能力是条目字段，不是厂商判断**——`supportsVideo` 由接入者勾选，
 *     于是"视频模型"可以是任何一家（这正是「不要把 qwen 单独列出来」的落点）；
 *  ② **密钥不进注册表 JSON**——序列化后不得出现 apiKey（否则 `isSecret`
 *     逐键掩码失效，整条配置变成明文可读）；
 *  ③ **单条写坏不连坐**——一条非法条目只丢它自己，其余照常可用。
 */
import {
  CUSTOM_PROVIDER_DEFAULTS,
  LEGACY_DEFAULTS,
  legacyProviders,
  normalizeProviderEntry,
  parseProvidersJson,
  removeProviderEntry,
  selectableProviders,
  serializeProviders,
  toProviderViews,
  upsertProviderEntry,
  type AiProviderEntry,
} from "../ai-providers";

const entry = (over: Partial<AiProviderEntry> = {}): AiProviderEntry => ({
  id: "qwen-vl",
  label: "通义千问 VL",
  transport: "openai",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen-vl-max",
  maxTokens: 8192,
  timeoutMs: 120_000,
  supportsVideo: true,
  enabled: true,
  ...over,
});

describe("normalizeProviderEntry", () => {
  it("合法条目原样保留（含 supportsVideo 能力位）", () => {
    const res = normalizeProviderEntry(entry());
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.entry).toMatchObject({
      id: "qwen-vl",
      supportsVideo: true,
      maxTokens: 8192,
    });
  });

  it("id 形态闸：允许 a-z0-9._-，其余拒绝（id 会进配置键名）", () => {
    for (const bad of ["", "Qwen VL", "../etc", "a".repeat(65), "中文"]) {
      expect(normalizeProviderEntry({ ...entry(), id: bad }).status).toBe(
        "error",
      );
    }
    for (const good of ["openai", "qwen-vl", "my.gw_1", "a"]) {
      expect(normalizeProviderEntry({ ...entry(), id: good }).status).toBe(
        "ok",
      );
    }
  });

  it("内置 id 缺字段时用内置缺省；未知 id 用自定义缺省", () => {
    const builtin = normalizeProviderEntry({ id: "qwen" });
    expect(builtin.status).toBe("ok");
    if (builtin.status === "ok") {
      expect(builtin.entry.baseUrl).toBe(LEGACY_DEFAULTS.qwen.baseUrl);
      expect(builtin.entry.supportsVideo).toBe(true);
    }
    const custom = normalizeProviderEntry({ id: "my-gw" });
    if (custom.status === "ok") {
      expect(custom.entry.maxTokens).toBe(CUSTOM_PROVIDER_DEFAULTS.maxTokens);
      expect(custom.entry.supportsVideo).toBe(false);
    }
  });

  it("transport 封闭枚举：非 ollama 一律 openai", () => {
    const res = normalizeProviderEntry({
      ...entry(),
      transport: "weird" as never,
    });
    if (res.status === "ok") expect(res.entry.transport).toBe("openai");
    const ollama = normalizeProviderEntry({ ...entry(), transport: "ollama" });
    if (ollama.status === "ok") expect(ollama.entry.transport).toBe("ollama");
  });

  it("脏数值回落缺省（maxTokens/timeoutMs 不得变成 0 或 NaN）", () => {
    const res = normalizeProviderEntry({
      ...entry(),
      maxTokens: -5,
      timeoutMs: "abc" as never,
    });
    if (res.status === "ok") {
      expect(res.entry.maxTokens).toBeGreaterThan(0);
      expect(res.entry.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("enabled:false 原样保留（禁用是合法状态，不是脏值）", () => {
    const res = normalizeProviderEntry({ ...entry(), enabled: false });
    if (res.status === "ok") expect(res.entry.enabled).toBe(false);
  });
});

describe("parseProvidersJson", () => {
  it("未配置 → configured=false（调用方回落到旧键合成）", () => {
    expect(parseProvidersJson("")).toMatchObject({
      configured: false,
      entries: [],
      errors: [],
    });
    expect(parseProvidersJson(null).configured).toBe(false);
  });

  it("非法 JSON/非数组 → configured=false + 可读错误", () => {
    const bad = parseProvidersJson("{not json");
    expect(bad.configured).toBe(false);
    expect(bad.errors[0]).toContain("不是合法 JSON");
    expect(parseProvidersJson('{"a":1}').errors[0]).toContain("必须是数组");
  });

  it("单条写坏不连坐：只丢该条，其余可用", () => {
    const parsed = parseProvidersJson(
      JSON.stringify([entry(), { id: "BAD ID", baseUrl: "https://x" }]),
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.entries[0].id).toBe("qwen-vl");
  });

  it("id 重复只保留第一条并报错（重复会让路由指向不确定）", () => {
    const parsed = parseProvidersJson(
      JSON.stringify([entry(), entry({ model: "dup-model" })]),
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.errors[0]).toContain("id 重复");
  });
});

describe("serialize / mutate", () => {
  it("序列化**不含密钥**（否则 isSecret 掩码失效）", () => {
    const json = serializeProviders([entry()]);
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("sk-");
    expect(JSON.parse(json)[0]).toMatchObject({
      id: "qwen-vl",
      supportsVideo: true,
    });
  });

  it("序列化稳定排序（diff/审计可读）", () => {
    const json = serializeProviders([entry({ id: "b" }), entry({ id: "a" })]);
    expect(JSON.parse(json).map((e: { id: string }) => e.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("upsert 同 id 覆盖、remove 按 id 删除", () => {
    const base = [entry({ id: "a" }), entry({ id: "b" })];
    const upserted = upsertProviderEntry(
      base,
      entry({ id: "a", model: "new" }),
    );
    expect(upserted).toHaveLength(2);
    expect(upserted.find((e) => e.id === "a")?.model).toBe("new");
    expect(removeProviderEntry(base, "a").map((e) => e.id)).toEqual(["b"]);
  });
});

describe("legacyProviders / selectableProviders / views", () => {
  it("旧键合成三条内置条目（存量部署升级零行为变化）", () => {
    const legacy = legacyProviders({ qwen: { model: "qwen-max" } });
    expect(legacy.map((e) => e.id)).toEqual(["openai", "qwen", "ollama"]);
    expect(legacy.find((e) => e.id === "qwen")?.model).toBe("qwen-max");
    // 能力位来自内置缺省，而不是代码里的厂商判断
    expect(legacy.find((e) => e.id === "qwen")?.supportsVideo).toBe(true);
    expect(legacy.find((e) => e.id === "openai")?.supportsVideo).toBe(false);
  });

  it("按用途可选集合：video 只留 supportsVideo；agent 只留 OpenAI 兼容面", () => {
    const list = [
      entry({ id: "video-model", supportsVideo: true }),
      entry({ id: "text-model", supportsVideo: false }),
      entry({ id: "local", transport: "ollama", supportsVideo: false }),
      entry({ id: "off", enabled: false, supportsVideo: true }),
    ];
    expect(selectableProviders(list, "video").map((e) => e.id)).toEqual([
      "video-model",
    ]);
    expect(selectableProviders(list, "agent").map((e) => e.id)).toEqual([
      "video-model",
      "text-model",
    ]);
    expect(selectableProviders(list, "analysis").map((e) => e.id)).toEqual([
      "video-model",
      "text-model",
      "local",
    ]);
  });

  it("视图只暴露 hasApiKey 布尔，不回传密钥", () => {
    const views = toProviderViews(
      [entry()],
      { "qwen-vl": "sk-secret" },
      { legacy: false },
    );
    expect(views[0].hasApiKey).toBe(true);
    expect(JSON.stringify(views)).not.toContain("sk-secret");
    expect(views[0].legacy).toBe(false);
  });
});

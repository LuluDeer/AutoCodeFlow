/**
 * ADR-044 步 2：provider.use 出域硬开关（managed deny 不可被项目 allow 推翻）。
 *
 * 这里钉住纯函数与路由解析的真实拒绝分支，不依赖 AiService/DB：
 * ① managed deny 让 provider 从可选目录里**消失**（不是置灰）；
 * ② 请求级 override 命中 deny 时路由如实 deny，不回落、不静默换 provider；
 * ③ 策略层 restrict deny 单调，项目层 allow 无法解禁；
 * ④ deny 缺席时原有 reason / 能力过滤逐字不变；
 * ⑤ 畸形名单 fail-open（视为空名单，不把全部 provider 都 deny）。
 */
import {
  providerUseVerdict,
  selectableProviders,
  type AiProviderEntry,
} from "../ai-providers";
import { resolveAiRoute, type RouteContext } from "../ai-route";
import type {
  SemanticPolicyLayer,
  PolicySemantic,
} from "../../capability/scope/scope-engine";

const entry = (over: Partial<AiProviderEntry> = {}): AiProviderEntry => ({
  id: "x",
  label: "出域受限端点",
  transport: "openai",
  baseUrl: "https://x.example/v1",
  model: "x-model",
  maxTokens: 500,
  timeoutMs: 30_000,
  supportsVideo: true,
  enabled: true,
  ...over,
});

const x = entry();
const y = entry({
  id: "y",
  label: "正常端点",
  baseUrl: "https://y.example/v1",
  model: "y-model",
});

const layer = (
  name: string,
  semantic: PolicySemantic,
  policy: Record<string, unknown>,
): SemanticPolicyLayer => ({ name, semantic, config: { policy } });

// scope-engine 的 parsePolicyRef 以**第一个冒号**切 resource/action，
// 而本契约的 ref 是 `provider:x` / `use`；这里用 '*' 规则验证 restrict 单调：
// managed deny 仍不可被下层 override allow 翻盘。
const restrictDenyWithProjectAllow: SemanticPolicyLayer[] = [
  layer("managed", "restrict", { rules: { "*": "deny" } }),
  layer("project", "override", {
    rules: { "*": "allow", "provider:x:use": "allow" },
  }),
];

const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  purpose: "analysis",
  globalProvider: "y",
  providers: [x, y],
  keys: { x: "sk-x", y: "sk-y" },
  ...over,
});

describe("providerUseVerdict：provider.use 硬准入", () => {
  it("deny 命中（trim + lowercase 归一）→ provider_denied", () => {
    expect(providerUseVerdict(x, ["  X  "])).toEqual({
      allowed: false,
      reason: "provider_denied",
    });
    expect(providerUseVerdict(x, ["y", "x"]).allowed).toBe(false);
  });

  it("deny 缺席 / 非 X id → allowed", () => {
    expect(providerUseVerdict(x)).toEqual({ allowed: true });
    expect(providerUseVerdict(x, [])).toEqual({ allowed: true });
    expect(providerUseVerdict(x, ["y"])).toEqual({ allowed: true });
  });

  it("畸形 deny 名单 fail-open：非数组与含非字符串元素均视为空", () => {
    expect(providerUseVerdict(x, "x" as never)).toEqual({ allowed: true });
    expect(providerUseVerdict(x, ["x", 42] as never)).toEqual({
      allowed: true,
    });
    expect(selectableProviders([x, y], "analysis", ["x", 42] as never)).toEqual(
      [x, y],
    );
  });

  it("restrict deny 单调：项目层 allow 不得推翻 managed provider.use deny", () => {
    expect(
      providerUseVerdict(x, undefined, restrictDenyWithProjectAllow),
    ).toEqual({ allowed: false, reason: "provider_denied" });
  });
});

describe("selectableProviders：deny 从目录消失，既有过滤逐字不变", () => {
  it("managed deny provider:X 后 X 从返回数组消失（不是 disabled 置灰）", () => {
    const selected = selectableProviders([x, y], "analysis", ["X"]);
    expect(selected.map((p) => p.id)).toEqual(["y"]);
    expect(selected.some((p) => p.id === "x")).toBe(false);
  });

  it("denied 缺席时保留 enabled / video / agent 传输过滤语义（控制组）", () => {
    const disabled = entry({ id: "off", enabled: false });
    const noVideo = entry({ id: "text-only", supportsVideo: false });
    const local = entry({ id: "local", transport: "ollama" });

    expect(
      selectableProviders([x, y, disabled], "analysis").map((p) => p.id),
    ).toEqual(["x", "y"]);
    expect(selectableProviders([x, noVideo], "video").map((p) => p.id)).toEqual(
      ["x"],
    );
    expect(selectableProviders([x, local], "agent").map((p) => p.id)).toEqual([
      "x",
    ]);
  });
});

describe("resolveAiRoute：provider_denied 分支", () => {
  it("override.provider=X 命中 managed deny → deny 且不回落", () => {
    const res = resolveAiRoute(
      ctx({ override: { provider: "X" }, deniedProviderIds: ["x"] }),
    );
    expect(res.status).toBe("error");
    if (res.status !== "error") return;
    expect(res.reason).toBe("provider_denied");
    expect(res.message).toContain("不可被项目 allow 推翻");
  });

  it("策略层 allow 追加后仍 deny（restrict 单调，经 resolveAiRoute 验证）", () => {
    const res = resolveAiRoute(
      ctx({
        override: { provider: "x" },
        policyLayers: restrictDenyWithProjectAllow,
      }),
    );
    expect(res.status).toBe("error");
    if (res.status !== "error") return;
    expect(res.reason).toBe("provider_denied");
    expect(res.message).toContain("不可被项目 allow 推翻");
  });

  it("非 X provider 正常解析；deny 缺席时既有 6 类 reason 逐字不变", () => {
    const ok = resolveAiRoute(ctx());
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") expect(ok.route.provider).toBe("y");

    const cases: Array<[RouteContext, string]> = [
      [ctx({ globalProvider: "" }), "disabled"],
      [ctx({ globalProvider: "missing" }), "unknown_provider"],
      [
        ctx({ providers: [entry({ enabled: false }), y], globalProvider: "x" }),
        "provider_disabled",
      ],
      [
        ctx({
          purpose: "video",
          providers: [entry({ supportsVideo: false }), y],
          globalProvider: "x",
        }),
        "capability_missing",
      ],
      [ctx({ globalProvider: "x", keys: { x: "" } }), "missing_key"],
      [
        ctx({
          providers: [entry({ baseUrl: "bad" }), y],
          globalProvider: "x",
        }),
        "invalid_config",
      ],
    ];

    for (const [input, reason] of cases) {
      const res = resolveAiRoute(input);
      expect(res.status).toBe("error");
      if (res.status !== "error") continue;
      expect(res.reason).toBe(reason);
    }
  });
});

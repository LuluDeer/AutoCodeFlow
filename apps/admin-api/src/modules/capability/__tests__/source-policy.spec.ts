import {
  SUPPORTED_SOURCE_TYPES,
  assertOriginAllowed,
  canAutoUpdate,
  canToggleMarketplace,
  isSupportedSourceType,
  type ExtendedSourceType,
} from "../source-policy";

const ORIGINAL_FOUR: ExtendedSourceType[] = [
  "builtin",
  "registry",
  "git",
  "folder",
];
const FIVE_EXTERNAL: ExtendedSourceType[] = [
  "npm",
  "git",
  "github",
  "server",
  "mcp:",
];
const MARKETPLACE_ELIGIBLE: ExtendedSourceType[] = [
  "registry",
  "git",
  "npm",
  "github",
  "mcp:",
];

describe("N25 source-policy · isSupportedSourceType", () => {
  it.each(SUPPORTED_SOURCE_TYPES)("闭包内源类型 %s 判支持", (type) => {
    expect(isSupportedSourceType(type)).toBe(true);
  });

  it("原 4 源全部仍在闭包内", () => {
    for (const type of ORIGINAL_FOUR) {
      expect(isSupportedSourceType(type)).toBe(true);
    }
  });

  it("五源外部面全部在闭包内", () => {
    for (const type of FIVE_EXTERNAL) {
      expect(isSupportedSourceType(type)).toBe(true);
    }
  });

  it.each([
    "unknown-source",
    "marketplace",
    "plugin@marketplace",
    "",
    " ",
    "builtin ",
    "NPM",
    "mcp",
    "__proto__",
    "constructor",
    null,
    undefined,
    42,
    {},
    [],
  ])("闭包外类型 %p 判不支持（反证：恒真即红）", (type) => {
    expect(isSupportedSourceType(type)).toBe(false);
  });

  it("控制组：闭包判据不是恒真也不是恒假", () => {
    const accepted = SUPPORTED_SOURCE_TYPES.filter(isSupportedSourceType);
    expect(accepted).toHaveLength(SUPPORTED_SOURCE_TYPES.length);
    expect(isSupportedSourceType("rogue-source")).toBe(false);
  });
});

describe("N25 source-policy · canToggleMarketplace", () => {
  it.each(MARKETPLACE_ELIGIBLE)("%s + plugin@marketplace 可启停", (type) => {
    const source = { type, ref: "plugin@marketplace" };
    expect(canToggleMarketplace(source, true)).toBe(true);
    expect(canToggleMarketplace(source, false)).toBe(true);
  });

  it.each(["builtin", "folder", "server"] as ExtendedSourceType[])(
    "%s 即使 ref 形似 marketplace 也不可启停",
    (type) => {
      expect(
        canToggleMarketplace({ type, ref: "plugin@marketplace" }, true),
      ).toBe(false);
    },
  );

  it.each(["plugin", "plugin@other", "@marketplace", "Plugin@marketplace", ""])(
    "ref 为 %p 时不可启停",
    (ref) => {
      expect(canToggleMarketplace({ type: "npm", ref }, true)).toBe(false);
    },
  );

  it("未知源类型 + marketplace ref 不可启停", () => {
    expect(
      canToggleMarketplace(
        { type: "rogue-source", ref: "plugin@marketplace" },
        true,
      ),
    ).toBe(false);
  });

  it.each([undefined, null, "true", 1, {}])(
    "enabled 为 %p 时 fail-closed",
    (enabled) => {
      expect(
        canToggleMarketplace(
          { type: "npm", ref: "plugin@marketplace" },
          enabled,
        ),
      ).toBe(false);
    },
  );

  it.each([null, undefined, "npm", 42, [], true])(
    "source 形态为 %p 时 fail-closed",
    (source) => {
      expect(canToggleMarketplace(source, true)).toBe(false);
    },
  );

  it("控制组：无 marketplace 身份的普通 npm 源不可启停", () => {
    expect(
      canToggleMarketplace({ type: "npm", ref: "git+https://x/y" }, true),
    ).toBe(false);
  });
});

describe("N25 source-policy · canAutoUpdate", () => {
  it.each(FIVE_EXTERNAL)("五源 %s + 版本差异放行", (type) => {
    expect(canAutoUpdate({ type }, "1.0.0", "1.1.0")).toBe(true);
  });

  it.each(["builtin", "registry", "folder"] as ExtendedSourceType[])(
    "非五源 %s 不放行",
    (type) => {
      expect(canAutoUpdate({ type }, "1.0.0", "1.1.0")).toBe(false);
    },
  );

  it("未知源类型 + 完整版本信息仍不放行", () => {
    expect(canAutoUpdate({ type: "rogue-source" }, "1.0.0", "1.1.0")).toBe(
      false,
    );
  });

  it.each([undefined, null, "", "  ", 1, {}, []])(
    "currentVersion 为 %p 时 fail-closed",
    (currentVersion) => {
      expect(canAutoUpdate({ type: "npm" }, currentVersion, "1.1.0")).toBe(
        false,
      );
    },
  );

  it.each([undefined, null, "", "  ", 1, {}, []])(
    "latestVersion 为 %p 时 fail-closed（反证：放行即红）",
    (latestVersion) => {
      expect(canAutoUpdate({ type: "npm" }, "1.0.0", latestVersion)).toBe(
        false,
      );
    },
  );

  it("版本相同不放行", () => {
    expect(canAutoUpdate({ type: "npm" }, "1.0.0", "1.0.0")).toBe(false);
  });

  it.each([null, undefined, "npm", 42, [], true])(
    "source 形态为 %p 时 fail-closed",
    (source) => {
      expect(canAutoUpdate(source, "1.0.0", "1.1.0")).toBe(false);
    },
  );

  it("控制组：空白版本在两侧都不放行", () => {
    expect(canAutoUpdate({ type: "github" }, "  ", "1.1.0")).toBe(false);
    expect(canAutoUpdate({ type: "github" }, "1.0.0", "  ")).toBe(false);
    expect(canAutoUpdate({ type: "github" }, "1.0.0", "1.0.1")).toBe(true);
  });
});

// N21 / ADR-044：来源白名单 + 分级标签（企业管控硬边界，fail-closed）
describe("source-policy — N21 来源白名单与分级标签", () => {
  it("合法来源（公网 public / 内网 sensitive）放行", () => {
    expect(
      assertOriginAllowed(
        { type: "git", ref: "https://github.com/acf/skill.git" },
        "public",
      ).ok,
    ).toBe(true);
    expect(
      assertOriginAllowed(
        { type: "git", ref: "https://git.internal.example/skill.git" },
        "sensitive",
      ).ok,
    ).toBe(true);
    expect(assertOriginAllowed({ type: "folder" }).ok).toBe(true);
  });

  it("URL userinfo（带凭据）一律拒", () => {
    const v = assertOriginAllowed({
      type: "git",
      ref: "https://user:pass@github.com/acf/skill.git",
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/credentials/i);
  });

  it("headers 字段（不可移植、会带出密钥）一律拒", () => {
    expect(
      assertOriginAllowed({
        type: "server",
        ref: "https://api.example.com",
        headers: { Authorization: "Bearer x" },
      }).ok,
    ).toBe(false);
  });

  it("白名单外 scheme（命令型）一律拒", () => {
    expect(
      assertOriginAllowed({ type: "server", ref: "file:///etc/passwd" }).ok,
    ).toBe(false);
    expect(
      assertOriginAllowed({ type: "server", ref: "javascript:alert(1)" }).ok,
    ).toBe(false);
  });

  it("sensitive 能力禁止公网 host", () => {
    const v = assertOriginAllowed(
      { type: "git", ref: "https://github.com/acf/skill.git" },
      "sensitive",
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/sensitive/i);
    expect(
      assertOriginAllowed(
        { type: "git", ref: "https://10.0.0.5/skill.git" },
        "sensitive",
      ).ok,
    ).toBe(true);
  });

  it("非法分级与畸形形态 fail-closed", () => {
    expect(assertOriginAllowed({ type: "git" }, "top-secret").ok).toBe(false);
    expect(assertOriginAllowed(null).ok).toBe(false);
    expect(assertOriginAllowed({ type: "git", ref: "" }).ok).toBe(false);
    // 非 URL ref（package@marketplace）由 type 层校验，不在来源层拒
    expect(
      assertOriginAllowed({ type: "npm", ref: "my-skill@marketplace" }).ok,
    ).toBe(true);
  });
});

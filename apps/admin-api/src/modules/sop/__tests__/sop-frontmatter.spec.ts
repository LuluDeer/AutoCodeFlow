import {
  parseFrontMatterYaml,
  resolveMaxRounds,
  sopContentHash,
  stableStringify,
  SOP_CAPABILITIES,
  SOP_CLARIFICATION_QUESTION_MAX,
  SOP_DEFAULT_MAX_ROUNDS,
  SOP_MAX_ROUNDS_HARD_CAP,
  SopFrontMatterError,
  validateFrontMatter,
} from "../sop-frontmatter";

/** 合法发布形态的最小 front-matter（各用例在其上做单点变异）。 */
function validRaw(): Record<string, unknown> {
  return {
    target: { application: "demo-app" },
    capabilities: ["filesystem"],
    acceptance: [{ kind: "command", run: "python3 main.py" }],
    constraints: { maxDurationSec: 3600, allowedDomains: ["Example.COM"] },
    clarification: { owner: "center-agent", maxRounds: 3 },
  };
}

describe("stableStringify（contentHash 的前提）", () => {
  it("原始值直接 JSON 序列化", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify("x")).toBe('"x"');
    expect(stableStringify(true)).toBe("true");
  });

  it("对象键递归排序——键顺序不影响输出", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("嵌套对象同样排序；undefined 值被剔除", () => {
    const a = { z: { y: 1, x: { d: 4, c: 3 } } };
    const b = { z: { x: { c: 3, d: 4 }, y: 1 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify({ a: 1, gone: undefined })).toBe('{"a":1}');
  });

  it("数组保持顺序并递归稳定化", () => {
    expect(stableStringify([{ b: 1, a: 0 }, 2])).toBe('[{"a":0,"b":1},2]');
  });
});

describe("sopContentHash", () => {
  it("对键顺序不敏感、对内容敏感", () => {
    const fm = validateFrontMatter(validRaw(), { strict: true });
    const reordered = validateFrontMatter(
      JSON.parse(
        JSON.stringify({
          clarification: { maxRounds: 3, owner: "center-agent" },
          constraints: { allowedDomains: ["Example.COM"], maxDurationSec: 3600 },
          acceptance: [{ run: "python3 main.py", kind: "command" }],
          capabilities: ["filesystem"],
          target: { application: "demo-app" },
        }),
      ) as Record<string, unknown>,
      { strict: true },
    );
    expect(sopContentHash(fm, "body")).toBe(sopContentHash(reordered, "body"));
    expect(sopContentHash(fm, "body")).not.toBe(sopContentHash(fm, "body2"));
  });
});

describe("parseFrontMatterYaml", () => {
  it("合法映射原样返回", () => {
    expect(parseFrontMatterYaml("acceptance: []\n")).toEqual({ acceptance: [] });
  });

  it("非法 YAML 包装为 SopFrontMatterError", () => {
    expect(() => parseFrontMatterYaml("a: [")).toThrow(SopFrontMatterError);
  });

  it("空文档 / 数组 / 标量顶层都拒绝", () => {
    expect(() => parseFrontMatterYaml("")).toThrow(SopFrontMatterError);
    expect(() => parseFrontMatterYaml("null")).toThrow(/为空/);
    expect(() => parseFrontMatterYaml("- a")).toThrow(/顶层必须是映射/);
    expect(() => parseFrontMatterYaml("42")).toThrow(/顶层必须是映射/);
  });

  it("执行类标签（!!js/function）直接抛错——LLM 输出不得携带可执行语义", () => {
    const evil = "acceptance: !!js/function 'function(){...}'";
    expect(() => parseFrontMatterYaml(evil)).toThrow(SopFrontMatterError);
  });
});

describe("validateFrontMatter · 严格校验矩阵", () => {
  it("合法发布形态全绿且域名归一为小写", () => {
    const out = validateFrontMatter(validRaw(), { strict: true });
    expect(out.target).toEqual({ application: "demo-app" });
    expect(out.capabilities).toEqual(["filesystem"]);
    expect(out.acceptance).toEqual([{ kind: "command", run: "python3 main.py" }]);
    expect(out.constraints?.allowedDomains).toEqual(["example.com"]);
    expect(out.clarification).toEqual({ owner: "center-agent", maxRounds: 3 });
  });

  it("兼容 sop: 包裹层", () => {
    const out = validateFrontMatter({ sop: validRaw() }, { strict: true });
    expect(out.acceptance).toHaveLength(1);
  });

  it("未知顶层键两种形态都拒绝（front-matter 是机器契约）", () => {
    expect(() =>
      validateFrontMatter({ ...validRaw(), notes: "hi" }, { strict: true }),
    ).toThrow(/未知键 sop\.notes/);
    expect(() =>
      validateFrontMatter({ sop: { ...validRaw(), notes: "hi" } }, { strict: false }),
    ).toThrow(/未知键 sop\.notes/);
  });

  it("target：非映射 / 未知键 / 空串", () => {
    expect(() => validateFrontMatter({ target: "x" }, { strict: false })).toThrow(
      /target 必须是映射/,
    );
    expect(() =>
      validateFrontMatter({ target: { nope: 1 } }, { strict: false }),
    ).toThrow(/未知键 sop\.target\.nope/);
    expect(() =>
      validateFrontMatter({ target: { application: "  " } }, { strict: false }),
    ).toThrow(/application 必须是非空字符串/);
    const out = validateFrontMatter(
      {
        target: {
          application: "a",
          runtime: "python",
          manifestEntry: "demo:main",
        },
        acceptance: [{ kind: "command", run: "x" }],
      },
      { strict: true },
    );
    expect(out.target).toEqual({
      application: "a",
      runtime: "python",
      manifestEntry: "demo:main",
    });
  });

  it("capabilities：非数组 / 越枚举 / 合法枚举", () => {
    expect(() =>
      validateFrontMatter({ capabilities: "browser" }, { strict: false }),
    ).toThrow(/capabilities 必须是数组/);
    expect(() =>
      validateFrontMatter({ capabilities: ["shell"] }, { strict: false }),
    ).toThrow(/不在能力域枚举内/);
    const out = validateFrontMatter(
      { capabilities: [...SOP_CAPABILITIES], acceptance: [{ kind: "command", run: "x" }] },
      { strict: true },
    );
    expect(out.capabilities).toEqual([...SOP_CAPABILITIES]);
  });

  it("acceptance：发布必填 / 草稿可缺", () => {
    expect(() => validateFrontMatter({}, { strict: true })).toThrow(
      /acceptance 必填/,
    );
    const draft = validateFrontMatter({}, { strict: false });
    expect(draft.acceptance).toEqual([]);
  });

  it("acceptance：空数组 / 超 10 项 / 非映射项 / 未知键 / 非法 kind", () => {
    expect(() =>
      validateFrontMatter({ acceptance: [] }, { strict: true }),
    ).toThrow(/非空数组/);
    expect(() =>
      validateFrontMatter(
        { acceptance: Array.from({ length: 11 }, () => ({ kind: "command", run: "x" })) },
        { strict: true },
      ),
    ).toThrow(/最多 10 项/);
    expect(() =>
      validateFrontMatter({ acceptance: ["run main"] }, { strict: false }),
    ).toThrow(/acceptance\[0\] 必须是映射/);
    expect(() =>
      validateFrontMatter(
        { acceptance: [{ kind: "command", run: "x", retry: 3 }] },
        { strict: false },
      ),
    ).toThrow(/未知键 sop\.acceptance\[0\]\.retry/);
    expect(() =>
      validateFrontMatter({ acceptance: [{ kind: "eval" }] }, { strict: false }),
    ).toThrow(/kind 必须是 command \| platform/);
  });

  it("acceptance command：run 缺失严格拒绝、草稿放行；空串拒绝", () => {
    expect(() =>
      validateFrontMatter({ acceptance: [{ kind: "command" }] }, { strict: true }),
    ).toThrow(/（command）缺 run/);
    const draft = validateFrontMatter(
      { acceptance: [{ kind: "command" }] },
      { strict: false },
    );
    expect(draft.acceptance[0]).toEqual({ kind: "command" });
    expect(() =>
      validateFrontMatter(
        { acceptance: [{ kind: "command", run: " " }] },
        { strict: false },
      ),
    ).toThrow(/run 必须是非空字符串/);
  });

  it("acceptance platform：check 必填（严格）、task/expect/timeoutSec 可选", () => {
    expect(() =>
      validateFrontMatter({ acceptance: [{ kind: "platform" }] }, { strict: true }),
    ).toThrow(/（platform）缺 check/);
    const out = validateFrontMatter(
      {
        acceptance: [
          {
            kind: "platform",
            check: "status",
            task: "t-1",
            expect: "ok",
            timeoutSec: 60,
          },
        ],
      },
      { strict: true },
    );
    expect(out.acceptance[0]).toMatchObject({ kind: "platform", task: "t-1" });
  });

  it("acceptance platform：timeoutSec 必须是 1..3600 的整数", () => {
    for (const bad of [0, 3601, 1.5, "60"]) {
      expect(() =>
        validateFrontMatter(
          { acceptance: [{ kind: "platform", check: "s", timeoutSec: bad }] },
          { strict: false },
        ),
      ).toThrow(/timeoutSec 必须是 1\.\.3600 的整数/);
    }
  });

  it("constraints：maxDurationSec 60..86400、allowedDomains 裸域名、forbidden 数组", () => {
    for (const bad of [59, 86401, 60.5]) {
      expect(() =>
        validateFrontMatter({ constraints: { maxDurationSec: bad } }, { strict: false }),
      ).toThrow(/maxDurationSec 必须是 60\.\.86400 的整数/);
    }
    expect(() =>
      validateFrontMatter({ constraints: "x" }, { strict: false }),
    ).toThrow(/constraints 必须是映射/);
    expect(() =>
      validateFrontMatter(
        { constraints: { other: 1 } },
        { strict: false },
      ),
    ).toThrow(/未知键 sop\.constraints\.other/);
    expect(() =>
      validateFrontMatter(
        { constraints: { allowedDomains: "example.com" } },
        { strict: false },
      ),
    ).toThrow(/allowedDomains 必须是数组/);
    // 协议 / 路径 / 通配符 / 相对段 一律不是裸域名
    for (const bad of ["https://a.com", "a.com/path", "*.a.com", "a..com"]) {
      expect(() =>
        validateFrontMatter(
          { constraints: { allowedDomains: [bad] } },
          { strict: false },
        ),
      ).toThrow(/不是裸域名/);
    }
    expect(() =>
      validateFrontMatter(
        { constraints: { forbidden: [""] } },
        { strict: false },
      ),
    ).toThrow(/forbidden\[0\] 必须是非空字符串/);
    const out = validateFrontMatter(
      { constraints: { allowedDomains: ["B.com"], forbidden: ["rm -rf"] } },
      { strict: false },
    );
    expect(out.constraints).toEqual({
      allowedDomains: ["b.com"],
      forbidden: ["rm -rf"],
    });
  });

  it("clarification：owner 枚举、maxRounds 1..硬上限", () => {
    expect(() =>
      validateFrontMatter({ clarification: "x" }, { strict: false }),
    ).toThrow(/clarification 必须是映射/);
    expect(() =>
      validateFrontMatter({ clarification: { who: 1 } }, { strict: false }),
    ).toThrow(/未知键 sop\.clarification\.who/);
    expect(() =>
      validateFrontMatter({ clarification: { owner: "executor" } }, { strict: false }),
    ).toThrow(/owner 必须是 center-agent \| human/);
    for (const bad of [0, 6, 2.5]) {
      expect(() =>
        validateFrontMatter({ clarification: { maxRounds: bad } }, { strict: false }),
      ).toThrow(/maxRounds/);
    }
    const out = validateFrontMatter(
      {
        acceptance: [{ kind: "command", run: "x" }],
        clarification: { owner: "human", maxRounds: 1 },
      },
      { strict: true },
    );
    expect(out.clarification).toEqual({ owner: "human", maxRounds: 1 });
  });
});

describe("resolveMaxRounds", () => {
  it("null / 无 clarification / 无 maxRounds → 默认 5", () => {
    expect(resolveMaxRounds(null)).toBe(SOP_DEFAULT_MAX_ROUNDS);
    expect(resolveMaxRounds({ acceptance: [] })).toBe(SOP_DEFAULT_MAX_ROUNDS);
    expect(
      resolveMaxRounds({ acceptance: [], clarification: {} }),
    ).toBe(SOP_DEFAULT_MAX_ROUNDS);
  });

  it("front-matter 值生效但被硬上限钳住", () => {
    expect(resolveMaxRounds({ acceptance: [], clarification: { maxRounds: 2 } })).toBe(2);
    expect(
      resolveMaxRounds({ acceptance: [], clarification: { maxRounds: 99 } }),
    ).toBe(SOP_MAX_ROUNDS_HARD_CAP);
  });

  it("非法值（<1 / 非数字）回默认", () => {
    expect(resolveMaxRounds({ acceptance: [], clarification: { maxRounds: 0 } })).toBe(5);
    expect(
      resolveMaxRounds({ acceptance: [], clarification: { maxRounds: "3" as unknown as number } }),
    ).toBe(5);
  });

  it("常量与防线：澄清问题长度上限存在（11 §5.2）", () => {
    expect(SOP_CLARIFICATION_QUESTION_MAX).toBeGreaterThan(0);
    expect(SOP_MAX_ROUNDS_HARD_CAP).toBe(5);
  });
});

/**
 * provider-ref 单测：凭据占位与 `provider/model#variant` 的纯解析层。
 *
 * 反证锚点：
 *  ① 明文凭证（sk- / PEM / 长 hex）若被当成 `{env:NAME}` 接受 ⇒ 转红；
 *  ② 畸形 ref 若被猜出 provider/model/variant ⇒ 转红；
 *  ③ 每组的"合法样本"是控制组——保证收严正则没有把正常表达一起打死。
 */
import {
  parseEnvPlaceholder,
  parseProviderModelVariant,
  resolveReasoningEffort,
} from "../provider-ref";

describe("parseEnvPlaceholder", () => {
  it("控制组：严格形态精确拆出 NAME", () => {
    expect(parseEnvPlaceholder("{env:OPENAI_API_KEY}")).toEqual({
      name: "OPENAI_API_KEY",
    });
    expect(parseEnvPlaceholder("{env:A}")).toEqual({ name: "A" });
    expect(parseEnvPlaceholder("{env:A1_B2}")).toEqual({ name: "A1_B2" });
    expect(parseEnvPlaceholder("{env:9}")).toEqual({ name: "9" });
  });

  it("明文凭证 fail-closed：sk- / PEM / 长 hex 一律不接受", () => {
    const plaintext = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz",
      "sk-1234567890abcdef",
      "-----BEGIN OPENAI PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END OPENAI PRIVATE KEY-----",
      "a".repeat(64),
      "0123456789abcdef".repeat(4),
    ];
    for (const value of plaintext) {
      expect(parseEnvPlaceholder(value)).toBeNull();
    }
  });

  it("畸形占位 fail-closed：空值/小写/连字符/点号/错前缀/空白", () => {
    const malformed = [
      "",
      "   ",
      "{env:}",
      "{env:lower}",
      "{env:OpenAI_Key}",
      "{env:FOO-BAR}",
      "{env:FOO.BAR}",
      "{env:FOO BAR}",
      "env:FOO",
      "{ENV:FOO}",
      "{secret:FOO}",
      "{env:FOO} ",
      " {env:FOO}",
      "{env:FOO",
      "{env:FOO}}",
      "FOO",
    ];
    for (const value of malformed) {
      expect(parseEnvPlaceholder(value)).toBeNull();
    }
  });

  it("非字符串与结尾换行返回 null（JS `$` 尾换行陷阱）", () => {
    expect(parseEnvPlaceholder("{env:FOO}\n")).toBeNull();
    expect(parseEnvPlaceholder("{env:FOO}\r\n")).toBeNull();
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(parseEnvPlaceholder(value)).toBeNull();
    }
  });
});

describe("parseProviderModelVariant", () => {
  it("控制组：provider/model#variant 精确拆分", () => {
    expect(parseProviderModelVariant("openai/gpt-4o#high")).toEqual({
      provider: "openai",
      model: "gpt-4o",
      variant: "high",
    });
    expect(parseProviderModelVariant("qwen-vl/qwen-vl-max#medium")).toEqual({
      provider: "qwen-vl",
      model: "qwen-vl-max",
      variant: "medium",
    });
    expect(parseProviderModelVariant("my.gw_1/llama3:latest#low")).toEqual({
      provider: "my.gw_1",
      model: "llama3:latest",
      variant: "low",
    });
  });

  it("variant 缺省：返回对象不带该键（读取为 undefined），不猜测", () => {
    const parsed = parseProviderModelVariant("openai/gpt-4o");
    expect(parsed).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(parsed?.variant).toBeUndefined();
    expect(parsed && "variant" in parsed).toBe(false);
  });

  it("畸形 ref 返回 null，不猜 provider / model / variant", () => {
    const malformed = [
      "",
      "/",
      "openai",
      "openai/",
      "/gpt-4o",
      "openai/gpt-4o#",
      "openai/gpt-4o#high#low",
      "openai/gpt/4o",
      "OpenAI/gpt-4o",
      " openai/gpt-4o",
      "openai/gpt-4o ",
      "openai/gpt-4o\n",
      "openai/{env:KEY}",
      "openai/gpt-4o#reasoning high",
      `${"a".repeat(65)}/gpt-4o`,
    ];
    for (const ref of malformed) {
      expect(parseProviderModelVariant(ref)).toBeNull();
    }
  });

  it("非字符串 ref 返回 null", () => {
    for (const ref of [null, undefined, 123, {}, []]) {
      expect(parseProviderModelVariant(ref)).toBeNull();
    }
  });
});

describe("resolveReasoningEffort", () => {
  it("控制组：三个明确取值恒等映射", () => {
    expect(resolveReasoningEffort("low")).toBe("low");
    expect(resolveReasoningEffort("medium")).toBe("medium");
    expect(resolveReasoningEffort("high")).toBe("high");
  });

  it("未知词、大小写变体、空值一律 null（不虚构取值）", () => {
    for (const variant of [
      undefined,
      "",
      "LOW",
      "High",
      "minimal",
      "none",
      "auto",
      "reasoning:high",
    ]) {
      expect(resolveReasoningEffort(variant)).toBeNull();
    }
  });

  it("非字符串入参返回 null", () => {
    for (const variant of [null, 42, {}, []]) {
      expect(resolveReasoningEffort(variant as unknown as string)).toBeNull();
    }
  });
});

describe("跨函数契约：占位与 ref 不串味", () => {
  it("ref 的 variant 交给 resolveReasoningEffort 得到 reasoningEffort", () => {
    const withVariant = parseProviderModelVariant("openai/gpt-4o#high");
    expect(withVariant && resolveReasoningEffort(withVariant.variant)).toBe(
      "high",
    );
    const withoutVariant = parseProviderModelVariant("openai/gpt-4o");
    expect(
      withoutVariant && resolveReasoningEffort(withoutVariant.variant),
    ).toBeNull();
  });

  it("env 占位不是 ref，ref 也不是 env 占位", () => {
    expect(parseProviderModelVariant("{env:OPENAI_API_KEY}")).toBeNull();
    expect(parseEnvPlaceholder("openai/gpt-4o#high")).toBeNull();
  });
});

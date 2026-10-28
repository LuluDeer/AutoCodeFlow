/**
 * `ai-json` 单测：模型输出的宽容提取 + slug 归一。
 *
 * 为什么值得单测：这两个函数决定「模型答对了但包装多余」会不会被误判成失败。
 * 判太严 → 用户看到"生成失败，请重试"（而重试还是同样的包装）；判太松 →
 * 把半截 JSON 当成完整草稿。
 */
import { extractJsonObject, normalizeSopSlug } from "../ai-json";

describe("extractJsonObject", () => {
  it("纯 JSON 直接解析", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("容忍 markdown 围栏（模型最爱加的包装）", () => {
    expect(extractJsonObject('```json\n{"title":"x"}\n```')).toEqual({
      title: "x",
    });
    expect(extractJsonObject('```\n{"title":"y"}\n```')).toEqual({
      title: "y",
    });
  });

  it("容忍前后闲话（取首个 { 到末个 }）", () => {
    expect(
      extractJsonObject('好的，草稿如下：\n{"title":"z"}\n如需调整请告诉我。'),
    ).toEqual({ title: "z" });
  });

  it("数组/标量不算对象（返回 null，不猜）", () => {
    expect(extractJsonObject("[1,2]")).toBeNull();
    expect(extractJsonObject("123")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject(null)).toBeNull();
  });

  it("半截 JSON 如实失败（不修补）", () => {
    expect(extractJsonObject('{"title":"x"')).toBeNull();
  });

  it("超大输入直接拒（防把整段视频转录灌进来）", () => {
    expect(extractJsonObject("{}" + "x".repeat(600 * 1024))).toBeNull();
  });
});

describe("normalizeSopSlug", () => {
  it("小写 + 非字母数字折叠为连字符 + 去首尾", () => {
    expect(normalizeSopSlug("Daily Report v2")).toBe("daily-report-v2");
    expect(normalizeSopSlug("  你好 World!!  ")).toBe("world");
    expect(normalizeSopSlug("--a--b--")).toBe("a-b");
  });

  it("限长 128（slug 进 URL 与配置键）", () => {
    expect(normalizeSopSlug("a".repeat(300)).length).toBe(128);
  });

  it("非字符串 → 空串（调用方据此回落到标题/随机）", () => {
    expect(normalizeSopSlug(undefined)).toBe("");
    expect(normalizeSopSlug(42)).toBe("");
  });
});

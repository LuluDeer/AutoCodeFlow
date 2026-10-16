/**
 * API-I18N：Swagger UI 语言开关的**纯逻辑**契约。
 *
 * 为什么只测 `collectEntries` / `buildSwaggerI18nScript` 而不测 DOM 操作：
 * 开关的 DOM 部分跑在浏览器里（注入的字符串），本仓没有浏览器测试设施；
 * 而真正容易出错、且一旦出错就**静默**的是「从文档里提取了哪些对」这一步——
 * 提取漏了某类位置，开关切过去那类文案就原地不动，用户看到"半中半英"，
 * 且不会报任何错。故把提取面钉死在这里。
 */
import { buildSwaggerI18nScript, collectEntries } from "../swagger-i18n-toggle";

const doc = {
  components: {
    schemas: {
      Executor: {
        properties: {
          id: { description: "执行器 ID", "x-i18n-en": "Executor ID" },
          address: {
            description: "执行器地址",
            "x-i18n-en": "Executor address",
          },
        },
      },
    },
  },
  paths: {
    "/executors": {
      parameters: [
        { name: "page", description: "页码", "x-i18n-en": "Page number" },
      ],
      get: {
        summary: "列出执行器",
        description: "返回全部执行器",
        "x-i18n-en": {
          summary: "List executors",
          description: "Return all executors",
        },
        parameters: [
          { name: "q", description: "关键字", "x-i18n-en": "Keyword" },
        ],
        requestBody: { description: "查询体", "x-i18n-en": "Query body" },
        responses: {
          "200": { description: "成功", "x-i18n-en": "OK" },
        },
      },
    },
  },
};

describe("API-I18N · Swagger UI 语言开关", () => {
  it("提取 schema 属性的中英对（裸字符串形态）", () => {
    const m = new Map(collectEntries(doc).map((e) => [e.zh, e.en]));
    expect(m.get("执行器 ID")).toBe("Executor ID");
    expect(m.get("执行器地址")).toBe("Executor address");
  });

  it("提取 operation 的 summary 与 description（对象形态，各自成对）", () => {
    const m = new Map(collectEntries(doc).map((e) => [e.zh, e.en]));
    expect(m.get("列出执行器")).toBe("List executors");
    expect(m.get("返回全部执行器")).toBe("Return all executors");
  });

  it("提取 param / requestBody / response（与注入脚本同一批位置）", () => {
    const m = new Map(collectEntries(doc).map((e) => [e.zh, e.en]));
    expect(m.get("页码")).toBe("Page number");
    expect(m.get("关键字")).toBe("Keyword");
    expect(m.get("查询体")).toBe("Query body");
    expect(m.get("成功")).toBe("OK");
  });

  it("同一中文文案只保留一条（文档里重复出现很常见）", () => {
    const dup = {
      components: {
        schemas: {
          A: {
            properties: { p: { description: "重复文案", "x-i18n-en": "Dup" } },
          },
          B: {
            properties: { q: { description: "重复文案", "x-i18n-en": "Dup" } },
          },
        },
      },
      paths: {},
    };
    expect(collectEntries(dup)).toHaveLength(1);
  });

  it("无 x-i18n-en 的节点不产生条目（不做中→中映射）", () => {
    const none = {
      components: {
        schemas: { A: { properties: { p: { description: "只有中文" } } } },
      },
      paths: {},
    };
    expect(collectEntries(none)).toHaveLength(0);
  });

  it("生成的脚本内嵌完整映射表，且**运行时**按长度降序排（防子串切碎）", () => {
    const entries = [
      { path: "a", zh: "短", en: "S" },
      { path: "b", zh: "很长的中文文案", en: "A much longer English text" },
    ];
    const js = buildSwaggerI18nScript(entries);
    expect(js).toContain("很长的中文文案");
    expect(js).toContain("A much longer English text");
    // 排序是**脚本内**的运行时行为（PAIRS.sort），不是注入时的顺序——
    // 故断言"脚本里有这条排序"，而不是断言 JSON 载荷的先后。
    expect(js).toContain("PAIRS.sort");
    expect(js).toMatch(/b\[0\]\.length\s*-\s*a\[0\]\.length/);
    // 且注入的载荷本身无害：两条都在（顺序由脚本自己保证）
    expect(JSON.parse(/(\[\[.*?\]\])/.exec(js)![1])).toHaveLength(2);
  });

  it("脚本跳过 CODE/PRE 节点（代码块是示例，不得被文案替换）", () => {
    const js = buildSwaggerI18nScript([{ path: "a", zh: "x", en: "y" }]);
    expect(js).toContain("'CODE'");
    expect(js).toContain("'PRE'");
  });

  it("脚本转义安全（文案含引号/反斜杠时不破坏注入）", () => {
    const js = buildSwaggerI18nScript([
      { path: "a", zh: '带"引号"的中文', en: 'with "quotes" and \\ backslash' },
    ]);
    // 生成的是合法 JS：能通过 Function 构造（不执行，只解析）
    expect(() => new Function(js)).not.toThrow();
  });

  it("空条目也生成合法脚本（不抛错）", () => {
    const js = buildSwaggerI18nScript([]);
    expect(() => new Function(js)).not.toThrow();
  });
});

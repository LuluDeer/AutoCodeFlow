/**
 * `llm-response` 单测：上游响应的三种畸形形状。
 *
 * 为什么钉得这么细：这些都是**真实 provider 会返回**的东西（不是假设），
 * 而每一个都会把 Agent 带进死路——缺 id 的下一步是 400，重复 id 的下一步是
 * 结果错位，parts 数组的下一步是 "[object Object]" 进会话历史。三者都在网关
 * 收口，所以断言写在这一层。
 */
import {
  MAX_TOOL_CALLS_PER_RESPONSE,
  isTruncatedFinish,
  normalizeAssistantContent,
  normalizeToolCalls,
} from "../llm-response";

describe("normalizeAssistantContent", () => {
  it("字符串原样（含空串）", () => {
    expect(normalizeAssistantContent("结论")).toBe("结论");
    expect(normalizeAssistantContent("")).toBe("");
  });

  it("parts 数组拼接 text 片段（部分 provider 纯文本也返回数组）", () => {
    expect(
      normalizeAssistantContent([
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("第一段第二段");
  });

  it("图片/视频片段不进文本（它们在多模态请求里已有自己的位置）", () => {
    expect(
      normalizeAssistantContent([
        { type: "image_url", image_url: { url: "https://x/y.png" } },
        { type: "text", text: "看图" },
      ]),
    ).toBe("看图");
  });

  it("对象/null/数字等异常形状 → 空串（绝不把 JSON 垃圾写进会话历史）", () => {
    expect(normalizeAssistantContent(null)).toBe("");
    expect(normalizeAssistantContent(undefined)).toBe("");
    expect(normalizeAssistantContent({ foo: "bar" })).toBe("");
    expect(normalizeAssistantContent(42)).toBe("");
    expect(normalizeAssistantContent([{ type: "text" }, null, 7])).toBe("");
  });
});

describe("normalizeToolCalls", () => {
  it("正常形状原样保留（不二次转义 arguments）", () => {
    const out = normalizeToolCalls([
      {
        id: "c1",
        type: "function",
        function: { name: "get_task", arguments: '{"id":"t-1"}' },
      },
    ]);
    expect(out).toEqual([
      {
        id: "c1",
        type: "function",
        function: { name: "get_task", arguments: '{"id":"t-1"}' },
      },
    ]);
  });

  it("缺 id → 生成确定性 id（可复盘、且下一步回传不会 undefined）", () => {
    const raw = [{ function: { name: "get_task", arguments: '{"a":1}' } }];
    const a = normalizeToolCalls(raw);
    const b = normalizeToolCalls(raw);
    expect(a?.[0].id).toMatch(/^call_1_[a-z0-9]+$/);
    // 同输入同输出：重放/replay 不会因为 id 漂移而对不上
    expect(a?.[0].id).toBe(b?.[0].id);
  });

  it("重复 id 加后缀而不是丢弃（两次调用都是模型的真实意图）", () => {
    const out = normalizeToolCalls([
      { id: "dup", function: { name: "get_task", arguments: "{}" } },
      { id: "dup", function: { name: "get_execution", arguments: "{}" } },
    ]);
    expect(out?.map((c) => c.id)).toEqual(["dup", "dup_2"]);
  });

  it("arguments 是对象 → 序列化为字符串（Agent 侧按字符串解析）", () => {
    const out = normalizeToolCalls([
      { id: "c1", function: { name: "get_task", arguments: { id: "t-1" } } },
    ]);
    expect(out?.[0].function.arguments).toBe('{"id":"t-1"}');
  });

  it("arguments 缺失 → 空对象字符串（边界校验按必填项报错，而不是 JSON 解析炸）", () => {
    const out = normalizeToolCalls([
      { id: "c1", function: { name: "list_tasks" } },
    ]);
    expect(out?.[0].function.arguments).toBe("{}");
  });

  it("没有函数名/形状不对的条目整条丢弃（不替模型编工具名）", () => {
    const out = normalizeToolCalls([
      { id: "c0", function: { arguments: "{}" } },
      { id: "c1", function: { name: "   " } },
      { id: "c2" },
      null,
      "nope",
      { id: "c3", function: { name: "list_tasks", arguments: "{}" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out?.[0].function.name).toBe("list_tasks");
  });

  it("空数组/非数组 → undefined（与既有 res.toolCalls ?? null 语义一致）", () => {
    expect(normalizeToolCalls([])).toBeUndefined();
    expect(normalizeToolCalls(undefined)).toBeUndefined();
    expect(normalizeToolCalls(null)).toBeUndefined();
    expect(normalizeToolCalls("garbage")).toBeUndefined();
  });

  it("超上限的批量被截断（防异常响应拖垮一轮循环）", () => {
    const raw = Array.from(
      { length: MAX_TOOL_CALLS_PER_RESPONSE + 5 },
      (_v, i) => ({
        id: `c${i}`,
        function: { name: "list_tasks", arguments: "{}" },
      }),
    );
    const out = normalizeToolCalls(raw);
    expect(out).toHaveLength(MAX_TOOL_CALLS_PER_RESPONSE);
  });

  it("id 全是空白字符 → 视为缺失", () => {
    const out = normalizeToolCalls([
      { id: "   ", function: { name: "list_tasks", arguments: "{}" } },
    ]);
    expect(out?.[0].id).toMatch(/^call_1_/);
  });
});

describe("isTruncatedFinish", () => {
  it("length 视为被 max_tokens 截断（含大小写变体）", () => {
    expect(isTruncatedFinish("length")).toBe(true);
    expect(isTruncatedFinish("LENGTH")).toBe(true);
  });

  it("stop/tool_calls/null → 不是截断", () => {
    expect(isTruncatedFinish("stop")).toBe(false);
    expect(isTruncatedFinish("tool_calls")).toBe(false);
    expect(isTruncatedFinish(undefined)).toBe(false);
    expect(isTruncatedFinish(123)).toBe(false);
  });
});

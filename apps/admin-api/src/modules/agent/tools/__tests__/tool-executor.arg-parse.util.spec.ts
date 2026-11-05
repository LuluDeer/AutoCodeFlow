/**
 * R67（ADR-031 步骤 4/5）：**入参归一/校验**模块的独立单测。
 *
 * 这段代码从 `tool-executor.service.ts` 整段搬出（原在 `execute` 内），
 * 本文件直接测它，不经过 `ToolExecutorService` —— 搬出的前提是「不依赖类的
 * 任何状态」，独立单测正是这个前提的可执行证据。
 *
 * 与 `tool-executor.service.spec.ts` 里既有的 `repairToolArguments` 用例**不重复**：
 * 那些仍从 service 的 re-export 取（钉住 import 面没变），这里钉的是
 * 归一函数本身的契约（含 `parseToolArguments` 这个新增出口）。
 */
import {
  parseToolArguments,
  previewEnvelope,
  repairToolArguments,
} from "../tool-executor.arg-parse.util";

describe("repairToolArguments（R67 搬出后的独立契约）", () => {
  it("空串 → {}（不是报错）", () => {
    expect(repairToolArguments("")).toEqual({ ok: true, value: {} });
  });

  it("剥离 Markdown 代码围栏", () => {
    expect(repairToolArguments('```json\n{"a":1}\n```').value).toEqual({
      a: 1,
    });
  });

  it("去除前后散文（截取首尾花括号之间）", () => {
    expect(
      repairToolArguments('好的，参数如下：{"taskId":"t-1"} 请查收').value,
    ).toEqual({ taskId: "t-1" });
  });

  it("去除尾逗号", () => {
    expect(repairToolArguments('{"a":1,}').value).toEqual({ a: 1 });
  });

  it("缺值的畸形 JSON **绝不猜**：如实返回 ok:false 且 reason 写明尝试过的修复", () => {
    const out = repairToolArguments('{"timeout":}');
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("仍无法解析");
  });
});

describe("parseToolArguments（归一出口）", () => {
  it("合法 JSON 对象 → args 为归一后的对象，message 为 null", () => {
    expect(parseToolArguments('{"taskId":"t-1"}')).toEqual({
      ok: true,
      args: { taskId: "t-1" },
      message: null,
    });
  });

  it("标量 JSON → args 为 null；数组 → 原样透传（**搬出前就是如此**，bug-compatible）", () => {
    // 口径来源：搬出前的 `parsedArgs && typeof parsedArgs === "object"` ——数组也是
    // object ⇒ 会被当成 args 传下去。R67 的要求是零行为变更，故这里**钉住现状**
    // 而不是顺手修它（修它会改变 `boundary.check` 收到的 args 形状）。
    expect(parseToolArguments("42").args).toBeNull();
    expect(parseToolArguments('[1,2]').args).toEqual([1, 2]);
  });

  it("修不了的畸形 JSON → ok:false，message 带修复摘要 + 原文前 200 字符", () => {
    const raw = '{"timeout":}';
    const out = parseToolArguments(raw);
    expect(out.ok).toBe(false);
    expect(out.args).toBeNull();
    expect(out.message).toContain("工具参数不是合法 JSON");
    expect(out.message).toContain(raw);
  });

  it("超长原文只截前 200 字符（不把整段载荷写进错误文案）", () => {
    const raw = "{" + "x".repeat(500) + ":}";
    const out = parseToolArguments(raw);
    expect(out.ok).toBe(false);
    expect(out.message?.length ?? 0).toBeLessThan(raw.length);
  });
});

describe("previewEnvelope（搬出后仍被 service 的 buildArgsPreview 复用）", () => {
  it("未截断：信封不含 omittedBytes", () => {
    expect(JSON.parse(previewEnvelope('{"a":1}', false, 0))).toEqual({
      truncated: false,
      args: '{"a":1}',
    });
  });

  it("截断：信封带 omittedBytes 且 args 是转义后的字符串", () => {
    const env = JSON.parse(previewEnvelope('{"a":1}', true, 42));
    expect(env.truncated).toBe(true);
    expect(env.omittedBytes).toBe(42);
    expect(env.args).toBe('{"a":1}');
  });
});

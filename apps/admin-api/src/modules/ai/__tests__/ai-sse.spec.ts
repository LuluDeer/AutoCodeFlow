/**
 * SSE 分帧单测（流式会话的前置）。
 *
 * 这类 bug 只在**慢网络/分片恰好切断帧**时出现（真机跑一百次未必撞上一次），
 * 所以必须用纯函数把它钉住：半帧要留在缓冲里、下一块补齐后能接上、
 * `\r\n` 与 `\n` 混用不能丢帧、心跳注释行不能当数据。
 */
import { parseSseFrames, parseStreamDelta } from "../ai-sse";

describe("parseSseFrames", () => {
  it("完整帧：切出来，rest 为空", () => {
    const { frames, rest } = parseSseFrames(
      'data: {"a":1}\n\ndata: {"b":2}\n\n',
    );
    expect(frames.map((f) => f.data)).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe("");
  });

  it("半帧留在 rest：下一块补齐后能接上（分片恰好切在 JSON 中间）", () => {
    const first = parseSseFrames('data: {"choices":[{"delta":{"con');
    expect(first.frames).toHaveLength(0);
    expect(first.rest).toContain('{"choices"');

    const second = parseSseFrames(first.rest + 'tent":"你"}}]}\n\n');
    expect(second.frames[0].data).toBe(
      '{"choices":[{"delta":{"content":"你"}}]}',
    );
  });

  it("\r\n 换行与 \n 混用都不丢帧", () => {
    const { frames } = parseSseFrames("data: a\r\n\r\ndata: b\n\n");
    expect(frames.map((f) => f.data)).toEqual(["a", "b"]);
  });

  it("心跳注释行（: 开头）被忽略（反代保活用，不是数据）", () => {
    const { frames } = parseSseFrames(": ping\n\ndata: x\n\n: keepalive\n\n");
    expect(frames.map((f) => f.data)).toEqual(["x"]);
  });

  it("具名事件保留 event 字段；多行 data 按规范拼接", () => {
    const { frames } = parseSseFrames(
      'event: delta\ndata: {"text":\ndata: "你"}\n\n',
    );
    expect(frames[0]).toEqual({ event: "delta", data: '{"text":\n"你"}' });
  });
});

describe("parseStreamDelta", () => {
  it("[DONE] → 结束标记", () => {
    expect(parseStreamDelta("[DONE]")).toEqual({ text: "", done: true });
  });

  it("正文增量", () => {
    expect(
      parseStreamDelta('{"choices":[{"delta":{"content":"你好"}}]}'),
    ).toMatchObject({ text: "你好" });
  });

  it("空 delta / 心跳帧 → 无文本、不报错", () => {
    expect(parseStreamDelta('{"choices":[{"delta":{}}]}')?.text).toBe("");
    expect(parseStreamDelta('{"choices":[]}')?.text).toBe("");
  });

  it("usage 只在末帧出现时解析（含 cached_tokens）", () => {
    const d = parseStreamDelta(
      '{"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":100}}}',
    );
    expect(d?.usage).toEqual({
      tokensIn: 120,
      tokensOut: 8,
      cachedTokens: 100,
    });
  });

  it("finish_reason 视为结束（部分 provider 不发 [DONE]）", () => {
    expect(
      parseStreamDelta('{"choices":[{"delta":{},"finish_reason":"stop"}]}')
        ?.done,
    ).toBe(true);
  });

  it("畸形 JSON → null（忽略该帧，不中断整条流）", () => {
    expect(parseStreamDelta("{not json")).toBeNull();
    expect(parseStreamDelta("")).toBeNull();
  });

  it("流内错误帧 → 抛出（如实报错，而不是当成没说话）", () => {
    expect(() =>
      parseStreamDelta('{"error":{"message":"rate limited"}}'),
    ).toThrow(/rate limited/);
  });
});

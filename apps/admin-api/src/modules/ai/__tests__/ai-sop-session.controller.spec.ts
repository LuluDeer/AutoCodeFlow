/**
 * 流式端点（SSE）的控制器级断言。
 *
 * 这一层最容易"看起来能跑、实际坑人"的三件事：
 *  ① 帧序：先 `delta` 后 `done`（反了前端会先渲染再丢字）；
 *  ② 失败时机：**一个 delta 都没发**时可以安全退回同步路径（provider 不支
 *     持 stream 就直接 400）；已经发过字就不能重试（会造成内容重复）；
 *  ③ 错误帧：响应头已发出，抛异常只会让客户端看到断流，必须写成 `error` 帧。
 */
import { AiSopSessionController } from "../ai-sop-session.controller";

function fakeRes() {
  const res = {
    headers: {} as Record<string, string>,
    frames: [] as Array<{ event: string; data: string }>,
    ended: false,
    setHeader: jest.fn((k: string, v: string) => {
      res.headers[k] = v;
      return res;
    }),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      const m = /^event: (\w+)\ndata: (.*)\n\n$/s.exec(chunk);
      if (m) res.frames.push({ event: m[1], data: m[2] });
      return true;
    }),
    end: jest.fn(() => {
      res.ended = true;
      return res;
    }),
  };
  return res;
}

const view = {
  id: "s-1",
  status: "drafted",
  messages: [],
  media: [],
  draft: null,
};

function harness(
  turnImpl: (
    id: string,
    input: unknown,
    onDelta?: (t: string) => void,
  ) => Promise<unknown>,
) {
  const sessions = { turn: jest.fn(turnImpl) };
  return { ctl: new AiSopSessionController(sessions as never), sessions };
}

afterEach(() => jest.clearAllMocks());

describe("turnStream —— SSE 帧序与失败时机", () => {
  it("正常：delta 先到、done 收尾，且响应头是 SSE", async () => {
    const h = harness(async (_id, _input, onDelta) => {
      onDelta?.("你");
      onDelta?.("好");
      return view;
    });
    const res = fakeRes();

    await h.ctl.turnStream("s-1", { text: "继续" }, res as never);

    expect(res.headers["Content-Type"]).toContain("text/event-stream");
    // nginx 缓冲会让逐字效果消失
    expect(res.headers["X-Accel-Buffering"]).toBe("no");
    expect(res.frames.map((f) => f.event)).toEqual(["delta", "delta", "done"]);
    expect(JSON.parse(res.frames[2].data)).toEqual(view);
    expect(res.ended).toBe(true);
  });

  it("一个 delta 都没发就失败 → 退回同步路径（provider 可能不支持 stream）", async () => {
    let call = 0;
    const h = harness(async (_id, _input, onDelta) => {
      call += 1;
      if (call === 1) throw new Error("stream not supported (400)");
      onDelta?.("");
      return view;
    });
    const res = fakeRes();

    await h.ctl.turnStream("s-1", { text: "继续" }, res as never);

    expect(h.sessions.turn).toHaveBeenCalledTimes(2);
    // 第二次调用不带 onDelta（同步语义）
    expect((h.sessions.turn as jest.Mock).mock.calls[1][2]).toBeUndefined();
    expect(res.frames.map((f) => f.event)).toEqual(["done"]);
    expect(res.frames.some((f) => f.event === "error")).toBe(false);
  });

  it("已经发过字再失败 → 只发 error 帧（不重试，避免内容重复）", async () => {
    const h = harness(async (_id, _input, onDelta) => {
      onDelta?.("半截");
      throw new Error("upstream reset");
    });
    const res = fakeRes();

    await h.ctl.turnStream("s-1", { text: "继续" }, res as never);

    expect(h.sessions.turn).toHaveBeenCalledTimes(1);
    expect(res.frames.map((f) => f.event)).toEqual(["delta", "error"]);
    expect(JSON.parse(res.frames[1].data)).toMatchObject({
      message: expect.stringContaining("upstream reset"),
    });
    expect(res.ended).toBe(true);
  });

  it("同步兜底也失败 → error 帧（不抛：响应头已发出）", async () => {
    const h = harness(async () => {
      throw new Error("boom");
    });
    const res = fakeRes();

    await expect(
      h.ctl.turnStream("s-1", { text: "x" }, res as never),
    ).resolves.toBeUndefined();
    expect(res.frames.map((f) => f.event)).toEqual(["error"]);
    expect(res.ended).toBe(true);
  });
});

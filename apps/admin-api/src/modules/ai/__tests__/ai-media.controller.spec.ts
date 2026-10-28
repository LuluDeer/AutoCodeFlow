/**
 * 公开下载端点（视频直链）的控制器级断言。
 *
 * 这是**唯一一条 @Public 的 AI 读面**：授权全靠 URL 签名，所以状态码语义就是
 * 安全边界——签错 403、过期 410、文件不符 403、不存在 404、越界 416。
 * 另外钉住 `Range/206` 与 `Content-Range`（视频 fetcher 会先探测再分段拉，
 * 不支持时有的实现会整段下载并超时）。
 */
import { AiMediaController } from "../ai-media.controller";
import { buildSignedMediaUrl } from "../ai-media-url";

const SECRET = "0123456789abcdef0123456789abcdef";

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    written: [] as string[],
    // Node/Express 的 setHeader 返回 this（可链式），替身必须同语义，
    // 否则 `res.status(416).setHeader(...).end()` 会在替身上断链
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
      return res;
    }),
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    end: jest.fn(() => res),
    write: jest.fn((chunk: string) => {
      res.written.push(chunk);
      return true;
    }),
    headers,
  };
  return res;
}

function fakeStream() {
  const handlers: Record<string, () => void> = {};
  return {
    pipe: jest.fn(),
    on: jest.fn((event: string, cb: () => void) => {
      handlers[event] = cb;
    }),
    handlers,
  };
}

function harness(opts: { withRow?: boolean; sizeBytes?: number } = {}) {
  const size = opts.sizeBytes ?? 1000;
  const row = {
    id: "m-1",
    name: "demo.mp4",
    mime: "video/mp4",
    sizeBytes: size,
    storedPath: "x/demo.mp4",
  };
  const stream = fakeStream();
  const media = {
    requireById: jest.fn(async () => {
      if (opts.withRow === false) throw new Error("视频不存在或已被清理");
      return row;
    }),
    openStream: jest.fn(() => ({
      stream,
      start: 0,
      end: size - 1,
      size,
    })),
  };
  const ai = { signingSecret: jest.fn(async () => SECRET) };
  const ctl = new AiMediaController(media as never, ai as never);
  return { ctl, media, ai, stream };
}

function signedUrl(mediaId = "m-1", fileName = "demo.mp4") {
  const res = buildSignedMediaUrl(
    { mediaId, fileName },
    { secret: SECRET, baseUrl: "https://acf.example.com" },
  );
  if (res.status !== "ok") throw new Error("fixture must sign");
  return new URL(res.url);
}

afterEach(() => jest.clearAllMocks());

describe("download —— 签名与状态码", () => {
  it("签名有效 + Range → 206 且带 Content-Range/Content-Length", async () => {
    const h = harness();
    const url = signedUrl();
    const res = fakeRes();

    await h.ctl.download(
      "m-1",
      "demo.mp4",
      url.searchParams.get("exp")!,
      url.searchParams.get("sig")!,
      { headers: { range: "bytes=0-99" } } as never,
      res as never,
    );

    expect(res.statusCode).toBe(206);
    expect(res.headers["Content-Range"]).toBe("bytes 0-999/1000");
    expect(res.headers["Content-Type"]).toBe("video/mp4");
    expect(res.headers["Accept-Ranges"]).toBe("bytes");
    expect(h.stream.pipe).toHaveBeenCalledWith(res);
  });

  it("无 Range → 200 + 完整长度（不误发 206）", async () => {
    const h = harness();
    const url = signedUrl();
    const res = fakeRes();

    await h.ctl.download(
      "m-1",
      "demo.mp4",
      url.searchParams.get("exp")!,
      url.searchParams.get("sig")!,
      { headers: {} } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Length"]).toBe("1000");
    expect(res.headers["Content-Range"]).toBeUndefined();
  });

  it("签名不符 → 403，且不打开文件", async () => {
    const h = harness();
    const url = signedUrl();
    const res = fakeRes();

    await h.ctl.download(
      "m-1",
      "demo.mp4",
      url.searchParams.get("exp")!,
      "tampered",
      { headers: {} } as never,
      res as never,
    );

    expect(res.statusCode).toBe(403);
    expect(h.media.openStream).not.toHaveBeenCalled();
  });

  it("换文件名（签名覆盖了它）→ 403", async () => {
    const h = harness();
    const url = signedUrl();
    const res = fakeRes();

    await h.ctl.download(
      "m-1",
      "other.mp4",
      url.searchParams.get("exp")!,
      url.searchParams.get("sig")!,
      { headers: {} } as never,
      res as never,
    );
    expect(res.statusCode).toBe(403);
  });

  it("文件不存在 → 404", async () => {
    const h = harness({ withRow: false });
    const url = signedUrl();
    const res = fakeRes();

    await h.ctl.download(
      "m-1",
      "demo.mp4",
      url.searchParams.get("exp")!,
      url.searchParams.get("sig")!,
      { headers: {} } as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
  });

  it("Range 越界 → 416 且带 Content-Range: bytes */size", async () => {
    const h = harness();
    const url = signedUrl();
    const res = fakeRes();

    await h.ctl.download(
      "m-1",
      "demo.mp4",
      url.searchParams.get("exp")!,
      url.searchParams.get("sig")!,
      { headers: { range: "bytes=5000-6000" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(416);
    expect(res.headers["Content-Range"]).toBe("bytes */1000");
    expect(h.media.openStream).not.toHaveBeenCalled();
  });

  it("没配密钥（fail-closed）→ 403，绝不放行", async () => {
    const h = harness();
    h.ai.signingSecret.mockResolvedValueOnce("");
    const url = signedUrl();
    const res = fakeRes();

    await h.ctl.download(
      "m-1",
      "demo.mp4",
      url.searchParams.get("exp")!,
      url.searchParams.get("sig")!,
      { headers: {} } as never,
      res as never,
    );
    expect(res.statusCode).toBe(403);
  });
});

describe("upload —— 参数缺失", () => {
  it("没上传文件 → 400 语义（不落空文件）", async () => {
    const h = harness();
    await expect(h.ctl.upload(undefined, { id: 1 })).rejects.toThrow(/为空/);
  });
});

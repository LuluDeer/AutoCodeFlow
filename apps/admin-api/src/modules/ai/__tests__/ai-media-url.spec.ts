/**
 * `ai-media-url` 单测：视频直链的签发与校验。
 *
 * 为什么钉得这么细：这条 URL 是**能力凭证**（有效期内谁拿到谁能取那段视频），
 * 而它的三种失效方式都不报错——过期被拒（用户侧只看到"生成失败"）、换文件名
 * 取别的文件（越权）、签名比较走非常量时间（侧信道）。全部在纯函数层钉死。
 */
import {
  DEFAULT_MEDIA_URL_TTL_MS,
  MIN_SECRET_LENGTH,
  buildSignedMediaUrl,
  mimeForFileName,
  safeMediaFileName,
  verifySignedMediaUrl,
  videoExtension,
} from "../ai-media-url";

const CFG = {
  secret: "0123456789abcdef0123456789abcdef",
  baseUrl: "https://acf.example.com/",
  ttlMs: 60 * 60 * 1000,
};
const NOW = 1_700_000_000_000;

describe("safeMediaFileName / videoExtension / mime", () => {
  it("只允许安全字符，且不得以点开头（防穿越/隐藏文件）", () => {
    expect(safeMediaFileName("demo.mp4")).toBe("demo.mp4");
    expect(safeMediaFileName("Demo_1-final.webm")).toBe("Demo_1-final.webm");
    for (const bad of [
      "../etc/passwd",
      ".hidden.mp4",
      "a b.mp4",
      "a/b.mp4",
      "",
      "x".repeat(200),
    ]) {
      expect(safeMediaFileName(bad)).toBeNull();
    }
  });

  it("扩展名白名单（其余一律不签，宁可不支持也不发错类型）", () => {
    expect(videoExtension("a.mp4")).toBe("mp4");
    expect(videoExtension("A.MOV")).toBe("mov");
    expect(videoExtension("a.txt")).toBeNull();
    expect(videoExtension("noext")).toBeNull();
  });

  it("MIME 来自扩展名（下载端点据此设 Content-Type）", () => {
    expect(mimeForFileName("a.mp4")).toBe("video/mp4");
    expect(mimeForFileName("a.webm")).toBe("video/webm");
    expect(mimeForFileName("a.mov")).toBe("video/quicktime");
    expect(mimeForFileName("a.txt")).toBe("application/octet-stream");
  });
});

describe("buildSignedMediaUrl", () => {
  it("路径以真实扩展名结尾 + query 带 exp/sig（fetcher 按扩展名判类型）", () => {
    const res = buildSignedMediaUrl(
      { mediaId: "m-1", fileName: "demo.mp4", now: NOW },
      CFG,
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.url).toMatch(
      /^https:\/\/acf\.example\.com\/api\/ai\/media\/m-1\/demo\.mp4\?exp=\d+&sig=[A-Za-z0-9_-]+$/,
    );
    expect(res.expEpochSec).toBe(Math.floor((NOW + CFG.ttlMs) / 1000));
  });

  it("baseUrl 末尾斜杠归一（不产生双斜杠）", () => {
    const res = buildSignedMediaUrl(
      { mediaId: "m", fileName: "a.mp4", now: NOW },
      { ...CFG, baseUrl: "https://x.test///" },
    );
    if (res.status === "ok") {
      expect(res.url.startsWith("https://x.test/api/ai/media/")).toBe(true);
    }
  });

  it("TTL 默认 60 分钟（排队 + 下载都算在内，不是越短越好）", () => {
    const res = buildSignedMediaUrl(
      { mediaId: "m", fileName: "a.mp4", now: NOW },
      { secret: CFG.secret, baseUrl: CFG.baseUrl },
    );
    if (res.status === "ok") {
      expect(res.expEpochSec).toBe(
        Math.floor((NOW + DEFAULT_MEDIA_URL_TTL_MS) / 1000),
      );
    }
  });

  it("没配密钥/密钥过短 → fail-closed（绝不发一条无效链接）", () => {
    for (const secret of ["", "short", "x".repeat(MIN_SECRET_LENGTH - 1)]) {
      const res = buildSignedMediaUrl(
        { mediaId: "m", fileName: "a.mp4", now: NOW },
        { ...CFG, secret },
      );
      expect(res.status).toBe("error");
      if (res.status === "error") expect(res.reason).toBe("no_secret");
    }
  });

  it("base 不是 http(s) → 拒绝签发（内网 localhost 链接模型取不到）", () => {
    for (const baseUrl of ["", "ftp://x", "127.0.0.1:8080"]) {
      const res = buildSignedMediaUrl(
        { mediaId: "m", fileName: "a.mp4", now: NOW },
        { ...CFG, baseUrl },
      );
      expect(res.status).toBe("error");
      if (res.status === "error") expect(res.reason).toBe("no_base_url");
    }
  });

  it("文件名/扩展名非法 → 拒绝签发（而不是签一条取不到或类型错的链接）", () => {
    const bad = buildSignedMediaUrl(
      { mediaId: "m", fileName: "../x.mp4", now: NOW },
      CFG,
    );
    expect(bad.status === "error" && bad.reason).toBe("bad_file_name");

    const txt = buildSignedMediaUrl(
      { mediaId: "m", fileName: "notes.txt", now: NOW },
      CFG,
    );
    expect(txt.status === "error" && txt.reason).toBe("bad_extension");
  });

  it("同一输入同一条 URL（幂等，便于日志比对与重试）", () => {
    const a = buildSignedMediaUrl(
      { mediaId: "m", fileName: "a.mp4", now: NOW },
      CFG,
    );
    const b = buildSignedMediaUrl(
      { mediaId: "m", fileName: "a.mp4", now: NOW },
      CFG,
    );
    expect(a).toEqual(b);
  });
});

describe("verifySignedMediaUrl", () => {
  const signed = (() => {
    const res = buildSignedMediaUrl(
      { mediaId: "m-1", fileName: "demo.mp4", now: NOW },
      CFG,
    );
    if (res.status !== "ok") throw new Error("fixture must sign");
    const u = new URL(res.url);
    return {
      mediaId: "m-1",
      fileName: "demo.mp4",
      exp: u.searchParams.get("exp")!,
      sig: u.searchParams.get("sig")!,
      expEpochSec: res.expEpochSec,
    };
  })();

  it("有效签名 + 未过期 → ok", () => {
    expect(
      verifySignedMediaUrl({ ...signed, now: NOW + 1000 }, CFG).status,
    ).toBe("ok");
  });

  it("过期 → expired（这是能力型 URL 的自然收敛）", () => {
    const res = verifySignedMediaUrl(
      { ...signed, now: (signed.expEpochSec + 1) * 1000 },
      CFG,
    );
    expect(res.status === "error" && res.reason).toBe("expired");
  });

  it("换文件名/换 mediaId 都验不过（签名覆盖两者，防越权取别的文件）", () => {
    const renamed = verifySignedMediaUrl(
      { ...signed, fileName: "other.mp4", now: NOW },
      CFG,
    );
    expect(renamed.status === "error" && renamed.reason).toBe("bad_signature");

    const otherId = verifySignedMediaUrl(
      { ...signed, mediaId: "m-2", now: NOW },
      CFG,
    );
    expect(otherId.status === "error" && otherId.reason).toBe("bad_signature");
  });

  it("换密钥 → bad_signature（部署换密钥后旧链接立刻失效）", () => {
    const res = verifySignedMediaUrl(
      { ...signed, now: NOW },
      { secret: "ffffffffffffffffffffffffffffffff" },
    );
    expect(res.status === "error" && res.reason).toBe("bad_signature");
  });

  it("参数缺失/exp 非数字 → malformed（不猜）", () => {
    for (const exp of ["", "abc", "1e5", "-1"]) {
      const res = verifySignedMediaUrl({ ...signed, exp, now: NOW }, CFG);
      expect(res.status === "error" && res.reason).toBe("malformed");
    }
  });

  it("空签名/非法文件名 → malformed", () => {
    expect(
      verifySignedMediaUrl({ ...signed, sig: "", now: NOW }, CFG).status,
    ).toBe("error");
    expect(
      verifySignedMediaUrl({ ...signed, fileName: "../x.mp4", now: NOW }, CFG)
        .status,
    ).toBe("error");
  });

  it("没配密钥 → no_secret（fail-closed，绝不放行）", () => {
    const res = verifySignedMediaUrl({ ...signed, now: NOW }, { secret: "" });
    expect(res.status === "error" && res.reason).toBe("no_secret");
  });
});

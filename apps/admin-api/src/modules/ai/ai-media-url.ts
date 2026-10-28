/**
 * 推理质量轮（2026-10-28）：**视频直链的短时签名 URL**。
 *
 * ## 为什么必须签名 + 为什么签名后模型照样能用
 * 视频理解（转 SOP）要把一段视频交给 provider——模型侧只会做一次普通
 * `HTTP GET`（预签名直链就是这么被普遍使用的），所以**签名放在 query 里对
 * 模型完全透明**：它带着 query 去取，我们验签后吐字节。用 JWT 就不行——
 * provider 没有也不该有平台凭据，JWT 守卫会把它 401 掉。
 *
 * 但"直链"能不能被消费，取决于**URL 形状**，这与签名无关却最容易踩：
 *   ① **路径必须以真实扩展名结尾**（`/media/<id>/demo.mp4`）。不少 fetcher
 *      先按扩展名判类型，`/media/abc?sig=…`（无扩展名）会被当未知类型拒掉。
 *   ② **Content-Type / Content-Length 必须来自落库元数据**（端点职责，见
 *      `ai-media.controller`），不能靠嗅探。
 *   ③ **HEAD 与 Range(206) 要支持**：视频 fetcher 常先探测再分段拉；不支持
 *      分段时有的实现会整段下载并超时。
 *   ④ **宿主必须对 provider 可达**：内网中台模型打不到——这是 `ai.mediaBaseUrl`
 *      存在的理由（公网反代 / CDN / OSS）。
 *   ⑤ **不要 302**：跳转后部分 fetcher 会丢掉 query（签名）而被 401。
 *   ⑥ **TTL 要够长**：生成任务会排队，排队 + 下载可能十几分钟。默认 60 分钟，
 *      不是"越短越安全就等于越好"——过期失败对用户是纯损失。
 *
 * ## 签什么、防什么
 * 签名 = `HMAC-SHA256(secret, mediaId + "\n" + exp + "\n" + fileName)`。
 *   · 覆盖 fileName：防止换路径取到同 id 的其它文件；
 *   · 覆盖 exp：过期即失效（能力型 URL 的自然收敛）；
 *   · 常量时间比较：不给计时侧信道留口子；
 *   · secret 缺失 → **fail-closed**（签不出就明确拒绝，绝不发一条无效链接）。
 *
 * 泄漏面如实说明：这条 URL 是**针对单个文件的 bearer 能力**，有效期内谁拿到
 * 谁就能取那段视频；不泄漏的是「其它媒体」「目录列表」「写权限」。故 TTL
 * 按"够用即止"取舍，并在签发时记日志（谁、哪个会话、哪个 mediaId）。
 *
 * 纯函数 + 注入时钟：签名/过期/畸形三种分支必须能在单测里被逐条钉住。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** 允许作为视频直链的扩展名（其余一律拒绝签发，宁可不支持也不发错类型）。 */
export const SIGNED_VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "m4v"] as const;

/** 扩展名 → MIME（下载端点据此设 Content-Type）。 */
export const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
};

/** 签名 URL 的默认有效期：60 分钟（排队 + 下载都算在内）。 */
export const DEFAULT_MEDIA_URL_TTL_MS = 60 * 60 * 1000;

/** secret 最短长度——短密钥的 HMAC 与不签差不多。 */
export const MIN_SECRET_LENGTH = 16;

export interface MediaSigningConfig {
  /** HMAC 密钥（env `AI_MEDIA_URL_SECRET`）。 */
  secret: string;
  /**
   * 对 provider 可达的 base（env `AI_MEDIA_BASE_URL`），例如
   * `https://acf.example.com` 或 CDN 域名。**不要**指向 127.0.0.1。
   */
  baseUrl: string;
  /** URL 有效期（毫秒）；默认 60 分钟。 */
  ttlMs?: number;
}

export type SignResult =
  | { status: "ok"; url: string; expEpochSec: number }
  | {
      status: "error";
      reason: "no_secret" | "no_base_url" | "bad_extension" | "bad_file_name";
      message: string;
    };

export type VerifyResult =
  | { status: "ok" }
  | {
      status: "error";
      reason: "malformed" | "expired" | "bad_signature" | "no_secret";
      message: string;
    };

/** 文件名安全化：只允许 `[A-Za-z0-9._-]`，且不得以 `.` 开头（防路径穿越/隐藏文件）。 */
export function safeMediaFileName(raw: string): string | null {
  const name = (raw ?? "").trim();
  if (name.length === 0 || name.length > 128) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (name.startsWith(".")) return null;
  return name;
}

/** 取扩展名（小写，不含点）；不在白名单里返回 null。 */
export function videoExtension(fileName: string): string | null {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0 || idx === fileName.length - 1) return null;
  const ext = fileName.slice(idx + 1).toLowerCase();
  return (SIGNED_VIDEO_EXTENSIONS as readonly string[]).includes(ext)
    ? ext
    : null;
}

/** MIME（未知扩展名回落 `application/octet-stream`，端点据此也不该硬编码）。 */
export function mimeForFileName(fileName: string): string {
  const ext = videoExtension(fileName);
  return (ext && VIDEO_MIME_BY_EXT[ext]) || "application/octet-stream";
}

function sign(
  secret: string,
  mediaId: string,
  exp: string,
  fileName: string,
): string {
  return createHmac("sha256", secret)
    .update(`${mediaId}\n${exp}\n${fileName}`)
    .digest("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 签发一条直链。
 *
 * 失败一律**返回错误而不是抛**：调用方（视频转 SOP 端点）要把"没配密钥/
 * 没配公网 base"翻译成可读的用户提示，而不是一个 500。
 */
export function buildSignedMediaUrl(
  input: { mediaId: string; fileName: string; now?: number },
  cfg: MediaSigningConfig,
): SignResult {
  const secret = (cfg.secret ?? "").trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      status: "error",
      reason: "no_secret",
      message: `AI_MEDIA_URL_SECRET 未配置或过短（至少 ${MIN_SECRET_LENGTH} 字符）——视频直链无法签发`,
    };
  }
  const base = (cfg.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    return {
      status: "error",
      reason: "no_base_url",
      message:
        "AI_MEDIA_BASE_URL 未配置（必须是模型可达的 http(s) 地址）——视频直链无法签发",
    };
  }
  const fileName = safeMediaFileName(input.fileName);
  if (!fileName) {
    return {
      status: "error",
      reason: "bad_file_name",
      message: `媒体文件名不合法：${input.fileName}`,
    };
  }
  if (!videoExtension(fileName)) {
    return {
      status: "error",
      reason: "bad_extension",
      message: `不支持的视频扩展名：${fileName}（允许 ${SIGNED_VIDEO_EXTENSIONS.join(" / ")}）`,
    };
  }

  const now = input.now ?? Date.now();
  const ttl = Math.max(1_000, cfg.ttlMs ?? DEFAULT_MEDIA_URL_TTL_MS);
  const expEpochSec = Math.floor((now + ttl) / 1000);
  const exp = String(expEpochSec);
  const sig = sign(secret, input.mediaId, exp, fileName);

  // 路径带真实扩展名（fetcher 按扩展名判类型的现实，见头注 ①）
  const url =
    `${base}/api/ai/media/${encodeURIComponent(input.mediaId)}/${fileName}` +
    `?exp=${exp}&sig=${encodeURIComponent(sig)}`;
  return { status: "ok", url, expEpochSec };
}

/** 校验一条直链的签名与有效期（下载端点用）。 */
export function verifySignedMediaUrl(
  input: {
    mediaId: string;
    fileName: string;
    exp: string;
    sig: string;
    now?: number;
  },
  cfg: Pick<MediaSigningConfig, "secret">,
): VerifyResult {
  const secret = (cfg.secret ?? "").trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    return { status: "error", reason: "no_secret", message: "签名密钥未配置" };
  }
  const mediaId = (input.mediaId ?? "").trim();
  const fileName = safeMediaFileName(input.fileName ?? "");
  const expRaw = (input.exp ?? "").trim();
  const sig = (input.sig ?? "").trim();
  if (!mediaId || !fileName || !/^\d{1,12}$/.test(expRaw) || !sig) {
    return {
      status: "error",
      reason: "malformed",
      message: "直链参数不完整或格式非法",
    };
  }

  const expected = sign(secret, mediaId, expRaw, fileName);
  if (!constantTimeEqual(expected, sig)) {
    return { status: "error", reason: "bad_signature", message: "签名无效" };
  }

  const now = input.now ?? Date.now();
  if (Number(expRaw) * 1000 <= now) {
    return { status: "error", reason: "expired", message: "直链已过期" };
  }
  return { status: "ok" };
}

import { createHmac, timingSafeEqual } from "crypto";

/**
 * 入站 webhook HMAC-SHA256 签名校验的共享纯函数（FEAT-21）。
 *
 * 平台入站 webhook 的统一签名纪律——applications webhook 与 alerts webhook
 * 此前各自持有一份逐参数一致的实现，第三处（任务 webhook）出现前收敛于此：
 *   - 签名头 X-Hub-Signature-256 = `sha256=` + HMAC-SHA256(secret, `${timestamp}.${rawBody}`) hex
 *     （与 GitHub webhook 惯例一致；`${timestamp}` 用**请求头原值**——发送方按
 *     原值签名，这里不得做数值归一化，否则前导零/空格变体签不上）；
 *   - 时间头 X-AutoCodeFlow-Timestamp = 毫秒时间戳，超窗（默认 ±5min）拒绝防重放；
 *   - 比较必须常数时间（timingSafeEqual），长度不等先短路（避免 length leak）。
 *
 * 本函数**只判定不抛**：失败原因枚举返回，由调用方映射各自的 401 消息与
 * 日志文案——alerts 的 "Alert webhook authentication failed" 与 applications
 * 的反枚举统一消息保持逐字节不变。
 */

/** 平台 webhook 签名头（GitHub webhook 惯例）。 */
export const WEBHOOK_SIGNATURE_HEADER = "x-hub-signature-256";

/** 平台 webhook 时间戳头（毫秒）。 */
export const WEBHOOK_TIMESTAMP_HEADER = "x-autocodeflow-timestamp";

/** 默认时间窗 ±5 分钟（与 applications/alerts 先例逐参数一致）。 */
export const WEBHOOK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export interface WebhookSignatureInput {
  /** 原始请求体（main.ts express.json verify 全局挂载 req.rawBody）。 */
  rawBody?: Buffer;
  /** X-Hub-Signature-256 头原值。 */
  signature?: string;
  /** X-AutoCodeFlow-Timestamp 头原值（毫秒）。 */
  timestamp?: string;
}

export type WebhookSignatureFailure =
  | "missing_signature"
  | "missing_timestamp"
  | "stale_timestamp"
  | "no_raw_body"
  | "signature_mismatch";

/**
 * 签名通过返回 null；失败返回原因枚举（不区分失败细节地统一 401 是调用方
 * 的反枚举职责，这里只负责把可诊断性留给日志）。
 */
export function verifyWebhookSignature(
  input: WebhookSignatureInput,
  secret: string,
  opts?: { windowMs?: number; nowMs?: number },
): WebhookSignatureFailure | null {
  if (!input.signature) return "missing_signature";
  if (!input.timestamp) return "missing_timestamp";
  const timestampMs = Number(input.timestamp);
  const windowMs = opts?.windowMs ?? WEBHOOK_TIMESTAMP_WINDOW_MS;
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs((opts?.nowMs ?? Date.now()) - timestampMs) > windowMs
  ) {
    return "stale_timestamp";
  }
  if (!input.rawBody) return "no_raw_body";
  const expected =
    "sha256=" +
    createHmac("sha256", secret)
      .update(
        Buffer.concat([Buffer.from(`${input.timestamp}.`), input.rawBody]),
      )
      .digest("hex");
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(input.signature);
  const valid =
    expectedBuf.length === receivedBuf.length &&
    timingSafeEqual(expectedBuf, receivedBuf);
  return valid ? null : "signature_mismatch";
}

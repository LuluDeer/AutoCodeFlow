import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import {
  verifyWebhookSignature,
  WEBHOOK_TIMESTAMP_WINDOW_MS,
  type WebhookSignatureFailure,
} from "../../common/utils/webhook-hmac.util";
import { IM_PLATFORMS, type ImPlatform } from "./entities/im-identity.entity";

/**
 * N6：Gateway sender 验证 + 平台 user 绑定断言（纯函数，不读环境、不发请求）。
 *
 * 签名范式与 webhook-hmac.util 逐参数一致：HMAC-SHA256(secret, `${timestamp}.${rawBody}`)，
 * 时间窗默认 ±5min（`WEBHOOK_TIMESTAMP_WINDOW_MS`）防重放，常数时间比较。
 * 这里直接复用 `verifyWebhookSignature` 而不是另写一份，避免两条签名实现漂移。
 * 不同的只是入口形状：IM adapter 拿到的是 (platform, imSenderId) 而非 appName。
 */

export interface ImSenderVerificationInput {
  platform: string;
  imSenderId: string;
  /** X-Hub-Signature-256 头原值。 */
  signature?: string;
  /** X-AutoCodeFlow-Timestamp 头原值（毫秒）。 */
  timestamp?: string;
  /** 原始请求体（express.json verify 挂在 req.rawBody）。 */
  rawBody?: Buffer | string;
}

export type ImSenderFailure =
  | "invalid_platform"
  | "invalid_sender_id"
  | "missing_secret"
  | WebhookSignatureFailure;

/**
 * 判定结果。注意本仓 tsconfig 关闭了 strictNullChecks，布尔判别联合在此配置下
 * 无法稳定收窄，故用「ok + 可选 reason」的单一接口形态（调用方读 reason 不加
 * 类型守卫也不报错）。
 */
export interface ImSenderVerificationResult {
  ok: boolean;
  reason?: ImSenderFailure;
}

export const IM_SENDER_ID_MAX = 128;

function isImPlatform(value: unknown): value is ImPlatform {
  return (
    typeof value === "string" &&
    (IM_PLATFORMS as readonly string[]).includes(value)
  );
}

/**
 * 验签名（含时间窗防重放）。只判定不抛，失败原因枚举返回，由调用方映射 4xx。
 * `opts.nowMs` 供单测钉死「过期/replay」行为；生产走 Date.now()。
 */
export function verifyImSender(
  input: ImSenderVerificationInput,
  secret: string,
  opts?: { windowMs?: number; nowMs?: number },
): ImSenderVerificationResult {
  if (!isImPlatform(input?.platform))
    return { ok: false, reason: "invalid_platform" };
  const senderId = input?.imSenderId;
  if (
    typeof senderId !== "string" ||
    senderId.trim().length === 0 ||
    senderId.length > IM_SENDER_ID_MAX
  ) {
    return { ok: false, reason: "invalid_sender_id" };
  }
  if (typeof secret !== "string" || secret.length === 0) {
    return { ok: false, reason: "missing_secret" };
  }

  const rawBody =
    typeof input.rawBody === "string"
      ? Buffer.from(input.rawBody)
      : input.rawBody;
  const failure = verifyWebhookSignature(
    {
      rawBody,
      signature: input.signature,
      timestamp: input.timestamp,
    },
    secret,
    {
      windowMs: opts?.windowMs ?? WEBHOOK_TIMESTAMP_WINDOW_MS,
      ...(opts?.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    },
  );
  return failure ? { ok: false, reason: failure } : { ok: true };
}

/** 绑定关系的最小形状（与 ImIdentity 实体同字段语义）。 */
export interface ImIdentityBindingShape {
  verified: boolean;
  platformUserId: number | null | undefined;
}

/**
 * 「IM 身份 → 平台 user」落点：verified=false、未绑定 platformUserId、
 * 传入 user 与绑定不一致时一律 fail-closed（VALIDATION_FAILED）。
 *
 * 这是 N6 的核心安全断言：受控执行面认的是经过 Gateway sender 验证并绑定的
 * 平台 user，不是 IM 设备凭证，也不是群里自称的身份。
 */
export function assertPlatformUser(
  identity: ImIdentityBindingShape | null | undefined,
  user: { id: number } | null | undefined,
): void {
  const fail = (detail: string): never => {
    throw new AppError(ErrorCode.VALIDATION_FAILED, { detail });
  };
  if (!identity) fail("IM identity is not bound");
  if (identity.verified !== true) fail("IM sender is not verified");
  if (identity.platformUserId == null) fail("IM identity has no platform user");
  if (!user || !Number.isFinite(user.id)) fail("platform user is missing");
  if (user.id !== identity.platformUserId) {
    fail("platform user does not match the bound IM identity");
  }
}

/**
 * N6 · IM webhook adapter（纯判定 / 解析层）。
 *
 * 验签边界（避免两套验签）：本文件**不做 HMAC**。调用方必须先以
 * verifyWebhookSignature（common/utils/webhook-hmac.util.ts）对 rawBody +
 * 签名头 + 时间戳头完成校验，通过后才能调用下面的函数；challenge 回显同样
 * 只在验签通过后执行，绝不把 echostr / challenge 变成未验签的反射面。
 *
 * 本文件零 HTTP / 零 DB / 零加解密 I/O：只接普通对象，只返回普通值；
 * 同输入必同输出，不读环境、不发请求、不落库。
 */

import type { ImPlatform } from "./entities/im-identity.entity";

/** challenge 回显串上限（企微 echostr / 飞书 challenge 同口径，超限 fail-closed）。 */
export const IM_CHALLENGE_MAX = 256;
/** sender id 上限（与 sender-validator 的 IM_SENDER_ID_MAX 同口径）。 */
export const IM_ADAPTER_SENDER_ID_MAX = 128;
/** 提取文本上限（与 ImIntakeDto.message 的 MaxLength(500) 同口径）。 */
export const IM_ADAPTER_TEXT_MAX = 500;

/** Express req.query 的最小形状：值可能是重复参数数组或嵌套对象。 */
export type ImWebhookQuery = Record<string, unknown> | null | undefined;

/** 从平台 payload 提取出的最小可用消息形状（不回传原始 body）。 */
export interface ImWebhookMessage {
  platform: ImPlatform;
  senderId: string;
  text: string;
  chatId?: string;
  messageId?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(query: ImWebhookQuery, key: string): boolean {
  return (
    isPlainObject(query) && Object.prototype.hasOwnProperty.call(query, key)
  );
}

function ownValue(query: ImWebhookQuery, key: string): unknown {
  return isPlainObject(query)
    ? (query as Record<string, unknown>)[key]
    : undefined;
}

function nonEmptyString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.trim().length === 0) return null;
  if (value.length > max) return null;
  return value;
}

function optionalString(
  value: unknown,
  max = IM_ADAPTER_SENDER_ID_MAX,
): string | undefined {
  const result = nonEmptyString(value, max);
  return result === null ? undefined : result;
}

/**
 * 是否为平台首轮校验请求：查询串带企微 `echostr` 或飞书 `challenge`。
 *
 * 空串也算 challenge 请求（不能因值为空就分流到消息提取分支）；非字符串值
 * 与两平台键共存都视为畸形，判否，交给 buildChallengeResponse fail-closed。
 */
export function isChallengeRequest(query: ImWebhookQuery): boolean {
  const wecom = hasOwn(query, "echostr");
  const feishu = hasOwn(query, "challenge");
  if (wecom === feishu) return false;
  return typeof ownValue(query, wecom ? "echostr" : "challenge") === "string";
}

/**
 * 回显平台校验串。只回显、不验签（验签由调用方先做，见文件头）。
 * 缺失、非字符串、空/纯空白、超长（>IM_CHALLENGE_MAX）、双平台键共存 ⇒ null。
 */
export function buildChallengeResponse(query: ImWebhookQuery): string | null {
  const wecom = hasOwn(query, "echostr");
  const feishu = hasOwn(query, "challenge");
  if (wecom === feishu) return null;
  const value = ownValue(query, wecom ? "echostr" : "challenge");
  if (typeof value !== "string") return null;
  if (value.trim().length === 0) return null;
  if (value.length > IM_CHALLENGE_MAX) return null;
  return value;
}

/** 飞书 `event.message.content`：v1 为纯文本，v2 为 `{"text":"..."}` JSON 串。 */
function feishuText(raw: unknown): string | null {
  const rawText = nonEmptyString(raw, IM_ADAPTER_TEXT_MAX * 4);
  if (rawText === null) return null;
  let text = rawText;
  if (rawText.startsWith("{")) {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (isPlainObject(parsed)) {
        const inner = nonEmptyString(parsed.text, IM_ADAPTER_TEXT_MAX);
        if (inner !== null) text = inner;
      }
    } catch {
      // 非合法 JSON：按原文当纯文本处理（飞书 v1 形态）。
    }
  }
  return nonEmptyString(text, IM_ADAPTER_TEXT_MAX);
}

/** 飞书 senderId：优先 user_id，其次 open_id，最后 message.sender_id（v1）。 */
function feishuSenderId(
  event: Record<string, unknown>,
  message: Record<string, unknown>,
): string | null {
  const sender = isPlainObject(event.sender) ? event.sender : null;
  const ids =
    sender && isPlainObject(sender.sender_id) ? sender.sender_id : null;
  const candidates: unknown[] = [
    ids ? ids.user_id : undefined,
    ids ? ids.open_id : undefined,
    message.sender_id,
  ];
  for (const candidate of candidates) {
    const id = nonEmptyString(candidate, IM_ADAPTER_SENDER_ID_MAX);
    if (id !== null) return id;
  }
  return null;
}

/** 企微：只读 FromUserName / content，绝不读 event.message.content（飞书形态）。 */
function extractWecom(body: unknown): ImWebhookMessage | null {
  if (!isPlainObject(body)) return null;
  const senderId = nonEmptyString(body.FromUserName, IM_ADAPTER_SENDER_ID_MAX);
  const text = nonEmptyString(body.content, IM_ADAPTER_TEXT_MAX);
  if (senderId === null || text === null) return null;
  const message: ImWebhookMessage = {
    platform: "wecom",
    senderId,
    text,
  };
  const chatId = optionalString(body.ChatId);
  const messageId = optionalString(body.MsgId);
  if (chatId !== undefined) message.chatId = chatId;
  if (messageId !== undefined) message.messageId = messageId;
  return message;
}

/** 飞书：只读 event.message.content / event.sender.sender_id，绝不读企微字段。 */
function extractFeishu(body: unknown): ImWebhookMessage | null {
  if (!isPlainObject(body)) return null;
  if (!isPlainObject(body.event)) return null;
  const event = body.event;
  if (!isPlainObject(event.message)) return null;
  const message = event.message;
  const text = feishuText(message.content);
  if (text === null) return null;
  const senderId = feishuSenderId(event, message);
  if (senderId === null) return null;
  const result: ImWebhookMessage = {
    platform: "feishu",
    senderId,
    text,
  };
  const chatId = optionalString(message.chat_id);
  const messageId = optionalString(message.message_id);
  if (chatId !== undefined) result.chatId = chatId;
  if (messageId !== undefined) result.messageId = messageId;
  return result;
}

/**
 * 从平台 payload 提取 senderId + 文本。平台严格隔离：企微走 FromUserName /
 * content，飞书走 event.message.content / event.sender.sender_id；未知平台、
 * 字段缺失、类型错误、超长一律返回 null（fail-closed），不抛异常。
 */
export function extractImMessage(
  platform: string,
  body: unknown,
): ImWebhookMessage | null {
  if (platform === "wecom") return extractWecom(body);
  if (platform === "feishu") return extractFeishu(body);
  return null;
}

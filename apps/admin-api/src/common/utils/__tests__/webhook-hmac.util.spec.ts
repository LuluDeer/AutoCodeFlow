import { createHmac } from "crypto";
import {
  WEBHOOK_TIMESTAMP_WINDOW_MS,
  verifyWebhookSignature,
} from "../webhook-hmac.util";

/**
 * FEAT-21: 共享 webhook HMAC 校验纯函数 spec。
 *
 * 契约锚点：签名 = `sha256=` + HMAC-SHA256(secret, `${timestamp}.${rawBody}`)，
 * 其中 timestamp 用**请求头原值**（applications/alerts 先例的逐字节兼容性）。
 */

const SECRET = "shared-webhook-secret";
const NOW = 1_700_000_000_000;
const BODY = Buffer.from(JSON.stringify({ hello: "world" }));

function sign(timestamp: string, body: Buffer, secret = SECRET): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
      .digest("hex")
  );
}

describe("verifyWebhookSignature（FEAT-21）", () => {
  const goodInput = (ts: string = String(NOW)) => ({
    rawBody: BODY,
    signature: sign(ts, BODY),
    timestamp: ts,
  });

  it("合法签名 → null", () => {
    expect(
      verifyWebhookSignature(goodInput(), SECRET, { nowMs: NOW }),
    ).toBeNull();
  });

  it("时间头带空白变体时按**原值**参与 HMAC（不做数值归一化）", () => {
    const ts = ` ${NOW} `;
    // Number(" 170...") 去空白后仍在窗口内；发送方按原值签名。
    expect(
      verifyWebhookSignature(goodInput(ts), SECRET, { nowMs: NOW }),
    ).toBeNull();
  });

  it("缺签名头 → missing_signature", () => {
    const input = goodInput();
    delete (input as { signature?: string }).signature;
    expect(verifyWebhookSignature(input, SECRET, { nowMs: NOW })).toBe(
      "missing_signature",
    );
  });

  it("缺时间头 → missing_timestamp", () => {
    const input = goodInput();
    delete (input as { timestamp?: string }).timestamp;
    expect(verifyWebhookSignature(input, SECRET, { nowMs: NOW })).toBe(
      "missing_timestamp",
    );
  });

  it("时间窗边界：恰好 +window 通过，+window+1 拒绝（stale_timestamp）", () => {
    const atEdge = String(NOW + WEBHOOK_TIMESTAMP_WINDOW_MS);
    expect(
      verifyWebhookSignature(goodInput(atEdge), SECRET, { nowMs: NOW }),
    ).toBeNull();

    const pastEdge = String(NOW + WEBHOOK_TIMESTAMP_WINDOW_MS + 1);
    expect(
      verifyWebhookSignature(goodInput(pastEdge), SECRET, { nowMs: NOW }),
    ).toBe("stale_timestamp");
  });

  it("非数值时间戳 → stale_timestamp", () => {
    expect(
      verifyWebhookSignature(goodInput("not-a-number"), SECRET, {
        nowMs: NOW,
      }),
    ).toBe("stale_timestamp");
  });

  it("rawBody 缺失 → no_raw_body", () => {
    const input = goodInput();
    delete (input as { rawBody?: Buffer }).rawBody;
    expect(verifyWebhookSignature(input, SECRET, { nowMs: NOW })).toBe(
      "no_raw_body",
    );
  });

  it("错误 secret → signature_mismatch（不抛）", () => {
    expect(
      verifyWebhookSignature(goodInput(), "other-secret", { nowMs: NOW }),
    ).toBe("signature_mismatch");
  });

  it("body 被篡改（签名仍为原 body 计算）→ signature_mismatch", () => {
    const input = goodInput();
    const tampered = Buffer.concat([BODY, Buffer.from(" ")]);
    expect(
      verifyWebhookSignature({ ...input, rawBody: tampered }, SECRET, {
        nowMs: NOW,
      }),
    ).toBe("signature_mismatch");
  });

  it("长度不等的垃圾签名走长度短路 → signature_mismatch（无异常）", () => {
    expect(
      verifyWebhookSignature(
        { rawBody: BODY, signature: "sha256=short", timestamp: String(NOW) },
        SECRET,
        { nowMs: NOW },
      ),
    ).toBe("signature_mismatch");
  });
});

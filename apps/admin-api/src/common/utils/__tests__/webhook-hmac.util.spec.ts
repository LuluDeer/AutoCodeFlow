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

  /**
   * OBS-02 金向量：与 `scripts/alertmanager-hmac-proxy.selftest.mjs` 里的
   * GOLDEN_VECTORS **逐字节同源**（同一组 secret/timestamp/body → 同一签名字面量）。
   *
   * 为什么两边各钉一次：告警链路的两端不在同一进程/语言里——签名侧是
   * `scripts/alertmanager-hmac-proxy.mjs`（node:crypto createHmac），校验侧是
   * 本文件的 `verifyWebhookSignature`。任一侧改了分隔符/前缀/拼接顺序/编码口径，
   * 症状都是生产上的「Alertmanager 发出去了、admin-api 静默 401、告警再也到不了
   * 值班渠道」，而**两侧各自的单测都还是绿的**（各自以自己为基准）。同一组字面量
   * 两处钉死，单侧漂移必然让另一侧变红。
   *
   * 改这组向量前先读 `scripts/alertmanager-hmac-proxy.mjs` 头部「四个关键设计」，
   * 并同步改两个文件。
   */
  it("金向量：与 alertmanager-hmac-proxy 加签侧逐字节一致（跨进程契约）", () => {
    const vectors = [
      {
        secret: "alert-webhook-secret",
        timestamp: "1750000000000",
        body: '{"version":"4","status":"firing","alerts":[{"status":"firing","labels":{"alertname":"Demo"}}]}',
        signature:
          "sha256=b409e77207b58e207bf7f2fb37f58e75a335285e549d761a5341346771e07d9e",
      },
      {
        secret: "alert-webhook-secret",
        timestamp: "1750000000000",
        body: "",
        signature:
          "sha256=fb4c25fa1300363c0a8961171ee16c7d146593077fca90cbb4f2c3e5ee8831eb",
      },
      {
        secret: "测试密钥-多字节",
        timestamp: "1750000000123",
        body: '{"a":"告警","b":"emoji 🚨"}',
        signature:
          "sha256=bd93273b0fe26f3e04e020b5f748bdf4b6fedef19ff060eaad1ccfc6a27f6cf2",
      },
    ];
    for (const vector of vectors) {
      const rawBody = Buffer.from(vector.body, "utf8");
      // nowMs 取向量自身时间戳 → 断言只考验算法，不依赖运行时刻
      expect(
        verifyWebhookSignature(
          {
            rawBody,
            signature: vector.signature,
            timestamp: vector.timestamp,
          },
          vector.secret,
          { nowMs: Number(vector.timestamp) },
        ),
      ).toBeNull();
    }
  });

  it("金向量反证：body 或 timestamp 改一字节 → signature_mismatch（向量有齿）", () => {
    const rawBody = Buffer.from('{"a":1}', "utf8");
    const ts = "1750000000000";
    const signature =
      "sha256=" +
      createHmac("sha256", "alert-webhook-secret")
        .update(Buffer.concat([Buffer.from(`${ts}.`), rawBody]))
        .digest("hex");
    expect(
      verifyWebhookSignature(
        { rawBody, signature, timestamp: ts },
        "alert-webhook-secret",
        { nowMs: Number(ts) },
      ),
    ).toBeNull();
    // 同一签名配被改过的 body → 拒
    expect(
      verifyWebhookSignature(
        { rawBody: Buffer.from('{"a":2}', "utf8"), signature, timestamp: ts },
        "alert-webhook-secret",
        { nowMs: Number(ts) },
      ),
    ).toBe("signature_mismatch");
    // 同一签名配另一个 timestamp（头值参与 HMAC）→ 拒
    expect(
      verifyWebhookSignature(
        { rawBody, signature, timestamp: "1750000000001" },
        "alert-webhook-secret",
        { nowMs: Number(ts) + 1 },
      ),
    ).toBe("signature_mismatch");
  });
});

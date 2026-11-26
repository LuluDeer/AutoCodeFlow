/**
 * N6：sender 签名验证 + 平台 user 绑定断言的单测。
 *
 * 沿用仓内 jest.mock 框架边界风格：只替换 Nest/TypeORM/AppError/实体装饰器，
 * 让 verifyImSender 真实调用 webhook-hmac.util 的同一份 HMAC 实现。
 * 验收级别：单测 / 纯函数（不代表真实 Gateway 入站链）。
 */
jest.mock("typeorm", () => {
  const deco =
    () =>
    (..._args: unknown[]): void =>
      undefined;
  return {
    Column: deco,
    CreateDateColumn: deco,
    Entity: deco,
    Index: deco,
    PrimaryGeneratedColumn: deco,
    UpdateDateColumn: deco,
  };
});

jest.mock("../../../common/errors/app-error", () => ({
  AppError: class AppError extends Error {
    errorCode: string;
    params: unknown;
    constructor(code: string, params?: unknown) {
      super(code);
      this.errorCode = code;
      this.params = params;
    }
  },
}));

import { createHmac } from "crypto";
import { verifyImSender, assertPlatformUser } from "../sender-validator";

const SECRET = "im-signing-secret-0123456789abcdef";
const NOW = 1_800_000_000_000;
const RAW = Buffer.from('{"imSenderId":"zhangsan","text":"hello"}');

function sign(secret: string, timestamp: string, rawBody: Buffer): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
      .digest("hex")
  );
}

const validInput = () => {
  const timestamp = String(NOW);
  return {
    platform: "wecom",
    imSenderId: "zhangsan",
    timestamp,
    signature: sign(SECRET, timestamp, RAW),
    rawBody: RAW,
  };
};

function expectValidationFailed(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    expect((err as { errorCode?: string }).errorCode).toBe("VALIDATION_FAILED");
    return;
  }
  throw new Error("expected VALIDATION_FAILED to be thrown");
}

describe("verifyImSender", () => {
  it("签名正确 + 时间窗内 → ok", () => {
    expect(verifyImSender(validInput(), SECRET, { nowMs: NOW })).toEqual({
      ok: true,
    });
  });

  it("rawBody 为字符串时同构校验通过", () => {
    const input = validInput();
    expect(
      verifyImSender({ ...input, rawBody: RAW.toString("utf8") }, SECRET, {
        nowMs: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it("时间戳过期（>5min）→ stale_timestamp（重放拒绝）", () => {
    const input = validInput();
    expect(
      verifyImSender(input, SECRET, { nowMs: NOW + 6 * 60 * 1000 }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("自定义时间窗生效", () => {
    const input = validInput();
    expect(
      verifyImSender(input, SECRET, {
        nowMs: NOW + 10_000,
        windowMs: 1_000,
      }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("签名错误 → signature_mismatch", () => {
    const input = validInput();
    expect(
      verifyImSender({ ...input, signature: "sha256=deadbeef" }, SECRET, {
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("错密钥 → signature_mismatch", () => {
    expect(
      verifyImSender(validInput(), "wrong-secret", { nowMs: NOW }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("缺签名 / 缺时间戳 / 缺 body → 对应原因", () => {
    const input = validInput();
    expect(
      verifyImSender({ ...input, signature: undefined }, SECRET, {
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "missing_signature" });
    expect(
      verifyImSender({ ...input, timestamp: undefined }, SECRET, {
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "missing_timestamp" });
    expect(
      verifyImSender({ ...input, rawBody: undefined }, SECRET, { nowMs: NOW }),
    ).toEqual({ ok: false, reason: "no_raw_body" });
  });

  it("非法平台 / 空 sender / 空 secret → 入口即拒", () => {
    const input = validInput();
    expect(
      verifyImSender({ ...input, platform: "telegram" }, SECRET, {
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "invalid_platform" });
    expect(
      verifyImSender({ ...input, imSenderId: "  " }, SECRET, { nowMs: NOW }),
    ).toEqual({ ok: false, reason: "invalid_sender_id" });
    expect(verifyImSender(input, "", { nowMs: NOW })).toEqual({
      ok: false,
      reason: "missing_secret",
    });
  });
});

describe("assertPlatformUser", () => {
  const user = { id: 42 };

  it("verified=false → VALIDATION_FAILED", () => {
    expectValidationFailed(() =>
      assertPlatformUser({ verified: false, platformUserId: 42 }, user),
    );
  });

  it("未绑定 platformUserId → VALIDATION_FAILED", () => {
    expectValidationFailed(() =>
      assertPlatformUser({ verified: true, platformUserId: null }, user),
    );
  });

  it("绑定 user 与传入 user 不一致 → VALIDATION_FAILED", () => {
    expectValidationFailed(() =>
      assertPlatformUser({ verified: true, platformUserId: 7 }, user),
    );
  });

  it("identity 缺失 / user 缺失 → VALIDATION_FAILED", () => {
    expectValidationFailed(() => assertPlatformUser(null, user));
    expectValidationFailed(() =>
      assertPlatformUser({ verified: true, platformUserId: 42 }, null),
    );
  });

  it("verified=true 且绑定一致 → 放行", () => {
    expect(() =>
      assertPlatformUser({ verified: true, platformUserId: 42 }, user),
    ).not.toThrow();
  });
});

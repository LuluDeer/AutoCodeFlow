import { createHmac, randomBytes } from "crypto";

/**
 * SEC-03: 自实现 RFC 6238（TOTP）/ RFC 4226（HOTP）——零新依赖。
 *
 * 选用 HMAC-SHA1 + 6 位数字 + 30s 步长（RFC 6238 推荐 profile，与 Google
 * Authenticator / Microsoft Authenticator / 1Password 等主流验证器兼容）。
 * HMAC-SHA1 由 Node 内置 crypto 提供，无需引入 otplib（lockfile 零变更）。
 *
 * Base32 编解码按 RFC 4648 字母表实现（无 padding，标准 otpauth secret 形态）。
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32（RFC 4648，无 padding）编码。 */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Base32（RFC 4648）解码。非字母表字符（空格/横线/小写归一后仍非法）抛
 * Error——调用方在 enable/verify 路径必须 fail-closed，不静默吞错。
 */
export function base32Decode(input: string): Buffer {
  const normalized = input.replace(/[\s-]/g, "").toUpperCase();
  if (normalized.length === 0) throw new Error("empty base32 input");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of normalized) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 生成 160-bit（20 字节）随机 TOTP 密钥，Base32 编码返回。 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * RFC 4226 HOTP：动态截断（dynamic truncation）+ 6 位十进制化。
 * 纯函数，counter 由调用方给出——TOTP 与确定性测试都从这里走。
 */
export function hotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(msg).digest();
  // dynamic truncation：取最后一字节低 4 位为偏移
  const offset = digest[digest.length - 1] & 0x0f;
  const bin =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** TOTP 步长（RFC 6238 §5.2 推荐值 X=30s）。 */
export const TOTP_STEP_SECONDS = 30;
/** 允许的时钟漂移窗口（±1 步 = 前后各 30s）。 */
export const TOTP_WINDOW_STEPS = 1;

/**
 * RFC 6238 TOTP 校验：counter = floor(unixSeconds / 30)。
 * 允许 ±TOTP_WINDOW_STEPS 步漂移；任一窗口命中即通过，并返回命中的
 * counter（供后续重放防护扩展使用）。
 */
export function totpVerify(
  secretBase32: string,
  code: string,
  unixSeconds: number,
): { valid: boolean; matchedCounter?: number } {
  const normalized = (code ?? "").trim();
  if (!/^\d{6}$/.test(normalized)) return { valid: false };
  const counter = Math.floor(unixSeconds / TOTP_STEP_SECONDS);
  for (let drift = -TOTP_WINDOW_STEPS; drift <= TOTP_WINDOW_STEPS; drift++) {
    const candidate = hotp(secretBase32, counter + drift);
    if (candidate === normalized) {
      return { valid: true, matchedCounter: counter + drift };
    }
  }
  return { valid: false };
}

/** 当前时刻（±窗口）应该出现的一组有效码——仅用于确定性测试。 */
export function totpCodesAt(secretBase32: string, unixSeconds: number): string[] {
  const counter = Math.floor(unixSeconds / TOTP_STEP_SECONDS);
  const codes: string[] = [];
  for (let drift = -TOTP_WINDOW_STEPS; drift <= TOTP_WINDOW_STEPS; drift++) {
    codes.push(hotp(secretBase32, counter + drift));
  }
  return codes;
}

/**
 * 构造 otpauth:// URL（Key URI Format，Google Authenticator 兼容）。
 * label 与 issuer 均做 URL 编码。
 */
export function buildOtpauthUrl(
  secretBase32: string,
  issuer: string,
  account: string,
): string {
  const issuerEnc = encodeURIComponent(issuer);
  const label = `${issuerEnc}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

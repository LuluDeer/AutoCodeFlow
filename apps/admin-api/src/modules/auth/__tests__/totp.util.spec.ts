import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  hotp,
  totpVerify,
  totpCodesAt,
  buildOtpauthUrl,
  TOTP_STEP_SECONDS,
  TOTP_WINDOW_STEPS,
} from "../totp.util";

/**
 * SEC-03: TOTP util tests — RFC 6238 Appendix B reference vectors (SHA-1)
 * plus Base32 round-trips and deterministic clock-based verification.
 */

// RFC 6238 Appendix B secret ("12345678901234567890" ASCII) in Base32.
const RFC_SEED_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp.util (SEC-03)", () => {
  describe("base32", () => {
    it("round-trips arbitrary bytes", () => {
      for (const hex of [
        "00",
        "ff",
        "0102030405",
        "deadbeefcafebabe",
        "1234567890abcdef1234567890abcdef1234",
      ]) {
        const buf = Buffer.from(hex, "hex");
        expect(base32Decode(base32Encode(buf)).toString("hex")).toBe(hex);
      }
    });

    it("matches the RFC 4648 test vector (no padding)", () => {
      // "foo" -> MZXW6=== ; stripped padding form is MZXW6
      expect(base32Encode(Buffer.from("foo"))).toBe("MZXW6");
      expect(base32Decode("MZXW6").toString()).toBe("foo");
    });

    it("decodes case-insensitively and ignores separators", () => {
      expect(base32Decode("mzxw6").toString()).toBe("foo");
      expect(base32Decode("mzx w6-").toString()).toBe("foo");
    });

    it("rejects invalid characters (fail closed)", () => {
      expect(() => base32Decode("MZXW6!")).toThrow(/invalid base32/);
      expect(() => base32Decode("")).toThrow(/empty/);
    });
  });

  describe("generateTotpSecret", () => {
    it("returns 32-char base32 (160-bit) secrets", () => {
      const s = generateTotpSecret();
      expect(s).toMatch(/^[A-Z2-7]{32}$/);
      expect(s).not.toBe(generateTotpSecret());
    });
  });

  describe("hotp / totpVerify — RFC 6238 Appendix B (SHA-1)", () => {
    // 6-digit truncations of the RFC 8-digit vectors (last 6 digits).
    const cases: [number, string][] = [
      [59, "287082"], // 94287082
      [1111111109, "081804"], // 07081804
      [1111111111, "050471"], // 14050471
      [1234567890, "005924"], // 89005924
      [2000000000, "279037"], // 69279037
      [20000000000, "353130"], // 65353130
    ];

    it.each(cases)("produces the RFC vector at T=%d", (t, expected) => {
      const counter = Math.floor(t / TOTP_STEP_SECONDS);
      expect(hotp(RFC_SEED_B32, counter)).toBe(expected);
    });

    it.each(cases)("verifies the RFC vector at T=%d", (t, expected) => {
      expect(totpVerify(RFC_SEED_B32, expected, t)).toEqual({
        valid: true,
        matchedCounter: Math.floor(t / TOTP_STEP_SECONDS),
      });
    });

    it("accepts a code from the previous/next window (±1 step drift)", () => {
      const t = 59;
      const codes = totpCodesAt(RFC_SEED_B32, t);
      expect(codes).toHaveLength(2 * TOTP_WINDOW_STEPS + 1);
      // A code from one step ahead (T+30) is accepted at T.
      expect(totpVerify(RFC_SEED_B32, codes[1], t).valid).toBe(true);
    });

    it("rejects wrong codes, non-6-digit input, and empty strings", () => {
      expect(totpVerify(RFC_SEED_B32, "000000", 59).valid).toBe(false);
      expect(totpVerify(RFC_SEED_B32, "2870821", 59).valid).toBe(false);
      expect(totpVerify(RFC_SEED_B32, "28708", 59).valid).toBe(false);
      expect(totpVerify(RFC_SEED_B32, "abcdef", 59).valid).toBe(false);
      expect(totpVerify(RFC_SEED_B32, "", 59).valid).toBe(false);
      expect(totpVerify(RFC_SEED_B32, undefined as any, 59).valid).toBe(false);
    });

    it("rejects a code from another secret (secret mismatch)", () => {
      const other = generateTotpSecret();
      const code = hotp(RFC_SEED_B32, Math.floor(59 / 30));
      expect(totpVerify(other, code, 59).valid).toBe(false);
    });
  });

  describe("buildOtpauthUrl", () => {
    it("emits a Google Authenticator compatible otpauth://totp URL", () => {
      const url = buildOtpauthUrl("ABC234DEF", "AutoCodeFlow", "admin");
      expect(url).toContain("otpauth://totp/AutoCodeFlow:admin?");
      expect(url).toContain("secret=ABC234DEF");
      expect(url).toContain("issuer=AutoCodeFlow");
      expect(url).toContain("algorithm=SHA1");
      expect(url).toContain("digits=6");
      expect(url).toContain("period=30");
    });

    it("URL-encodes account names with special characters", () => {
      const url = buildOtpauthUrl("ABC234DEF", "AutoCodeFlow", "a:b@c");
      expect(url).toContain("AutoCodeFlow:a%3Ab%40c");
    });
  });
});

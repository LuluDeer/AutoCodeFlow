import {
  signExecutionCallbackToken,
  verifyExecutionCallbackToken,
  parseExecutionCallbackToken,
  EXECUTION_CALLBACK_TOKEN_PREFIX,
} from "../execution-callback-token.util";

const EXEC_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const OTHER_UUID = "6b4adba5-a2f8-4fe7-bf4f-5277d0d7f2b7";
const SECRET = "test-secret-vector";

// Pinned cross-component vector: executor-node's
// execution-callback-token.spec.ts asserts it produces this EXACT token for
// (SECRET, EXEC_UUID, 2000000000). If the algorithm ever changes on one
// side only, one of the two suites goes red.
const PINNED_EXP = 2000000000;
const PINNED_TOKEN =
  "v1.f47ac10b-58cc-4372-a567-0e02b2c3d479.2000000000." +
  "29f7b55965d77d10204409c0146d78628d5d06b86f4c32d8a2778cc2fb84e56b";

describe("execution-callback-token.util (N23 per-execution HMAC tokens)", () => {
  describe("pinned test vector", () => {
    it("signs the exact token executor-node produces for the same inputs", () => {
      expect(signExecutionCallbackToken(SECRET, EXEC_UUID, PINNED_EXP)).toBe(
        PINNED_TOKEN,
      );
    });

    it("verifies the pinned token against the pinned secret", () => {
      const claims = verifyExecutionCallbackToken(
        PINNED_TOKEN,
        [SECRET],
        PINNED_EXP - 1,
      );
      expect(claims).toEqual({
        executionId: EXEC_UUID,
        expiresAtSec: PINNED_EXP,
      });
    });
  });

  describe("sign / verify round-trip", () => {
    it("accepts a freshly signed token", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = signExecutionCallbackToken(SECRET, EXEC_UUID, now + 60);
      expect(verifyExecutionCallbackToken(token, [SECRET])).toEqual({
        executionId: EXEC_UUID,
        expiresAtSec: now + 60,
      });
    });

    it("rejects an expired token (fail closed)", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = signExecutionCallbackToken(SECRET, EXEC_UUID, now - 1);
      expect(verifyExecutionCallbackToken(token, [SECRET])).toBeNull();
    });

    it("rejects a token signed with a different secret", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = signExecutionCallbackToken(
        "other-secret",
        EXEC_UUID,
        now + 60,
      );
      expect(verifyExecutionCallbackToken(token, [SECRET])).toBeNull();
    });

    it("rejects a tampered executionId", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = signExecutionCallbackToken(SECRET, EXEC_UUID, now + 60);
      const tampered = token.replace(EXEC_UUID, OTHER_UUID);
      expect(verifyExecutionCallbackToken(tampered, [SECRET])).toBeNull();
    });

    it("rejects a tampered expiry", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = signExecutionCallbackToken(SECRET, EXEC_UUID, now + 60);
      const parts = token.split(".");
      parts[2] = String(now + 999999);
      expect(
        verifyExecutionCallbackToken(parts.join("."), [SECRET]),
      ).toBeNull();
    });

    it("tries every candidate secret (DB-rotated token fallback)", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = signExecutionCallbackToken(
        "db-rotated-token",
        EXEC_UUID,
        now + 60,
      );
      expect(
        verifyExecutionCallbackToken(token, [
          "",
          "env-token",
          "db-rotated-token",
        ]),
      ).not.toBeNull();
    });

    it("rejects when no candidate secret is configured (fail closed)", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = signExecutionCallbackToken(SECRET, EXEC_UUID, now + 60);
      expect(verifyExecutionCallbackToken(token, [])).toBeNull();
    });
  });

  describe("structural parsing", () => {
    it("returns null for non-prefixed (shared/dynamic) tokens", () => {
      expect(parseExecutionCallbackToken("plain-shared-token")).toBeNull();
      expect(
        parseExecutionCallbackToken(
          "v2.00000000-0000-4000-8000-000000000000.1.aa",
        ),
      ).toBeNull();
    });

    it("returns null for malformed v1 tokens", () => {
      expect(
        parseExecutionCallbackToken(`${EXECUTION_CALLBACK_TOKEN_PREFIX}`),
      ).toBeNull();
      expect(
        parseExecutionCallbackToken(
          `${EXECUTION_CALLBACK_TOKEN_PREFIX}${EXEC_UUID}.notanumber.deadbeef`,
        ),
      ).toBeNull();
      expect(
        parseExecutionCallbackToken(
          `${EXECUTION_CALLBACK_TOKEN_PREFIX}${EXEC_UUID}.9999999999.short`,
        ),
      ).toBeNull();
      expect(
        parseExecutionCallbackToken(
          `${EXECUTION_CALLBACK_TOKEN_PREFIX}${EXEC_UUID}.9999999999.${"z".repeat(64)}`,
        ),
      ).toBeNull();
    });

    it("verify() treats a structurally-valid token with a bad signature as null", () => {
      const bad = `${EXECUTION_CALLBACK_TOKEN_PREFIX}${EXEC_UUID}.9999999999.${"0".repeat(64)}`;
      expect(verifyExecutionCallbackToken(bad, [SECRET])).toBeNull();
    });
  });
});

import { randomBytes } from "crypto";
import {
  SECRET_ENC_PREFIX,
  decryptSecretValue,
  encryptSecretValue,
  encryptSecretsObject,
  decryptSecretsObject,
  maskSecretsObject,
  parseSecretsKey,
  isEncryptedSecret,
} from "../secret-crypto.util";
import { SecretsCryptoService } from "../secret-crypto.util.service";

/**
 * SEC-02: task secrets at-rest encryption — unit matrix.
 * Covers: roundtrip, tamper/wrong-key failure (no crash beyond the expected
 * throw), plaintext passthrough (mixed ciphertext/plaintext storage), key
 * parsing (hex/base64/passphrase), degraded no-key mode, idempotent
 * re-encryption, dispatch merge semantics and API masking.
 */

const HEX_KEY = randomBytes(32).toString("hex");
const KEY = Buffer.from(HEX_KEY, "hex");

describe("secret-crypto.util (SEC-02)", () => {
  describe("parseSecretsKey", () => {
    it("accepts a 64-char hex key", () => {
      expect(parseSecretsKey(HEX_KEY).length).toBe(32);
      expect(parseSecretsKey(HEX_KEY).equals(KEY)).toBe(true);
    });

    it("accepts a 44-char base64 key (with padding)", () => {
      const b64 = randomBytes(32).toString("base64");
      expect(b64.length).toBe(44);
      const parsed = parseSecretsKey(b64);
      expect(parsed.length).toBe(32);
      expect(parsed.equals(Buffer.from(b64, "base64"))).toBe(true);
    });

    it("stretches arbitrary passphrases to 32 bytes deterministically", () => {
      const a = parseSecretsKey("my deployment secret phrase");
      const b = parseSecretsKey("my deployment secret phrase");
      expect(a.length).toBe(32);
      expect(a.equals(b)).toBe(true);
    });

    it("rejects empty keys", () => {
      expect(() => parseSecretsKey("")).toThrow();
      expect(() => parseSecretsKey("   ")).toThrow();
    });
  });

  describe("encrypt/decrypt roundtrip", () => {
    it("roundtrips a plaintext value", () => {
      const secret = "p@ssw0rd-字典-🔐";
      const envelope = encryptSecretValue(secret, KEY);
      expect(isEncryptedSecret(envelope)).toBe(true);
      expect(envelope).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
      expect(envelope).not.toContain(secret);
      expect(decryptSecretValue(envelope, KEY)).toBe(secret);
    });

    it("uses a random IV — two envelopes of the same plaintext differ", () => {
      const a = encryptSecretValue("same", KEY);
      const b = encryptSecretValue("same", KEY);
      expect(a).not.toBe(b);
      expect(decryptSecretValue(a, KEY)).toBe("same");
      expect(decryptSecretValue(b, KEY)).toBe("same");
    });

    it("throws on wrong key (GCM auth failure) instead of returning garbage", () => {
      const envelope = encryptSecretValue("hunter2", KEY);
      const wrongKey = randomBytes(32);
      expect(() => decryptSecretValue(envelope, wrongKey)).toThrow();
    });

    it("throws on tampered ciphertext (auth tag mismatch)", () => {
      const envelope = encryptSecretValue("hunter2", KEY);
      const parts = envelope.split(":");
      const ct = Buffer.from(parts[3], "base64");
      ct[0] = ct[0] ^ 0xff;
      parts[3] = ct.toString("base64");
      expect(() => decryptSecretValue(parts.join(":"), KEY)).toThrow();
    });

    it("throws on malformed envelopes", () => {
      expect(() => decryptSecretValue("enc:v1:only-two-fields", KEY)).toThrow();
      expect(() => decryptSecretValue("enc:v1:!!!:!!!:!!!", KEY)).toThrow();
      expect(() => decryptSecretValue("plaintext", KEY)).toThrow(
        "not an enc:v1 secret envelope",
      );
    });
  });

  describe("secrets object encrypt/decrypt", () => {
    it("encrypts every string leaf and roundtrips nested objects", () => {
      const secrets = {
        apiKey: "sk-live-123",
        db: { password: "pg-pass", port: 5432 },
        empty: null,
      };
      const stored = encryptSecretsObject(secrets, KEY) as Record<string, any>;
      expect(isEncryptedSecret(stored.apiKey)).toBe(true);
      expect(isEncryptedSecret(stored.db.password)).toBe(true);
      expect(isEncryptedSecret(stored.db.port)).toBe(true); // numbers stringified then sealed
      expect(stored.empty).toBeNull();
      const roundtrip = decryptSecretsObject(stored, KEY) as Record<string, any>;
      // Numeric leaves are stringified before sealing (encrypt-everything
      // semantics for a secrets-shaped object) — document it in the contract.
      expect(roundtrip).toEqual({
        apiKey: "sk-live-123",
        db: { password: "pg-pass", port: "5432" },
        empty: null,
      });
    });

    it("is idempotent — already-encrypted leaves are not double-wrapped", () => {
      const once = encryptSecretsObject({ apiKey: "v" }, KEY);
      const twice = encryptSecretsObject(once as Record<string, string>, KEY);
      expect(twice).toEqual(once);
    });

    it("passes plaintext leaves through on decrypt (mixed storage)", () => {
      const mixed = { apiKey: "sk-123", note: "plain legacy value" };
      const out = decryptSecretsObject(mixed, KEY);
      expect(out).toEqual(mixed);
    });

    it("throws on envelope leaves when key is null (cannot dispatch degraded)", () => {
      const stored = encryptSecretsObject({ apiKey: "v" }, KEY);
      expect(() => decryptSecretsObject(stored, null)).toThrow(
        /SEC_SECRETS_KEY is not configured/,
      );
    });

    it("handles null/undefined objects", () => {
      expect(encryptSecretsObject(null, KEY)).toBeNull();
      expect(encryptSecretsObject(undefined, KEY)).toBeUndefined();
      expect(decryptSecretsObject(null, KEY)).toBeNull();
      expect(encryptSecretsObject({}, KEY)).toEqual({});
    });
  });

  describe("maskSecretsObject", () => {
    it("masks leaf values but keeps structure and keys", () => {
      const masked = maskSecretsObject({
        apiKey: "sk-live-123",
        db: { password: "pg-pass" },
        empty: null,
      }) as Record<string, any>;
      expect(masked.apiKey).toBe("******");
      expect(masked.db.password).toBe("******");
      expect(masked.empty).toBeNull();
      expect(Object.keys(masked)).toEqual(["apiKey", "db", "empty"]);
    });

    it("masks envelope ciphertext too (never leaks the raw envelope)", () => {
      const stored = encryptSecretsObject({ apiKey: "v" }, KEY) as Record<
        string,
        string
      >;
      const masked = maskSecretsObject(stored) as Record<string, string>;
      expect(masked.apiKey).toBe("******");
      expect(masked.apiKey).not.toContain(SECRET_ENC_PREFIX);
    });
  });
});

describe("SecretsCryptoService (SEC-02)", () => {
  const makeService = (env: Record<string, string | undefined>) =>
    new SecretsCryptoService({
      get: (path: string) => (path === "secrets.key" ? env.SEC_SECRETS_KEY : undefined),
    } as any);

  it("degrades to plaintext when the key is not configured (no crash)", () => {
    const svc = makeService({});
    expect(svc.encryptionEnabled).toBe(false);
    const secrets = { apiKey: "sk-123" };
    expect(svc.encryptForStorage(secrets)).toEqual(secrets); // plaintext passthrough
    expect(svc.decryptForDispatch(secrets)).toEqual(secrets);
    expect(svc.maskForResponse(secrets)).toEqual({ apiKey: "******" });
  });

  it("encrypts writes and decrypts reads when the key is configured", () => {
    const svc = makeService({ SEC_SECRETS_KEY: HEX_KEY });
    expect(svc.encryptionEnabled).toBe(true);
    const stored = svc.encryptForStorage({ apiKey: "sk-123" }) as Record<
      string,
      string
    >;
    expect(isEncryptedSecret(stored.apiKey)).toBe(true);
    expect(svc.decryptForDispatch(stored)).toEqual({ apiKey: "sk-123" });
  });

  it("warns once (not per write) in degraded mode with non-empty secrets", () => {
    const warns: string[] = [];
    const svc = new SecretsCryptoService({
      get: () => undefined,
    } as any);
    // Patch the internal logger after construction to observe warn calls.
    (svc as any).logger = { warn: (m: string) => warns.push(m) };
    svc.encryptForStorage({ apiKey: "a" });
    svc.encryptForStorage({ apiKey: "b" });
    svc.encryptForStorage({});
    const storageWarns = warns.filter((w) =>
      w.includes("Storing task secrets in plaintext"),
    );
    expect(storageWarns.length).toBe(1);
  });

  it("rejects encryptValue in degraded mode", () => {
    const svc = makeService({});
    expect(() => svc.encryptValue("x")).toThrow(/SEC_SECRETS_KEY is not configured/);
  });
});

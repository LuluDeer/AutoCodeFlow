import { randomBytes } from "crypto";
import {
  SECRET_ENC_PREFIX,
  SECRET_MASK_LITERAL,
  decryptSecretValue,
  encryptSecretValue,
  encryptSecretsObject,
  decryptSecretsObject,
  maskSecretsObject,
  mergeSecretsOnUpdate,
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
      expect(envelope).toMatch(
        /^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
      );
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
      const roundtrip = decryptSecretsObject(stored, KEY) as Record<
        string,
        any
      >;
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

  /**
   * SEC-02 续（生产故障）：PATCH 的**逐键合并**。
   *
   * 本组测试钉住的是"掩码回写"这一不可逆损毁路径：读路径必然把每个叶子换成
   * `******`，控制台要显示既有键就必然持有掩码——整体替换语义下，一次"只改
   * 超时"的保存就会把掩码当真实凭据写进库。合并语义让"键缺省 = 保留"，
   * 掩码只能表达"不改"，永远不落库。
   */
  describe("mergeSecretsOnUpdate（掩码回写防护）", () => {
    const storedEncrypted = () =>
      encryptSecretsObject(
        { FEISHU_APP_ID: "cli_real", FEISHU_APP_SECRET: "sec_real" },
        KEY,
      ) as Record<string, unknown>;

    it("掩码叶子 → 保留库里原值（真实凭据不被掩码覆盖）", () => {
      const stored = storedEncrypted();
      const merged = mergeSecretsOnUpdate(
        stored,
        { FEISHU_APP_ID: SECRET_MASK_LITERAL },
        KEY,
      );
      // 逐字节相同：连密文都没重新加密过
      expect(merged.FEISHU_APP_ID).toBe(stored.FEISHU_APP_ID);
      expect(decryptSecretsObject(merged, KEY)).toEqual({
        FEISHU_APP_ID: "cli_real",
        FEISHU_APP_SECRET: "sec_real",
      });
    });

    it("后端读面回给客户端的整体掩码对象回传 = 一个键都不改（本故障的复现路径）", () => {
      const stored = storedEncrypted();
      // 控制台拿到的就是 maskForResponse 的结果，一字不改地 PATCH 回来
      const echoed = maskSecretsObject(stored) as Record<string, unknown>;
      const merged = mergeSecretsOnUpdate(stored, echoed, KEY);
      expect(merged).toEqual(stored);
      expect(decryptSecretsObject(merged, KEY)).toEqual({
        FEISHU_APP_ID: "cli_real",
        FEISHU_APP_SECRET: "sec_real",
      });
    });

    it("键缺省 → 保留（只提交一个键不会删掉其它凭据）", () => {
      const stored = storedEncrypted();
      const merged = mergeSecretsOnUpdate(
        stored,
        { NEW_KEY: "v" },
        KEY,
      ) as Record<string, unknown>;
      expect(Object.keys(merged).sort()).toEqual([
        "FEISHU_APP_ID",
        "FEISHU_APP_SECRET",
        "NEW_KEY",
      ]);
      expect(merged.FEISHU_APP_ID).toBe(stored.FEISHU_APP_ID);
    });

    it("叶子 = null → 删除该键（合并语义下「删除」必须显式表达）", () => {
      const stored = storedEncrypted();
      const merged = mergeSecretsOnUpdate(
        stored,
        { FEISHU_APP_SECRET: null },
        KEY,
      ) as Record<string, unknown>;
      expect(Object.keys(merged)).toEqual(["FEISHU_APP_ID"]);
    });

    it("真实新值 → 加密覆盖，且不碰其它键", () => {
      const stored = storedEncrypted();
      const merged = mergeSecretsOnUpdate(
        stored,
        { FEISHU_APP_ID: "cli_rotated" },
        KEY,
      ) as Record<string, unknown>;
      expect(merged.FEISHU_APP_ID).not.toBe(stored.FEISHU_APP_ID);
      expect(isEncryptedSecret(merged.FEISHU_APP_ID as string)).toBe(true);
      expect(decryptSecretsObject(merged, KEY)).toEqual({
        FEISHU_APP_ID: "cli_rotated",
        FEISHU_APP_SECRET: "sec_real",
      });
    });

    it("掩码发给「库里没有的键」 → no-op（绝不把掩码字面量写进库）", () => {
      const merged = mergeSecretsOnUpdate(
        null,
        { NOT_STORED: SECRET_MASK_LITERAL },
        KEY,
      );
      expect(merged).toEqual({});
    });

    it("stored 为 null 时按空库合并", () => {
      const merged = mergeSecretsOnUpdate(null, { A: "1" }, KEY) as Record<
        string,
        unknown
      >;
      expect(decryptSecretsObject(merged, KEY)).toEqual({ A: "1" });
    });

    it("嵌套对象递归合并（掩码只影响命中的那一层）", () => {
      const stored = encryptSecretsObject(
        { db: { user: "u", password: "p" } },
        KEY,
      ) as Record<string, any>;
      const merged = mergeSecretsOnUpdate(
        stored,
        { db: { user: SECRET_MASK_LITERAL, password: "new-p" } },
        KEY,
      ) as Record<string, any>;
      expect(merged.db.user).toBe(stored.db.user);
      expect(decryptSecretsObject(merged, KEY)).toEqual({
        db: { user: "u", password: "new-p" },
      });
    });

    it("降级模式（无 key）同样合并，不留掩码", () => {
      const merged = mergeSecretsOnUpdate(
        { A: "plain-a" },
        { A: SECRET_MASK_LITERAL, B: "plain-b" },
        null,
      );
      expect(merged).toEqual({ A: "plain-a", B: "plain-b" });
    });
  });
});

describe("SecretsCryptoService (SEC-02)", () => {
  const makeService = (env: Record<string, string | undefined>) =>
    new SecretsCryptoService({
      get: (path: string) =>
        path === "secrets.key" ? env.SEC_SECRETS_KEY : undefined,
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
    expect(() => svc.encryptValue("x")).toThrow(
      /SEC_SECRETS_KEY is not configured/,
    );
  });
});

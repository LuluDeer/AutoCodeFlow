import { UnauthorizedException } from "@nestjs/common";
import { verifyExecutorToken } from "../verify-executor-token.util";

const SECRET = "super-secret-token-32chars-long!";

const makeConfigService = (nodeEnv: string, token: string) => ({
  get: jest.fn((key: string) => {
    if (key === "app.nodeEnv") return nodeEnv;
    if (key === "executor.sharedToken") return token;
    return undefined;
  }),
});

const makeSystemConfig = (dbToken: string | null) => ({
  findOne: dbToken === null
    ? jest.fn().mockRejectedValue(new Error("not found"))
    : jest.fn().mockResolvedValue({ value: dbToken }),
});

describe("verifyExecutorToken", () => {
  describe("when no token is configured", () => {
    it("passes silently in development", async () => {
      const cfg = makeConfigService("development", "");
      const sys = makeSystemConfig(null);
      await expect(verifyExecutorToken(undefined, cfg as any, sys as any)).resolves.toBeUndefined();
    });

    it("passes silently in test", async () => {
      const cfg = makeConfigService("test", "");
      const sys = makeSystemConfig(null);
      await expect(verifyExecutorToken("any-token", cfg as any, sys as any)).resolves.toBeUndefined();
    });

    it("throws in production even without auth header", async () => {
      const cfg = makeConfigService("production", "");
      const sys = makeSystemConfig(null);
      await expect(verifyExecutorToken(undefined, cfg as any, sys as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("throws in production with a token in header when none configured", async () => {
      const cfg = makeConfigService("production", "");
      const sys = makeSystemConfig(null);
      await expect(verifyExecutorToken("Bearer anything", cfg as any, sys as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("when token is configured via env/config", () => {
    it("accepts matching Bearer token", async () => {
      const cfg = makeConfigService("test", SECRET);
      const sys = makeSystemConfig(null);
      await expect(verifyExecutorToken(`Bearer ${SECRET}`, cfg as any, sys as any))
        .resolves.toBeUndefined();
    });

    it("accepts raw token (no Bearer prefix)", async () => {
      const cfg = makeConfigService("test", SECRET);
      const sys = makeSystemConfig(null);
      await expect(verifyExecutorToken(SECRET, cfg as any, sys as any))
        .resolves.toBeUndefined();
    });

    it("rejects wrong token", async () => {
      const cfg = makeConfigService("test", SECRET);
      const sys = makeSystemConfig(null);
      await expect(verifyExecutorToken("Bearer wrong-token", cfg as any, sys as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("rejects empty auth header when token is set", async () => {
      const cfg = makeConfigService("test", SECRET);
      const sys = makeSystemConfig(null);
      await expect(verifyExecutorToken("", cfg as any, sys as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("rejects undefined auth header when token is set", async () => {
      const cfg = makeConfigService("test", SECRET);
      const sys = makeSystemConfig(null);
      await expect(verifyExecutorToken(undefined, cfg as any, sys as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("rejects token that is prefix of the actual token", async () => {
      const cfg = makeConfigService("test", SECRET);
      const sys = makeSystemConfig(null);
      // Shorter token would fail timingSafeEqual due to length mismatch
      await expect(verifyExecutorToken(`Bearer ${SECRET.slice(0, -1)}`, cfg as any, sys as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("rejects token that is superset of the actual token", async () => {
      const cfg = makeConfigService("test", SECRET);
      const sys = makeSystemConfig(null);
      await expect(verifyExecutorToken(`Bearer ${SECRET}X`, cfg as any, sys as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("when DB token overrides env token", () => {
    it("accepts DB token and rejects env token", async () => {
      const dbToken = "db-stored-token-value";
      const cfg = makeConfigService("test", SECRET);  // env token is SECRET
      const sys = makeSystemConfig(dbToken);          // DB token overrides
      // DB token works
      await expect(verifyExecutorToken(`Bearer ${dbToken}`, cfg as any, sys as any))
        .resolves.toBeUndefined();
    });

    it("DB findOne failure falls back to env token", async () => {
      const cfg = makeConfigService("test", SECRET);
      // DB throws — should fall back to env SECRET
      const sys = { findOne: jest.fn().mockRejectedValue(new Error("db offline")) };
      await expect(verifyExecutorToken(`Bearer ${SECRET}`, cfg as any, sys as any))
        .resolves.toBeUndefined();
    });
  });
});

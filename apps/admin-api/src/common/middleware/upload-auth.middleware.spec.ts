import { createUploadAuthMiddleware, isPublicUploadPath } from "./upload-auth.middleware";
import * as jwt from "jsonwebtoken";

const SECRET = "test-secret-key-at-least-32-characters!";

const makeDeps = (overrides: Record<string, unknown> = {}) => {
  const configValues: Record<string, unknown> = {
    "jwt.secret": SECRET,
    "executor.sharedToken": "executor-shared-token",
    ...overrides,
  };
  const configService = { get: (key: string) => configValues[key] };
  const systemConfigService = {
    findOne: jest.fn().mockRejectedValue(new Error("not found")),
  };
  return { configService, systemConfigService } as any;
};

const makeRes = () => {
  const res: any = {
    statusCode: undefined,
    body: undefined,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockImplementation((payload) => {
      res.body = payload;
    }),
  };
  return res;
};

const makeReq = (opts: { path?: string; authorization?: string; method?: string; originalUrl?: string } = {}) =>
  ({
    method: opts.method ?? "GET",
    path: opts.path ?? "/packages/app_123.zip",
    originalUrl: opts.originalUrl ?? `/uploads${opts.path ?? "/packages/app_123.zip"}`,
    headers: opts.authorization
      ? { authorization: opts.authorization }
      : ({} as Record<string, string>),
  }) as any;

describe("upload-auth.middleware (ARCH-002)", () => {
  describe("isPublicUploadPath", () => {
    it("matches exact prefix and sub-paths, ignoring leading slashes", () => {
      expect(isPublicUploadPath("/public/file.zip", ["public"])).toBe(true);
      expect(isPublicUploadPath("public/file.zip", ["/public/"])).toBe(true);
      expect(isPublicUploadPath("/public", ["public"])).toBe(true);
    });

    it("does not match other prefixes or look-alike names", () => {
      expect(isPublicUploadPath("/packages/file.zip", ["public"])).toBe(false);
      expect(isPublicUploadPath("/publicized/file.zip", ["public"])).toBe(false);
    });

    it("is empty by default (fail closed — no anonymous uploads path)", () => {
      expect(isPublicUploadPath("/anything.zip")).toBe(false);
    });
  });

  describe("createUploadAuthMiddleware", () => {
    it("allows requests with a valid access JWT", async () => {
      const token = jwt.sign({ sub: 1, username: "admin", type: "access" }, SECRET, {
        expiresIn: "5m",
      });
      const mw = createUploadAuthMiddleware(...(Object.values(makeDeps()) as [any, any]));
      const next = jest.fn();
      await mw(makeReq({ authorization: `Bearer ${token}` }), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("rejects JWTs without the access type marker (SEC-001 parity)", async () => {
      const token = jwt.sign({ sub: 1, username: "admin" }, SECRET, { expiresIn: "5m" });
      const mw = createUploadAuthMiddleware(...(Object.values(makeDeps()) as [any, any]));
      const next = jest.fn();
      const res = makeRes();
      await mw(makeReq({ authorization: `Bearer ${token}` }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("rejects expired or tampered JWTs without falling through to 500", async () => {
      const token = jwt.sign({ sub: 1, type: "access" }, SECRET, { expiresIn: "-10s" });
      const mw = createUploadAuthMiddleware(...(Object.values(makeDeps()) as [any, any]));
      const next = jest.fn();
      const res = makeRes();
      await mw(makeReq({ authorization: `Bearer ${token}` }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("allows requests with the executor shared token", async () => {
      const mw = createUploadAuthMiddleware(...(Object.values(makeDeps()) as [any, any]));
      const next = jest.fn();
      await mw(makeReq({ authorization: "Bearer executor-shared-token" }), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("rejects missing/invalid credentials with 401", async () => {
      const mw = createUploadAuthMiddleware(...(Object.values(makeDeps()) as [any, any]));
      const next = jest.fn();
      const res = makeRes();
      await mw(makeReq(), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.body.message).toMatch(/uploads require/i);

      const next2 = jest.fn();
      const res2 = makeRes();
      await mw(makeReq({ authorization: "Bearer wrong-token" }), res2, next2);
      expect(next2).not.toHaveBeenCalled();
      expect(res2.status).toHaveBeenCalledWith(401);
    });

    it("serves whitelisted public sub-paths without any credentials", async () => {
      const mw = createUploadAuthMiddleware(
        ...(Object.values(makeDeps()) as [any, any]),
        ["public"],
      );
      const next = jest.fn();
      await mw(makeReq({ path: "/public/receipt.txt" }), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});

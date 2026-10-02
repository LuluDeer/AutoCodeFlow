import { HttpException, HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import { RegistryController } from "../registry.controller";
import { AuditService } from "../../audit/audit.service";
import { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { UserRole } from "../../users/entities/user.entity";
import type { Request } from "express";

/** A7：控制器现在需要 AuditService（上传审计）与调用主体（审计要记「谁传的」）。 */
const makeAudit = (): AuditService =>
  ({ log: jest.fn().mockResolvedValue(undefined) }) as unknown as AuditService;

const makeController = (
  cfg: Record<string, unknown> = {},
  audit: AuditService = makeAudit(),
): RegistryController =>
  new RegistryController(new ConfigService(cfg as never), audit);

const adminUser: AuthUser = {
  id: 1,
  username: "admin",
  email: "admin@example.com",
  role: UserRole.ADMIN,
  isActive: true,
};

const reqStub = { ip: "127.0.0.1" } as unknown as Request;

/** Start a server on an ephemeral 127.0.0.1 port and return the port. */
const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
  });

/** Destroy every client socket so server.close() cannot hang the test. */
const trackSockets = (server: http.Server) => {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return () => sockets.forEach((s) => s.destroy());
};

const makeMulterFile = (
  content = "fake-wheel-bytes",
  originalname = "pkg-1.0.0.whl",
): Express.Multer.File =>
  ({
    fieldname: "content",
    originalname,
    encoding: "7bit",
    mimetype: "application/octet-stream",
    buffer: Buffer.from(content),
    size: Buffer.byteLength(content),
  }) as unknown as Express.Multer.File;

describe("RegistryController upload proxy (S4 timeouts)", () => {
  // DEEP-AUDIT B·2.1 回归桩：模拟自建 registry-pypi（FastAPI/Starlette）的
  // redirect_slashes 行为——任何带尾斜杠的路径（且去掉尾斜杠后有路由）回 307，
  // 无尾斜杠路径回 200。此前代理打 `/upload/` 且把 `<400` 当成功，307 被吞成
  // 「上传成功」而包实际未落盘。
  const makeStarletteLikeServer = (
    seen: Array<{ method?: string; url?: string }>,
  ): http.Server =>
    http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url });
        res.setHeader("Connection", "close");
        if (req.url && req.url.length > 1 && req.url.endsWith("/")) {
          // Starlette redirect_slashes：保留方法的重定向（此处不跟随）
          res.writeHead(307, { Location: req.url.replace(/\/+$/, "") });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
    });

  it("2.1: posts to the canonical POST / path (no trailing slash) and reports success only on 2xx", async () => {
    const seen: Array<{ method?: string; url?: string }> = [];
    const server = makeStarletteLikeServer(seen);
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = makeController({
      PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
      REGISTRY_UPLOAD_TIMEOUT_MS: "3000",
    });

    await expect(
      controller.uploadPypiPackage(
        makeMulterFile(),
        "pkg",
        "1.0.0",
        adminUser,
        reqStub,
      ),
    ).resolves.toEqual({ success: true });

    // 规范路：POST /，绝不能再出现带尾斜杠的 /upload/（会触发上游 307）
    expect(seen).toEqual([{ method: "POST", url: "/" }]);

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("2.1: treats an upstream 3xx redirect as BAD_GATEWAY, never as success", async () => {
    // 上游直接对任意路径回 307（模拟旧路由形态 /upload/ 与重定向语义并存）：
    // 代理不跟随重定向，必须显式失败而不是把 3xx 报成 success。
    const server = http.createServer((req, res) => {
      res.writeHead(307, { Location: "/" });
      res.end();
    });
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = makeController({
      PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
      REGISTRY_UPLOAD_TIMEOUT_MS: "3000",
    });

    await expect(
      controller.uploadPypiPackage(
        makeMulterFile(),
        "pkg",
        "1.0.0",
        adminUser,
        reqStub,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fails with GATEWAY_TIMEOUT within the deadline when the backend hangs", async () => {
    // Upstream that accepts the POST and never responds — the hung-backend
    // scenario the proxy must survive instead of pinning the connection.
    const server = http.createServer(() => {
      /* intentionally never respond */
    });
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = makeController({
      PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
      REGISTRY_UPLOAD_TIMEOUT_MS: "300",
    });

    const startedAt = Date.now();
    await expect(
      controller.uploadPypiPackage(
        makeMulterFile(),
        "pkg",
        "1.0.0",
        adminUser,
        reqStub,
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.GATEWAY_TIMEOUT,
      message: "Upstream registry upload timed out",
    });

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(10_000);

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("still completes a normal upload when the backend answers in time", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = makeController({
      PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
      REGISTRY_UPLOAD_TIMEOUT_MS: "3000",
    });

    await expect(
      controller.uploadPypiPackage(
        makeMulterFile(),
        "pkg",
        "1.0.0",
        adminUser,
        reqStub,
      ),
    ).resolves.toEqual({ success: true });

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("maps a backend 500 to BAD_GATEWAY", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = makeController({
      PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
      REGISTRY_UPLOAD_TIMEOUT_MS: "3000",
    });

    await expect(
      controller.uploadPypiPackage(
        makeMulterFile(),
        "pkg",
        "1.0.0",
        adminUser,
        reqStub,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects a missing file with BAD_REQUEST before any proxying", async () => {
    const controller = makeController({});
    await expect(
      controller.uploadPypiPackage(
        undefined as unknown as Express.Multer.File,
        "pkg",
        "1.0.0",
        adminUser,
        reqStub,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it("rejects a disallowed extension with BAD_REQUEST before any proxying", async () => {
    const controller = makeController({});
    await expect(
      controller.uploadPypiPackage(
        makeMulterFile("evil", "payload.exe"),
        "pkg",
        "1.0.0",
        adminUser,
        reqStub,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });
});

describe("RegistryController npm package listing (S5 authenticated registry)", () => {
  let server: http.Server;
  let destroyAll: () => void;
  let port: number;
  const seen: Array<{
    method?: string;
    url?: string;
    authorization?: string;
  }> = [];

  beforeAll(async () => {
    // A Verdaccio stand-in: /-/user/login issues a token for svc/svc-pass,
    // /-/verdaccio/packages requires `Authorization: Bearer svc-token`.
    // `Connection: close` keeps the client from holding a keep-alive socket
    // open after each response (that would hang server.close()).
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          authorization: (req.headers.authorization as string) ?? "",
        });
        res.setHeader("Connection", "close");
        if (req.url === "/-/user/login") {
          const creds = JSON.parse(body) as {
            username?: string;
            name?: string;
            password?: string;
          };
          const user = creds.username ?? creds.name;
          if (user === "svc" && creds.password === "svc-pass") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ token: "svc-token" }));
          } else {
            res.writeHead(401);
            res.end(JSON.stringify({ error: "bad credentials" }));
          }
          return;
        }
        if (req.url === "/-/verdaccio/packages") {
          if (req.headers.authorization === "Bearer svc-token") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify([{ name: "@autoflow/core", latest: "1.2.3" }]),
            );
          } else {
            res.writeHead(401);
            res.end("unauthorized");
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    destroyAll = trackSockets(server);
    port = await listen(server);
  });

  afterAll(async () => {
    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it("S5: logs in with the configured service account and lists packages", async () => {
    const controller = makeController({
      registry: {
        npm: {
          url: `http://127.0.0.1:${port}`,
          user: "svc",
          pass: "svc-pass",
          token: "",
        },
      },
    });

    await expect(controller.listNpmPackages()).resolves.toEqual({
      packages: [{ name: "@autoflow/core", latest: "1.2.3" }],
    });
    // login first, then the authenticated packages pull
    expect(seen).toEqual([
      { method: "PUT", url: "/-/user/login", authorization: "" },
      {
        method: "GET",
        url: "/-/verdaccio/packages",
        authorization: "Bearer svc-token",
      },
    ]);
  });

  it("B-3: surfaces the upstream 401 as BAD_GATEWAY when no credentials are configured（不再静默变空列表）", async () => {
    const controller = makeController({
      registry: {
        npm: {
          url: `http://127.0.0.1:${port}`,
          user: "",
          pass: "",
          token: "",
        },
      },
    });
    (controller as unknown as { logger: Record<string, jest.Mock> }).logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    // B-3 前：匿名 401 被吞成 { packages: [] } 200，故障静默；现在按 502
    // 透出（消息含上游状态码），前端 StateError 错误态得以触发。
    await expect(controller.listNpmPackages()).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      message: expect.stringContaining("401"),
    });
    // anonymous 401 — and the miss is still explained at debug level
    expect(seen).toEqual([
      { method: "GET", url: "/-/verdaccio/packages", authorization: "" },
    ]);
    expect(
      (controller as unknown as { logger: Record<string, jest.Mock> }).logger
        .debug,
    ).toHaveBeenCalled();
  });

  it("S5: uses a pre-issued token directly without a login round-trip", async () => {
    const controller = makeController({
      registry: {
        npm: {
          url: `http://127.0.0.1:${port}`,
          user: "",
          pass: "",
          token: "svc-token",
        },
      },
    });

    await expect(controller.listNpmPackages()).resolves.toEqual({
      packages: [{ name: "@autoflow/core", latest: "1.2.3" }],
    });
    expect(seen).toEqual([
      {
        method: "GET",
        url: "/-/verdaccio/packages",
        authorization: "Bearer svc-token",
      },
    ]);
  });

  it("B-3: surfaces the upstream 401 as BAD_GATEWAY when the configured credentials are rejected", async () => {
    const controller = makeController({
      registry: {
        npm: {
          url: `http://127.0.0.1:${port}`,
          user: "svc",
          pass: "wrong",
          token: "",
        },
      },
    });

    await expect(controller.listNpmPackages()).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      message: expect.stringContaining("401"),
    });
    expect(seen.map((r) => r.url)).toEqual([
      "/-/user/login",
      "/-/verdaccio/packages",
    ]);
  });
});

describe("RegistryController list proxy error surfacing (B-3 / B-9)", () => {
  /** Stand-in for the registry-pypi /simple/ index page. */
  const makeSimpleIndexServer = (status: number, body: string): http.Server =>
    http.createServer((_req, res) => {
      res.setHeader("Connection", "close");
      res.writeHead(status, { "Content-Type": "text/html" });
      res.end(body);
    });

  it("B-3: surfaces an upstream 5xx as BAD_GATEWAY（消息含上游状态码，不再是空列表 200）", async () => {
    const server = makeSimpleIndexServer(503, "maintenance");
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = makeController({
      PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
    });

    await expect(controller.listPypiPackages()).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      message: expect.stringContaining("503"),
    });

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("B-3: an upstream 2xx with zero anchors is still a 200 empty list（失败与空态语义分离）", async () => {
    const server = makeSimpleIndexServer(
      200,
      "<html><body><p>No packages published yet.</p></body></html>",
    );
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = makeController({
      PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
    });

    await expect(controller.listPypiPackages()).resolves.toEqual({
      packages: [],
    });

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("B-3: the fetchText timeout marker (504) maps to GATEWAY_TIMEOUT", () => {
    const controller = makeController({});
    const fail = (
      controller as unknown as {
        throwUpstreamListFailure: (
          upstream: string,
          status: number,
          text: string,
        ) => never;
      }
    ).throwUpstreamListFailure.bind(controller) as (
      upstream: string,
      status: number,
      text: string,
    ) => never;

    try {
      fail("PyPI registry", HttpStatus.GATEWAY_TIMEOUT, "timeout");
      throw new Error("expected throwUpstreamListFailure to throw");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    }
  });

  it("B-9: decodes HTML entities in index anchor text（a&amp;b → a&b，转义不再透出到列表）", async () => {
    const server = makeSimpleIndexServer(
      200,
      "<html><body>" +
        '<a href="/simple/a&amp;b/">a&amp;b</a>' +
        '<a href="/simple/plain/">plain</a>' +
        '<a href="/simple/esc/">&amp;lt;tag&amp;gt;</a>' +
        "</body></html>",
    );
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = makeController({
      PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
    });

    // `&amp;lt;` 只解码一轮得 `&lt;`（单次解码语义，不越界）。
    await expect(controller.listPypiPackages()).resolves.toEqual({
      packages: ["a&b", "plain", "&lt;tag&gt;"],
    });

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("B-9: &amp; must be replaced last so double-escaped text survives one decode round", () => {
    const controller = makeController({});
    const decode = (
      controller as unknown as {
        decodeHtmlEntities: (s: string) => string;
      }
    ).decodeHtmlEntities;
    expect(decode.call(controller, "a&amp;b")).toBe("a&b");
    expect(decode.call(controller, "&amp;lt;")).toBe("&lt;");
    expect(decode.call(controller, "plain")).toBe("plain");
  });
});

describe("RegistryController upload status mapping (B-10)", () => {
  const makeStatusServer = (status: number, body: string): http.Server =>
    http.createServer((_req, res) => {
      res.setHeader("Connection", "close");
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });

  it("B-10: maps an upstream 409 (same filename, different sha256) to CONFLICT", async () => {
    const server = makeStatusServer(
      409,
      '{"detail":"Artifact pkg-1.0.0.whl already exists with a different sha256"}',
    );
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = makeController({
      PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
      REGISTRY_UPLOAD_TIMEOUT_MS: "3000",
    });

    await expect(
      controller.uploadPypiPackage(
        makeMulterFile(),
        "pkg",
        "1.0.0",
        adminUser,
        reqStub,
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      message: expect.stringContaining("版本已存在或内容冲突"),
    });

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("B-10: maps an upstream 413 (size cap) to PAYLOAD_TOO_LARGE", async () => {
    const server = makeStatusServer(413, '{"detail":"Package too large"}');
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = makeController({
      PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
      REGISTRY_UPLOAD_TIMEOUT_MS: "3000",
    });

    await expect(
      controller.uploadPypiPackage(
        makeMulterFile(),
        "pkg",
        "1.0.0",
        adminUser,
        reqStub,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.PAYLOAD_TOO_LARGE });

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("B-10: keeps other upstream statuses as BAD_GATEWAY", async () => {
    const server = makeStatusServer(500, "boom");
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = makeController({
      PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
      REGISTRY_UPLOAD_TIMEOUT_MS: "3000",
    });

    await expect(
      controller.uploadPypiPackage(
        makeMulterFile(),
        "pkg",
        "1.0.0",
        adminUser,
        reqStub,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("RegistryController npm login token cache (B-11)", () => {
  let server: http.Server;
  let destroyAll: () => void;
  let port: number;
  const seen: Array<{ method?: string; url?: string }> = [];

  beforeAll(async () => {
    // 独立的 Verdaccio 替身（与 S5 describe 同构）：svc2/svc2-pass 换
    // svc2-token，包列表要求 Bearer。
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url });
        res.setHeader("Connection", "close");
        if (req.url === "/-/user/login") {
          const creds = JSON.parse(body) as {
            username?: string;
            name?: string;
            password?: string;
          };
          const user = creds.username ?? creds.name;
          if (user === "svc2" && creds.password === "svc2-pass") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ token: "svc2-token" }));
          } else {
            res.writeHead(401);
            res.end(JSON.stringify({ error: "bad credentials" }));
          }
          return;
        }
        if (req.url === "/-/verdaccio/packages") {
          if (req.headers.authorization === "Bearer svc2-token") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify([{ name: "@autoflow/cached" }]));
          } else {
            res.writeHead(401);
            res.end("unauthorized");
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    destroyAll = trackSockets(server);
    port = await listen(server);
  });

  afterAll(async () => {
    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const makeCachedController = (): RegistryController =>
    makeController({
      registry: {
        npm: {
          url: `http://127.0.0.1:${port}`,
          user: "svc2",
          pass: "svc2-pass",
          token: "",
        },
      },
    });

  const clearTokenCache = () => {
    const statics = RegistryController as unknown as {
      npmTokenCache: Map<string, unknown>;
      npmLoginInflight: Map<string, unknown>;
    };
    statics.npmTokenCache.clear();
    statics.npmLoginInflight.clear();
  };

  beforeEach(() => {
    seen.length = 0;
    // B-11：token 缓存是模块级静态态——用例间必须清空保证确定性。
    clearTokenCache();
  });

  it("B-11: the second listing within the TTL does not hit /-/user/login again", async () => {
    const controller = makeCachedController();

    await expect(controller.listNpmPackages()).resolves.toEqual({
      packages: [{ name: "@autoflow/cached" }],
    });
    await expect(controller.listNpmPackages()).resolves.toEqual({
      packages: [{ name: "@autoflow/cached" }],
    });

    expect(seen.filter((r) => r.url === "/-/user/login")).toHaveLength(1);
    expect(seen.filter((r) => r.url === "/-/verdaccio/packages")).toHaveLength(
      2,
    );
  });

  it("B-11: concurrent listings share one in-flight login（单飞，不放大登录次数）", async () => {
    const controller = makeCachedController();

    await Promise.all([
      controller.listNpmPackages(),
      controller.listNpmPackages(),
    ]);

    expect(seen.filter((r) => r.url === "/-/user/login")).toHaveLength(1);
    expect(seen.filter((r) => r.url === "/-/verdaccio/packages")).toHaveLength(
      2,
    );
  });

  it("B-11: a different pass gets its own cache key（凭据轮换立即生效）", async () => {
    const controller = makeCachedController();
    await controller.listNpmPackages();
    const loginsAfterFirst = seen.filter(
      (r) => r.url === "/-/user/login",
    ).length;
    expect(loginsAfterFirst).toBe(1);

    const rotated = makeController({
      registry: {
        npm: {
          url: `http://127.0.0.1:${port}`,
          user: "svc2",
          pass: "rotated-pass",
          token: "",
        },
      },
    });
    // 轮换后的凭据登录会被 401 拒（替身只认 svc2-pass）→ B-3 语义 502。
    // 关键断言：这次**必须**重新打 login（不读旧凭据的缓存项）——登录
    // 计数从 1 涨到 2，而非复用旧 token 直接打包列表。
    await expect(rotated.listNpmPackages()).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
    });
    expect(seen.filter((r) => r.url === "/-/user/login")).toHaveLength(2);
  });
});

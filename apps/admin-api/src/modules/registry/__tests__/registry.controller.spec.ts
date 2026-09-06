import { HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import { RegistryController } from "../registry.controller";

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
  it("fails with GATEWAY_TIMEOUT within the deadline when the backend hangs", async () => {
    // Upstream that accepts the POST and never responds — the hung-backend
    // scenario the proxy must survive instead of pinning the connection.
    const server = http.createServer(() => {
      /* intentionally never respond */
    });
    const destroyAll = trackSockets(server);
    const port = await listen(server);
    const controller = new RegistryController(
      new ConfigService({
        PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
        REGISTRY_UPLOAD_TIMEOUT_MS: "300",
      }),
    );

    const startedAt = Date.now();
    await expect(
      controller.uploadPypiPackage(makeMulterFile(), "pkg", "1.0.0"),
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
    const controller = new RegistryController(
      new ConfigService({
        PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
        REGISTRY_UPLOAD_TIMEOUT_MS: "3000",
      }),
    );

    await expect(
      controller.uploadPypiPackage(makeMulterFile(), "pkg", "1.0.0"),
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
    const controller = new RegistryController(
      new ConfigService({
        PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
        REGISTRY_UPLOAD_TIMEOUT_MS: "3000",
      }),
    );

    await expect(
      controller.uploadPypiPackage(makeMulterFile(), "pkg", "1.0.0"),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });

    destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects a missing file with BAD_REQUEST before any proxying", async () => {
    const controller = new RegistryController(new ConfigService({}));
    await expect(
      controller.uploadPypiPackage(
        undefined as unknown as Express.Multer.File,
        "pkg",
        "1.0.0",
      ),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it("rejects a disallowed extension with BAD_REQUEST before any proxying", async () => {
    const controller = new RegistryController(new ConfigService({}));
    await expect(
      controller.uploadPypiPackage(
        makeMulterFile("evil", "payload.exe"),
        "pkg",
        "1.0.0",
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
    const controller = new RegistryController(
      new ConfigService({
        NPM_REGISTRY_URL: `http://127.0.0.1:${port}`,
        registry: { npm: { user: "svc", pass: "svc-pass", token: "" } },
      }),
    );

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

  it("S5: keeps the previous anonymous behavior (empty list) when no credentials are configured", async () => {
    const controller = new RegistryController(
      new ConfigService({
        NPM_REGISTRY_URL: `http://127.0.0.1:${port}`,
        registry: { npm: { user: "", pass: "", token: "" } },
      }),
    );
    (controller as unknown as { logger: Record<string, jest.Mock> }).logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    await expect(controller.listNpmPackages()).resolves.toEqual({
      packages: [],
    });
    // anonymous 401 — and the miss is explained at debug level
    expect(seen).toEqual([
      { method: "GET", url: "/-/verdaccio/packages", authorization: "" },
    ]);
    expect(
      (controller as unknown as { logger: Record<string, jest.Mock> }).logger
        .debug,
    ).toHaveBeenCalled();
  });

  it("S5: uses a pre-issued token directly without a login round-trip", async () => {
    const controller = new RegistryController(
      new ConfigService({
        NPM_REGISTRY_URL: `http://127.0.0.1:${port}`,
        registry: { npm: { user: "", pass: "", token: "svc-token" } },
      }),
    );

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

  it("S5: falls back to the empty-list behavior when the configured credentials are rejected", async () => {
    const controller = new RegistryController(
      new ConfigService({
        NPM_REGISTRY_URL: `http://127.0.0.1:${port}`,
        registry: { npm: { user: "svc", pass: "wrong", token: "" } },
      }),
    );

    await expect(controller.listNpmPackages()).resolves.toEqual({
      packages: [],
    });
    expect(seen.map((r) => r.url)).toEqual([
      "/-/user/login",
      "/-/verdaccio/packages",
    ]);
  });
});

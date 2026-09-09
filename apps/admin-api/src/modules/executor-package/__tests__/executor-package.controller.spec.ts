import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as jwt from "jsonwebtoken";
import * as request from "supertest";
import * as fs from "fs";
import * as nodePath from "path";
import { Readable } from "stream";
import axios from "axios";
import { ExecutorPackageController } from "../executor-package.controller";
import { ExecutorPackageService } from "../executor-package.service";
import { buildContentDisposition } from "../executor-package.controller";
import { ExecutorService } from "../../executor/executor.service";
import { SystemConfigService } from "../../config/config.service";
import { assertSafeExecutorUrl } from "../../../common/utils/safe-http.util";

jest.mock("../../executor/executor.service", () => ({
  ExecutorService: jest.fn(),
}));
jest.mock("axios");
jest.mock("../../../common/utils/safe-http.util");

describe("ExecutorPackageController download HTTP contract", () => {
  let app: INestApplication;
  const id = "11111111-1111-4111-8111-111111111111";
  const path = `/api/executor-packages/${id}/download`;
  const secret = "download-access-test-secret";
  const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
  const pkg = {
    id,
    name: "runner",
    version: "1.0.0",
    originalFilename: "runner.zip",
  };
  const config = new ConfigService({
    "jwt.secret": secret,
    "executor.sharedToken": "env-token",
    ADMIN_API_URL: "http://admin:3002/api/",
  });
  const systemConfig = { findOne: jest.fn() };
  // R9: the download route consumes the streaming openPackageFile contract
  // (Readable + on-disk size) instead of the old in-memory getFileBuffer.
  const openPackageFile = jest.fn<any, any>();
  const service = {
    openPackageFile,
    findOne: jest.fn().mockResolvedValue(pkg),
    configService: config,
    logger: { log: jest.fn(), warn: jest.fn() },
    pushToExecutors: ExecutorPackageService.prototype.pushToExecutors,
  };
  const streamPayload = () => ({
    stream: Readable.from([buffer]),
    fileSize: buffer.length,
    pkg,
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ExecutorPackageController],
      providers: [
        { provide: ExecutorPackageService, useValue: service },
        { provide: ConfigService, useValue: config },
        { provide: SystemConfigService, useValue: systemConfig },
        {
          provide: ExecutorService,
          useValue: {
            findAll: jest
              .fn()
              .mockResolvedValue([
                { id: "exec-1", address: "http://executor:8002" },
              ]),
          },
        },
      ],
    }).compile();
    // Keep the real class-level JWT and role guards: metadata is part of the contract.
    app = module.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    systemConfig.findOne.mockResolvedValue({ value: "db-token" });
    openPackageFile.mockResolvedValue(streamPayload());
  });
  afterAll(async () => {
    await app.close();
  });

  it("streams file bytes with the DB shared token (R9: streaming contract)", async () => {
    const response = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", "Bearer db-token")
      .expect(200);
    expect(response.body).toEqual(buffer);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="runner.zip"',
    );
    expect(response.headers["content-length"]).toBe(String(buffer.length));
    expect(openPackageFile).toHaveBeenCalledWith(id);
    expect(systemConfig.findOne).toHaveBeenCalledWith("executor.sharedToken");
  });

  it("preserves administrator access JWT downloads", async () => {
    const token = jwt.sign(
      { sub: 1, username: "admin", type: "access" },
      secret,
      { expiresIn: "15m" },
    );
    const response = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual(buffer);
  });

  it.each([
    ["missing", undefined],
    ["wrong", "Bearer wrong-token"],
    ["superseded env token", "Bearer env-token"],
    ["refresh", `Bearer ${jwt.sign({ type: "refresh" }, secret)}`],
    ["missing type", `Bearer ${jwt.sign({ sub: 1 }, secret)}`],
    [
      "expired",
      `Bearer ${jwt.sign({ type: "access" }, secret, { expiresIn: -1 })}`,
    ],
    [
      "wrong signature",
      `Bearer ${jwt.sign({ type: "access" }, "other-secret")}`,
    ],
  ])(
    "rejects %s credentials before opening the file stream",
    async (_name, header) => {
      const req = request(app.getHttpServer()).get(path);
      if (header) req.set("Authorization", header);
      const response = await req.expect(401);
      expect(response.body.message).toBe(
        "Unauthorized: package downloads require a valid access JWT or executor token",
      );
      expect(openPackageFile).not.toHaveBeenCalled();
    },
  );

  it("downloads the URL generated by the push payload using its DB credential", async () => {
    jest.mocked(assertSafeExecutorUrl).mockResolvedValue(undefined);
    jest.mocked(axios.post).mockResolvedValue({ data: {} });
    const result = await app.get(ExecutorPackageController).push(id);
    expect(result[0].success).toBe(true);
    const [, rawPayload, rawOptions] = jest.mocked(axios.post).mock.calls[0];
    const payload = rawPayload as { downloadUrl: string };
    const options = rawOptions as { headers: { Authorization: string } };
    expect(payload.downloadUrl).toBe(`http://admin:3002${path}`);
    expect(options.headers.Authorization).toBe("Bearer db-token");
    const response = await request(app.getHttpServer())
      .get(new URL(payload.downloadUrl).pathname)
      .set("Authorization", options.headers.Authorization)
      .expect(200);
    expect(response.body).toEqual(buffer);
  });

  // R9: the upload must use multer diskStorage into the service temp dir and
  // the download must stream — no whole-file buffer round-trips remain.
  it("uses multer diskStorage and streaming IO end to end (R9)", () => {
    const src = fs.readFileSync(
      nodePath.join(__dirname, "..", "executor-package.controller.ts"),
      "utf-8",
    );
    expect(src).toContain("diskStorage(");
    expect(src).not.toContain("memoryStorage(");
    expect(src).toContain("pipeline(");

    const svcSrc = fs.readFileSync(
      nodePath.join(__dirname, "..", "executor-package.service.ts"),
      "utf-8",
    );
    // streaming hash + streaming download + atomic move
    expect(svcSrc).toContain("createReadStream");
    expect(svcSrc).toContain("rename(");
    expect(svcSrc).not.toContain("writeFileSync");
    expect(svcSrc).not.toContain("readFileSync");
  });
});

// QA10: the stored originalFilename is attacker-controlled — the
// Content-Disposition header value must never carry CR/LF (header
// injection), unbalanced quotes or raw non-ASCII bytes.
describe("buildContentDisposition (QA10 sanitization)", () => {
  const build = (raw: string | null | undefined) =>
    buildContentDisposition(raw);

  it("keeps a plain ASCII filename unchanged", () => {
    expect(build("runner.zip")).toBe('attachment; filename="runner.zip"');
  });

  it("strips CR/LF and control characters (header injection)", () => {
    const out = build("evil.zip\r\nX-Injected: 1\nmore.zip");
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe('attachment; filename="evil.zipX-Injected: 1more.zip"');
  });

  it("falls back to the sanitized default for empty/whitespace-only names", () => {
    expect(build(null)).toBe('attachment; filename="download"');
    expect(build(undefined)).toBe('attachment; filename="download"');
    expect(build("")).toBe('attachment; filename="download"');
    expect(build("\r\n")).toBe('attachment; filename="download"');
  });

  it("carries a non-ASCII (Chinese) name in filename* with an ASCII fallback", () => {
    const out = build("数据包.zip");
    // legacy filename param contains no raw non-ASCII bytes
    expect(out).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"; /);
    expect(out).not.toMatch(/[^\x00-\x7f]/);
    // RFC 5987 extended parameter carries the UTF-8 percent-encoded name
    // intact (data loss is confined to the legacy ASCII fallback)
    expect(out).toBe(
      `attachment; filename=".zip"; filename*=UTF-8''${encodeURIComponent("数据包.zip")}`,
    );
  });

  it("encodes quotes and backslashes out of the quoted-string (no breakout)", () => {
    const out = build('we"ird\\name.zip');
    // CR/LF-free and the quote never terminates the quoted-string early
    expect(out).not.toMatch(/[\r\n]/);
    // non-ASCII-safe path is taken only when needed; quotes/backslash are
    // printable ASCII but excluded from the quoted-string allowlist, so the
    // RFC 5987 path must carry them.
    expect(out).toContain("filename*=UTF-8''");
    const encoded = out.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded)).toBe('we"ird\\name.zip');
  });
});

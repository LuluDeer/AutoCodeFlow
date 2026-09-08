import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { ArtifactsService } from "../artifacts.service";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { SystemConfigService } from "../../config/config.service";
import { ExecutorService } from "../../executor/executor.service";

// 机器鉴权走的是共享 token 校验工具，这里 mock 掉具体实现，只测编排逻辑。
jest.mock("../../../common/utils/verify-executor-token.util", () => ({
  verifyExecutorToken: jest.fn(),
  getExecutorSharedToken: jest.fn(),
}));
import { verifyExecutorToken } from "../../../common/utils/verify-executor-token.util";

const EXEC_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

describe("ArtifactsService（FEAT-05）", () => {
  let svc: ArtifactsService;
  let tmpRoot: string;
  let findOne: jest.Mock;
  let validateTokenByAddress: jest.Mock;
  const originalLogArtifactDir = process.env.LOG_ARTIFACT_DIR;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acf-artifacts-"));
    process.env.LOG_ARTIFACT_DIR = tmpRoot;

    findOne = jest.fn();
    validateTokenByAddress = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ArtifactsService,
        { provide: getRepositoryToken(TaskExecution), useValue: { findOne } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: SystemConfigService, useValue: { findOne: jest.fn() } },
        { provide: ExecutorService, useValue: { validateTokenByAddress } },
      ],
    }).compile();
    svc = moduleRef.get(ArtifactsService);
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (originalLogArtifactDir === undefined)
      delete process.env.LOG_ARTIFACT_DIR;
    else process.env.LOG_ARTIFACT_DIR = originalLogArtifactDir;
  });

  beforeEach(() => {
    (verifyExecutorToken as jest.Mock).mockReset();
    findOne.mockReset();
    validateTokenByAddress.mockReset();
  });

  describe("resolveArtifactPath 防路径穿越", () => {
    it("裸安全文件名解析到 <root>/<execId>/<name>", () => {
      const p = svc.resolveArtifactPath(EXEC_ID, "screenshot_01.png");
      expect(p).toBe(path.join(tmpRoot, EXEC_ID, "screenshot_01.png"));
    });
    it("拒绝 ../ 穿越", () => {
      expect(() => svc.resolveArtifactPath(EXEC_ID, "../evil.sh")).toThrow(
        BadRequestException,
      );
    });
    it("拒绝含路径分隔符的名字", () => {
      expect(() => svc.resolveArtifactPath(EXEC_ID, "a/b.png")).toThrow(
        BadRequestException,
      );
      expect(() => svc.resolveArtifactPath(EXEC_ID, "a\\b.png")).toThrow(
        BadRequestException,
      );
    });
    it("拒绝前导点/绝对路径/空名", () => {
      expect(() => svc.resolveArtifactPath(EXEC_ID, ".hidden")).toThrow(
        BadRequestException,
      );
      expect(() => svc.resolveArtifactPath(EXEC_ID, "/etc/passwd")).toThrow(
        BadRequestException,
      );
      expect(() => svc.resolveArtifactPath(EXEC_ID, "")).toThrow(
        BadRequestException,
      );
    });
    it("非 UUID executionId 抛 BadRequest", () => {
      expect(() => svc.resolveArtifactPath("not-a-uuid", "a.png")).toThrow(
        BadRequestException,
      );
    });
  });

  describe("saveArtifact / openArtifact 落盘回环", () => {
    it("写入后可读回，字节/大小/sha 一致，并回显清单条目", async () => {
      const buf = Buffer.from("hello-artifact-payload");
      const item = await svc.saveArtifact(EXEC_ID, "report.csv", buf, sha(buf));
      expect(item).toEqual({
        name: "report.csv",
        size: buf.length,
        sha256: sha(buf),
      });

      const { stream, fileSize, contentType } = await svc.openArtifact(
        EXEC_ID,
        "report.csv",
      );
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).equals(buf)).toBe(true);
      expect(fileSize).toBe(buf.length);
      expect(contentType).toBe("text/csv");
    });
    it("sha256 不符抛 BadRequest 且不留脏文件", async () => {
      const buf = Buffer.from("genuine");
      await expect(
        svc.saveArtifact(
          EXEC_ID,
          "tampered.bin",
          buf,
          sha(Buffer.from("other")),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fs.existsSync(path.join(tmpRoot, EXEC_ID, "tampered.bin"))).toBe(
        false,
      );
    });
    it("openArtifact 缺文件抛 NotFound", async () => {
      await expect(
        svc.openArtifact(EXEC_ID, "missing.txt"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("verifyUploadAuth（复用回调鉴权形态）", () => {
    it("执行行不存在 → NotFound", async () => {
      findOne.mockResolvedValue(null);
      await expect(
        svc.verifyUploadAuth(EXEC_ID, "Bearer x"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    it("共享 token 有效 → 放行", async () => {
      findOne.mockResolvedValue({
        id: EXEC_ID,
        executorAddress: "1.2.3.4:9000",
      });
      (verifyExecutorToken as jest.Mock).mockResolvedValue(undefined);
      const exec = await svc.verifyUploadAuth(EXEC_ID, "Bearer shared");
      expect(exec.id).toBe(EXEC_ID);
    });
    it("共享无效但每执行器动态 token 有效 → 放行", async () => {
      findOne.mockResolvedValue({
        id: EXEC_ID,
        executorAddress: "1.2.3.4:9000",
      });
      (verifyExecutorToken as jest.Mock).mockRejectedValue(new Error("nope"));
      validateTokenByAddress.mockResolvedValue(true);
      const exec = await svc.verifyUploadAuth(EXEC_ID, "Bearer dynamic");
      expect(exec.id).toBe(EXEC_ID);
      expect(validateTokenByAddress).toHaveBeenCalledWith(
        "1.2.3.4:9000",
        "dynamic",
      );
    });
    it("两条凭据均失败 → Unauthorized", async () => {
      findOne.mockResolvedValue({
        id: EXEC_ID,
        executorAddress: "1.2.3.4:9000",
      });
      (verifyExecutorToken as jest.Mock).mockRejectedValue(new Error("nope"));
      validateTokenByAddress.mockResolvedValue(false);
      await expect(
        svc.verifyUploadAuth(EXEC_ID, "Bearer bad"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("getManifest", () => {
    it("返回行内存清单，缺省为 []", async () => {
      findOne.mockResolvedValue({
        id: EXEC_ID,
        artifacts: [{ name: "a.png", size: 1, sha256: "x" }],
      });
      expect(await svc.getManifest(EXEC_ID)).toHaveLength(1);
      findOne.mockResolvedValue({ id: EXEC_ID, artifacts: null });
      expect(await svc.getManifest(EXEC_ID)).toEqual([]);
    });
  });
});

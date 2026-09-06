import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ExecutorPackageService } from "../executor-package.service";
import {
  ExecutorPackage,
  ExecutorPackageStatus,
} from "../executor-package.entity";
import * as fs from "fs";
import * as crypto from "crypto";
import { Readable } from "stream";
import axios from "axios";
import { ExecutorPackageController } from "../executor-package.controller";
import { assertSafeExecutorUrl } from "../../../common/utils/safe-http.util";

// The controller only needs findAll; avoid native dependencies under the fs mock.
jest.mock("../../executor/executor.service", () => ({
  ExecutorService: jest.fn(),
}));
jest.mock("axios");
jest.mock("../../../common/utils/safe-http.util");

jest.mock("fs");
const mockFs = fs as jest.Mocked<typeof fs>;

/**
 * R9: uploads arrive as on-disk temp files (multer diskStorage) and are
 * hashed by streaming. The fs module is jest-mocked, so stub the promise API
 * surface the service uses (open/stat/rename/unlink/copyFile) and wire a
 * real createReadStream to an in-memory map so the streamed checksum is
 * genuinely computed from file content.
 */
const diskFiles = new Map<string, Buffer>();

const stubFsDisk = () => {
  // jest.mock("fs") automock does not materialize the lazy `promises` getter
  // — install a full stub object for the promise API surface the service uses.
  (fs as any).promises = {
    open: jest.fn(async (p: string) => ({
      read: async (buf: Buffer) => {
        const content = diskFiles.get(p) ?? Buffer.alloc(0);
        const head = content.subarray(0, buf.length);
        head.copy(buf);
        return { bytesRead: head.length };
      },
      close: async () => undefined,
    })),
    stat: jest.fn(async (p: string) => ({
      size: (diskFiles.get(p) ?? Buffer.alloc(0)).length,
    })),
    rename: jest.fn(async (from: string, to: string) => {
      diskFiles.set(to, diskFiles.get(from) ?? Buffer.alloc(0));
      diskFiles.delete(from);
    }),
    unlink: jest.fn(async (p: string) => {
      diskFiles.delete(p);
    }),
    copyFile: jest.fn(async (from: string, to: string) => {
      diskFiles.set(to, diskFiles.get(from) ?? Buffer.alloc(0));
    }),
  };
  (fs as any).createReadStream = jest.fn((p: string) => {
    const content = diskFiles.get(p);
    if (!content) {
      return Readable.from(
        (async function* () {
          throw new Error(`ENOENT: ${p}`);
        })(),
      );
    }
    return Readable.from([content]);
  });
};

describe("ExecutorPackageService", () => {
  let service: ExecutorPackageService;
  let repo: jest.Mocked<Repository<ExecutorPackage>>;

  const UPLOAD_TMP_FILE = "/tmp/pkg-upload-tmp/upload-1";
  const mockFile: Express.Multer.File = {
    // P1: the on-disk temp content must start with the zip magic bytes
    // (PK\x03\x04) to pass the upload content validation.
    buffer: Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("fake-zip-content"),
    ]),
    originalname: "executor-v1.0.0.zip",
    mimetype: "application/zip",
    size: 1024,
    fieldname: "file",
    encoding: "7bit",
    destination: "",
    filename: "",
    // R9: diskStorage puts the upload on disk; the service consumes file.path.
    path: UPLOAD_TMP_FILE,
    stream: null as any,
  };

  const mockPkg: ExecutorPackage = {
    id: "pkg-001",
    name: "my-executor",
    version: "1.0.0",
    type: "node",
    platform: "linux",
    description: "test",
    filename: "my-executor-1.0.0-abcd1234.zip",
    filePath: "/uploads/executor-packages/my-executor-1.0.0-abcd1234.zip",
    originalFilename: "executor-v1.0.0.zip",
    mimeType: "application/zip",
    fileSize: 1024,
    checksum:
      "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
    status: ExecutorPackageStatus.ACTIVE,
    uploadedBy: "admin",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  } as any;

  beforeEach(async () => {
    mockFs.existsSync = jest.fn().mockReturnValue(true);
    mockFs.mkdirSync = jest.fn();
    diskFiles.clear();
    diskFiles.set(UPLOAD_TMP_FILE, mockFile.buffer);
    stubFsDisk();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutorPackageService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue("/uploads/executor-packages"),
          },
        },
        {
          provide: getRepositoryToken(ExecutorPackage),
          useValue: {
            findOne: jest.fn(),
            findAndCount: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            remove: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ExecutorPackageService>(ExecutorPackageService);
    repo = module.get(getRepositoryToken(ExecutorPackage));
  });

  afterEach(() => jest.clearAllMocks());

  describe("create", () => {
    it("should throw BadRequestException when no file is provided", async () => {
      await expect(
        service.create(
          { name: "x", version: "1.0", type: "node" } as any,
          null as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    // R9: the service consumes the multer diskStorage temp file (file.path).
    it("R9: rejects an upload without an on-disk temp path", async () => {
      await expect(
        service.create(
          { name: "x", version: "1.0", type: "node" } as any,
          { ...mockFile, path: "" } as any,
        ),
      ).rejects.toThrow(/diskStorage/);
    });

    it("should throw ConflictException when package already exists", async () => {
      repo.findOne.mockResolvedValue(mockPkg);
      await expect(
        service.create(
          { name: "my-executor", version: "1.0.0", type: "node" } as any,
          mockFile,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it("should create and save a new package (R9: rename from disk, streamed checksum)", async () => {
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue(mockPkg);
      repo.save.mockResolvedValue(mockPkg);

      const result = await service.create(
        { name: "my-executor", version: "1.0.0", type: "node" } as any,
        mockFile,
        "admin",
      );

      expect(result).toEqual(mockPkg);
      expect(repo.save).toHaveBeenCalled();
      // R9: the temp upload is moved into the upload dir (same-volume rename)
      const rename = (fs.promises as any).rename as jest.Mock;
      expect(rename).toHaveBeenCalledTimes(1);
      const [, dest] = rename.mock.calls[0];
      expect(dest.replace(/\\/g, "/")).toContain("uploads/executor-packages");
      expect(dest).toMatch(/[\\/]my-executor-1\.0\.0-[0-9a-f]{8}\.zip$/);
      // the file content was moved intact
      expect(diskFiles.get(dest)).toEqual(mockFile.buffer);
      // checksum recorded on the row is the SHA-256 of the file content
      const createArg = repo.create.mock.calls[0][0] as any;
      expect(createArg.checksum).toBe(
        crypto.createHash("sha256").update(mockFile.buffer).digest("hex"),
      );
    });

    it("R9: best-effort unlinks the temp upload when validation fails", async () => {
      repo.findOne.mockResolvedValue(null);
      // non-archive content on disk
      diskFiles.set(UPLOAD_TMP_FILE, Buffer.from("not-an-archive"));

      await expect(
        service.create(
          { name: "x", version: "1.0", type: "node" } as any,
          mockFile,
        ),
      ).rejects.toThrow(BadRequestException);

      const unlink = (fs.promises as any).unlink as jest.Mock;
      expect(unlink).toHaveBeenCalledWith(UPLOAD_TMP_FILE);
      expect(diskFiles.has(UPLOAD_TMP_FILE)).toBe(false);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it("R9: cleans up the temp upload when the DB save fails", async () => {
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue(mockPkg);
      repo.save.mockRejectedValue(new Error("db down"));

      await expect(
        service.create(
          { name: "x", version: "1.0", type: "node" } as any,
          mockFile,
        ),
      ).rejects.toThrow("db down");

      const unlink = (fs.promises as any).unlink as jest.Mock;
      expect(unlink).toHaveBeenCalledWith(UPLOAD_TMP_FILE);
    });

    // QA9: at save-failure time the upload has ALREADY been moved into its
    // final location — that file must be unlinked too, otherwise an orphan
    // (invisible to every listing) lingers on disk and collides with a
    // future upload of the same checksum.
    it("QA9: unlinks the moved-in-place file when the DB save fails", async () => {
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue(mockPkg);
      repo.save.mockRejectedValue(new Error("db down"));

      await expect(
        service.create(
          { name: "my-executor", version: "1.0.0", type: "node" } as any,
          mockFile,
        ),
      ).rejects.toThrow("db down");

      const rename = (fs.promises as any).rename as jest.Mock;
      const dest = rename.mock.calls[0][1] as string;
      const unlink = (fs.promises as any).unlink as jest.Mock;
      expect(unlink).toHaveBeenCalledWith(dest);
      // the orphan is gone from disk
      expect(diskFiles.has(dest)).toBe(false);
    });
  });

  // QA9: startup sweep — a crashed process or a killed 500 MB upload leaves
  // multer temp files in upload-tmp with no request path to clean them up.
  describe("QA9: onModuleInit sweeps stale upload-tmp files", () => {
    it("removes only stale regular files (keeps fresh files and directories)", async () => {
      const now = Date.now();
      (fs.promises as any).readdir = jest
        .fn()
        .mockResolvedValue(["stale.tmp", "fresh.tmp", "subdir"]);
      (fs.promises as any).stat = jest.fn(async (p: string) => {
        if (p.endsWith("stale.tmp"))
          return {
            isFile: () => true,
            mtimeMs: now - 2 * 60 * 60 * 1000,
          };
        if (p.endsWith("fresh.tmp"))
          return { isFile: () => true, mtimeMs: now };
        return { isFile: () => false, mtimeMs: now - 5 * 60 * 60 * 1000 };
      });

      await service.onModuleInit();

      const unlink = (fs.promises as any).unlink as jest.Mock;
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(String(unlink.mock.calls[0][0])).toContain("stale.tmp");
    });

    it("a sweep failure is logged and does not block bootstrap", async () => {
      (fs.promises as any).readdir = jest
        .fn()
        .mockRejectedValue(new Error("EACCES"));
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => {});

      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to sweep"),
      );
      warnSpy.mockRestore();
    });
  });

  describe("findAll", () => {
    it("should return items and total", async () => {
      repo.findAndCount.mockResolvedValue([[mockPkg], 1]);
      const result = await service.findAll({ page: 1, pageSize: 20 } as any);
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe("findOne", () => {
    it("should return package when found", async () => {
      repo.findOne.mockResolvedValue(mockPkg);
      const result = await service.findOne("pkg-001");
      expect(result).toEqual(mockPkg);
    });

    it("should throw NotFoundException when not found", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("update", () => {
    it("should update and return the package", async () => {
      repo.findOne.mockResolvedValue(mockPkg);
      repo.save.mockResolvedValue({ ...mockPkg, description: "updated" });
      const result = await service.update("pkg-001", {
        description: "updated",
      } as any);
      expect(result.description).toBe("updated");
    });

    it("should throw ConflictException on duplicate name/version", async () => {
      const otherPkg = { ...mockPkg, id: "pkg-002" };
      repo.findOne
        .mockResolvedValueOnce(mockPkg) // findOne for findOne(id)
        .mockResolvedValueOnce(otherPkg); // conflict check
      await expect(
        service.update("pkg-001", {
          name: "my-executor",
          version: "1.0.0",
          type: "node",
        } as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("remove", () => {
    it("should delete file from disk and remove from db", async () => {
      repo.findOne.mockResolvedValue(mockPkg);
      repo.remove.mockResolvedValue(mockPkg);

      await service.remove("pkg-001");

      expect((fs.promises as any).unlink).toHaveBeenCalledWith(
        mockPkg.filePath,
      );
      expect(repo.remove).toHaveBeenCalledWith(mockPkg);
    });

    it("should still remove from db even if file does not exist on disk", async () => {
      mockFs.existsSync = jest.fn().mockReturnValue(false);
      repo.findOne.mockResolvedValue(mockPkg);
      repo.remove.mockResolvedValue(mockPkg);

      await service.remove("pkg-001");

      expect((fs.promises as any).unlink).not.toHaveBeenCalled();
      expect(repo.remove).toHaveBeenCalled();
    });
  });

  describe("openPackageFile (R9 streaming download)", () => {
    it("should return a readable stream, size and pkg when file exists", async () => {
      repo.findOne.mockResolvedValue(mockPkg);
      diskFiles.set(mockPkg.filePath, Buffer.from("package-bytes"));

      const result = await service.openPackageFile("pkg-001");

      expect(result.pkg).toEqual(mockPkg);
      expect(result.fileSize).toBe("package-bytes".length);
      expect(fs.createReadStream).toHaveBeenCalledWith(mockPkg.filePath);
      // drain the stream to prove it yields the file content
      const chunks: Buffer[] = [];
      for await (const c of result.stream) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe("package-bytes");
    });

    it("should throw NotFoundException when file not on disk", async () => {
      mockFs.existsSync = jest.fn().mockReturnValue(false);
      repo.findOne.mockResolvedValue(mockPkg);
      await expect(service.openPackageFile("pkg-001")).rejects.toThrow(
        NotFoundException,
      );
      expect(fs.createReadStream).not.toHaveBeenCalled();
    });
  });

  describe("pushToExecutors", () => {
    const targets = [
      { id: "exec-001", address: "http://executor:8002" },
    ] as any;
    const config = { get: jest.fn() };
    const systemConfig = { findOne: jest.fn() };
    let controller: ExecutorPackageController;

    beforeEach(() => {
      repo.findOne.mockResolvedValue(mockPkg);
      config.get.mockImplementation((key: string) =>
        key === "ADMIN_API_URL" ? "http://host:3002/" : "env-token",
      );
      systemConfig.findOne.mockResolvedValue({ value: "db-token" });
      jest.mocked(axios.post).mockResolvedValue({ data: {} });
      jest.mocked(assertSafeExecutorUrl).mockResolvedValue(undefined);
      service = new ExecutorPackageService(repo, config as any);
      controller = new ExecutorPackageController(
        service,
        { findAll: jest.fn().mockResolvedValue(targets) } as any,
        config as any,
        systemConfig as any,
      );
    });

    it.each([
      "http://host:3002",
      "http://host:3002/",
      "http://host:3002///",
      "http://host:3002/api/",
      "http://host:3002/api/api/",
    ])("normalizes %s and sends the DB token", async (baseUrl) => {
      config.get.mockImplementation((key: string) =>
        key === "ADMIN_API_URL" ? baseUrl : "env-token",
      );
      await expect(controller.push(mockPkg.id)).resolves.toEqual([
        { executorId: "exec-001", address: targets[0].address, success: true },
      ]);
      expect(systemConfig.findOne).toHaveBeenCalledWith("executor.sharedToken");
      expect(assertSafeExecutorUrl).toHaveBeenCalledWith(targets[0].address);
      expect(axios.post).toHaveBeenCalledWith(
        "http://executor:8002/api/update-package",
        expect.objectContaining({
          packageId: mockPkg.id,
          downloadUrl:
            "http://host:3002/api/executor-packages/pkg-001/download",
          checksum: mockPkg.checksum,
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer db-token",
          }),
        }),
      );
      expect(config.get).not.toHaveBeenCalledWith(
        "ADMIN_API_BASE_URL",
        expect.anything(),
      );
    });

    it.each([undefined, "", "   "])(
      "rejects missing configuration %p before sending",
      async (baseUrl) => {
        config.get.mockReturnValue(baseUrl);
        await expect(controller.push(mockPkg.id)).rejects.toMatchObject({
          status: 503,
          message:
            "ADMIN_API_URL is not configured; cannot push executor package",
        });
        expect(axios.post).not.toHaveBeenCalled();
      },
    );

    it.each([
      "/relative",
      "ftp://host",
      "http://host?query=1",
      "http://host#fragment",
    ])("rejects invalid base URL %s before sending", async (baseUrl) => {
      config.get.mockReturnValue(baseUrl);
      await expect(controller.push(mockPkg.id)).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining("ADMIN_API_URL"),
      });
      expect(axios.post).not.toHaveBeenCalled();
    });

    it("falls back to env when the DB key is unavailable", async () => {
      systemConfig.findOne.mockRejectedValue(new Error("not found"));
      await controller.push(mockPkg.id);
      expect(axios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer env-token",
          }),
        }),
      );
    });

    it("reads the rotated DB token on the next push", async () => {
      await controller.push(mockPkg.id);
      systemConfig.findOne.mockResolvedValue({ value: "rotated-token" });
      await controller.push(mockPkg.id);
      expect(axios.post).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer rotated-token",
          }),
        }),
      );
    });

    it("keeps SSRF rejection before the outbound request", async () => {
      jest
        .mocked(assertSafeExecutorUrl)
        .mockRejectedValue(new Error("Unsafe executor URL"));
      await expect(controller.push(mockPkg.id)).resolves.toEqual([
        expect.objectContaining({
          success: false,
          error: "Unsafe executor URL",
        }),
      ]);
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  describe("deprecate / activate", () => {
    it("should set status to DEPRECATED", async () => {
      const deprecated = {
        ...mockPkg,
        status: ExecutorPackageStatus.DEPRECATED,
      };
      repo.findOne.mockResolvedValue(mockPkg);
      repo.save.mockResolvedValue(deprecated);
      const result = await service.deprecate("pkg-001");
      expect(result.status).toBe(ExecutorPackageStatus.DEPRECATED);
    });

    it("should set status to ACTIVE", async () => {
      const active = { ...mockPkg, status: ExecutorPackageStatus.ACTIVE };
      repo.findOne.mockResolvedValue({
        ...mockPkg,
        status: ExecutorPackageStatus.DEPRECATED,
      });
      repo.save.mockResolvedValue(active);
      const result = await service.activate("pkg-001");
      expect(result.status).toBe(ExecutorPackageStatus.ACTIVE);
    });
  });
});

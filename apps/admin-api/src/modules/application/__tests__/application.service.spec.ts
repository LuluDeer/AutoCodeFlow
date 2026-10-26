import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException } from "@nestjs/common";
import fs from "fs";
import * as path from "path";
import { ApplicationService } from "../application.service";
import { Application, ApplicationStatus } from "../entities/application.entity";
// 上传即产生版本：recordUploadVersion 落 application_versions（@Optional 注入）
import { ApplicationVersion } from "../entities/application-version.entity";
import { AppDeployment } from "../entities/app-deployment.entity";
import { ModuleRef } from "@nestjs/core";
import { AiService } from "../../ai/ai.service";
// ARCH-30: 应用健康分析走 AiAnalysisService 封装
import { AiAnalysisService } from "../../ai/ai-analysis.service";
import { UserRole } from "../../users/entities/user.entity";
// NETOPT-8③: remove() 的执行器清理扇出（stop + uninstall）走 axios
import { ExecutorService } from "../../executor/executor.service";
import { AuditService } from "../../audit/audit.service";
// DEEP-AUDIT B·4.3: 扇出失败通知的测试替身
import { NotificationService } from "../../notification/notification.service";
// ARCH-33（ADR-016）：控制面 pull 通道的测试替身（默认 push）
import { controlPlaneMocks } from "../../../common/testing/control-plane-mocks";

// R4/R1: deployFromGit spawns git and resolves the repo host — pin both so
// the specs never touch the network or a real binary.
jest.mock("child_process", () => ({ spawn: jest.fn() }));
jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ status: 200 }) },
}));
import axios from "axios";
import { spawn } from "child_process";
import { lookup } from "node:dns/promises";
import { EventEmitter } from "events";
const mockedSpawn = spawn as unknown as jest.Mock;
const mockedLookup = lookup as unknown as jest.Mock;

/**
 * R4: the service now uses async child_process.spawn wrapped in a Promise.
 * The fake mimics the real child surface the wrapper consumes: stdout/stderr
 * streams that emit buffered data, plus error/close events. The `result`
 * option preloads the stream payload and exit code; an `error` option
 * simulates a spawn failure (ENOENT). Timing is async so the wrapper's
 * promise path is exercised.
 */
const fakeSpawn = (opts: {
  status?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
}) => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  setImmediate(() => {
    if (opts.error) {
      child.emit("error", opts.error);
      child.emit("close", null);
      return;
    }
    if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
    child.emit("close", opts.status ?? 0);
  });
  return child;
};

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn((d: any) => d),
  save: jest.fn((e: any) => Promise.resolve(e)),
  // R54：deployFromGit 的部署头/收尾改为列级 update（ADR-026 规则 4）——假仓储必须
  // 提供 update，否则这条路径在测试里等于不存在（ADR-027 的同一教训）。
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  remove: jest.fn(),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
  // R5a：remove() 的包清理引用计数走 createQueryBuilder——缺省计数 0
  //（无其他引用，允许 unlink）；需要「仍被引用/查询失败」语义的用例用
  // overrides 覆盖。链式桩与 A-7 describe 的 versionRepo 同构。
  createQueryBuilder: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(0),
  })),
  ...overrides,
});

/**
 * R54：deployFromGit 的部署头/收尾改用**列级 update**（ADR-026 规则 4），因此
 * 「最后一次状态写入」要从 update 的 patch 读（save 的实参里已经没有它了）。
 * 没有 update 记录时回落到 save 实参，兼容尚未改写的路径。
 */
const lastStatusPatch = (
  appRepo: ReturnType<typeof makeRepo>,
): Record<string, any> => {
  const updates = (appRepo.update as jest.Mock).mock.calls;
  if (updates.length > 0) return updates[updates.length - 1]?.[1] ?? {};
  const saves = (appRepo.save as jest.Mock).mock.calls;
  return saves[saves.length - 1]?.[0] ?? {};
};

describe("ApplicationService", () => {
  let service: ApplicationService;
  let appRepo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    appRepo = makeRepo({ findOne: jest.fn() });
    const module = await Test.createTestingModule({
      providers: [
        ApplicationService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
        { provide: ModuleRef, useValue: { get: jest.fn() } },
        {
          provide: AiService,
          useValue: {
            analyzeAppHealth: jest.fn().mockResolvedValue({ aiAnalysis: "" }),
          },
        },
        // ARCH-30: AiAnalysisService 直通桩（application.analyzeHealth 不经
        // 该封装——其 AI 面是 analyzeAppHealth 非 analyzeFailure——仅补齐 DI 面）
        {
          provide: AiAnalysisService,
          useValue: { analyzeFailure: jest.fn().mockResolvedValue("") },
        },
      ],
    }).compile();
    service = module.get(ApplicationService);
  });

  describe("findAll", () => {
    it("should return applications ordered by createdAt DESC", async () => {
      const apps = [{ id: "1", name: "app1" }];
      appRepo.find.mockResolvedValue(apps);
      const result = await service.findAll();
      expect(result).toEqual(apps);
      expect(appRepo.find).toHaveBeenCalledWith({
        order: { createdAt: "DESC" },
      });
    });
  });

  describe("findById", () => {
    it("should return an application when found", async () => {
      const app = { id: "1", name: "app1" };
      appRepo.findOne.mockResolvedValue(app);
      const result = await service.findById("1");
      expect(result).toEqual(app);
    });

    it("should throw NotFoundException when not found", async () => {
      appRepo.findOne.mockResolvedValue(null);
      await expect(service.findById("nonexistent")).rejects.toThrow("不存在");
    });
  });

  // R1: env masking on the read surface — secrets stay raw in the DB
  // (executors need them at deploy time) but the HTTP read surface
  // returns '***' for password/secret/token/api_key class field names.
  describe("findById / findAll — env masking (R1)", () => {
    it("masks secret-class env keys on the read surface", async () => {
      const row = {
        id: "1",
        name: "app1",
        env: {
          DATABASE_URL: "postgres://user:pass@db/app",
          API_KEY: "sk-very-secret",
          NODE_ENV: "production",
        },
      };
      appRepo.findOne.mockResolvedValue(row);
      const result = await service.findById("1");
      expect(result.env).toEqual({
        DATABASE_URL: "postgres://user:pass@db/app",
        API_KEY: "***",
        NODE_ENV: "production",
      });
      // the underlying row is untouched (mask is a shallow clone)
      expect(row.env.API_KEY).toBe("sk-very-secret");
    });

    it("findByIdRaw bypasses masking for internal deploy/upgrade callers", async () => {
      const row = {
        id: "1",
        name: "app1",
        env: { API_KEY: "sk-very-secret", NODE_ENV: "production" },
      };
      appRepo.findOne.mockResolvedValue(row);
      const result = await service.findByIdRaw("1");
      expect(result.env.API_KEY).toBe("sk-very-secret");
    });

    it("findAll applies the mask to every row", async () => {
      const rows = [
        { id: "1", name: "a", env: { SECRET_TOKEN: "abc" } },
        { id: "2", name: "b", env: { password: "hunter2", OTHER: "x" } },
      ];
      appRepo.find.mockResolvedValue(rows);
      const result = await service.findAll();
      expect(result[0].env.SECRET_TOKEN).toBe("***");
      expect(result[1].env.password).toBe("***");
      expect(result[1].env.OTHER).toBe("x");
    });

    it("apps with no env map are returned unchanged", async () => {
      const row = { id: "1", name: "app1" };
      appRepo.findOne.mockResolvedValue(row);
      const result = await service.findById("1");
      expect(result).toEqual(row);
    });
  });

  describe("create", () => {
    it("should create an application successfully", async () => {
      appRepo.findOne.mockResolvedValue(null);
      appRepo.save.mockResolvedValue({
        id: "1",
        name: "test-app",
        status: ApplicationStatus.ACTIVE,
      });

      const result = await service.create({
        name: "test-app",
        version: "1.0.0",
        runtime: "node",
      });

      expect(result.name).toBe("test-app");
      expect(result.status).toBe(ApplicationStatus.ACTIVE);
    });

    it("should throw ConflictException when name already exists", async () => {
      appRepo.findOne.mockResolvedValue({ id: "1", name: "test-app" });
      await expect(
        service.create({ name: "test-app", version: "1.0.0", runtime: "node" }),
      ).rejects.toThrow("已存在");
    });
  });

  describe("update", () => {
    it("should update an application", async () => {
      const app = { id: "1", name: "app1", description: "" };
      appRepo.findOne.mockResolvedValue(app);
      appRepo.save.mockResolvedValue({ ...app, description: "updated" });

      const result = await service.update("1", { description: "updated" });
      expect(result.description).toBe("updated");
    });

    // R1: update() must load the RAW row. If it went through the masked
    // findById(), every env-less update (webhook version bump, upload
    // upsert) would persist '***' over the real secret values.
    // R1 的**结构解**（R61）：不带 env 的 update 现在根本不写 env 列 ——
    // 掩码副本落库从「靠先取 RAW 行规避」变成**没有这条路径**。
    it("R61: env-less update 的 patch 里根本没有 env（'***' 无路可走）", async () => {
      const row = {
        id: "1",
        name: "app1",
        env: { API_KEY: "sk-real", NODE_ENV: "prod" },
      };
      appRepo.findOne.mockResolvedValue(row);

      await service.update("1", { description: "bumped by webhook" });

      const patch = appRepo.update.mock.calls[0][1];
      expect(patch).not.toHaveProperty("env");
      expect(patch.description).toBe("bumped by webhook");
      // 其余列也不许被「顺手带回」——整行回写才会带 status/manifest/gitRepo
      expect(patch).not.toHaveProperty("status");
      expect(patch).not.toHaveProperty("manifest");
      expect(appRepo.save).not.toHaveBeenCalled();
    });

    it("R1: an admin form echoing '***' for a secret key keeps the saved raw value", async () => {
      const row = { id: "1", name: "app1", env: { API_KEY: "sk-real" } };
      appRepo.findOne.mockResolvedValue(row);

      await service.update("1", { env: { API_KEY: "***", NEW_VAR: "v" } });

      // dto 带 env 时，落库的是**合并后保留原值的** RAW env（掩码位被真实值替换）
      const patch = appRepo.update.mock.calls[0][1];
      expect(patch.env).toEqual({ API_KEY: "sk-real", NEW_VAR: "v" });
    });

    it("R1: the update RESPONSE is masked (public webhook route must never echo raw env)", async () => {
      const row = { id: "1", name: "app1", env: { API_KEY: "sk-real" } };
      appRepo.findOne.mockResolvedValue(row);

      const result = await service.update("1", { description: "d" });

      expect(result.env.API_KEY).toBe("***");
    });
  });

  // R4: gitRepo only passed a FORMAT regex before — a well-formed
  // http://169.254.169.254/... made `git clone` an SSRF first hop. The host
  // must now clear the safe-http classification BEFORE spawnSync.
  describe("deployFromGit — R1 raw write + R4 SSRF gate", () => {
    afterEach(() => {
      mockedSpawn.mockReset();
      mockedLookup.mockReset();
    });

    it("R54: DEPLOYING 只写 4 列——env 根本不进 patch（R-01 从「靠 RAW 规避」变成结构上不可能）", async () => {
      const row = { id: "1", name: "app1", env: { API_KEY: "sk-real" } };
      appRepo.findOne.mockResolvedValue(row);
      mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      const patches: Array<{ where: any; patch: any }> = [];
      appRepo.update.mockImplementation((where: any, patch: any) => {
        patches.push({ where, patch });
        return Promise.resolve({ affected: 1 });
      });
      // Clone fails fast — we only care about the FIRST write (DEPLOYING).
      mockedSpawn.mockImplementation(() =>
        fakeSpawn({ status: 128, stderr: "repository not found" }),
      );

      await expect(
        service.deployFromGit("1", "https://github.com/org/repo.git", "main"),
      ).rejects.toThrow("repository not found");

      const first = patches[0];
      // 部署头是**占位条件写**：WHERE 带 status 谓词（= 同一应用同时只允许一次部署）。
      // 旧实现是 update/save 只带 id，两次并发部署会互相覆盖 status 与 manifest。
      expect(first.where).toEqual(
        expect.objectContaining({ id: "1", status: expect.anything() }),
      );
      expect(first.patch.status).toBe(ApplicationStatus.DEPLOYING);
      expect(first.patch.gitRepo).toBe("https://github.com/org/repo.git");
      expect(first.patch.gitBranch).toBe("main");
      // 关键：env **不在 patch 里** —— 旧实现整行 save 必须靠「先取 RAW 行」来避免
      // 把掩码 '***' 落库；现在这条风险从结构上消失，不再依赖调用顺序正确。
      expect(first.patch).not.toHaveProperty("env");
      expect(first.patch).not.toHaveProperty("name");
      // 整行 save 彻底不再用于部署头写入
      expect(appRepo.save).not.toHaveBeenCalled();
    });

    it("R4: refuses a repo whose host resolves to cloud metadata — git never spawns", async () => {
      appRepo.findOne.mockResolvedValue({ id: "1", name: "app1" });
      mockedLookup.mockResolvedValue([
        { address: "169.254.169.254", family: 4 },
      ]);

      await expect(
        service.deployFromGit("1", "http://evil.example.com/r.git", "main"),
      ).rejects.toThrow(/已拒绝克隆/);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it("R4: refuses a loopback IP-literal repo URL", async () => {
      appRepo.findOne.mockResolvedValue({ id: "1", name: "app1" });

      await expect(
        service.deployFromGit("1", "http://127.0.0.1:3000/r.git", "main"),
      ).rejects.toThrow(/loopback/);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it("R4: refuses the scp-like git@127.0.0.1:path form", async () => {
      appRepo.findOne.mockResolvedValue({ id: "1", name: "app1" });

      await expect(
        service.deployFromGit("1", "git@127.0.0.1:org/repo.git", "main"),
      ).rejects.toThrow(/loopback/);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it("R4: a public repo proceeds to clone (behavior unchanged)", async () => {
      appRepo.findOne.mockResolvedValue({ id: "1", name: "app1" });
      mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      mockedSpawn.mockImplementation(() =>
        fakeSpawn({ status: 0, stdout: "deadbeef" }),
      );

      await service.deployFromGit(
        "1",
        "https://github.com/org/repo.git",
        "main",
      );

      expect(mockedSpawn).toHaveBeenCalled();
      const updates = (appRepo.update as jest.Mock).mock.calls;
      // 收尾只写 status（且带 DEPLOYING 前置），git 元信息在**部署头**那一次写里
      const header = updates[0]?.[1] ?? {};
      const settle = updates[updates.length - 1]?.[1] ?? {};
      expect(header.status).toBe(ApplicationStatus.DEPLOYING);
      expect(header.gitRepo).toBe("https://github.com/org/repo.git");
      expect(settle.status).toBe(ApplicationStatus.ACTIVE);
      expect(settle).not.toHaveProperty("gitRepo");
      // rev-parse 得到的 commit 落库（在部署头之后、clone 成功时补写）
      const withCommit = updates
        .map(([, p]: any[]) => p)
        .find((p: any) => p?.gitCommit != null);
      expect(withCommit?.gitCommit).toBe("deadbeef");
    });

    it("R4: spawn stays async — no spawnSync import remains on the event loop", async () => {
      // Regression pin: the service must use the async child_process.spawn
      // wrapper (event loop stays live during a 120s clone), not spawnSync.
      const src = fs.readFileSync(
        path.join(__dirname, "..", "application.service.ts"),
        "utf-8",
      );
      expect(src).toContain('import { spawn } from "child_process"');
      // no synchronous spawn call sites remain (doc-comment mentions excluded)
      expect(src).not.toContain("spawnSync(");
    });

    // QA8: runaway children must not balloon the admin-api heap and must not
    // survive the timeout as detached process groups.
    describe("QA8: spawnAsync output cap + process-group timeout", () => {
      const SERVICE_SRC = fs.readFileSync(
        path.join(__dirname, "..", "application.service.ts"),
        "utf-8",
      );

      it("caps stdout/stderr aggregation at 10 MB (run-command.ts parity)", () => {
        expect(SERVICE_SRC).toMatch(/const CAP = 10 \* 1024 \* 1024;/);
        // both data handlers stop appending past the cap
        expect(SERVICE_SRC).toMatch(
          /if \(stdout\.length < CAP\) stdout \+= c\.toString\("utf-8"\);/,
        );
        expect(SERVICE_SRC).toMatch(
          /if \(stderr\.length < CAP\) stderr \+= c\.toString\("utf-8"\);/,
        );
      });

      it("spawns detached on POSIX only and kills the process group on timeout", () => {
        // detached would open a console window on Windows with no kill
        // benefit there — the option must be gated to non-win32.
        expect(SERVICE_SRC).toMatch(/detached: process\.platform !== "win32"/);
        // the timeout path signals the group (negative pid) best-effort
        expect(SERVICE_SRC).toMatch(/process\.kill\(-child\.pid\)/);
      });

      it("behavior: an oversized child output resolves (capped) instead of OOM-ing", async () => {
        appRepo.findOne.mockResolvedValue({ id: "1", name: "app1" });
        mockedLookup.mockResolvedValue([
          { address: "93.184.216.34", family: 4 },
        ]);
        // 60 MB of stdout — 6x the cap. Both spawned calls (clone and
        // rev-parse) must resolve promptly with the cap in place.
        mockedSpawn
          .mockImplementationOnce(() =>
            fakeSpawn({ status: 0, stdout: "a".repeat(60 * 1024 * 1024) }),
          )
          .mockImplementationOnce(() =>
            fakeSpawn({ status: 0, stdout: "deadbeef" }),
          );

        await service.deployFromGit(
          "1",
          "https://github.com/org/repo.git",
          "main",
        );

        expect(mockedSpawn).toHaveBeenCalledTimes(2);
        const lastSave = lastStatusPatch(appRepo);
        expect(lastSave.gitCommit).toBe("deadbeef");
      });
    });
  });

  describe("remove", () => {
    it("should remove an application", async () => {
      const app = { id: "1", name: "app1" };
      appRepo.findOne.mockResolvedValue(app);
      appRepo.remove.mockResolvedValue(undefined);

      await service.remove("1");
      expect(appRepo.remove).toHaveBeenCalledWith(app);
    });

    // R18/R9c: deleting an application should best-effort unlink the local
    // package file it points at — but only when the URL resolves inside the
    // service's own uploads/packages root (arbitrary-delete guard).
    it("R9c: unlinks a local package file under uploads/packages", async () => {
      const app = {
        id: "1",
        name: "app1",
        packageUrl: "http://api.example.com/uploads/packages/my-app_123.zip",
      };
      appRepo.findOne.mockResolvedValue(app);
      appRepo.remove.mockResolvedValue(undefined);
      const unlink = jest
        .spyOn(fs.promises, "unlink")
        .mockResolvedValue(undefined);

      await service.remove("1");

      const calledPath = unlink.mock.calls[0][0] as string;
      expect(path.normalize(calledPath)).toBe(
        path.normalize(
          path.join(process.cwd(), "uploads", "packages", "my-app_123.zip"),
        ),
      );
      expect(appRepo.remove).toHaveBeenCalledWith(app);
      unlink.mockRestore();
    });

    it("R9c: does not unlink for a remote package URL outside /uploads/packages", async () => {
      const app = {
        id: "1",
        name: "app1",
        packageUrl: "http://cdn.example.com/downloads/whatever.zip",
      };
      appRepo.findOne.mockResolvedValue(app);
      appRepo.remove.mockResolvedValue(undefined);
      const unlink = jest
        .spyOn(fs.promises, "unlink")
        .mockResolvedValue(undefined);

      await service.remove("1");

      expect(unlink).not.toHaveBeenCalled();
      unlink.mockRestore();
    });

    it("R9c: refuses traversal attempts out of the upload root", async () => {
      const app = {
        id: "1",
        name: "app1",
        packageUrl:
          "http://api.example.com/uploads/packages/..%2F..%2Fsecrets.txt",
      };
      appRepo.findOne.mockResolvedValue(app);
      appRepo.remove.mockResolvedValue(undefined);
      const unlink = jest
        .spyOn(fs.promises, "unlink")
        .mockResolvedValue(undefined);

      await service.remove("1");

      expect(unlink).not.toHaveBeenCalled();
      expect(appRepo.remove).toHaveBeenCalledWith(app);
      unlink.mockRestore();
    });

    it("R9c: a failed unlink does not block the DB deletion", async () => {
      const app = {
        id: "1",
        name: "app1",
        packageUrl: "http://api.example.com/uploads/packages/app.zip",
      };
      appRepo.findOne.mockResolvedValue(app);
      appRepo.remove.mockResolvedValue(undefined);
      const unlink = jest
        .spyOn(fs.promises, "unlink")
        .mockRejectedValue(new Error("EBUSY"));

      await expect(service.remove("1")).resolves.toBeUndefined();
      expect(appRepo.remove).toHaveBeenCalledWith(app);
      unlink.mockRestore();
    });
  });

  describe("findByNameWithSecret", () => {
    it("returns null when app does not exist", async () => {
      // createQueryBuilder chain
      const qb = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      (appRepo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.findByNameWithSecret("nonexistent");
      expect(result).toBeNull();
      expect(qb.addSelect).toHaveBeenCalledWith("app.webhookSecret");
      expect(qb.where).toHaveBeenCalledWith("app.name = :name", {
        name: "nonexistent",
      });
    });

    it("returns app with webhookSecret loaded", async () => {
      const appWithSecret = {
        id: "1",
        name: "my-app",
        webhookSecret: "s3cr3t",
      };
      const qb = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(appWithSecret),
      };
      (appRepo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.findByNameWithSecret("my-app");
      expect(result).toEqual(appWithSecret);
      expect(result?.webhookSecret).toBe("s3cr3t");
    });
  });

  // W-21 (windows-findings): the manifest auto-registration path passed
  // requirements through a `taskService.create({...} as any)` payload while
  // the entity had no column — silently dropped. Now it persists, so pin the
  // passthrough + the per-task error isolation against future refactors.
  describe("syncTasksFromManifest (W-21 requirements passthrough)", () => {
    it("forwards taskDef.requirements to TaskService.create", async () => {
      appRepo.findOne.mockResolvedValue({
        id: "app-1",
        manifest: {
          runtime: "python",
          tasks: [
            { id: "t1", name: "task-one", requirements: ["requests>=2.31"] },
            { id: "t2", name: "task-two" },
          ],
        },
      });
      const created: Array<Record<string, unknown>> = [];
      (service as any)._taskService = {
        create: jest.fn(async (dto: Record<string, unknown>) => {
          created.push(dto);
          return { id: dto.id };
        }),
      };

      const count = await service.syncTasksFromManifest("app-1");

      expect(count).toBe(2);
      expect(created[0].requirements).toEqual(["requests>=2.31"]);
      expect(created[0].runtime).toBe("python"); // manifest-level default applied
      expect(created[1].requirements).toBeUndefined();
    });

    it("an 'already exists' task does not abort the remaining registrations", async () => {
      appRepo.findOne.mockResolvedValue({
        id: "app-1",
        manifest: {
          runtime: "node",
          tasks: [{ id: "dup" }, { id: "fresh", requirements: ["left-pad"] }],
        },
      });
      const create = jest
        .fn()
        .mockRejectedValueOnce(new Error('Task with id "dup" already exists'))
        .mockImplementationOnce(async (dto: Record<string, unknown>) => ({
          id: dto.id,
        }));
      (service as any)._taskService = { create };

      const count = await service.syncTasksFromManifest("app-1");

      expect(count).toBe(1);
      expect(create).toHaveBeenCalledTimes(2);
      expect(
        (create.mock.calls[1][0] as Record<string, unknown>).requirements,
      ).toEqual(["left-pad"]);
    });

    // QA-02 phase 2: manifestPath 文件分支与「无 manifest 可用」早退分支。
    it("reads a manifest from an explicit file path when provided", async () => {
      const manifestPath = path.join(__dirname, "manifest.fixture.json");
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          runtime: "python",
          tasks: [{ id: "file-task", name: "from-file" }],
        }),
      );
      try {
        appRepo.findOne.mockResolvedValue({ id: "app-1", manifest: null });
        const create = jest.fn().mockResolvedValue({ id: "file-task" });
        (service as any)._taskService = { create };

        const count = await service.syncTasksFromManifest(
          "app-1",
          manifestPath,
        );

        expect(count).toBe(1);
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({ id: "file-task", runtime: "python" }),
        );
      } finally {
        fs.unlinkSync(manifestPath);
      }
    });

    it("returns 0 when neither a path nor a stored manifest is available", async () => {
      appRepo.findOne.mockResolvedValue({ id: "app-1", manifest: null });
      expect(await service.syncTasksFromManifest("app-1")).toBe(0);
    });

    it("returns 0 when the manifest has no tasks array or no taskService", async () => {
      appRepo.findOne.mockResolvedValue({
        id: "app-1",
        manifest: { runtime: "node" },
      });
      (service as any)._taskService = { create: jest.fn() };
      expect(await service.syncTasksFromManifest("app-1")).toBe(0);

      // tasks 数组在但 taskService 未接入 → 早退 0
      appRepo.findOne.mockResolvedValue({
        id: "app-1",
        manifest: { tasks: [{ id: "t" }] },
      });
      (service as any)._taskService = null;
      expect(await service.syncTasksFromManifest("app-1")).toBe(0);
    });
  });

  // ============================================================================
  // QA-02 第二阶段（branches 冲 75）：application.service 剩余分支定向补测。
  // 范围：analyzeHealth 统计聚合、deployFromGit manifest 自动注册、
  // resolveLocalPackagePath 防御矩阵、spawnAsync error/信号退出分支。
  // 全部断言具体行为，无凑数弱断言。
  // ============================================================================

  describe("analyzeHealth — aggregation branches (QA-02 phase 2)", () => {
    it("aggregates per-task stats and flags critical tasks (successRate<50, totalRuns>3)", async () => {
      appRepo.findOne.mockResolvedValue({
        id: "app-1",
        name: "my-app",
        env: { API_KEY: "sk" },
      });
      const findAll = jest.fn().mockResolvedValue({
        items: [
          { id: "t1", name: "healthy" },
          { id: "t2", name: "critical" },
        ],
      });
      const stats = jest
        .fn()
        .mockResolvedValueOnce({
          successRate: 95,
          avgDuration: 100,
          totalRuns: 10,
        })
        .mockResolvedValueOnce({
          successRate: 20,
          avgDuration: 800,
          totalRuns: 5,
        });
      (service as any)._taskService = { findAll, getExecutionStats: stats };
      (service as any).aiService.analyzeAppHealth = jest
        .fn()
        .mockResolvedValue("looks mostly fine");

      const result = await service.analyzeHealth("app-1");

      expect(result.stats.totalTasks).toBe(2);
      expect(result.stats.avgSuccessRate).toBe(57.5); // round((95+20)/2*10)/10
      expect(result.stats.avgDuration).toBe(450);
      expect(result.stats.criticalTasks).toEqual(["critical"]);
      expect(result.analysis).toBe("looks mostly fine");
    });

    it("falls back to neutral stats (100% / 0ms) when every task stats lookup fails", async () => {
      appRepo.findOne.mockResolvedValue({ id: "app-1", name: "my-app" });
      const findAll = jest.fn().mockResolvedValue({
        items: [{ id: "t1", name: "never-ran" }],
      });
      const stats = jest
        .fn()
        .mockRejectedValue(new Error("stats backend down"));
      (service as any)._taskService = { findAll, getExecutionStats: stats };

      const result = await service.analyzeHealth("app-1");

      expect(result.stats.avgSuccessRate).toBe(100);
      expect(result.stats.avgDuration).toBe(0);
      expect(result.stats.criticalTasks).toEqual([]);
    });

    it("renders a degraded analysis string when the AI returns empty", async () => {
      appRepo.findOne.mockResolvedValue({ id: "app-1", name: "my-app" });
      (service as any)._taskService = {
        findAll: jest.fn().mockResolvedValue({ items: [] }),
      };
      (service as any).aiService.analyzeAppHealth = jest
        .fn()
        .mockResolvedValue("");

      const result = await service.analyzeHealth("app-1");
      expect(result.analysis).toBe(
        "AI analysis not available (AI provider not configured).",
      );
    });
  });

  describe("deployFromGit — manifest auto-registration and clone error paths (QA-02 phase 2)", () => {
    afterEach(() => {
      mockedSpawn.mockReset();
      mockedLookup.mockReset();
    });

    it("rejects an invalid git branch name before any spawn", async () => {
      appRepo.findOne.mockResolvedValue({ id: "1", name: "app1" });
      await expect(
        service.deployFromGit(
          "1",
          "https://github.com/o/r.git",
          "bad branch; rm -rf",
        ),
      ).rejects.toThrow(/git 分支名非法/);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it("rejects a malformed git repo URL (format gate)", async () => {
      appRepo.findOne.mockResolvedValue({ id: "1", name: "app1" });
      await expect(
        service.deployFromGit("1", "not-a-url", "main"),
      ).rejects.toThrow(/git 仓库 URL 非法/);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it("auto-registers manifest tasks after a successful clone and honors manifest defaults", async () => {
      const tmpRoot = path.join(__dirname, "deploy-fixture");
      fs.mkdirSync(tmpRoot, { recursive: true });
      const manifestFile = path.join(tmpRoot, "manifest.json");
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({
          runtime: "python",
          entrypoint: "run.py",
          timeout: 600,
          tasks: [
            { id: "mt1", name: "manifest-task-one", cron: "0 5 * * *" },
            { id: "mt2" },
          ],
        }),
      );
      appRepo.findOne.mockResolvedValue({
        id: "1",
        name: "app1",
        runtime: "node",
        entrypoint: "index.js",
        gitCommit: null,
      });
      const create = jest
        .fn()
        .mockRejectedValueOnce(new Error('Task with id "mt1" already exists'))
        .mockResolvedValueOnce({ id: "mt2" });
      (service as any)._taskService = { create };
      // 让 mkdtempSync 命中我们的 fixture 目录：spy 临时目录创建。
      const mkdtempSpy = jest
        .spyOn(fs, "mkdtempSync")
        .mockReturnValue(tmpRoot as unknown as string);
      const rmSpy = jest.spyOn(fs, "rmSync").mockImplementation(() => {});
      mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      mockedSpawn
        .mockImplementationOnce(() => fakeSpawn({ status: 0, stdout: "" }))
        .mockImplementationOnce(() =>
          fakeSpawn({ status: 0, stdout: "deadbeef" }),
        );

      try {
        await service.deployFromGit("1", "https://github.com/o/r.git", "main");
      } finally {
        // 清理 fixture（rmSpy 屏蔽了服务自身的清理调用）
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        mkdtempSpy.mockRestore();
        rmSpy.mockRestore();
      }

      const created = create.mock.calls.map(
        (c: any[]) => c[0] as Record<string, unknown>,
      );
      expect(created).toHaveLength(2);
      // 任务级字段缺省时回退 manifest 级默认
      expect(created[0]).toMatchObject({
        id: "mt1",
        runtime: "python",
        entrypoint: "run.py",
        timeout: 600,
        applicationId: "1",
      });
      expect(created[1].name).toBe("mt2");
      // already-exists 仅 warn 不中断（第二个任务仍被注册），终态 ACTIVE
      const lastSave = lastStatusPatch(appRepo);
      expect(lastSave.status).toBe(ApplicationStatus.ACTIVE);
      expect(lastSave.gitCommit).toBe("deadbeef");
    });

    it("surfaces a rev-parse failure as a deployment failure (status=FAILED)", async () => {
      appRepo.findOne.mockResolvedValue({ id: "1", name: "app1" });
      mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      mockedSpawn
        .mockImplementationOnce(() => fakeSpawn({ status: 0, stdout: "" }))
        .mockImplementationOnce(() => fakeSpawn({ status: 128 }));
      const rmSpy = jest.spyOn(fs, "rmSync").mockImplementation(() => {});

      try {
        await expect(
          service.deployFromGit("1", "https://github.com/o/r.git", "main"),
        ).rejects.toThrow("git rev-parse HEAD 执行失败");
      } finally {
        rmSpy.mockRestore();
      }
      const lastSave = lastStatusPatch(appRepo);
      expect(lastSave.status).toBe(ApplicationStatus.FAILED);
    });

    it("spawnAsync: a spawn error event resolves with status -1 and the error message", async () => {
      appRepo.findOne.mockResolvedValue({ id: "1", name: "app1" });
      mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      mockedSpawn.mockImplementation(() =>
        fakeSpawn({ error: new Error("spawn git ENOENT") }),
      );
      const rmSpy = jest.spyOn(fs, "rmSync").mockImplementation(() => {});

      try {
        await expect(
          service.deployFromGit("1", "https://github.com/o/r.git", "main"),
        ).rejects.toThrow(/spawn git ENOENT/);
      } finally {
        rmSpy.mockRestore();
      }
    });

    it("spawnAsync: a signal-killed clone (close code null) resolves as -1 and fails the clone", async () => {
      appRepo.findOne.mockResolvedValue({ id: "1", name: "app1" });
      mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      // 模拟信号击杀：'close' 事件带 null code —— finish(code ?? -1) → -1。
      // 这里不用 fakeSpawn（其 `opts.status ?? 0` 会把 null 变 0），改为内联
      // 构造一个 close(null) 的 child。
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: jest.Mock;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      setImmediate(() => child.emit("close", null));
      mockedSpawn.mockImplementation(() => child);
      const rmSpy = jest.spyOn(fs, "rmSync").mockImplementation(() => {});

      try {
        await expect(
          service.deployFromGit("1", "https://github.com/o/r.git", "main"),
        ).rejects.toThrow(/git clone failed/);
        const lastSave = lastStatusPatch(appRepo);
        expect(lastSave.status).toBe(ApplicationStatus.FAILED);
      } finally {
        rmSpy.mockRestore();
      }
    });
  });

  describe("remove — resolveLocalPackagePath defense matrix (QA-02 phase 2)", () => {
    it.each([
      ["ftp scheme", "ftp://cdn.example.com/uploads/packages/a.zip"],
      [
        "nested path under the marker",
        "http://api.example.com/uploads/packages/nested/a.zip",
      ],
      [
        "backslash traversal",
        "http://api.example.com/uploads/packages/..%5C..%5Csecret.txt",
      ],
    ])("refuses unlink for %s", async (_label, packageUrl) => {
      const app = { id: "1", name: "app1", packageUrl };
      appRepo.findOne.mockResolvedValue(app);
      const unlink = jest
        .spyOn(fs.promises, "unlink")
        .mockResolvedValue(undefined);

      await service.remove("1");
      expect(unlink).not.toHaveBeenCalled();
      unlink.mockRestore();
    });

    it("unlinks a resolved package file and still removes the app row", async () => {
      const app = {
        id: "1",
        name: "app1",
        packageUrl: "http://api.example.com/uploads/packages/clean.zip",
      };
      appRepo.findOne.mockResolvedValue(app);
      const unlink = jest
        .spyOn(fs.promises, "unlink")
        .mockResolvedValue(undefined);

      await service.remove("1");
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(appRepo.remove).toHaveBeenCalledWith(app);
      unlink.mockRestore();
    });
  });
});

// -------------------------------------------------------------------------
// R5a（评审 §4.5/§九 5a）：内容寻址包存储的应用删除清理——remove() 在级联
// 删除前枚举当前行 + 版本快照钉住的全部 packageUrl，删行后按「无其他引用」
// 逐 URL 清理（其他应用行手填 packageUrl 指进本应用子树时不误删），并
// best-effort 回收空 <sha256>/<appId> 目录。旧扁平文件/旧 URL 行为不变。
// -------------------------------------------------------------------------
describe("ApplicationService.remove — R5a 内容寻址包清理", () => {
  const SHA_A = "a".repeat(64);
  const SHA_B = "b".repeat(64);
  const URL_A = `http://api.example.com/uploads/packages/app-1/${SHA_A}/pkg.zip`;
  const URL_B = `http://api.example.com/uploads/packages/app-1/${SHA_B}/pkg.zip`;
  const FLAT_URL = "http://api.example.com/uploads/packages/Demo_123.zip";
  const PKG_ROOT = path.normalize(
    path.join(process.cwd(), "uploads", "packages"),
  );
  const localPathFor = (url: string) =>
    path.join(PKG_ROOT, ...url.split("/uploads/packages/")[1].split("/"));

  const admin = { id: 1, role: UserRole.ADMIN };

  /** 装配：appRepo 可覆写（引用计数语义），versionRepo 可选注入。 */
  const buildSvc = async (
    appRepoOverrides: Partial<Record<string, jest.Mock>> = {},
    versionRepo: {
      find: jest.Mock;
      createQueryBuilder: jest.Mock;
    } | null = null,
  ) => {
    const repo = makeRepo({ findOne: jest.fn(), ...appRepoOverrides });
    const providers: unknown[] = [
      ApplicationService,
      { provide: getRepositoryToken(Application), useValue: repo },
      { provide: ModuleRef, useValue: { get: jest.fn() } },
      {
        provide: AiService,
        useValue: {
          analyzeAppHealth: jest.fn().mockResolvedValue({ aiAnalysis: "" }),
        },
      },
      {
        provide: AiAnalysisService,
        useValue: { analyzeFailure: jest.fn().mockResolvedValue("") },
      },
    ];
    if (versionRepo) {
      providers.push({
        provide: getRepositoryToken(ApplicationVersion),
        useValue: versionRepo,
      });
    }
    const module = await Test.createTestingModule({
      providers: providers as never,
    }).compile();
    return { svc: module.get(ApplicationService), appRepo: repo };
  };

  const appRow = (packageUrl: string | null) =>
    ({
      id: "app-1",
      name: "Demo",
      ownerUserId: 1,
      packageUrl,
    }) as Application;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("当前行嵌套包被清理，且空 <sha256>/<appId> 目录被回收（根目录不动）", async () => {
    const unlinkSpy = jest
      .spyOn(fs.promises, "unlink")
      .mockResolvedValue(undefined);
    // spyOn 对已安装的 spy 幂等——清历史调用，断言与本用例一一对应。
    unlinkSpy.mockClear();
    const rmdirSpy = jest
      .spyOn(fs.promises, "rmdir")
      .mockResolvedValue(undefined as never);
    const { svc, appRepo } = await buildSvc();
    appRepo.findOne.mockResolvedValue(appRow(URL_A));

    await svc.remove("app-1", admin);

    expect(appRepo.remove).toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledWith(localPathFor(URL_A));
    expect(rmdirSpy).toHaveBeenCalledWith(path.join(PKG_ROOT, "app-1", SHA_A));
    expect(rmdirSpy).toHaveBeenCalledWith(path.join(PKG_ROOT, "app-1"));
    expect(rmdirSpy).not.toHaveBeenCalledWith(PKG_ROOT);
  });

  it("快照钉住的 URL 一并清理；同字节多版本共享路径去重后只删一次", async () => {
    const unlinkSpy = jest
      .spyOn(fs.promises, "unlink")
      .mockResolvedValue(undefined);
    unlinkSpy.mockClear();
    // URL_A 同时是当前行与两条快照的值（同字节重传/多版本同包），URL_B 仅被
    // 一条快照钉住——去重后各删一次。
    const versionRepo = {
      find: jest
        .fn()
        .mockResolvedValue([
          { snapshot: { packageUrl: URL_A } },
          { snapshot: { packageUrl: URL_A } },
          { snapshot: { packageUrl: URL_B } },
        ]),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      })),
    };
    const { svc, appRepo } = await buildSvc({}, versionRepo);
    appRepo.findOne.mockResolvedValue(appRow(URL_A));

    await svc.remove("app-1", admin);

    expect(unlinkSpy).toHaveBeenCalledTimes(2);
    expect(unlinkSpy).toHaveBeenCalledWith(localPathFor(URL_A));
    expect(unlinkSpy).toHaveBeenCalledWith(localPathFor(URL_B));
  });

  it("URL 仍被其他应用行引用时不删（宁留孤儿，不误删）", async () => {
    const unlinkSpy = jest
      .spyOn(fs.promises, "unlink")
      .mockResolvedValue(undefined);
    // 全局引用计数（applications.packageUrl）命中 1——别的应用手填了同一 URL。
    const { svc, appRepo } = await buildSvc({
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(1),
      })),
    });
    appRepo.findOne.mockResolvedValue(appRow(URL_A));

    await svc.remove("app-1", admin);

    expect(appRepo.remove).toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("引用计数查询失败按有引用处理（不删，删除主链不受影响）", async () => {
    const unlinkSpy = jest
      .spyOn(fs.promises, "unlink")
      .mockResolvedValue(undefined);
    const { svc, appRepo } = await buildSvc({
      createQueryBuilder: jest.fn(() => {
        throw new Error("db down");
      }),
    });
    appRepo.findOne.mockResolvedValue(appRow(URL_A));

    await expect(svc.remove("app-1", admin)).resolves.toBeUndefined();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("旧扁平 URL 仍被清理（兼容），且不回收 uploads/packages 根目录", async () => {
    const unlinkSpy = jest
      .spyOn(fs.promises, "unlink")
      .mockResolvedValue(undefined);
    const rmdirSpy = jest
      .spyOn(fs.promises, "rmdir")
      .mockResolvedValue(undefined as never);
    const { svc, appRepo } = await buildSvc();
    appRepo.findOne.mockResolvedValue(appRow(FLAT_URL));

    await svc.remove("app-1", admin);

    expect(unlinkSpy).toHaveBeenCalledWith(localPathFor(FLAT_URL));
    expect(rmdirSpy).not.toHaveBeenCalled();
  });

  it("快照枚举失败时降级为只清当前行 URL（绝不阻断删除主链）", async () => {
    const unlinkSpy = jest
      .spyOn(fs.promises, "unlink")
      .mockResolvedValue(undefined);
    const versionRepo = {
      find: jest.fn().mockRejectedValue(new Error("db down")),
      // 引用计数链桩（返回 0：无其他引用，允许清理当前行 URL）
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      })),
    };
    const { svc, appRepo } = await buildSvc({}, versionRepo);
    appRepo.findOne.mockResolvedValue(appRow(URL_A));

    await expect(svc.remove("app-1", admin)).resolves.toBeUndefined();
    expect(unlinkSpy).toHaveBeenCalledWith(localPathFor(URL_A));
  });
});

// NETOPT-8③: 应用删除不再静默——admin 侧 remove() 在 DB 删除完成后对
// 「有部署的执行器」best-effort 并行扇出：先逐部署 POST /app-stop（既有
// 端点），再 POST /app-uninstall（新端点）。执行器全挂 / 旧版 404 都只
// warn，绝不影响删除主流程（应用行此时已删除）。
describe("ApplicationService.remove — executor cleanup fanout (NETOPT-8③)", () => {
  let service: ApplicationService;
  let appRepo: ReturnType<typeof makeRepo>;
  let deploymentRepo: { find: jest.Mock; findOne: jest.Mock };
  let executorService: {
    getExecutorUrl: jest.Mock;
    getSharedToken: jest.Mock;
    // ARCH-33（ADR-016）：清理扇出先判传输方式（默认 push）
    resolveExecutorTransport: jest.Mock;
    enqueueExecutorCommand: jest.Mock;
  };
  const mockedAxiosPost = (axios as unknown as { post: jest.Mock }).post;

  beforeEach(async () => {
    appRepo = makeRepo();
    // A-5: remove() 前置的在途校验也走 deploymentRepo.findOne（无在途行 → null）
    deploymentRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    executorService = {
      getExecutorUrl: jest.fn(
        (addr: string, p: string) => `http://${addr}/${p}`,
      ),
      getSharedToken: jest.fn().mockResolvedValue("shared-token"),
      ...controlPlaneMocks(),
    };
    // assertAndPinExecutorUrl 的 DNS 解析桩（public IP → 放行）
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mockedAxiosPost.mockReset();
    mockedAxiosPost.mockResolvedValue({ status: 200 });
    const module = await Test.createTestingModule({
      providers: [
        ApplicationService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
        {
          provide: getRepositoryToken(AppDeployment),
          useValue: deploymentRepo,
        },
        { provide: ExecutorService, useValue: executorService },
        { provide: ModuleRef, useValue: { get: jest.fn() } },
        {
          provide: AiService,
          useValue: { analyzeAppHealth: jest.fn().mockResolvedValue("") },
        },
        {
          provide: AiAnalysisService,
          useValue: { analyzeFailure: jest.fn().mockResolvedValue("") },
        },
      ],
    }).compile();
    service = module.get(ApplicationService);
  });

  const appRow = () =>
    ({
      id: "app-1",
      name: "Demo",
      ownerUserId: null,
      packageUrl: null,
    }) as Application;

  it("删除路径会先逐部署 app-stop 再 app-uninstall（同地址执行器去重扇出）", async () => {
    appRepo.findOne.mockResolvedValue(appRow());
    deploymentRepo.find.mockResolvedValue([
      { id: "dep-1", executorAddress: "exec-1:8100" },
      { id: "dep-2", executorAddress: "exec-1:8100" },
    ]);

    await service.remove("app-1", { id: 1, role: UserRole.ADMIN });

    // 顺序：stop(dep-1) → stop(dep-2) → uninstall(app-1)
    expect(mockedAxiosPost).toHaveBeenCalledTimes(3);
    expect(mockedAxiosPost.mock.calls[0][0]).toContain("/api/app-stop");
    expect(mockedAxiosPost.mock.calls[0][1]).toEqual({ deploymentId: "dep-1" });
    expect(mockedAxiosPost.mock.calls[1][0]).toContain("/api/app-stop");
    expect(mockedAxiosPost.mock.calls[1][1]).toEqual({ deploymentId: "dep-2" });
    expect(mockedAxiosPost.mock.calls[2][0]).toContain("/api/app-uninstall");
    expect(mockedAxiosPost.mock.calls[2][1]).toEqual({ appId: "app-1" });
    // 通道/凭据形态与 app-deployment stop() 同源：Bearer sharedToken + 禁重定向
    expect(mockedAxiosPost.mock.calls[2][2]).toEqual(
      expect.objectContaining({
        maxRedirects: 0,
        headers: { Authorization: "Bearer shared-token" },
      }),
    );
    // 部署行查询发生在 DB 删除之前（CASCADE 后就查不到了）
    expect(deploymentRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { applicationId: "app-1" } }),
    );
    expect(appRepo.remove).toHaveBeenCalled();
  });

  // R32-C1（类别 1「按 address vs 按 id 取」）：部署行自带 executorId（deploy 时
  // 写入），但扇出此前只 select executorAddress → 按地址分组 + 按地址解析传输。
  // ADR-017 §5 允许 pull 同址多行并存，于是那两条退化成：
  //   ① resolveExecutorTransport 只给 address → findOne({where:{address}}) 首行
  //      获胜 → 清理命令进到**另一台**的队列；
  //   ② 同址两台被折叠成一个目标 → 第二台永远收不到自己的 stop/uninstall。
  // 反证：把 select 的 executorId 去掉、或把分组键改回 address，本用例即转红。
  it("同址两台（executorId 不同）按行身份各自扇出：不合并、不串队", async () => {
    appRepo.findOne.mockResolvedValue(appRow());
    deploymentRepo.find.mockResolvedValue([
      { id: "dep-a1", executorId: "exec-a", executorAddress: "shared:8100" },
      { id: "dep-b1", executorId: "exec-b", executorAddress: "shared:8100" },
    ]);
    // pull 模式：每台都从自己的队列取件。
    executorService.resolveExecutorTransport.mockImplementation(
      async (opts: { executorId?: string | null; address?: string }) => ({
        mode: "pull",
        executor: { id: opts.executorId ?? `addr:${opts.address}` },
      }),
    );

    await service.remove("app-1", { id: 1, role: UserRole.ADMIN });

    // ① 传输解析带上了行身份（不再只给 address）。
    expect(
      executorService.resolveExecutorTransport.mock.calls
        .map((c: any[]) => c[0].executorId)
        .sort(),
    ).toEqual(["exec-a", "exec-b"]);
    // ② 每台的命令只进自己的队列，两台都被清理。
    const enq = executorService.enqueueExecutorCommand.mock.calls;
    expect(enq).toContainEqual([
      "exec-a",
      "app-stop",
      { deploymentId: "dep-a1" },
    ]);
    expect(enq).toContainEqual([
      "exec-b",
      "app-stop",
      { deploymentId: "dep-b1" },
    ]);
    expect(enq).toContainEqual(["exec-a", "app-uninstall", { appId: "app-1" }]);
    expect(enq).toContainEqual(["exec-b", "app-uninstall", { appId: "app-1" }]);
    // ③ 不串队（修复前 B 的部署会被塞进 A 的队列）。
    expect(enq).not.toContainEqual([
      "exec-a",
      "app-stop",
      { deploymentId: "dep-b1" },
    ]);
  });

  it("执行器全挂时应用仍被删且 remove() 不抛错", async () => {
    appRepo.findOne.mockResolvedValue(appRow());
    deploymentRepo.find.mockResolvedValue([
      { id: "dep-1", executorAddress: "exec-1:8100" },
    ]);
    mockedAxiosPost.mockRejectedValue(new Error("connect timeout"));

    await expect(
      service.remove("app-1", { id: 1, role: UserRole.ADMIN }),
    ).resolves.toBeUndefined();
    expect(appRepo.remove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "app-1" }),
    );
  });

  it("旧版执行器对 app-uninstall 返回 404 仍不影响删除主流程", async () => {
    appRepo.findOne.mockResolvedValue(appRow());
    deploymentRepo.find.mockResolvedValue([
      { id: "dep-1", executorAddress: "exec-1:8100" },
    ]);
    mockedAxiosPost.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/app-uninstall")) {
        throw Object.assign(new Error("Request failed with status code 404"), {
          response: { status: 404 },
        });
      }
      return { status: 200 };
    });

    await expect(
      service.remove("app-1", { id: 1, role: UserRole.ADMIN }),
    ).resolves.toBeUndefined();
    // stop 仍发出（旧执行器支持），uninstall 失败被吞
    expect(mockedAxiosPost.mock.calls[0][0]).toContain("/api/app-stop");
    expect(appRepo.remove).toHaveBeenCalled();
  });

  it("无部署行时不发任何执行器请求", async () => {
    appRepo.findOne.mockResolvedValue(appRow());
    deploymentRepo.find.mockResolvedValue([]);

    await service.remove("app-1", { id: 1, role: UserRole.ADMIN });
    expect(mockedAxiosPost).not.toHaveBeenCalled();
    expect(appRepo.remove).toHaveBeenCalled();
  });

  it("部署行查询失败时跳过扇出但应用照删（best-effort）", async () => {
    appRepo.findOne.mockResolvedValue(appRow());
    deploymentRepo.find.mockRejectedValue(new Error("db down"));

    await expect(
      service.remove("app-1", { id: 1, role: UserRole.ADMIN }),
    ).resolves.toBeUndefined();
    expect(mockedAxiosPost).not.toHaveBeenCalled();
    expect(appRepo.remove).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DEEP-AUDIT B·4.3: 扇出清理结果**可观测**——per-台成功/失败聚合后落审计
// （application.remove.fanout），有失败附一条告警通知；通知/审计故障均
// fail-open，绝不影响删除主链。
// ---------------------------------------------------------------------------
describe("ApplicationService.remove — fanout audit + notify (DEEP-AUDIT B·4.3)", () => {
  let service: ApplicationService;
  let appRepo: ReturnType<typeof makeRepo>;
  let deploymentRepo: { find: jest.Mock; findOne: jest.Mock };
  let executorService: {
    getExecutorUrl: jest.Mock;
    getSharedToken: jest.Mock;
    resolveExecutorTransport: jest.Mock;
    enqueueExecutorCommand: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let notifier: { sendAll: jest.Mock };
  const mockedAxiosPost = (axios as unknown as { post: jest.Mock }).post;

  const assemble = async (axiosImpl?: () => Promise<unknown>) => {
    appRepo = makeRepo();
    // A-5: remove() 前置的在途校验也走 deploymentRepo.findOne（无在途行 → null）
    deploymentRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    executorService = {
      getExecutorUrl: jest.fn(
        (addr: string, p: string) => `http://${addr}/${p}`,
      ),
      getSharedToken: jest.fn().mockResolvedValue("shared-token"),
      ...controlPlaneMocks(),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    notifier = { sendAll: jest.fn().mockResolvedValue({}) };
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mockedAxiosPost.mockReset();
    if (axiosImpl) mockedAxiosPost.mockImplementation(axiosImpl);
    else mockedAxiosPost.mockResolvedValue({ status: 200 });
    const module = await Test.createTestingModule({
      providers: [
        ApplicationService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
        {
          provide: getRepositoryToken(AppDeployment),
          useValue: deploymentRepo,
        },
        { provide: ExecutorService, useValue: executorService },
        { provide: ModuleRef, useValue: { get: jest.fn() } },
        {
          provide: AiService,
          useValue: { analyzeAppHealth: jest.fn().mockResolvedValue("") },
        },
        {
          provide: AiAnalysisService,
          useValue: { analyzeFailure: jest.fn().mockResolvedValue("") },
        },
        { provide: AuditService, useValue: audit },
        { provide: NotificationService, useValue: notifier },
      ],
    }).compile();
    service = module.get(ApplicationService);
  };

  const appRow = () =>
    ({
      id: "app-1",
      name: "Demo",
      ownerUserId: null,
      packageUrl: null,
    }) as Application;

  it("全部成功：fanout 审计记录 succeeded 台数，不触发通知", async () => {
    await assemble();
    appRepo.findOne.mockResolvedValue(appRow());
    deploymentRepo.find.mockResolvedValue([
      { id: "dep-1", executorAddress: "exec-1:8100" },
      { id: "dep-2", executorAddress: "exec-2:8100" },
    ]);

    await service.remove("app-1", {
      id: 1,
      role: UserRole.ADMIN,
      username: "ops",
    });

    const fanoutCall = audit.log.mock.calls.find(
      (c) => c[0]?.action === "application.remove.fanout",
    );
    expect(fanoutCall).toBeDefined();
    expect(fanoutCall[0].resourceId).toBe("app-1");
    // P2 溯源修复：扇出审计随删除人 username 落证（此前只有 userId）。
    expect(fanoutCall[0].username).toBe("ops");
    expect(fanoutCall[0].detail).toMatchObject({
      appId: "app-1",
      appName: "Demo",
      total: 2,
      succeeded: 2,
      failed: 0,
    });
    expect(notifier.sendAll).not.toHaveBeenCalled();
  });

  it("部分失败：失败台数与失败目标落审计，并发送 warning 通知", async () => {
    await assemble();
    appRepo.findOne.mockResolvedValue(appRow());
    deploymentRepo.find.mockResolvedValue([
      { id: "dep-1", executorAddress: "exec-1:8100" },
      { id: "dep-2", executorAddress: "exec-dead:8100" },
    ]);
    // exec-dead 不可达（stop 失败），exec-1 正常
    mockedAxiosPost.mockImplementation(async (url: string) => {
      if (String(url).includes("exec-dead")) {
        throw new Error("connect timeout");
      }
      return { status: 200 };
    });

    await service.remove("app-1", { id: 1, role: UserRole.ADMIN });

    const fanoutCall = audit.log.mock.calls.find(
      (c) => c[0]?.action === "application.remove.fanout",
    );
    expect(fanoutCall).toBeDefined();
    expect(fanoutCall[0].detail).toMatchObject({
      total: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(fanoutCall[0].detail.failedTargets).toEqual([
      expect.objectContaining({ address: "exec-dead:8100" }),
    ]);
    expect(notifier.sendAll).toHaveBeenCalledTimes(1);
    expect(notifier.sendAll.mock.calls[0][0]).toMatchObject({
      level: "warning",
      title: expect.stringContaining("Demo"),
    });
    expect(notifier.sendAll.mock.calls[0][0].content).toContain(
      "exec-dead:8100",
    );
  });

  it("通知/审计自身抛错不影响删除主链（fail-open）", async () => {
    await assemble();
    appRepo.findOne.mockResolvedValue(appRow());
    deploymentRepo.find.mockResolvedValue([
      { id: "dep-1", executorAddress: "exec-1:8100" },
    ]);
    audit.log.mockRejectedValue(new Error("audit db down"));
    notifier.sendAll.mockRejectedValue(new Error("webhook down"));
    mockedAxiosPost.mockRejectedValue(new Error("connect timeout"));

    await expect(
      service.remove("app-1", { id: 1, role: UserRole.ADMIN }),
    ).resolves.toBeUndefined();
    expect(appRepo.remove).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D3-B-P1-2: 应用 CRUD/部署触发审计落证（红→绿回归）。
// 装配一个 mock AuditService，断言 create/update/remove/deployFromGit 各落
// 对应 action（applicationId + 操作人）。
// ---------------------------------------------------------------------------
describe("ApplicationService — D3-B-P1-2 审计落证", () => {
  let service: ApplicationService;
  let appRepo: ReturnType<typeof makeRepo>;
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    appRepo = makeRepo();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        ApplicationService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
        { provide: ModuleRef, useValue: { get: jest.fn() } },
        {
          provide: AiService,
          useValue: {
            analyzeAppHealth: jest.fn().mockResolvedValue({ aiAnalysis: "" }),
          },
        },
        {
          provide: AiAnalysisService,
          useValue: { analyzeFailure: jest.fn().mockResolvedValue("") },
        },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(ApplicationService);
  });

  it("create：落证 application.create（含 userId/username 与 resourceId）", async () => {
    appRepo.findOne.mockResolvedValue(null);
    const saved = { id: "app-new", name: "Demo", ownerUserId: 9 };
    appRepo.save.mockResolvedValue(saved);

    // P2 溯源修复：控制器传完整 AuthUser，审计行必须带 username（此前只落
    // userId，审计页把真实用户操作误标「系统」）。
    await service.create({ name: "Demo" } as never, {
      id: 9,
      username: "ops",
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 9,
        username: "ops",
        action: "application.create",
        resource: "application",
        resourceId: "app-new",
      }),
    );
  });

  it("update：落证 application.update（含 username；systemBypass 时不落证）", async () => {
    const row = { id: "app-1", name: "Demo", ownerUserId: 9, env: null };
    appRepo.findOne.mockResolvedValue(row);
    appRepo.save.mockResolvedValue(row);

    await service.update("app-1", { name: "Demo2" } as never, {
      id: 9,
      role: UserRole.ADMIN,
      username: "ops",
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 9,
        username: "ops",
        action: "application.update",
        resourceId: "app-1",
      }),
    );

    audit.log.mockClear();
    await service.update("app-1", { name: "X" } as never, null, {
      systemBypass: true,
    });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("remove：落证 application.delete（含 username 与 name detail；扇出审计同带 username）", async () => {
    const row = { id: "app-1", name: "Demo", ownerUserId: 9, packageUrl: null };
    appRepo.findOne.mockResolvedValue(row);
    appRepo.remove.mockResolvedValue(row);

    await service.remove("app-1", {
      id: 9,
      role: UserRole.ADMIN,
      username: "ops",
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 9,
        username: "ops",
        action: "application.delete",
        resourceId: "app-1",
        detail: expect.objectContaining({ name: "Demo" }),
      }),
    );
    // P2 溯源修复：删除扇出（application.remove.fanout）同样落删除人 username。
    const fanoutCall = audit.log.mock.calls.find(
      (c) => c[0]?.action === "application.remove.fanout",
    );
    if (fanoutCall) {
      expect(fanoutCall[0].username).toBe("ops");
      expect(fanoutCall[0].userId).toBe(9);
    }
  });

  it("deployFromGit：落证 application.deploy（含 git 元信息）", async () => {
    const row = { id: "app-1", name: "Demo", env: null };
    appRepo.findOne.mockResolvedValue(row);
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mockedSpawn.mockImplementation(() =>
      fakeSpawn({ status: 0, stdout: "abc123" }),
    );

    await service.deployFromGit("app-1", "https://github.com/o/r.git", "main");
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "application.deploy",
        resourceId: "app-1",
        detail: expect.objectContaining({
          gitRepo: "https://github.com/o/r.git",
          gitBranch: "main",
        }),
      }),
    );
  });

  // 用户报障回归：zip 上传出来的版本必须能回滚。
  // 根因：recordUploadVersion 当初把 status 写成 'uploaded'，而回滚面的判据
  // （后端 rollbackApplication 的 released 守卫、前端 rollbackDisabled）只认
  // 'released' —— 于是每个上传的旧版本在版本历史里恒显示「仅已发布版本可回滚」。
  describe("recordUploadVersion（上传即产生版本 → 必须可回滚）", () => {
    const app = {
      id: "app-1",
      name: "Demo",
      version: "1.0.1",
      runtime: "node",
      status: "active",
      packageUrl: "https://api.example.com/uploads/packages/Demo_1.zip",
      gitCommit: null,
      gitBranch: null,
      gitRepo: null,
      manifest: null,
      env: null,
      entrypoint: "dist/main.js",
      description: null,
    } as unknown as Application;

    /** 单独装配：需要注入 ApplicationVersion 的 versionRepo（@Optional）。 */
    const buildWithVersionRepo = async (versionRepo: {
      findOne: jest.Mock;
      save: jest.Mock;
      create: jest.Mock;
    }) => {
      const repo = makeRepo({ findOne: jest.fn() });
      const module = await Test.createTestingModule({
        providers: [
          ApplicationService,
          { provide: getRepositoryToken(Application), useValue: repo },
          {
            provide: getRepositoryToken(ApplicationVersion),
            useValue: versionRepo,
          },
          { provide: ModuleRef, useValue: { get: jest.fn() } },
          {
            provide: AiService,
            useValue: {
              analyzeAppHealth: jest.fn().mockResolvedValue({ aiAnalysis: "" }),
            },
          },
          {
            provide: AiAnalysisService,
            useValue: { analyzeFailure: jest.fn().mockResolvedValue("") },
          },
        ],
      }).compile();
      return module.get(ApplicationService);
    };

    it("落库 status='released'（不是 'uploaded'）——否则回滚按钮永久禁用", async () => {
      const versionRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
        create: jest.fn().mockImplementation((v: unknown) => v),
      };
      const svc = await buildWithVersionRepo(versionRepo);

      await svc.recordUploadVersion(app, { id: 7 });

      expect(versionRepo.save).toHaveBeenCalledTimes(1);
      const saved = versionRepo.save.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(saved.status).toBe("released");
      // 与部署路径产出的版本行在回滚面上必须同权：sourceDeploymentId 为 null
      // 是「上传来源」的标识，但不影响可回滚性（后端按 id 查快照后只校验 status）。
      expect(saved.sourceDeploymentId).toBeNull();
      expect(saved.createdBy).toBe("7");
    });

    it("同版本号重复上传不重复落行（唯一索引 (applicationId, version)）", async () => {
      const versionRepo = {
        findOne: jest.fn().mockResolvedValue({ id: "v-existing" }),
        save: jest.fn(),
        create: jest.fn(),
      };
      const svc = await buildWithVersionRepo(versionRepo);

      await svc.recordUploadVersion(app, { id: 7 });

      expect(versionRepo.save).not.toHaveBeenCalled();
    });

    it("快照失败只 warn，不抛（best-effort：绝不阻断上传主链）", async () => {
      const versionRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockRejectedValue(new Error("db down")),
        create: jest.fn().mockImplementation((v: unknown) => v),
      };
      const svc = await buildWithVersionRepo(versionRepo);

      await expect(
        svc.recordUploadVersion(app, { id: 7 }),
      ).resolves.toBeUndefined();
    });

    // A-7①: 同版本号重传是文件替换——既有快照的 packageUrl 不再钉在首传的
    // 旧 zip 上，而是就地更新到本次新文件；旧 zip 在无其他快照引用时被
    // best-effort 清理（应用删除只 unlink 当前 packageUrl，历史快照钉住的
    // 旧 zip 会永久成为孤儿）。
    describe("A-7: 同版本重传更新快照 packageUrl + 清理无引用旧包", () => {
      // unlink 间谍逐用例还原——否则下一个 spyOn 拿到同一 spy，历史调用
      // 串场（「不清理」用例会看到上一用例的 unlink 记录）。
      afterEach(() => {
        jest.restoreAllMocks();
      });

      const LOCAL_URL_OLD = "http://api.local/uploads/packages/Demo_111.zip";
      const LOCAL_URL_NEW = "http://api.local/uploads/packages/Demo_222.zip";

      // R5a：oldUrl 可参数化——嵌套内容寻址形态（<appId>/<sha256>/<name>.zip）
      // 与旧扁平形态共用同一套装配。
      const buildWithRefs = async (
        referencedCount: number,
        oldUrl: string = LOCAL_URL_OLD,
      ) => {
        const versionRepo = {
          findOne: jest.fn().mockResolvedValue({
            id: "v-existing",
            applicationId: "app-1",
            version: "1.0.1",
            status: "released",
            snapshot: { packageUrl: oldUrl, entrypoint: "dist/main.js" },
          }),
          save: jest
            .fn()
            .mockImplementation((v: unknown) => Promise.resolve(v)),
          create: jest.fn().mockImplementation((v: unknown) => v),
          createQueryBuilder: jest.fn(() => ({
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getCount: jest.fn().mockResolvedValue(referencedCount),
          })),
        };
        const unlinkSpy = jest
          .spyOn(fs.promises, "unlink")
          .mockResolvedValue(undefined);
        const svc = await buildWithVersionRepo(versionRepo);
        return { svc, versionRepo, unlinkSpy };
      };

      it("重传后既有快照的 packageUrl 更新为新文件（版本历史/回滚不再带回旧包）", async () => {
        const { svc, versionRepo, unlinkSpy } = await buildWithRefs(0);
        const newApp = {
          ...app,
          packageUrl: LOCAL_URL_NEW,
        } as unknown as Application;

        await svc.recordUploadVersion(newApp, { id: 7 });

        expect(versionRepo.save).toHaveBeenCalledTimes(1);
        const saved = versionRepo.save.mock.calls[0][0] as {
          snapshot: Record<string, unknown>;
          id: string;
        };
        expect(saved.id).toBe("v-existing");
        expect(saved.snapshot.packageUrl).toBe(LOCAL_URL_NEW);
        // 快照其余字段保持首传值（同版本号 = 同一次发布的文件替换）
        expect(saved.snapshot.entrypoint).toBe("dist/main.js");
        // 旧 zip 无其他引用 → 被清理
        expect(unlinkSpy).toHaveBeenCalledWith(
          expect.stringContaining("Demo_111.zip"),
        );
      });

      it("旧 zip 仍被其他快照引用时不清理（宁留孤儿，不误删）", async () => {
        const { svc, versionRepo, unlinkSpy } = await buildWithRefs(1);
        const newApp = {
          ...app,
          packageUrl: LOCAL_URL_NEW,
        } as unknown as Application;

        await svc.recordUploadVersion(newApp, { id: 7 });

        // 快照仍更新，但引用查询命中 → 不 unlink
        expect(versionRepo.save).toHaveBeenCalledTimes(1);
        expect(unlinkSpy).not.toHaveBeenCalled();
      });

      it("远程 URL（非本服务 uploads/packages）不尝试本地清理", async () => {
        const versionRepo = {
          findOne: jest.fn().mockResolvedValue({
            id: "v-existing",
            applicationId: "app-1",
            version: "1.0.1",
            status: "released",
            snapshot: { packageUrl: "https://cdn.example.com/pkg.zip" },
          }),
          save: jest
            .fn()
            .mockImplementation((v: unknown) => Promise.resolve(v)),
          create: jest.fn(),
          createQueryBuilder: jest.fn(),
        };
        const unlinkSpy = jest
          .spyOn(fs.promises, "unlink")
          .mockResolvedValue(undefined);
        const svc = await buildWithVersionRepo(versionRepo);

        await svc.recordUploadVersion(
          {
            ...app,
            packageUrl: "https://cdn.example.com/pkg-new.zip",
          } as unknown as Application,
          { id: 7 },
        );

        expect(versionRepo.save).toHaveBeenCalledTimes(1);
        expect(unlinkSpy).not.toHaveBeenCalled();
      });

      // R5a：旧包为嵌套内容寻址路径（<appId>/<sha256>/<name>.zip）——无其他
      // 快照引用时按嵌套路径 unlink，并 best-effort 回收空 <sha256>/ 与其父
      // <appId>/ 目录；uploads/packages 根目录绝不被 rmdir。
      it("R5a: 嵌套内容寻址旧包无引用时清理并回收空目录", async () => {
        const sha = "a".repeat(64);
        const nestedOld = `http://api.local/uploads/packages/app-1/${sha}/Demo.zip`;
        const nestedNew = `http://api.local/uploads/packages/app-1/${"b".repeat(64)}/Demo.zip`;
        const { svc, unlinkSpy } = await buildWithRefs(0, nestedOld);
        const rmdirSpy = jest
          .spyOn(fs.promises, "rmdir")
          .mockResolvedValue(undefined as never);

        await svc.recordUploadVersion(
          {
            ...app,
            packageUrl: nestedNew,
          } as unknown as Application,
          { id: 7 },
        );

        const pkgRoot = path.normalize(
          path.join(process.cwd(), "uploads", "packages"),
        );
        const shaDir = path.join(pkgRoot, "app-1", sha);
        expect(unlinkSpy).toHaveBeenCalledWith(path.join(shaDir, "Demo.zip"));
        // 先试 <sha256>/ 目录，空则再试 <appId>/ 目录；根目录不在回收面。
        expect(rmdirSpy).toHaveBeenCalledWith(shaDir);
        expect(rmdirSpy).toHaveBeenCalledWith(path.join(pkgRoot, "app-1"));
        expect(rmdirSpy).not.toHaveBeenCalledWith(pkgRoot);
      });

      // R5a：旧扁平文件仍按原语义清理（单段路径），且没有嵌套父目录可回收——
      // rmdir 不得碰 uploads/packages 根。
      it("R5a: 旧扁平旧包清理时不回收 uploads/packages 根目录", async () => {
        const { svc, unlinkSpy } = await buildWithRefs(0);
        const rmdirSpy = jest
          .spyOn(fs.promises, "rmdir")
          .mockResolvedValue(undefined as never);

        await svc.recordUploadVersion(
          {
            ...app,
            packageUrl: LOCAL_URL_NEW,
          } as unknown as Application,
          { id: 7 },
        );

        expect(unlinkSpy).toHaveBeenCalledWith(
          expect.stringContaining("Demo_111.zip"),
        );
        expect(rmdirSpy).not.toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // A-5: 删除应用前校验在途部署——deploy() 推送是 fire-and-forget（重试约
  // 90s），窗口内删掉应用会级联删行并让执行器跑起无 DB 行的孤儿进程；审批中
  // 的行被静默级联删同样不可接受。存在在途行 → 409。
  // -------------------------------------------------------------------------
  describe("A-5: remove 校验在途部署", () => {
    const admin = { id: 1, role: UserRole.ADMIN };

    const buildWithDeploymentRepo = async (deploymentRepo: {
      findOne: jest.Mock;
      find: jest.Mock;
    }) => {
      const appRepo = makeRepo({
        findOne: jest.fn().mockResolvedValue({
          id: "app-1",
          name: "Demo",
          ownerUserId: 1,
          packageUrl: null,
        }),
      });
      const svc = new ApplicationService(
        appRepo as never,
        {} as never,
        {} as never,
        deploymentRepo as never,
        null as never,
      );
      return { svc, appRepo };
    };

    it("存在在途部署行（PENDING/DEPLOYING/UPGRADING）→ 409，不删应用", async () => {
      const deploymentRepo = {
        findOne: jest.fn().mockResolvedValue({
          id: "d-1",
          status: "deploying",
          approvalStatus: null,
        }),
        find: jest.fn().mockResolvedValue([]),
      };
      const { svc, appRepo } = await buildWithDeploymentRepo(deploymentRepo);

      await expect(svc.remove("app-1", admin)).rejects.toMatchObject({
        constructor: ConflictException,
        status: 409,
      });
      expect(appRepo.remove).not.toHaveBeenCalled();
      // 查询条件覆盖三类在途态与待审批两条 OR 分支
      const where = deploymentRepo.findOne.mock.calls[0][0].where;
      expect(where).toHaveLength(2);
      expect(where[0].status.value).toEqual(
        expect.arrayContaining(["pending", "deploying", "upgrading"]),
      );
      expect(where[1].approvalStatus).toBe("pending_approval");
    });

    it("待审批行（approvalStatus=pending_approval）→ 409", async () => {
      const deploymentRepo = {
        findOne: jest.fn().mockResolvedValue({
          id: "d-approval",
          status: "pending",
          approvalStatus: "pending_approval",
        }),
        find: jest.fn().mockResolvedValue([]),
      };
      const { svc, appRepo } = await buildWithDeploymentRepo(deploymentRepo);

      await expect(svc.remove("app-1", admin)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(appRepo.remove).not.toHaveBeenCalled();
    });

    it("全部终态 → 照常删除（不回归）", async () => {
      const deploymentRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
      };
      const { svc, appRepo } = await buildWithDeploymentRepo(deploymentRepo);

      await expect(svc.remove("app-1", admin)).resolves.toBeUndefined();
      expect(appRepo.remove).toHaveBeenCalledTimes(1);
    });

    it("deploymentRepo 未接线（既有单测装配）→ 跳过校验不阻断删除", async () => {
      const appRepo = makeRepo({
        findOne: jest.fn().mockResolvedValue({
          id: "app-1",
          name: "Demo",
          ownerUserId: 1,
          packageUrl: null,
        }),
      });
      const svc = new ApplicationService(
        appRepo as never,
        {} as never,
        {} as never,
        null as never,
        null as never,
      );

      await expect(svc.remove("app-1", admin)).resolves.toBeUndefined();
      expect(appRepo.remove).toHaveBeenCalledTimes(1);
    });
  });
});

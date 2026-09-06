import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import * as fs from "fs";
import * as path from "path";
import { ApplicationService } from "../application.service";
import { Application, ApplicationStatus } from "../entities/application.entity";
import { ModuleRef } from "@nestjs/core";
import { AiService } from "../../ai/ai.service";

// R4/R1: deployFromGit spawns git and resolves the repo host — pin both so
// the specs never touch the network or a real binary.
jest.mock("child_process", () => ({ spawn: jest.fn() }));
jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
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
  remove: jest.fn(),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
  ...overrides,
});

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
      await expect(service.findById("nonexistent")).rejects.toThrow(
        "not found",
      );
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
      ).rejects.toThrow("already exists");
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
    it("R1: persists the RAW env — a masked read surface is never written back", async () => {
      const row = {
        id: "1",
        name: "app1",
        env: { API_KEY: "sk-real", NODE_ENV: "prod" },
      };
      appRepo.findOne.mockResolvedValue(row);

      await service.update("1", { description: "bumped by webhook" });

      const saved = appRepo.save.mock.calls[0][0];
      expect(saved.env.API_KEY).toBe("sk-real");
      expect(saved.env.NODE_ENV).toBe("prod");
    });

    it("R1: an admin form echoing '***' for a secret key keeps the saved raw value", async () => {
      const row = { id: "1", name: "app1", env: { API_KEY: "sk-real" } };
      appRepo.findOne.mockResolvedValue(row);

      await service.update("1", { env: { API_KEY: "***", NEW_VAR: "v" } });

      const saved = appRepo.save.mock.calls[0][0];
      expect(saved.env).toEqual({ API_KEY: "sk-real", NEW_VAR: "v" });
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

    it("persists the RAW env on the DEPLOYING save (not the masked row)", async () => {
      const row = { id: "1", name: "app1", env: { API_KEY: "sk-real" } };
      appRepo.findOne.mockResolvedValue(row);
      mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      // Clone fails fast — we only care about the FIRST save (DEPLOYING).
      // Snapshot each save arg: the service mutates the same entity object
      // (status → FAILED) before saving again.
      const saves: Array<Record<string, unknown>> = [];
      appRepo.save.mockImplementation((e: any) => {
        saves.push({ ...e });
        return Promise.resolve(e);
      });
      mockedSpawn.mockImplementation(() =>
        fakeSpawn({ status: 128, stderr: "repository not found" }),
      );

      await expect(
        service.deployFromGit("1", "https://github.com/org/repo.git", "main"),
      ).rejects.toThrow("repository not found");

      expect(saves[0].status).toBe(ApplicationStatus.DEPLOYING);
      expect((saves[0].env as Record<string, string>).API_KEY).toBe("sk-real");
    });

    it("R4: refuses a repo whose host resolves to cloud metadata — git never spawns", async () => {
      appRepo.findOne.mockResolvedValue({ id: "1", name: "app1" });
      mockedLookup.mockResolvedValue([
        { address: "169.254.169.254", family: 4 },
      ]);

      await expect(
        service.deployFromGit("1", "http://evil.example.com/r.git", "main"),
      ).rejects.toThrow(/clone refused/);
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
      const lastSave =
        appRepo.save.mock.calls[appRepo.save.mock.calls.length - 1][0];
      expect(lastSave.status).toBe(ApplicationStatus.ACTIVE);
      expect(lastSave.gitCommit).toBe("deadbeef");
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
        const lastSave =
          appRepo.save.mock.calls[appRepo.save.mock.calls.length - 1][0];
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
  });
});

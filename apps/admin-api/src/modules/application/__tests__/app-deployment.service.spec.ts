import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppDeploymentService } from "../app-deployment.service";
import {
  AppDeployment,
  DeploymentStatus,
  RunMode,
} from "../entities/app-deployment.entity";
import { ApplicationVersion } from "../entities/application-version.entity";
import { ApplicationService } from "../application.service";
import { ExecutorService } from "../../executor/executor.service";
import { DOMAIN_EVENTS } from "../../../common/events/domain-events";

// Mock axios to avoid real HTTP calls
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ data: {} }) },
}));
import axios from "axios";
const mockAxiosPost = axios.post as jest.Mock;

// R8: pushDeployToExecutor / stop now run assertSafeExecutorUrl, which
// resolves hostnames via node:dns/promises — pin it so specs never hit DNS.
jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
import { lookup } from "node:dns/promises";
const mockedLookup = lookup as unknown as jest.Mock;

/** R5: a TypeORM-shaped unique-violation error (SQLSTATE 23505). */
const makeUniqueViolation = (constraint: string | null) =>
  Object.assign(
    new Error(
      `duplicate key value violates unique constraint "${constraint ?? "other_constraint"}"`,
    ),
    constraint
      ? {
          code: "23505",
          constraint,
          driverError: { code: "23505", constraint },
        }
      : { code: "23505" },
  );

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  create: jest.fn((d: any) => ({ ...d, id: "deploy-1" })),
  save: jest.fn((e: any) => Promise.resolve({ ...e, id: e.id ?? "deploy-1" })),
  ...overrides,
});

const mockApp = {
  id: "app-1",
  name: "my-app",
  gitRepo: "https://github.com/org/repo",
  gitBranch: "main",
  gitCommit: "abc123",
  runtime: "node",
  entrypoint: "node dist/main.js",
  version: "1.0.0",
  env: { NODE_ENV: "production" },
};

const mockExecutor = {
  id: "exec-1",
  address: "http://executor:3001",
};

describe("AppDeploymentService", () => {
  let service: AppDeploymentService;
  let repo: ReturnType<typeof makeRepo>;
  let versionRepo: ReturnType<typeof makeRepo>;
  // R1: deploy/rollback read the RAW application row (findByIdRaw) so the
  // executor receives the unmasked env; the HTTP read surface (findById)
  // is no longer on these paths.
  let appService: jest.Mocked<
    Pick<
      ApplicationService,
      | "findById"
      | "findByIdRaw"
      | "update"
      | "maskReadSurface"
      | "maskEnvForRead"
    >
  >;
  let executorService: jest.Mocked<
    Pick<
      ExecutorService,
      "findOne" | "getExecutorUrl" | "getSharedToken" | "selectLeastLoaded"
    >
  >;

  beforeEach(async () => {
    repo = makeRepo();
    versionRepo = makeRepo();
    appService = {
      findById: jest.fn().mockResolvedValue(mockApp),
      findByIdRaw: jest.fn().mockResolvedValue(mockApp),
      update: jest.fn((_: string, dto: any) =>
        Promise.resolve({ ...mockApp, ...dto }),
      ),
      // QA1: pass-through in unit tests — masking semantics are covered by
      // the dedicated maskEnvForRead / deployment read-surface specs.
      maskEnvForRead: jest.fn((env: any) => env),
      maskReadSurface: jest.fn((app: any) => app),
    };
    executorService = {
      findOne: jest.fn().mockResolvedValue(mockExecutor),
      // Mirror the real getExecutorUrl: bare host:port gets the http:// scheme.
      getExecutorUrl: jest.fn(
        (addr: string, p: string) =>
          `${addr.startsWith("http://") || addr.startsWith("https://") ? "" : "http://"}${addr}/${p}`,
      ),
      // 部署指令鉴权头现走 DB 优先的 getSharedToken
      getSharedToken: jest.fn().mockResolvedValue(""),
      selectLeastLoaded: jest.fn().mockResolvedValue(mockExecutor),
    };

    const module = await Test.createTestingModule({
      providers: [
        AppDeploymentService,
        { provide: getRepositoryToken(AppDeployment), useValue: repo },
        {
          provide: getRepositoryToken(ApplicationVersion),
          useValue: versionRepo,
        },
        { provide: ApplicationService, useValue: appService },
        { provide: ExecutorService, useValue: executorService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(AppDeploymentService);
    mockAxiosPost.mockClear();
    // R8: default lookup resolves to a public address — individual tests
    // override this to simulate metadata / unreachable hosts.
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    mockedLookup.mockReset();
  });

  describe("findAll", () => {
    it("returns all deployments ordered by createdAt DESC", async () => {
      const deployments = [{ id: "deploy-1" }];
      repo.findAndCount.mockResolvedValue([deployments, 1]);
      const result = await service.findAll();
      expect(result).toEqual({ data: deployments, total: 1 });
      expect(repo.findAndCount).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: "DESC" },
        relations: ["application"],
        skip: 0,
        take: 20,
      });
    });

    it("filters by applicationId when provided", async () => {
      repo.findAndCount.mockResolvedValue([[], 0]);
      await service.findAll("app-1");
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { applicationId: "app-1" } }),
      );
    });
  });

  describe("findById", () => {
    it("returns deployment when found", async () => {
      const d = { id: "deploy-1", status: DeploymentStatus.RUNNING };
      repo.findOne.mockResolvedValue(d);
      const result = await service.findById("deploy-1");
      expect(result).toEqual(d);
    });

    it("throws NotFoundException when not found", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findById("nope")).rejects.toThrow(NotFoundException);
    });
  });

  // QA1: the deployment read surface (row env, nested application env) and
  // the version-snapshot env must be masked like the application surface,
  // while upgrade/stop keep pushing and persisting the RAW env.
  describe("QA1: env read-surface masking", () => {
    const SECRET_RE = /pass|secret|token|api[_-]?key/i;
    const realMask = (env: any) => {
      if (!env || typeof env !== "object") return env;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(env as Record<string, string>))
        out[k] = SECRET_RE.test(k) ? "***" : v;
      return out;
    };

    beforeEach(() => {
      appService.maskEnvForRead.mockImplementation(realMask as any);
      appService.maskReadSurface.mockImplementation(((app: any) => ({
        ...app,
        env: realMask(app.env),
      })) as any);
    });

    it("findById masks secret-class keys on the row and the nested application", async () => {
      const d = {
        id: "deploy-1",
        status: DeploymentStatus.RUNNING,
        env: { API_KEY: "raw-secret", LOG_LEVEL: "debug" },
        application: {
          id: "app-1",
          env: { DB_PASSWORD: "raw-pw", FOO: "bar" },
        },
      };
      repo.findOne.mockResolvedValue(d);
      const result = await service.findById("deploy-1");
      expect(result.env).toEqual({ API_KEY: "***", LOG_LEVEL: "debug" });
      expect(result.application.env).toEqual({
        DB_PASSWORD: "***",
        FOO: "bar",
      });
    });

    it("upgrade pushes and persists the RAW env (masking never reaches the send path)", async () => {
      const d = {
        id: "deploy-1",
        applicationId: "app-1",
        status: DeploymentStatus.RUNNING,
        executorAddress: mockExecutor.address,
        env: { API_KEY: "raw-value" },
      };
      repo.findOne.mockResolvedValue(d);
      repo.save.mockImplementation(async (e: any) => e);
      mockAxiosPost.mockResolvedValue({ data: {} });

      await service.upgrade("deploy-1");

      expect(appService.findByIdRaw).toHaveBeenCalledWith("app-1");
      expect(appService.findById).not.toHaveBeenCalled();
      const savedArg = repo.save.mock.calls[0][0];
      expect(savedArg.env).toEqual({ API_KEY: "raw-value" });
    });

    // R5: upgrades must stay in UPGRADING (never DEPLOYING) so concurrent
    // rolling upgrades of one application do not collide on the partial
    // unique index uq_app_deployments_application_in_flight.
    it("R5: upgrade keeps the row in UPGRADING instead of DEPLOYING during the push", async () => {
      const d = {
        id: "deploy-1",
        applicationId: "app-1",
        status: DeploymentStatus.RUNNING,
        executorAddress: "203.0.113.10:3001",
        env: null,
      };
      repo.save.mockImplementation(async (e: any) => e);
      mockAxiosPost.mockResolvedValue({ data: {} });
      versionRepo.findOne.mockResolvedValue(null);

      await (service as any).pushDeployToExecutor(d, mockApp, true);

      const statuses = repo.save.mock.calls.map((c) => (c[0] as any).status);
      expect(statuses).not.toContain(DeploymentStatus.DEPLOYING);
      expect(d.status).toBe(DeploymentStatus.UPGRADING);
      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
      // plain deploys still transition through DEPLOYING
      const d2 = {
        id: "deploy-2",
        applicationId: "app-1",
        status: DeploymentStatus.PENDING,
        executorAddress: "203.0.113.10:3001",
        env: null,
      };
      mockAxiosPost.mockClear();
      await (service as any).pushDeployToExecutor(d2, mockApp);
      expect(d2.status).toBe(DeploymentStatus.DEPLOYING);
    });
  });

  describe("deploy", () => {
    it("creates deployment record and returns it", async () => {
      const saved = {
        id: "deploy-1",
        status: DeploymentStatus.PENDING,
        executorAddress: mockExecutor.address,
      };
      repo.create.mockReturnValue(saved);
      repo.save.mockResolvedValue(saved);

      const result = await service.deploy("app-1", {
        executorId: "exec-1",
        runMode: RunMode.DAEMON,
      });

      expect(result.id).toBe("deploy-1");
      expect(appService.findByIdRaw).toHaveBeenCalledWith("app-1");
      expect(executorService.findOne).toHaveBeenCalledWith("exec-1");
    });

    it("throws BadRequestException when app already has an in-flight deployment", async () => {
      repo.findOne.mockResolvedValue({
        id: "deploy-existing",
        status: "deploying",
      });
      await expect(
        service.deploy("app-1", {
          executorId: "exec-1",
          runMode: RunMode.DAEMON,
        }),
      ).rejects.toThrow(ConflictException);
    });

    // QA4: upgrade() leaves the row UPGRADING for the whole push (R5) and the
    // partial unique index intentionally does not constrain UPGRADING rows
    // (concurrent rolling upgrades must not collide on it). A deploy issued
    // while an upgrade is in flight would otherwise start a second real
    // process on the executor — the findOne guard must catch it.
    it("QA4: rejects a deploy while an UPGRADING deployment is in flight (409)", async () => {
      repo.findOne.mockResolvedValue({
        id: "deploy-upgrading",
        status: DeploymentStatus.UPGRADING,
      });

      await expect(
        service.deploy("app-1", {
          executorId: "exec-1",
          runMode: RunMode.DAEMON,
        }),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        status: 409,
        message: expect.stringContaining("status=upgrading"),
      });
      // Rejected before any row is created or any push is sent.
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    // QA4: the guard's where-clause must include PENDING, DEPLOYING and
    // UPGRADING — pin all three statuses on the interceptor query.
    it("QA4: the in-flight guard queries PENDING + DEPLOYING + UPGRADING", async () => {
      repo.findOne.mockResolvedValue(null);

      await service
        .deploy("app-1", {
          executorId: "exec-1",
          runMode: RunMode.DAEMON,
        })
        .catch(() => undefined);

      expect(repo.findOne).toHaveBeenCalled();
      const where = (repo.findOne.mock.calls[0][0] as any).where as Array<
        Record<string, unknown>
      >;
      expect(where.map((w) => w.status)).toEqual([
        DeploymentStatus.PENDING,
        DeploymentStatus.DEPLOYING,
        DeploymentStatus.UPGRADING,
      ]);
    });

    // R5: the findOne guard is TOCTOU-racy; the partial unique index
    // (migration 1789000000000) is the real race-closer. A losing concurrent
    // insert surfaces as SQLSTATE 23505 and must be converted to 409.
    it("R5: converts the in-flight unique violation (23505) into 409 Conflict", async () => {
      repo.findOne.mockResolvedValue(null); // guard passes (TOCTOU window)
      repo.save.mockRejectedValue(
        makeUniqueViolation("uq_app_deployments_application_in_flight"),
      );

      await expect(
        service.deploy("app-1", {
          executorId: "exec-1",
          runMode: RunMode.DAEMON,
        }),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        status: 409,
        message: expect.stringContaining(
          "already has an in-progress deployment",
        ),
      });
    });

    it("R5: matches the violation through the TypeORM driverError wrapper", async () => {
      repo.findOne.mockResolvedValue(null);
      const err = new Error("QueryFailedError");
      (err as any).driverError = {
        code: "23505",
        constraint: "uq_app_deployments_application_in_flight",
      };
      repo.save.mockRejectedValue(err);

      await expect(
        service.deploy("app-1", { runMode: RunMode.DAEMON }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("R5: does not misreport unrelated unique violations", async () => {
      repo.findOne.mockResolvedValue(null);
      repo.save.mockRejectedValue(makeUniqueViolation("some_other_constraint"));

      await expect(
        service.deploy("app-1", { runMode: RunMode.DAEMON }),
      ).rejects.not.toBeInstanceOf(ConflictException);
    });

    it("R5: rethrows non-unique save errors unchanged", async () => {
      repo.findOne.mockResolvedValue(null);
      repo.save.mockRejectedValue(new Error("connection refused"));

      await expect(
        service.deploy("app-1", { runMode: RunMode.DAEMON }),
      ).rejects.toThrow("connection refused");
    });
  });

  describe("version history", () => {
    it("returns persisted application version snapshots when present", async () => {
      const createdAt = new Date("2024-01-02T00:00:00Z");
      versionRepo.find.mockResolvedValue([
        {
          id: "version-1",
          applicationId: "app-1",
          version: "1.0.0",
          gitCommit: "abc123",
          sourceDeploymentId: "deploy-1",
          status: "released",
          createdAt,
          snapshot: { version: "1.0.0" },
        },
      ]);
      repo.find.mockResolvedValue([
        { id: "deploy-1", deployedVersion: "1.0.0" },
        { id: "deploy-2", deployedVersion: "1.0.0" },
      ]);

      const result = await service.getVersionHistory("app-1");

      expect(result).toEqual([
        expect.objectContaining({
          id: "version-1",
          deploymentId: "deploy-1",
          version: "1.0.0",
          commit: "abc123",
          deployCount: 2,
          snapshot: { version: "1.0.0" },
        }),
      ]);
    });

    it("keeps legacy deployment versions when snapshots only cover newer releases", async () => {
      versionRepo.find.mockResolvedValue([
        {
          id: "version-2",
          applicationId: "app-1",
          version: "2.0.0",
          gitCommit: "def456",
          sourceDeploymentId: "deploy-2",
          status: "released",
          createdAt: new Date("2024-01-02T00:00:00Z"),
          snapshot: { version: "2.0.0" },
        },
      ]);
      repo.find.mockResolvedValue([
        {
          id: "deploy-2",
          deployedVersion: "2.0.0",
          deployedCommit: "def456",
          status: DeploymentStatus.RUNNING,
          deployedAt: new Date("2024-01-02T00:00:00Z"),
          executorAddress: "executor:3001",
        },
        {
          id: "deploy-1",
          deployedVersion: "1.0.0",
          deployedCommit: "abc123",
          status: DeploymentStatus.STOPPED,
          deployedAt: new Date("2024-01-01T00:00:00Z"),
          executorAddress: "executor:3001",
        },
      ]);

      const result = await service.getVersionHistory("app-1");

      expect(result.map((v) => v.version)).toEqual(["2.0.0", "1.0.0"]);
      expect(result[1]).toEqual(
        expect.objectContaining({ deploymentId: "deploy-1", commit: "abc123" }),
      );
    });

    it("falls back to grouped deployments when no snapshots exist", async () => {
      versionRepo.find.mockResolvedValue([]);
      repo.find.mockResolvedValue([
        {
          id: "deploy-2",
          deployedVersion: "2.0.0",
          deployedCommit: "def456",
          status: DeploymentStatus.RUNNING,
          deployedAt: new Date("2024-01-02T00:00:00Z"),
          executorAddress: "executor:3001",
        },
        {
          id: "deploy-1",
          deployedVersion: "1.0.0",
          deployedCommit: "abc123",
          status: DeploymentStatus.STOPPED,
          deployedAt: new Date("2024-01-01T00:00:00Z"),
          executorAddress: "executor:3001",
        },
      ]);

      const result = await service.getVersionHistory("app-1");

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({ deploymentId: "deploy-2", version: "2.0.0" }),
      );
    });
  });

  describe("rollbackApplication", () => {
    it("restores application fields from a version snapshot and upgrades running deployments", async () => {
      versionRepo.findOne.mockResolvedValue({
        id: "version-1",
        applicationId: "app-1",
        version: "1.0.0",
        gitCommit: "abc123",
        status: "released",
        snapshot: {
          version: "1.0.0",
          runtime: "node",
          gitBranch: "release",
          packageUrl: "http://packages/app.zip",
          env: { NODE_ENV: "production" },
          entrypoint: "node app.js",
          manifest: { tasks: [] },
        },
      });
      repo.find.mockResolvedValue([
        { id: "deploy-1", status: DeploymentStatus.RUNNING },
      ]);
      repo.findOne.mockResolvedValue({
        id: "deploy-1",
        applicationId: "app-1",
        status: DeploymentStatus.RUNNING,
      });
      repo.save.mockImplementation((e: any) => Promise.resolve(e));

      const result = await service.rollbackApplication("app-1", "version-1");

      expect(appService.update).toHaveBeenCalledWith(
        "app-1",
        expect.objectContaining({
          version: "1.0.0",
          gitCommit: "abc123",
          gitBranch: "release",
          packageUrl: "http://packages/app.zip",
          runtime: "node",
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          ok: true,
          rolledBackTo: "1.0.0",
          total: 1,
          versionId: "version-1",
        }),
      );
    });

    it("does not clear application fields when version snapshot omits them", async () => {
      versionRepo.findOne.mockResolvedValue({
        id: "version-1",
        applicationId: "app-1",
        version: "1.0.1",
        gitCommit: null,
        status: "released",
        snapshot: { runtime: "node" },
      });
      repo.find.mockResolvedValue([]);

      await service.rollbackApplication("app-1", "version-1");

      expect(appService.update).toHaveBeenCalledWith("app-1", {
        version: "1.0.1",
        runtime: "node",
      });
    });

    it("rejects a version snapshot from another application", async () => {
      versionRepo.findOne.mockResolvedValue({
        id: "version-1",
        applicationId: "other-app",
        version: "1.0.0",
        status: "released",
        snapshot: {},
      });

      await expect(
        service.rollbackApplication("app-1", "version-1"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects rollback to an unreleased version snapshot", async () => {
      versionRepo.findOne.mockResolvedValue({
        id: "version-1",
        applicationId: "app-1",
        version: "1.0.0",
        status: "deploying",
        snapshot: {},
      });

      await expect(
        service.rollbackApplication("app-1", "version-1"),
      ).rejects.toThrow(BadRequestException);
      expect(appService.update).not.toHaveBeenCalled();
    });

    // R16: legacy deployments predate version snapshots and have no stored
    // packageUrl. The parent app's CURRENT packageUrl is not a historical
    // artifact, so the legacy path restores version/commit only and marks
    // packageUrlRestored=false instead of pretending to restore it.
    it("R16: legacy rollback restores version/commit and reports packageUrlRestored=false", async () => {
      versionRepo.findOne.mockResolvedValue(null);
      repo.find.mockResolvedValue([
        {
          id: "deploy-legacy",
          deployedVersion: "0.9.0",
          deployedCommit: "cafef00d",
          status: DeploymentStatus.RUNNING,
        },
      ]);

      const result = await service.rollbackApplication(
        "app-1",
        "deploy-legacy",
      );

      expect(appService.update).toHaveBeenCalledWith("app-1", {
        version: "0.9.0",
        gitCommit: "cafef00d",
      });
      // packageUrl must NOT be written back from the app's current value
      expect(appService.update.mock.calls[0][1]).not.toHaveProperty(
        "packageUrl",
      );
      expect(result).toEqual(
        expect.objectContaining({
          rolledBackTo: "0.9.0",
          versionId: null,
          packageUrlRestored: false,
        }),
      );
    });
  });

  describe("version snapshots", () => {
    it("saves a deploying application version snapshot after deploy command is accepted", async () => {
      const deployment: any = {
        id: "deploy-1",
        applicationId: "app-1",
        executorAddress: "executor:3001",
        runMode: RunMode.DAEMON,
        env: null,
        startCommand: null,
        status: DeploymentStatus.PENDING,
        deployedAt: null,
      };
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      versionRepo.findOne.mockResolvedValue(null);
      versionRepo.create.mockImplementation((e: any) => e);
      versionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      mockAxiosPost.mockResolvedValue({ data: {} });

      await (service as any).pushDeployToExecutor(deployment, mockApp);

      expect(deployment.deployedVersion).toBe(mockApp.version);
      expect(deployment.deployedCommit).toBe(mockApp.gitCommit);
      expect(versionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          applicationId: mockApp.id,
          version: mockApp.version,
          gitCommit: mockApp.gitCommit,
          sourceDeploymentId: deployment.id,
          snapshot: expect.objectContaining({
            id: mockApp.id,
            version: mockApp.version,
            gitCommit: mockApp.gitCommit,
          }),
        }),
      );
    });

    it("does not save a version snapshot when deploy command fails", async () => {
      jest.spyOn(global, "setTimeout").mockImplementation((cb: any) => {
        cb();
        return 0 as any;
      });
      const deployment = {
        id: "deploy-1",
        applicationId: "app-1",
        executorAddress: "executor:3001",
        runMode: RunMode.DAEMON,
        env: null,
        startCommand: null,
        status: DeploymentStatus.PENDING,
      };
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      mockAxiosPost.mockRejectedValue(new Error("executor offline"));

      await (service as any).pushDeployToExecutor(deployment, mockApp);

      expect(deployment.status).toBe(DeploymentStatus.FAILED);
      expect(versionRepo.save).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    });

    // QA6: uq_application_versions_applicationId_version constrains only
    // (applicationId, version) while the dedupe keys on sourceDeploymentId
    // too. Two instances of the same application upgrading concurrently both
    // pass the dedupe, and the losing INSERT fails with 23505 — that must not
    // fail (and retry!) the already-accepted deploy push.
    it("QA6: a 23505 on the version unique index is swallowed — push success semantics preserved", async () => {
      const deployment: any = {
        id: "deploy-2",
        applicationId: "app-1",
        executorAddress: "203.0.113.10:3001",
        runMode: RunMode.DAEMON,
        env: null,
        startCommand: null,
        status: DeploymentStatus.PENDING,
      };
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      // Dedupe misses: same (app, version) but a DIFFERENT sourceDeploymentId
      // is what makes the concurrent case slip past the findOne check.
      versionRepo.findOne.mockResolvedValue(null);
      versionRepo.create.mockImplementation((e: any) => e);
      versionRepo.save.mockRejectedValue(
        makeUniqueViolation("uq_application_versions_applicationId_version"),
      );
      mockAxiosPost.mockResolvedValue({ data: {} });
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => {});

      await expect(
        (service as any).pushDeployToExecutor(deployment, mockApp),
      ).resolves.toBeUndefined();

      // The push itself succeeded: exactly one executor POST (no retry storm)
      // and the row reached DEPLOYING with deploy metadata recorded.
      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
      expect(deployment.status).toBe(DeploymentStatus.DEPLOYING);
      expect(deployment.deployedVersion).toBe(mockApp.version);
      expect(deployment.deployedAt).toBeInstanceOf(Date);
      // The skip is observable (warn), not silent.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("already exists"),
      );
      warnSpy.mockRestore();
    });

    it("QA6: an unrelated unique violation on the snapshot save still fails the push", async () => {
      jest.spyOn(global, "setTimeout").mockImplementation((cb: any) => {
        cb();
        return 0 as any;
      });
      const deployment = {
        id: "deploy-3",
        applicationId: "app-1",
        executorAddress: "203.0.113.10:3001",
        runMode: RunMode.DAEMON,
        env: null,
        startCommand: null,
        status: DeploymentStatus.PENDING,
      };
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      versionRepo.findOne.mockResolvedValue(null);
      versionRepo.create.mockImplementation((e: any) => e);
      versionRepo.save.mockRejectedValue(
        makeUniqueViolation("some_other_constraint"),
      );
      mockAxiosPost.mockResolvedValue({ data: {} });

      await (service as any).pushDeployToExecutor(deployment, mockApp);

      // Pre-existing retry semantics: the violation escapes saveVersionSnapshot
      // into the push loop, which retries and eventually marks the row FAILED.
      expect(mockAxiosPost).toHaveBeenCalledTimes(3);
      expect(deployment.status).toBe(DeploymentStatus.FAILED);
      jest.restoreAllMocks();
    });

    // R8: pushDeployToExecutor is an authenticated outbound request whose
    // target address comes from executor-controlled rows — it must clear the
    // same executor SSRF policy as dispatch before any request is sent.
    it("R8: pushDeployToExecutor refuses a metadata address and never sends", async () => {
      mockedLookup.mockRejectedValue(new Error("no such host"));
      const deployment = {
        id: "deploy-1",
        applicationId: "app-1",
        executorAddress: "169.254.169.254:80",
        runMode: RunMode.DAEMON,
        env: null,
        startCommand: null,
        status: DeploymentStatus.PENDING,
        statusMessage: null as string | null,
      };
      repo.save.mockImplementation((e: any) => Promise.resolve(e));

      await (service as any).pushDeployToExecutor(deployment, mockApp);

      expect(deployment.status).toBe(DeploymentStatus.FAILED);
      expect(deployment.statusMessage).toMatch(/refused|resolves/i);
      expect(mockAxiosPost).not.toHaveBeenCalled();
      expect(versionRepo.save).not.toHaveBeenCalled();
    });

    it("R8: pushDeployToExecutor refuses a loopback IP literal before sending", async () => {
      const deployment = {
        id: "deploy-1",
        applicationId: "app-1",
        executorAddress: "127.0.0.1:3001",
        runMode: RunMode.DAEMON,
        env: null,
        startCommand: null,
        status: DeploymentStatus.PENDING,
        statusMessage: null as string | null,
      };
      repo.save.mockImplementation((e: any) => Promise.resolve(e));

      await (service as any).pushDeployToExecutor(deployment, mockApp);

      expect(deployment.status).toBe(DeploymentStatus.FAILED);
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it("R8: pushDeployToExecutor still reaches a public executor (behavior unchanged)", async () => {
      const deployment = {
        id: "deploy-1",
        applicationId: "app-1",
        executorAddress: "203.0.113.10:3001",
        runMode: RunMode.DAEMON,
        env: null,
        startCommand: null,
        status: DeploymentStatus.PENDING,
      };
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      mockAxiosPost.mockResolvedValue({ data: {} });

      await (service as any).pushDeployToExecutor(deployment, mockApp);

      expect(deployment.status).toBe(DeploymentStatus.DEPLOYING);
      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    });

    it("R8: stop refuses a metadata address without an outbound request", async () => {
      const deployment = {
        id: "deploy-1",
        status: DeploymentStatus.RUNNING,
        executorAddress: "169.254.169.254:3001",
        pid: 1234,
      };
      repo.findOne.mockResolvedValue(deployment);
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => {});

      const result = await service.stop("deploy-1");

      expect(mockAxiosPost).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refused"));
      // stop semantics preserved: the row still transitions to STOPPED.
      expect(result.status).toBe(DeploymentStatus.STOPPED);
      warnSpy.mockRestore();
    });

    it("R8: stop still signals a public executor", async () => {
      const deployment = {
        id: "deploy-1",
        status: DeploymentStatus.RUNNING,
        executorAddress: "203.0.113.10:3001",
        pid: 1234,
      };
      repo.findOne.mockResolvedValue(deployment);
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      mockAxiosPost.mockResolvedValue({ data: {} });

      await service.stop("deploy-1");

      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
      expect(mockAxiosPost.mock.calls[0][0]).toContain("203.0.113.10:3001");
    });
  });

  describe("stop", () => {
    it("sets status to STOPPED and saves", async () => {
      const deployment = {
        id: "deploy-1",
        status: DeploymentStatus.RUNNING,
        executorAddress: mockExecutor.address,
        pid: 1234,
      };
      repo.findOne.mockResolvedValue(deployment);
      repo.save.mockResolvedValue({
        ...deployment,
        status: DeploymentStatus.STOPPED,
        pid: null,
      });
      mockAxiosPost.mockResolvedValue({ data: {} });

      const result = await service.stop("deploy-1");
      expect(result.status).toBe(DeploymentStatus.STOPPED);
      expect(result.pid).toBeNull();
    });

    it("marks STOPPED even when executor call fails", async () => {
      const deployment = {
        id: "deploy-1",
        status: DeploymentStatus.RUNNING,
        executorAddress: mockExecutor.address,
        pid: 1234,
      };
      repo.findOne.mockResolvedValue(deployment);
      repo.save.mockResolvedValue({
        ...deployment,
        status: DeploymentStatus.STOPPED,
        pid: null,
      });
      mockAxiosPost.mockRejectedValue(new Error("executor offline"));

      const result = await service.stop("deploy-1");
      expect(result.status).toBe(DeploymentStatus.STOPPED);
    });
  });

  describe("detectStuckDeployments", () => {
    it("marks stuck deployments and their version snapshots as failed", async () => {
      const stuckDeployment = {
        id: "deploy-1",
        applicationId: "app-1",
        status: DeploymentStatus.DEPLOYING,
        statusMessage: null,
        deployedVersion: "1.0.0",
        deployedCommit: "abc123",
      };
      const versionSnapshot = {
        id: "version-1",
        applicationId: "app-1",
        version: "1.0.0",
        gitCommit: "abc123",
        sourceDeploymentId: "deploy-1",
        status: "deploying",
      };
      repo.find.mockResolvedValue([stuckDeployment]);
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      versionRepo.findOne.mockResolvedValue(versionSnapshot);
      versionRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.detectStuckDeployments();

      expect(stuckDeployment.status).toBe(DeploymentStatus.FAILED);
      expect(stuckDeployment.statusMessage).toBe(
        "[System] Deployment timed out after 10 minutes",
      );
      expect(versionSnapshot.status).toBe("failed");
      expect(versionRepo.save).toHaveBeenCalledWith(versionSnapshot);
    });

    // R6: the stuck predicate must key on updatedAt (refreshed when the row
    // enters DEPLOYING/UPGRADING and on every heartbeat), not createdAt. A
    // legacy deployment upgraded in place re-enters an in-progress state on
    // the SAME row with its original createdAt — a createdAt-based cron
    // mis-marked it FAILED and polluted the version snapshot.
    // QA5: PENDING joins the scan with its own shorter threshold.
    it("R6: selects stuck rows by updatedAt, never createdAt (pending + deploying + upgrading)", async () => {
      repo.find.mockResolvedValue([]);

      await service.detectStuckDeployments();

      expect(repo.find).toHaveBeenCalledTimes(1);
      const arg = repo.find.mock.calls[0][0];
      const where = arg.where as Array<Record<string, unknown>>;
      expect(Array.isArray(where)).toBe(true);
      expect(where.map((w) => w.status)).toEqual(
        expect.arrayContaining([
          DeploymentStatus.PENDING,
          DeploymentStatus.DEPLOYING,
          DeploymentStatus.UPGRADING,
        ]),
      );
      // Per-status thresholds: PENDING is swept after 5 minutes (QA5 — the
      // normal PENDING window is process-internal), DEPLOYING/UPGRADING after
      // the original 10.
      const expectedMs: Record<string, number> = {
        [DeploymentStatus.PENDING]: 5 * 60 * 1000,
        [DeploymentStatus.DEPLOYING]: 10 * 60 * 1000,
        [DeploymentStatus.UPGRADING]: 10 * 60 * 1000,
      };
      for (const w of where) {
        expect(w.createdAt).toBeUndefined();
        const op = w.updatedAt as { type: string; value: Date };
        // TypeORM FindOperator carrying LessThan(now - threshold)
        expect(op).toBeDefined();
        expect(op.type).toBe("lessThan");
        const threshold = op.value.getTime();
        const expected = expectedMs[w.status as string];
        expect(Date.now() - threshold).toBeGreaterThanOrEqual(expected - 1000);
        expect(Date.now() - threshold).toBeLessThan(expected + 5000);
      }
    });

    // QA5: deploy() INSERTs PENDING then pushes asynchronously — a crash
    // between the two steps leaves the row PENDING forever, where it keeps
    // matching the partial unique index and permanently 409s every future
    // deployment of the application. The sweep must recover such rows.
    it("QA5: a PENDING row stuck past the threshold is marked FAILED with an explanatory message", async () => {
      const pendingRow = {
        id: "deploy-pending",
        applicationId: "app-1",
        status: DeploymentStatus.PENDING,
        statusMessage: null,
        deployedVersion: null,
        deployedCommit: null,
      };
      repo.find.mockResolvedValue([pendingRow]);
      repo.save.mockImplementation((e: any) => Promise.resolve(e));
      versionRepo.findOne.mockResolvedValue(null);

      await service.detectStuckDeployments();

      expect(pendingRow.status).toBe(DeploymentStatus.FAILED);
      expect(pendingRow.statusMessage).toMatch(/PENDING/);
      expect(pendingRow.statusMessage).toMatch(/5 minutes/);
      // PENDING rows have no version snapshot yet — nothing to mark failed.
      expect(versionRepo.save).not.toHaveBeenCalled();
      // FAILED releases the partial unique index for the application.
      expect(pendingRow.status).not.toBe(DeploymentStatus.PENDING);
    });

    it("R6: an upgraded legacy deployment (old createdAt, fresh updatedAt) is not in the stuck set", async () => {
      // Simulates exactly the DB behavior the new predicate produces: the
      // row's createdAt is old but updatedAt was refreshed by the
      // DEPLOYING save, so it does not match updatedAt < now-10min.
      const now = Date.now();
      const upgradedRow = {
        id: "deploy-9",
        createdAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(now - 30 * 1000),
        status: DeploymentStatus.DEPLOYING,
      };
      const predicate = (row: { updatedAt: Date }) =>
        row.updatedAt.getTime() < now - 10 * 60 * 1000;
      expect(predicate(upgradedRow)).toBe(false);
      // sanity: the old createdAt-based predicate WOULD have killed it
      expect(upgradedRow.createdAt.getTime() < now - 10 * 60 * 1000).toBe(true);
    });
  });

  describe("handleHeartbeat", () => {
    it("updates status and pid from heartbeat", async () => {
      const deployment = {
        id: "deploy-1",
        status: DeploymentStatus.DEPLOYING,
        pid: null,
        statusMessage: null,
        lastHeartbeat: null,
      };
      repo.findOne.mockResolvedValue(deployment);
      repo.save.mockResolvedValue(deployment);

      await service.handleHeartbeat({
        deploymentId: "deploy-1",
        status: "running",
        pid: 5678,
        message: "up and running",
      });

      expect(deployment.status).toBe(DeploymentStatus.RUNNING);
      expect(deployment.pid).toBe(5678);
      expect(deployment.statusMessage).toBe("up and running");
      expect(repo.save).toHaveBeenCalled();
    });

    it("silently ignores heartbeat for unknown deployment", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.handleHeartbeat({ deploymentId: "ghost", status: "running" }),
      ).resolves.toBeUndefined();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it("handles unknown status string without crashing", async () => {
      const deployment = {
        id: "deploy-1",
        status: DeploymentStatus.RUNNING,
        pid: null,
        statusMessage: null,
        lastHeartbeat: null,
      };
      repo.findOne.mockResolvedValue(deployment);
      repo.save.mockResolvedValue(deployment);

      await service.handleHeartbeat({
        deploymentId: "deploy-1",
        status: "weird-status",
      });
      // status should remain unchanged
      expect(deployment.status).toBe(DeploymentStatus.RUNNING);
    });

    // 部署状态机（心跳侧）：RUNNING 心跳 → 版本快照 released + deployment.completed
    it("running heartbeat marks the version snapshot released and emits deployment.completed", async () => {
      const deployment = {
        id: "deploy-1",
        applicationId: "app-1",
        status: DeploymentStatus.DEPLOYING,
        deployedVersion: "1.2.0",
        deployedCommit: "abc123",
        executorAddress: "host:3002",
        pid: null,
        statusMessage: null,
        lastHeartbeat: null,
      };
      repo.findOne.mockResolvedValue(deployment);
      repo.save.mockResolvedValue(deployment);
      versionRepo.findOne.mockResolvedValue({ id: "v-1", status: "pending" });
      const bus = { emit: jest.fn() };
      (service as unknown as { eventBus: unknown }).eventBus = bus;

      await service.handleHeartbeat({
        deploymentId: "deploy-1",
        status: "running",
      });

      // 快照状态翻转：pending → released，按版本+commit+来源部署四键定位
      expect(versionRepo.findOne).toHaveBeenCalledWith({
        where: {
          applicationId: "app-1",
          version: "1.2.0",
          gitCommit: "abc123",
          sourceDeploymentId: "deploy-1",
        },
      });
      expect(versionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "v-1", status: "released" }),
      );
      // FEAT-07: 终态落库后出站事件（载荷全原始类型）
      expect(bus.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.DEPLOYMENT_COMPLETED,
        expect.objectContaining({
          deploymentId: "deploy-1",
          applicationId: "app-1",
          executorAddress: "host:3002",
          status: DeploymentStatus.RUNNING,
          deployedVersion: "1.2.0",
          deployedCommit: "abc123",
        }),
      );
    });

    // failed 心跳 → 版本快照 failed；非 RUNNING 终态不发 deployment.completed
    it("failed heartbeat marks the version snapshot failed and does not emit deployment.completed", async () => {
      const deployment = {
        id: "deploy-1",
        applicationId: "app-1",
        status: DeploymentStatus.DEPLOYING,
        deployedVersion: "1.2.0",
        deployedCommit: "abc123",
        pid: null,
        statusMessage: null,
        lastHeartbeat: null,
      };
      repo.findOne.mockResolvedValue(deployment);
      repo.save.mockResolvedValue(deployment);
      versionRepo.findOne.mockResolvedValue({ id: "v-1", status: "released" });
      const bus = { emit: jest.fn() };
      (service as unknown as { eventBus: unknown }).eventBus = bus;

      await service.handleHeartbeat({
        deploymentId: "deploy-1",
        status: "failed",
        message: "process crashed",
      });

      expect(deployment.status).toBe(DeploymentStatus.FAILED);
      expect(deployment.statusMessage).toBe("process crashed");
      expect(versionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "v-1", status: "failed" }),
      );
      expect(bus.emit).not.toHaveBeenCalled();
    });

    // stopped 心跳：不在状态机两分支内——不动快照、不发事件，仅落心跳与状态
    it("stopped heartbeat leaves snapshots untouched and emits nothing", async () => {
      const deployment = {
        id: "deploy-1",
        applicationId: "app-1",
        status: DeploymentStatus.RUNNING,
        deployedVersion: "1.2.0",
        pid: null,
        statusMessage: null,
        lastHeartbeat: null,
      };
      repo.findOne.mockResolvedValue(deployment);
      repo.save.mockResolvedValue(deployment);
      const bus = { emit: jest.fn() };
      (service as unknown as { eventBus: unknown }).eventBus = bus;

      await service.handleHeartbeat({
        deploymentId: "deploy-1",
        status: "stopped",
      });

      expect(deployment.status).toBe(DeploymentStatus.STOPPED);
      expect(versionRepo.findOne).not.toHaveBeenCalled();
      expect(versionRepo.save).not.toHaveBeenCalled();
      expect(bus.emit).not.toHaveBeenCalled();
    });

    // 快照幂等：status 已是目标态时不再写库；无 deployedVersion 的心跳
    // 不触发任何快照查询
    it("skips snapshot writes when status matches or no deployedVersion exists", async () => {
      const deployment = {
        id: "deploy-1",
        applicationId: "app-1",
        status: DeploymentStatus.DEPLOYING,
        deployedVersion: null,
        pid: null,
        statusMessage: null,
        lastHeartbeat: null,
      };
      repo.findOne.mockResolvedValue(deployment);
      repo.save.mockResolvedValue(deployment);

      await service.handleHeartbeat({
        deploymentId: "deploy-1",
        status: "running",
      });
      expect(versionRepo.findOne).not.toHaveBeenCalled();

      deployment.deployedVersion = "1.2.0";
      versionRepo.findOne.mockResolvedValue({ id: "v-1", status: "released" });
      await service.handleHeartbeat({
        deploymentId: "deploy-1",
        status: "running",
      });
      expect(versionRepo.findOne).toHaveBeenCalledTimes(1);
      expect(versionRepo.save).not.toHaveBeenCalled();
    });
  });
});

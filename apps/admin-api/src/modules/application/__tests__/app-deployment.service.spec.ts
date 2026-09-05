import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, BadRequestException } from "@nestjs/common";
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

// Mock axios to avoid real HTTP calls
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ data: {} }) },
}));
import axios from "axios";
const mockAxiosPost = axios.post as jest.Mock;

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
  let appService: jest.Mocked<Pick<ApplicationService, "findById" | "update">>;
  let executorService: jest.Mocked<
    Pick<ExecutorService, "findOne" | "getExecutorUrl" | "getSharedToken">
  >;

  beforeEach(async () => {
    repo = makeRepo();
    versionRepo = makeRepo();
    appService = {
      findById: jest.fn().mockResolvedValue(mockApp),
      update: jest.fn((_: string, dto: any) =>
        Promise.resolve({ ...mockApp, ...dto }),
      ),
    };
    executorService = {
      findOne: jest.fn().mockResolvedValue(mockExecutor),
      getExecutorUrl: jest.fn((addr, path) => `${addr}/${path}`),
      // 部署指令鉴权头现走 DB 优先的 getSharedToken
      getSharedToken: jest.fn().mockResolvedValue(""),
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
      expect(appService.findById).toHaveBeenCalledWith("app-1");
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
      ).rejects.toThrow(BadRequestException);
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
  });
});

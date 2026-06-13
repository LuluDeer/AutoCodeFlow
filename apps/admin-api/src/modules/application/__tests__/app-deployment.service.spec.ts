import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppDeploymentService } from "../app-deployment.service";
import { AppDeployment, DeploymentStatus, RunMode } from "../entities/app-deployment.entity";
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
  let appService: jest.Mocked<Pick<ApplicationService, "findById">>;
  let executorService: jest.Mocked<Pick<ExecutorService, "findOne" | "getExecutorUrl">>;

  beforeEach(async () => {
    repo = makeRepo();
    appService = { findById: jest.fn().mockResolvedValue(mockApp) };
    executorService = {
      findOne: jest.fn().mockResolvedValue(mockExecutor),
      getExecutorUrl: jest.fn((addr, path) => `${addr}/${path}`),
    };

    const module = await Test.createTestingModule({
      providers: [
        AppDeploymentService,
        { provide: getRepositoryToken(AppDeployment), useValue: repo },
        { provide: ApplicationService, useValue: appService },
        { provide: ExecutorService, useValue: executorService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
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
      const saved = { id: "deploy-1", status: DeploymentStatus.PENDING, executorAddress: mockExecutor.address };
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
      repo.findOne.mockResolvedValue({ id: "deploy-existing", status: "deploying" });
      await expect(
        service.deploy("app-1", { executorId: "exec-1", runMode: RunMode.DAEMON }),
      ).rejects.toThrow(BadRequestException);
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
      repo.save.mockResolvedValue({ ...deployment, status: DeploymentStatus.STOPPED, pid: null });
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
      repo.save.mockResolvedValue({ ...deployment, status: DeploymentStatus.STOPPED, pid: null });
      mockAxiosPost.mockRejectedValue(new Error("executor offline"));

      const result = await service.stop("deploy-1");
      expect(result.status).toBe(DeploymentStatus.STOPPED);
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

      await service.handleHeartbeat({ deploymentId: "deploy-1", status: "weird-status" });
      // status should remain unchanged
      expect(deployment.status).toBe(DeploymentStatus.RUNNING);
    });
  });
});

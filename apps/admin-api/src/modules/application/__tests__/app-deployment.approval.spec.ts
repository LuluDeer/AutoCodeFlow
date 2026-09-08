import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppDeploymentService } from "../app-deployment.service";
import {
  AppDeployment,
  DeploymentStatus,
  DeploymentApprovalStatus,
} from "../entities/app-deployment.entity";
import { ApplicationVersion } from "../entities/application-version.entity";
import { ApplicationService } from "../application.service";
import { ExecutorService } from "../../executor/executor.service";
import { AuditService } from "../../audit/audit.service";

// Mock axios to avoid real HTTP calls (same as app-deployment.service.spec).
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ data: {} }) },
}));
import axios from "axios";
const mockAxiosPost = axios.post as jest.Mock;
// R8: pushDeployToExecutor runs assertSafeExecutorUrl (node:dns/promises).
jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
import { lookup } from "node:dns/promises";
const mockedLookup = lookup as unknown as jest.Mock;

const flush = () => new Promise((r) => setTimeout(r, 0));

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  create: jest.fn((d: any) => ({ ...d, id: d.id ?? "deploy-1" })),
  save: jest.fn((e: any) => Promise.resolve({ ...e, id: e.id ?? "deploy-1" })),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  ...overrides,
});

const requester = { id: 1, name: "alice" };
const approver = { id: 2, name: "bob" };

const makeApp = (approvalRequired: boolean) => ({
  id: "app-1",
  name: "my-app",
  gitRepo: "https://github.com/org/repo",
  gitBranch: "main",
  runtime: "node",
  entrypoint: "node dist/main.js",
  version: "1.0.0",
  env: { NODE_ENV: "production" },
  approvalRequired,
});

const makePendingRow = (overrides: Record<string, any> = {}) => ({
  id: "deploy-1",
  applicationId: "app-1",
  executorId: "exec-1",
  executorAddress: "executor:3001",
  runMode: "daemon",
  status: DeploymentStatus.PENDING,
  approvalStatus: DeploymentApprovalStatus.PENDING_APPROVAL,
  approvalMeta: {
    requestedBy: requester.id,
    requestedByName: requester.name,
    requestedAt: "2026-09-08T00:00:00.000Z",
  },
  statusMessage: "Awaiting deployment approval",
  ...overrides,
});

describe("AppDeploymentService — DEP-04 审批流", () => {
  let service: AppDeploymentService;
  let repo: ReturnType<typeof makeRepo>;
  let appService: any;
  let executorService: any;
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    repo = makeRepo();
    appService = {
      findById: jest.fn(),
      findByIdRaw: jest.fn().mockResolvedValue(makeApp(true)),
      update: jest.fn(),
      maskEnvForRead: jest.fn((env: any) => env),
      maskReadSurface: jest.fn((app: any) => app),
    };
    executorService = {
      findOne: jest.fn().mockResolvedValue({ id: "exec-1", address: "executor:3001" }),
      // Mirror the real getExecutorUrl: bare host:port gets the http:// scheme.
      getExecutorUrl: jest.fn(
        (addr: string, p: string) =>
          `${addr.startsWith("http://") || addr.startsWith("https://") ? "" : "http://"}${addr}/${p}`,
      ),
      getSharedToken: jest.fn().mockResolvedValue(""),
      selectLeastLoaded: jest.fn().mockResolvedValue({ id: "exec-1", address: "executor:3001" }),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        AppDeploymentService,
        { provide: getRepositoryToken(AppDeployment), useValue: repo },
        { provide: getRepositoryToken(ApplicationVersion), useValue: makeRepo() },
        { provide: ApplicationService, useValue: appService },
        { provide: ExecutorService, useValue: executorService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(AppDeploymentService);
    mockAxiosPost.mockClear();
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(async () => {
    // fire-and-forget 推送链排空，避免跨用例悬挂 promise
    await flush();
    await flush();
  });

  describe("deploy() 审批门控", () => {
    it("approvalRequired=true：冻结为 pending_approval 行且不派发（无 axios push）", async () => {
      appService.findByIdRaw.mockResolvedValue(makeApp(true));

      const result = await service.deploy("app-1", {}, requester);
      await flush();

      expect(result.approvalStatus).toBe(
        DeploymentApprovalStatus.PENDING_APPROVAL,
      );
      expect(result.status).toBe(DeploymentStatus.PENDING);
      expect(result.approvalMeta.requestedBy).toBe(requester.id);
      expect(result.approvalMeta.requestedByName).toBe(requester.name);
      // 行只写一次（冻结），推送链零触发。
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(repo.save.mock.calls[0][0].statusMessage).toBe(
        "Awaiting deployment approval",
      );
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it("approvalRequired=false：既有直派行为零变化（无 approvalStatus，推送链触发）", async () => {
      appService.findByIdRaw.mockResolvedValue(makeApp(false));

      const result = await service.deploy("app-1", {}, requester);
      await flush();

      expect(result.approvalStatus).toBeUndefined();
      expect(repo.create).toHaveBeenCalledWith(
        expect.not.objectContaining({ approvalStatus: expect.anything() }),
      );
      expect(mockAxiosPost).toHaveBeenCalled();
    });

    it("待审批行占用 in-flight 名额：guard 命中时 409", async () => {
      appService.findByIdRaw.mockResolvedValue(makeApp(true));
      repo.findOne.mockResolvedValue(makePendingRow());

      await expect(service.deploy("app-1", {}, approver)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe("approve()", () => {
    it("第二人放行：原子认领 UPDATE + 转入 APPROVED + 推送链触发", async () => {
      repo.findOne.mockResolvedValue(makePendingRow());

      const result = await service.approveDeployment("deploy-1", approver);
      await flush();

      expect(result.approvalStatus).toBe(DeploymentApprovalStatus.APPROVED);
      expect(result.approvalMeta.actedBy).toBe(approver.id);
      expect(result.approvalMeta.actedByName).toBe(approver.name);
      expect(repo.update).toHaveBeenCalledWith(
        {
          id: "deploy-1",
          approvalStatus: DeploymentApprovalStatus.PENDING_APPROVAL,
        },
        expect.objectContaining({
          approvalStatus: DeploymentApprovalStatus.APPROVED,
        }),
      );
      // 推送链真实触发（fire-and-forget 落 DEPLOYING + 对执行器发请求）
      expect(mockAxiosPost).toHaveBeenCalled();
    });

    it("第二人规则：提交者本人 approve → 403 且零写入", async () => {
      repo.findOne.mockResolvedValue(makePendingRow());

      await expect(
        service.approveDeployment("deploy-1", requester),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("非待审批行 approve → 409", async () => {
      repo.findOne.mockResolvedValue(
        makePendingRow({ approvalStatus: DeploymentApprovalStatus.APPROVED }),
      );
      await expect(
        service.approveDeployment("deploy-1", approver),
      ).rejects.toThrow(ConflictException);
    });

    it("并发双审批：原子认领 affected=0 → 409（仅首者生效）", async () => {
      repo.findOne.mockResolvedValue(makePendingRow());
      repo.update.mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.approveDeployment("deploy-1", approver),
      ).rejects.toThrow(ConflictException);
    });

    it("approve 走审计（deployment.approve, app_deployment 资源, 提交人入 detail）", async () => {
      repo.findOne.mockResolvedValue(makePendingRow());

      await service.approveDeployment("deploy-1", approver);

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "deployment.approve",
          resource: "app_deployment",
          resourceId: "deploy-1",
          userId: approver.id,
          username: approver.name,
          detail: expect.objectContaining({ applicationId: "app-1" }),
        }),
      );
    });
  });

  describe("reject()", () => {
    it("拒绝：终态 FAILED（离开 in-flight）+ reason 双落（meta+statusMessage）", async () => {
      repo.findOne.mockResolvedValue(makePendingRow());

      const result = await service.rejectDeployment(
        "deploy-1",
        approver,
        "未走变更评审",
      );

      expect(result.approvalStatus).toBe(DeploymentApprovalStatus.REJECTED);
      expect(result.status).toBe(DeploymentStatus.FAILED);
      expect(result.approvalMeta.reason).toBe("未走变更评审");
      expect(result.statusMessage).toContain("未走变更评审");
      expect(repo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          approvalStatus: DeploymentApprovalStatus.REJECTED,
          status: DeploymentStatus.FAILED,
        }),
      );
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it("第二人规则：提交者本人 reject → 403", async () => {
      repo.findOne.mockResolvedValue(makePendingRow());

      await expect(
        service.rejectDeployment("deploy-1", requester, "self"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("reject 走审计（deployment.reject, reason 进 detail）", async () => {
      repo.findOne.mockResolvedValue(makePendingRow());

      await service.rejectDeployment("deploy-1", approver, "no-change-window");

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "deployment.reject",
          detail: expect.objectContaining({ reason: "no-change-window" }),
        }),
      );
    });
  });

  describe("cancel()", () => {
    it("提交者本人撤回：CANCELLED + FAILED 终态", async () => {
      repo.findOne.mockResolvedValue(makePendingRow());

      const result = await service.cancelDeployment("deploy-1", requester);

      expect(result.approvalStatus).toBe(DeploymentApprovalStatus.CANCELLED);
      expect(result.status).toBe(DeploymentStatus.FAILED);
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it("非提交者 cancel → 403（其他管理员想否决走 reject）", async () => {
      repo.findOne.mockResolvedValue(makePendingRow());

      await expect(
        service.cancelDeployment("deploy-1", approver),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("审计降级与脏数据容错", () => {
    it("AuditService 故障不阻断审批主链（fail-open warn）", async () => {
      repo.findOne.mockResolvedValue(makePendingRow());
      audit.log.mockRejectedValueOnce(new Error("audit down"));

      const result = await service.approveDeployment("deploy-1", approver);
      expect(result.approvalStatus).toBe(DeploymentApprovalStatus.APPROVED);
    });

    it("requestedBy 缺失（脏数据）：第二人检查放行 + 审批链可用", async () => {
      repo.findOne.mockResolvedValue(makePendingRow({ approvalMeta: {} }));

      const result = await service.approveDeployment("deploy-1", approver);
      expect(result.approvalStatus).toBe(DeploymentApprovalStatus.APPROVED);
    });
  });
});

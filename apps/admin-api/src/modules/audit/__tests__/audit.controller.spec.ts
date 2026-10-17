import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { AuditController } from "../audit.controller";
import { AuditService } from "../audit.service";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";

const mockAuditService = () => ({
  findAll: jest.fn(),
  exportCsv: jest.fn(),
});

describe("AuditController", () => {
  let controller: AuditController;
  let svc: ReturnType<typeof mockAuditService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [{ provide: AuditService, useFactory: mockAuditService }],
    }).compile();

    controller = module.get(AuditController);
    svc = module.get(AuditService);
  });

  afterEach(() => jest.clearAllMocks());

  // R5: audit endpoints carry sensitive operational data — the global
  // RolesGuard enforces ADMIN via this route metadata.
  describe("RBAC metadata", () => {
    it("findAll is restricted to ADMIN", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AuditController.prototype.findAll,
      );
      expect(roles).toEqual([UserRole.ADMIN]);
    });

    it("exportCsv is restricted to ADMIN", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AuditController.prototype.exportCsv,
      );
      expect(roles).toEqual([UserRole.ADMIN]);
    });
  });

  describe("findAll", () => {
    it("returns paginated audit logs", async () => {
      const expected = { data: [{ id: 1, action: "auth.login" }], total: 1 };
      svc.findAll.mockResolvedValue(expected);

      const result = await controller.findAll({
        page: 1,
        pageSize: 20,
      } as any);

      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, pageSize: 20 }),
      );
      expect(result).toEqual(expected);
    });

    it("passes action filter to service", async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({
        page: 1,
        pageSize: 10,
        action: "auth.login",
      } as any);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ action: "auth.login" }),
      );
    });

    it("passes resource filter to service", async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({
        page: 1,
        pageSize: 10,
        resource: "task",
      } as any);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ resource: "task" }),
      );
    });

    // AUTH-05: (resource, resourceId) pair filter passthrough.
    it("AUTH-05: passes resourceId filter to service", async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({
        page: 1,
        pageSize: 10,
        resource: "executor",
        resourceId: "e-42",
      } as any);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ resource: "executor", resourceId: "e-42" }),
      );
    });

    it("passes userId filter to service", async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({ page: 1, pageSize: 10, userId: 42 } as any);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 42 }),
      );
    });

    it("passes username and time-range filters to service", async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({
        page: 1,
        pageSize: 10,
        username: "admin",
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-31T23:59:59.000Z",
      } as any);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          username: "admin",
          startTime: "2026-01-01T00:00:00.000Z",
          endTime: "2026-01-31T23:59:59.000Z",
        }),
      );
    });

    // result 筛选透传（列表 + CSV 导出同滤，R4 P1-2 parity）。
    it("passes result filter to service", async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({
        page: 1,
        pageSize: 10,
        result: "failure",
      } as any);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ result: "failure" }),
      );
    });

    it("returns empty result when no logs match", async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      const result = await controller.findAll({
        page: 5,
        pageSize: 20,
        action: "nonexistent",
      } as any);
      expect(result).toEqual({ data: [], total: 0 });
    });

    // §2.1：`cursor` 必须**原样透传**（不能写成 `?? ""`——那会把每个不带游标的
    // 请求都推进 keyset 分支，破坏"不带 cursor 时响应逐字节不变"的加性契约）。
    it("§2.1: passes cursor through to the service verbatim", async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0, nextCursor: null });
      await controller.findAll({
        page: 1,
        pageSize: 10,
        cursor: "abc123",
      } as any);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: "abc123" }),
      );
    });

    it("§2.1: omitting cursor does NOT synthesise an empty-string cursor", async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({ page: 1, pageSize: 10 } as any);
      // 显式断言成 undefined（而不是 ""）——空串在服务层意味着"进入 keyset 模式"，
      // 而"没传"必须走 OFFSET 分支。
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: undefined }),
      );
    });
  });

  describe("exportCsv", () => {
    it("sends CSV with the same filter set as the list endpoint", async () => {
      svc.exportCsv.mockResolvedValue("id,action\n1,auth.login");
      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
      } as any;

      await controller.exportCsv(
        {
          action: "auth.login",
          username: "admin",
          startTime: "2026-01-01T00:00:00.000Z",
          endTime: "2026-01-31T23:59:59.000Z",
        } as any,
        res,
      );

      expect(svc.exportCsv).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "auth.login",
          username: "admin",
          startTime: "2026-01-01T00:00:00.000Z",
          endTime: "2026-01-31T23:59:59.000Z",
        }),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/csv; charset=utf-8",
      );
      expect(res.send).toHaveBeenCalledWith("id,action\n1,auth.login");
    });

    // AUTH-05: export honours the identical filter set including resourceId.
    it("AUTH-05: exportCsv passes resourceId through to the service", async () => {
      svc.exportCsv.mockResolvedValue("id,action\n1,auth.login");
      const res = { setHeader: jest.fn(), send: jest.fn() } as any;

      await controller.exportCsv({ resourceId: "exec-abc" } as any, res);

      expect(svc.exportCsv).toHaveBeenCalledWith(
        expect.objectContaining({ resourceId: "exec-abc" }),
      );
    });

    it("exportCsv passes result through to the service", async () => {
      svc.exportCsv.mockResolvedValue("id,action\n1,auth.login");
      const res = { setHeader: jest.fn(), send: jest.fn() } as any;

      await controller.exportCsv({ result: "success" } as any, res);

      expect(svc.exportCsv).toHaveBeenCalledWith(
        expect.objectContaining({ result: "success" }),
      );
    });
  });
});

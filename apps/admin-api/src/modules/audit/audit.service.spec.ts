import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AuditService } from "./audit.service";
import { AuditLog } from "./entities/audit-log.entity";

const makeRepo = () => ({
  create: jest.fn((d: any) => d),
  save: jest.fn((e: any) => Promise.resolve(e)),
  find: jest.fn(),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
});

describe("AuditService", () => {
  let service: AuditService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    repo = makeRepo();
    const module = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditLog), useValue: repo },
      ],
    }).compile();
    service = module.get(AuditService);
  });

  describe("log", () => {
    it("should save an audit log entry", async () => {
      await service.log({
        userId: 1,
        username: "admin",
        action: "task.create",
        resource: "task",
        resourceId: "task-1",
        ip: "127.0.0.1",
      });

      expect(repo.create).toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalled();
    });

    it("should default result to success", async () => {
      await service.log({ action: "test" });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ result: "success" }),
      );
    });

    it("should accept failure result", async () => {
      await service.log({ action: "test", result: "failure" });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ result: "failure" }),
      );
    });
  });
});

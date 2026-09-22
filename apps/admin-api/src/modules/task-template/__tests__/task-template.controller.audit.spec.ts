import { Test } from "@nestjs/testing";
import { TaskTemplateController } from "../task-template.controller";
import { TaskTemplateService } from "../task-template.service";
import { AuditService } from "../../audit/audit.service";
import { UserRole } from "../../users/entities/user.entity";

/**
 * D3-B-P2-2: task-template delete 审计落证回归。
 * 断言 remove() 委托 service 后落证 task_template.delete。
 */
describe("TaskTemplateController — D3-B-P2-2 删除审计落证", () => {
  it("remove：落证 task_template.delete（含操作人）", async () => {
    const svc = {
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new TaskTemplateController(
      svc as never,
      audit as unknown as AuditService,
    );
    const user = {
      username: "admin",
      role: UserRole.ADMIN,
    } as never;

    await controller.remove("tpl-1", user);

    expect(svc.remove).toHaveBeenCalledWith("tpl-1", {
      username: "admin",
      role: UserRole.ADMIN,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task_template.delete",
        resource: "task_template",
        resourceId: "tpl-1",
      }),
    );
  });
});

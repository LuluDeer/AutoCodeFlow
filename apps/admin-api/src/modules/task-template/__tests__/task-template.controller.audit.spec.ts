import { TaskTemplateController } from "../task-template.controller";
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
    // R39-A1：属主判定按 user id，请求方必须带 id。
    const user = {
      id: 7,
      username: "admin",
      role: UserRole.ADMIN,
    } as never;

    await controller.remove("tpl-1", user);

    expect(svc.remove).toHaveBeenCalledWith("tpl-1", {
      id: 7,
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

/**
 * P1-5: task_template.update 审计落证回归。
 * 断言 update() 委托 service 后落证 task_template.update，detail 记录被改字段。
 */
describe("TaskTemplateController — P1-5 编辑审计落证", () => {
  it("update：落证 task_template.update（含操作人与字段集合）", async () => {
    const svc = {
      update: jest.fn().mockResolvedValue({ id: "tpl-1" }),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new TaskTemplateController(
      svc as never,
      audit as unknown as AuditService,
    );
    const user = {
      id: 7,
      username: "admin",
      role: UserRole.ADMIN,
    } as never;
    const body = { name: "改名", category: "巡检" };

    await controller.update("tpl-1", body, user);

    expect(svc.update).toHaveBeenCalledWith(
      "tpl-1",
      body,
      expect.objectContaining({
        id: 7,
        username: "admin",
        role: UserRole.ADMIN,
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task_template.update",
        resource: "task_template",
        resourceId: "tpl-1",
        detail: { fields: ["name", "category"] },
      }),
    );
  });
});

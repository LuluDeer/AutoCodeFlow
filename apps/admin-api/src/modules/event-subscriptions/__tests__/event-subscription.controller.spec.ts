import { EventSubscriptionController } from "../event-subscription.controller";
import { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { UserRole } from "../../users/entities/user.entity";
import { EventSubscription } from "../entities/event-subscription.entity";
import { ParseUUIDPipe } from "@nestjs/common";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { WRITE_GUARD_KEY } from "../../../common/decorators/write-guard.decorator";

/**
 * QA-02（coverage 第一阶段）：FEAT-07 出站订阅 HTTP 面的控制器行为。
 *
 * event-subscriptions.spec 覆盖了 util/dispatcher/service 语义，但控制器
 * 七个端点此前零覆盖——路由参数如何进入服务、replay 的两段编排
 * （getDeadLetterForReplay → dispatcher.replayDeadLetter）与结果映射
 * （ok/error）是 HTTP 边界独有的契约，本 spec 直调处理器逐端点固化。
 */
describe("EventSubscriptionController — 端点委托契约（QA-02）", () => {
  const admin: AuthUser = {
    id: 1,
    username: "admin",
    email: "a@x",
    role: UserRole.ADMIN,
    isActive: true,
  };
  const plain: AuthUser = {
    id: 7,
    username: "u7",
    email: "u7@x",
    role: UserRole.USER,
    isActive: true,
  };
  const SUB_ID = "11111111-1111-4111-8111-111111111111";
  const DL_ID = "22222222-2222-4222-8222-222222222222";

  const makeDeps = () => {
    const svc = {
      findAll: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ subscription: { id: SUB_ID } }),
      update: jest.fn().mockResolvedValue({ id: SUB_ID, enabled: false }),
      remove: jest.fn().mockResolvedValue(undefined),
      listDeadLetters: jest
        .fn()
        .mockResolvedValue({ data: [{ id: DL_ID }], total: 1 }),
      getDeadLetterForReplay: jest.fn().mockResolvedValue({
        subscription: { id: SUB_ID },
        deadLetter: { id: DL_ID },
      }),
    };
    const dispatcher = {
      replayDeadLetter: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new EventSubscriptionController(
      svc as any,
      dispatcher as any,
    );
    const req = { user: admin } as any;
    return { controller, svc, dispatcher, req };
  };

  it("list forwards req.user — the ADMIN/all-own query split happens in the service", async () => {
    const { controller, svc, req } = makeDeps();
    await controller.list(req);
    expect(svc.findAll).toHaveBeenCalledWith(req.user);

    await controller.list({ user: plain } as any);
    expect(svc.findAll).toHaveBeenLastCalledWith(plain);
  });

  it("create forwards the DTO and user, passing the one-time generatedSecret response through", async () => {
    const { controller, svc, req } = makeDeps();
    const dto: any = { url: "https://x.example.com/hook" };
    const response = {
      subscription: { id: SUB_ID } as EventSubscription,
      generatedSecret: "one-time-echo",
    };
    svc.create.mockResolvedValueOnce(response);

    const result = await controller.create(dto, req);
    expect(svc.create).toHaveBeenCalledWith(dto, req.user);
    expect(result).toBe(response);
  });

  it("update delegates with the parsed UUID and body", async () => {
    const { controller, svc, req } = makeDeps();
    const dto: any = { enabled: false };

    const result = await controller.update(SUB_ID, dto, req);
    expect(svc.update).toHaveBeenCalledWith(SUB_ID, dto, req.user);
    expect(result).toEqual({ id: SUB_ID, enabled: false });
  });

  it("remove returns { ok: true } after the service delete (dead letters cascade)", async () => {
    const { controller, svc, req } = makeDeps();

    const result = await controller.remove(SUB_ID, req);
    expect(svc.remove).toHaveBeenCalledWith(SUB_ID, req.user);
    expect(result).toEqual({ ok: true });
  });

  it("deadLetters forwards paging params and the paged payload", async () => {
    const { controller, svc, req } = makeDeps();

    const result = await controller.deadLetters(
      SUB_ID,
      { page: 2, limit: 50 } as any,
      req,
    );
    expect(svc.listDeadLetters).toHaveBeenCalledWith(SUB_ID, req.user, 2, 50);
    expect(result).toEqual({ data: [{ id: DL_ID }], total: 1 });
  });

  it("replay maps a successful delivery to { ok: true }", async () => {
    const { controller, svc, dispatcher, req } = makeDeps();

    const result = await controller.replay(SUB_ID, DL_ID, req);
    expect(svc.getDeadLetterForReplay).toHaveBeenCalledWith(
      SUB_ID,
      DL_ID,
      req.user,
    );
    expect(dispatcher.replayDeadLetter).toHaveBeenCalledWith(
      { id: SUB_ID },
      { id: DL_ID },
    );
    expect(result).toEqual({ ok: true });
  });

  it("replay maps a failed delivery to { ok: false, error } without throwing", async () => {
    const { controller, dispatcher, req } = makeDeps();
    dispatcher.replayDeadLetter.mockResolvedValueOnce({
      ok: false,
      error: "connect ECONNREFUSED",
    });

    const result = await controller.replay(SUB_ID, DL_ID, req);
    expect(result).toEqual({ ok: false, error: "connect ECONNREFUSED" });
  });

  it("UUID route params are validated by ParseUUIDPipe metadata", async () => {
    const pipe = new ParseUUIDPipe();
    await expect(
      pipe.transform("not-a-uuid", { type: "param" } as any),
    ).rejects.toThrow("Validation failed (uuid is expected)");
    await expect(
      pipe.transform(SUB_ID, { type: "param" } as any),
    ).resolves.toBe(SUB_ID);
  });

  /**
   * SUB-SCOPE-01（本轮审计，行为变更）：新建订阅收紧为 ADMIN-only。
   *
   * 背景：投递端按 `where: { enabled: true }` 选取订阅、**不做属主过滤**，而四条
   * 可订阅事件是平台级全局发布的。此前 POST / 对任何已登录用户开放 ⇒ 任何人建一条
   * 订阅即可持续收到别人任务的终态 webhook（载荷含 taskName/errorMessage/logs）。
   * webhook 是"把数据送出平台"的能力，与 /notification/channels 同级，属管理面。
   */
  it("create 声明 @Roles(ADMIN)——出站通道是管理面能力", () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, EventSubscriptionController.prototype.create),
    ).toEqual([UserRole.ADMIN]);
  });

  it("create 不再并列 @WriteGuard（A2 规格：角色门控与 scope 声明不共存）", () => {
    expect(
      Reflect.getMetadata(
        WRITE_GUARD_KEY,
        EventSubscriptionController.prototype.create,
      ),
    ).toBeUndefined();
  });

  it("读面不收：list / deadLetters 仍无 @Roles（非管理员仍可看自己的订阅与死信）", () => {
    for (const m of ["list", "deadLetters"] as const) {
      expect(
        Reflect.getMetadata(
          ROLES_KEY,
          EventSubscriptionController.prototype[m],
        ),
      ).toBeUndefined();
    }
  });

  it("PATCH / DELETE 维持「ADMIN 或属主」——不因新建收紧而让存量订阅失效", () => {
    for (const m of ["update", "remove"] as const) {
      expect(
        Reflect.getMetadata(
          ROLES_KEY,
          EventSubscriptionController.prototype[m],
        ),
      ).toBeUndefined();
      // 属主语义由 service 的 scope:ownership 声明承载
      expect(
        (Reflect.getMetadata(
          WRITE_GUARD_KEY,
          EventSubscriptionController.prototype[m],
        ) as { scope?: string } | undefined)?.scope,
      ).toBe("ownership");
    }
  });
});

import { ConfigController } from "../config.controller";
import { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { UserRole } from "../../users/entities/user.entity";
import { BadRequestException, NotFoundException } from "@nestjs/common";

/**
 * QA-02（coverage 第一阶段）：系统配置控制器的读面脱敏与写面委托。
 *
 * S15（rollback 400）与 FEAT-08（rollback RBAC）已有专项 spec；本 spec
 * 定向补「secret 值/历史值的 *** 脱敏矩阵 + executor-shared-token 读写
 * （R4 F-1 明文仅 admin 面）+ CRUD 委托与审计上下文」——历轮 bug 高发
 * （masking 泄露/误覆盖读取面）均集中在这一带。
 */
describe("ConfigController — masking & delegation (QA-02)", () => {
  const admin: AuthUser = {
    id: 1,
    username: "admin",
    email: "a@x",
    role: UserRole.ADMIN,
    isActive: true,
  };
  const req = { ip: "10.1.1.1" } as any;

  type ServiceMock = {
    findAll: jest.Mock;
    findOne: jest.Mock;
    getByPrefix: jest.Mock;
    getByTag: jest.Mock;
    getHistory: jest.Mock;
    getSecretKeys: jest.Mock;
    upsert: jest.Mock;
    batchUpsert: jest.Mock;
    remove: jest.Mock;
    rollback: jest.Mock;
  };

  const makeDeps = () => {
    const service: ServiceMock = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      getByPrefix: jest.fn().mockResolvedValue([]),
      getByTag: jest.fn().mockResolvedValue([]),
      getHistory: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      getSecretKeys: jest.fn().mockResolvedValue(new Set<string>()),
      upsert: jest.fn().mockResolvedValue({ key: "k" }),
      batchUpsert: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue({ key: "k" }),
    };
    const controller = new ConfigController(service as any);
    return { controller, service };
  };

  it("list masks secret values but keeps plain ones readable", async () => {
    const { controller, service } = makeDeps();
    service.findAll.mockResolvedValue([
      { key: "plain", value: "visible", isSecret: false },
      { key: "secret", value: "hide-me", isSecret: true },
    ]);

    const result = (await controller.findAll()) as Array<any>;
    expect(result[0]).toEqual({
      key: "plain",
      value: "visible",
      isSecret: false,
    });
    expect(result[1].value).toBe("***");
  });

  it("list routes prefix/tag filters to the dedicated service calls", async () => {
    const { controller, service } = makeDeps();

    await controller.findAll("exec");
    expect(service.getByPrefix).toHaveBeenCalledWith("exec");
    expect(service.findAll).not.toHaveBeenCalled();

    await controller.findAll(undefined, "ml");
    expect(service.getByTag).toHaveBeenCalledWith("ml");

    await controller.findAll();
    expect(service.findAll).toHaveBeenCalledTimes(1);
  });

  it("findOne masks a secret key and passes a plain key through", async () => {
    const { controller, service } = makeDeps();
    service.findOne.mockResolvedValue({
      key: "secret",
      value: "hide-me",
      isSecret: true,
    });

    const masked = (await controller.findOne("secret")) as any;
    expect(masked.value).toBe("***");

    service.findOne.mockResolvedValue({
      key: "plain",
      value: "v",
      isSecret: false,
    });
    expect(((await controller.findOne("plain")) as any).value).toBe("v");
  });

  it("history masks old/new values only for keys registered as secrets", async () => {
    const { controller, service } = makeDeps();
    service.getHistory.mockResolvedValue({
      data: [
        { configKey: "secret", oldValue: "old", newValue: "new" },
        { configKey: "plain", oldValue: "o2", newValue: "n2" },
        { configKey: "secret", oldValue: null, newValue: null },
      ],
      total: 3,
    });
    service.getSecretKeys.mockResolvedValue(new Set(["secret"]));

    const result = (await controller.getHistory({} as any)) as any;
    expect(result.data[0]).toEqual({
      configKey: "secret",
      oldValue: "***",
      newValue: "***",
    });
    // plain rows untouched
    expect(result.data[1].oldValue).toBe("o2");
    // null stays null (distinct from the mask sentinel)
    expect(result.data[2].oldValue).toBeNull();
    expect(result.data[2].newValue).toBeNull();
  });

  it("history by key masks everything when that key is a secret", async () => {
    const { controller, service } = makeDeps();
    service.getHistory.mockResolvedValue({
      data: [{ configKey: "k", oldValue: "a", newValue: "b" }],
      total: 1,
    });
    service.getSecretKeys.mockResolvedValue(new Set(["k"]));

    const result = (await controller.getHistoryByKey("k", {} as any)) as any;
    expect(result.data[0].oldValue).toBe("***");
    expect(result.data[0].newValue).toBe("***");
    expect(service.getHistory).toHaveBeenCalledWith("k", 1, 20);
  });

  it("getExecutorSharedToken returns plaintext with hasToken, or a safe empty shape", async () => {
    const { controller, service } = makeDeps();
    service.findOne.mockResolvedValueOnce({
      key: "executor.sharedToken",
      value: "tok",
    });
    expect(await controller.getExecutorSharedToken()).toEqual({
      token: "tok",
      hasToken: true,
    });

    // missing row → no crash, no token
    service.findOne.mockRejectedValueOnce(new NotFoundException("nf"));
    expect(await controller.getExecutorSharedToken()).toEqual({
      token: null,
      hasToken: false,
    });
  });

  it("generateExecutorSharedToken persists a fresh 64-hex secret marked isSecret and returns it once", async () => {
    const { controller, service } = makeDeps();

    const { token } = (await controller.generateExecutorSharedToken(
      admin,
      req,
    )) as any;

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(service.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "executor.sharedToken",
        value: token,
        isSecret: true,
      }),
      { userId: "1", username: "admin", ipAddress: "10.1.1.1" },
    );
  });

  it("upsert / batchUpsert / remove delegate with the audit context", async () => {
    const { controller, service } = makeDeps();

    await controller.upsert({ key: "k", value: "v" } as any, admin, req);
    expect(service.upsert).toHaveBeenCalledWith(
      { key: "k", value: "v" },
      { userId: "1", username: "admin", ipAddress: "10.1.1.1" },
    );

    await controller.batchUpsert([{ key: "k" }] as any, admin, req);
    expect(service.batchUpsert).toHaveBeenCalledWith([{ key: "k" }], {
      userId: "1",
      username: "admin",
      ipAddress: "10.1.1.1",
    });

    await controller.remove("k", admin, req);
    expect(service.remove).toHaveBeenCalledWith("k", {
      userId: "1",
      username: "admin",
      ipAddress: "10.1.1.1",
    });
  });

  it("rollback forwards the actor context with the parsed integer id", async () => {
    const { controller, service } = makeDeps();

    await controller.rollback(7, admin, req);
    expect(service.rollback).toHaveBeenCalledWith(7, {
      userId: "1",
      username: "admin",
      ipAddress: "10.1.1.1",
    });
  });

  it("list propagates service failures (no masking-layer swallowing)", async () => {
    const { controller, service } = makeDeps();
    service.getByPrefix.mockRejectedValue(
      new BadRequestException("bad prefix"),
    );
    await expect(controller.findAll("x")).rejects.toThrow(BadRequestException);
  });
});

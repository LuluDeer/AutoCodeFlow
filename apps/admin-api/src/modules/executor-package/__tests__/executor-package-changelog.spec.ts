/**
 * 执行器包响应中的 changelog 字段：实体无该列，控制器在 DTO 声明的可选字段上
 * 补 `changelog: null`，让实际响应 JSON 与 Swagger 契约一致（仅字段映射，不改
 * 服务层业务逻辑）。
 */
import { ExecutorPackageController } from "../executor-package.controller";

jest.mock("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  return {
    ...actual,
    existsSync: jest.fn(() => true),
    mkdirSync: jest.fn(),
    promises: {
      ...actual.promises,
      stat: jest.fn(),
      open: jest.fn(),
      readFile: jest.fn(),
    },
  };
});

const pkg = {
  id: "p-1",
  name: "runner",
  version: "1.0.0",
  fileSize: 100,
  status: "active",
};

function makeController() {
  const svc = {
    findAll: jest.fn().mockResolvedValue({ items: [{ ...pkg }], total: 1 }),
    findOne: jest.fn().mockResolvedValue({ ...pkg }),
    findLatest: jest.fn().mockResolvedValue({ ...pkg }),
    create: jest.fn().mockResolvedValue({ ...pkg }),
    update: jest.fn().mockResolvedValue({ ...pkg }),
    deprecate: jest.fn().mockResolvedValue({ ...pkg }),
    activate: jest.fn().mockResolvedValue({ ...pkg }),
  };
  const controller = new ExecutorPackageController(
    svc as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controller, svc };
}

describe("ExecutorPackageController — changelog:null 响应映射", () => {
  it("findOne 追加 changelog:null（不改动服务层实体）", async () => {
    const { controller } = makeController();
    const result = await controller.findOne("p-1" as never);
    expect(result.changelog).toBeNull();
    expect(result.id).toBe("p-1");
  });

  it("findAll 每个 item 都追加 changelog:null，nextCursor 原样保留", async () => {
    const { controller, svc } = makeController();
    svc.findAll.mockResolvedValue({
      items: [{ ...pkg }, { ...pkg, id: "p-2" }],
      total: 2,
      nextCursor: null,
    });
    const result = await controller.findAll({} as never);
    expect(result.items.map((i) => i.changelog)).toEqual([null, null]);
    expect(result.nextCursor).toBeNull();
    expect(result.total).toBe(2);
  });

  it("findLatest 无匹配时仍返回 null", async () => {
    const { controller, svc } = makeController();
    svc.findLatest.mockResolvedValue(null);
    await expect(controller.findLatest("node" as never)).resolves.toBeNull();
  });

  it("deprecate/activate/create/update 均追加 changelog:null", async () => {
    const { controller } = makeController();
    expect((await controller.deprecate("p-1" as never)).changelog).toBeNull();
    expect((await controller.activate("p-1" as never)).changelog).toBeNull();
    expect(
      (await controller.create({} as never, {} as never, "tester")).changelog,
    ).toBeNull();
    expect(
      (await controller.update("p-1" as never, {} as never)).changelog,
    ).toBeNull();
  });
});

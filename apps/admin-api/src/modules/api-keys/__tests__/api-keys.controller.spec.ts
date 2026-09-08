import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { ApiKeysController } from "../api-keys.controller";
import { ApiKeysService } from "../api-keys.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { Reflector } from "@nestjs/core";

/**
 * AUTH-03: /api-keys 控制器——CRUD 委托契约、一次性明文回显、
 * 仅本人（userId 来自 JWT principal）、守卫装饰到位（JWT-only 面）。
 */

const svcMock = () => ({
  listForUser: jest.fn(async () => [{ id: 1, name: "k", keyPrefix: "acf_aa", scope: "readonly" }]),
  create: jest.fn(async (input) => ({
    apiKey: { id: 2, name: input.name, keyPrefix: "acf_bb", scope: input.scope },
    plaintext: "acf_" + "a".repeat(64),
  })),
  revoke: jest.fn(async (id, userId) =>
    id === 404 ? null : { id, revokedAt: new Date() },
  ),
});

const USER = { id: 42, username: "alice", role: "user" } as any;

describe("AUTH-03 ApiKeysController", () => {
  let controller: ApiKeysController;
  let svc: ReturnType<typeof svcMock>;

  beforeEach(async () => {
    svc = svcMock();
    const moduleRef = await Test.createTestingModule({
      controllers: [ApiKeysController],
      providers: [{ provide: ApiKeysService, useValue: svc }],
    }).compile();
    controller = moduleRef.get(ApiKeysController);
  });

  it("守卫装饰：@Controller api-keys 使用 JwtAuthGuard（配合 guard 面 401 双保险）", () => {
    // Nest 将 @UseGuards 参数经 ReflectableDecorator 记录在 "self:guards"/"guards" 键；
    // 遍历常见键断言存在 JwtAuthGuard，不依赖单一内部键名。
    const keys = ["guards", "self:guards", "__guards__"];
    const found = keys
      .map((k) => Reflect.getMetadata(k, ApiKeysController))
      .find((v) => Array.isArray(v));
    expect(found).toBeDefined();
    expect(found.flat()).toContain(JwtAuthGuard);
  });

  it("list 委托 listForUser(当前用户 id)", async () => {
    const rows = await controller.list(USER);
    expect(svc.listForUser).toHaveBeenCalledWith(42);
    expect(rows).toHaveLength(1);
  });

  it("create 回显明文 acf_ 一次，userId 取自 JWT principal 而非 body", async () => {
    const res = await controller.create(
      { name: "ci", scope: "trigger" } as any,
      USER,
      { ip: "1.1.1.1" } as any,
    );
    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, scope: "trigger", ip: "1.1.1.1" }),
    );
    expect(res.plaintext).toMatch(/^acf_[0-9a-f]{64}$/);
  });

  it("DELETE :id 软删吊销；不存在 → 404", async () => {
    const ok = await controller.revoke(9, USER, {} as any);
    expect(ok.success).toBe(true);
    expect(svc.revoke).toHaveBeenCalledWith(9, 42, "alice", undefined);
    await expect(controller.revoke(404, USER, {} as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("POST :id/revoke 别名等价且只操作本人 key", async () => {
    await controller.revokeAlias(9, USER, {} as any);
    expect(svc.revoke).toHaveBeenCalledWith(9, 42, "alice", undefined);
  });
});

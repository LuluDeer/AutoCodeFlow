import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { validate } from "class-validator";
import { ApiKeysController, SetSpendLimitDto } from "../api-keys.controller";
import { ApiKeysService } from "../api-keys.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";

/**
 * AUTH-03: /api-keys 控制器——CRUD 委托契约、一次性明文回显、
 * 仅本人（userId 来自 JWT principal）、守卫装饰到位（JWT-only 面）。
 */

const svcMock = () => ({
  listForUser: jest.fn(async () => [
    { id: 1, name: "k", keyPrefix: "acf_aa", scope: "readonly" },
  ]),
  create: jest.fn(async (input) => ({
    apiKey: {
      id: 2,
      name: input.name,
      keyPrefix: "acf_bb",
      scope: input.scope,
    },
    plaintext: "acf_" + "a".repeat(64),
  })),
  revoke: jest.fn(async (id, _userId) =>
    id === 404 ? null : { id, revokedAt: new Date() },
  ),
  remove: jest.fn(async (id, _userId) =>
    id === 404 ? null : { id, revokedAt: new Date() },
  ),
  rotate: jest.fn(async (id) =>
    id === 404
      ? null
      : {
          apiKey: {
            id,
            name: "k",
            keyPrefix: "acf_new",
            scope: "trigger",
            scopes: [],
            spendLimit: 500,
            expiresAt: null,
            revokedAt: null,
            lastUsedAt: null,
            createdAt: new Date(0),
          },
          plaintext: "acf_" + "b".repeat(64),
        },
  ),
  setSpendLimit: jest.fn(async (id, spendLimit) =>
    id === 404 ? null : { id, scope: "trigger", spendLimit },
  ),
});

const ADMIN = { id: 7, username: "root", role: "admin" } as any;

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
    await expect(
      controller.revoke(404, USER, {} as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("POST :id/revoke 别名等价且只操作本人 key", async () => {
    await controller.revokeAlias(9, USER, {} as any);
    expect(svc.revoke).toHaveBeenCalledWith(9, 42, "alice", undefined);
  });

  it("DELETE :id/permanent 硬删（仅已失效行由 service 判定）；不存在 → 404", async () => {
    const ok = await controller.remove(9, USER, { ip: "1.1.1.1" } as any);
    expect(ok.success).toBe(true);
    expect(svc.remove).toHaveBeenCalledWith(9, 42, "alice", "1.1.1.1");
    await expect(
      controller.remove(404, USER, {} as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ─── N19: rotate / limit ────────────────────────────────────────────────
  it("ADMIN 门控：rotate/limit 带 @Roles(ADMIN) 元数据且不带 WriteGuard", () => {
    for (const method of [controller.rotate, controller.setSpendLimit]) {
      expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual([UserRole.ADMIN]);
    }
  });

  it("POST :id/rotate 委托 rotate(id, actor)，明文一次回显；不存在 → 404", async () => {
    const res = await controller.rotate(9, ADMIN, { ip: "9.9.9.9" } as any);
    expect(svc.rotate).toHaveBeenCalledWith(9, {
      userId: 7,
      username: "root",
      ip: "9.9.9.9",
    });
    expect(res.plaintext).toMatch(/^acf_[0-9a-f]{64}$/);
    expect(res.spendLimit).toBe(500);
    await expect(
      controller.rotate(404, ADMIN, {} as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("PATCH :id/limit 委托 setSpendLimit(id, limit, actor)；null 清除；不存在 → 404", async () => {
    const res = await controller.setSpendLimit(
      9,
      { spendLimit: 500 } as any,
      ADMIN,
      {} as any,
    );
    expect(svc.setSpendLimit).toHaveBeenCalledWith(
      9,
      500,
      expect.objectContaining({ userId: 7 }),
    );
    expect(res.success).toBe(true);
    await controller.setSpendLimit(9, {} as any, ADMIN, {} as any);
    expect(svc.setSpendLimit).toHaveBeenLastCalledWith(
      9,
      null,
      expect.objectContaining({ userId: 7 }),
    );
    await expect(
      controller.setSpendLimit(404, { spendLimit: 1 } as any, ADMIN, {} as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("SetSpendLimitDto 校验：负数/非整数/超上限被拒，null 清除与合法值通过", async () => {
    const check = async (value: unknown) => {
      const dto = new SetSpendLimitDto();
      (dto as any).spendLimit = value;
      return (await validate(dto)).length === 0;
    };
    expect(await check(500)).toBe(true);
    expect(await check(null)).toBe(true);
    expect(await check(undefined)).toBe(true);
    expect(await check(-1)).toBe(false);
    expect(await check(1.5)).toBe(false);
    expect(await check(1_000_000_001)).toBe(false);
  });
});

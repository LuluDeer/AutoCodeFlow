/**
 * N16 续：capability 所有权移交端点单测（DTO 双签闸 + controller 装配 + ADMIN 门控）。
 *
 * 验收级别：单测 / 内存替身（svc 为 jest 桩，非真实 PG 持久化与 Nest DI 集成）。
 * 断言只覆盖本批字段移交语义：双签缺失必 400、成功路径两字段同传、ADMIN-only 门控。
 */
jest.mock("../capability.service", () => ({
  CapabilityService: class CapabilityServiceStub {},
  CapabilityActor: undefined,
  CapabilityResolution: undefined,
  CapabilityDump: undefined,
}));

import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";
import type { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { CapabilityController } from "../capability.controller";
import { TransferCapabilityDto } from "../dto/transfer-capability.dto";

const CAP_ID = "33333333-3333-4333-8333-333333333333";
const NEW_OWNER = "user:42|alice";
const NEW_BACKER = "role:platform-eng";

const admin: AuthUser = {
  id: 1,
  username: "admin",
  email: "admin@local",
  role: UserRole.ADMIN,
  isActive: true,
};
const normalUser: AuthUser = { ...admin, role: UserRole.USER };

function makeController() {
  const saved = {
    id: CAP_ID,
    key: "browser",
    owner: NEW_OWNER,
    backer: NEW_BACKER,
  };
  const svc = { update: jest.fn().mockResolvedValue(saved) };
  return {
    svc,
    saved,
    controller: new CapabilityController(svc as never),
  };
}

function guardContext(user: AuthUser | null): {
  getHandler: () => unknown;
  getClass: () => unknown;
  switchToHttp: () => { getRequest: () => { user: AuthUser | null } };
} {
  return {
    getHandler: () => CapabilityController.prototype.transfer,
    getClass: () => CapabilityController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  };
}

describe("POST /capabilities/:id/transfer（N16 所有权移交）", () => {
  it("反证①：只传 owner 不传 backer ⇒ DTO 校验失败（对应 400，禁止孤儿化半签）", () => {
    const dto = plainToInstance(TransferCapabilityDto, { owner: NEW_OWNER });
    const errors = validateSync(dto as object);
    expect(errors.some((e) => e.property === "backer")).toBe(true);
  });

  it("反证①：owner/backer 任一为空串或非字符串 ⇒ DTO 校验失败", () => {
    const emptyOwner = plainToInstance(TransferCapabilityDto, {
      owner: "",
      backer: NEW_BACKER,
    });
    expect(
      validateSync(emptyOwner as object).some((e) => e.property === "owner"),
    ).toBe(true);

    const nonStringBacker = plainToInstance(TransferCapabilityDto, {
      owner: NEW_OWNER,
      backer: 42,
    });
    expect(
      validateSync(nonStringBacker as object).some(
        (e) => e.property === "backer",
      ),
    ).toBe(true);
  });

  it("双签 DTO 合法（owner+backer 均非空字符串）⇒ 0 校验错误", () => {
    const dto = plainToInstance(TransferCapabilityDto, {
      owner: NEW_OWNER,
      backer: NEW_BACKER,
    });
    expect(validateSync(dto as object)).toEqual([]);
  });

  it("反证②：成功路径调 svc.update(id, {owner, backer}, actor)，两字段都透传", async () => {
    const { controller, svc, saved } = makeController();
    const dto = plainToInstance(TransferCapabilityDto, {
      owner: NEW_OWNER,
      backer: NEW_BACKER,
    });

    await expect(controller.transfer(CAP_ID, dto, admin)).resolves.toBe(saved);

    expect(svc.update).toHaveBeenCalledTimes(1);
    expect(svc.update).toHaveBeenCalledWith(
      CAP_ID,
      { owner: NEW_OWNER, backer: NEW_BACKER },
      { id: admin.id, username: admin.username, role: UserRole.ADMIN },
    );
    // 孤儿化反证：传给 service 的 patch 里没有任何额外字段。
    const patch = svc.update.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(["backer", "owner"]);
  });

  it("反证③：端点标 ADMIN；非 ADMIN 经 RolesGuard ⇒ false（框架转 403）", () => {
    const reflector = new Reflector();
    const handler = CapabilityController.prototype.transfer;
    const requiredRoles = reflector.get<UserRole[]>(ROLES_KEY, handler);
    expect(requiredRoles).toEqual([UserRole.ADMIN]);

    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(guardContext(normalUser) as never)).toBe(false);
    expect(guard.canActivate(guardContext(null) as never)).toBe(false);
    expect(guard.canActivate(guardContext(admin) as never)).toBe(true);
  });
});

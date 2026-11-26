/**
 * N16 续：capability 所有权移交单测（DTO 双签闸 + controller 装配 + ADMIN 门控
 * + service 层 capability.transfer 治理审计及 fail-open）。
 *
 * 验收级别：单测 / 内存替身（controller 的 svc 为 jest 桩；service 审计用例
 * 用内存 repo + audit 桩，非真实 PG 持久化与 Nest DI 集成）。
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

const { CapabilityService: RealCapabilityService } = jest.requireActual<
  typeof import("../capability.service")
>("../capability.service");

const CAP_ID = "33333333-3333-4333-8333-333333333333";
const OLD_OWNER = "user:7|bob";
const OLD_BACKER = "role:legacy";
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
const actor = {
  id: admin.id,
  username: admin.username,
  role: UserRole.ADMIN,
};

function makeController() {
  const saved = {
    id: CAP_ID,
    key: "browser",
    owner: NEW_OWNER,
    backer: NEW_BACKER,
  };
  const svc = { transfer: jest.fn().mockResolvedValue(saved) };
  return {
    svc,
    saved,
    controller: new CapabilityController(svc as never),
  };
}

/** 真实 service + 内存 repo：update 走条件写，审计走 log 桩。 */
function makeTransferService(auditLog: jest.Mock) {
  const row: Record<string, unknown> = {
    id: CAP_ID,
    key: "browser",
    kind: "skill",
    label: "Browser",
    description: null,
    version: "1.0.0",
    source: { type: "builtin" },
    visibility: "private",
    scope: { mode: "supervised", guidance: "L2" },
    manifest: { name: "browser", version: "1.0.0" },
    enabled: true,
    createdBy: null,
    owner: OLD_OWNER,
    backer: OLD_BACKER,
    versionPin: null,
    attestation: null,
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
  const repo = {
    findOne: jest.fn(async () => ({ ...row })),
    createQueryBuilder: jest.fn(() => {
      const params: Record<string, unknown> = {};
      let set: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        update: jest.fn(() => builder),
        set: jest.fn((s: Record<string, unknown>) => {
          set = s;
          return builder;
        }),
        where: jest.fn((_sql: string, p?: Record<string, unknown>) => {
          Object.assign(params, p ?? {});
          return builder;
        }),
        andWhere: jest.fn((_sql: string, p?: Record<string, unknown>) => {
          Object.assign(params, p ?? {});
          return builder;
        }),
        execute: jest.fn(async () => {
          const from = params.tsFrom as Date;
          const to = params.tsTo as Date;
          const cur = new Date(row.updatedAt as Date).getTime();
          if (!(cur >= from.getTime() && cur < to.getTime())) {
            return { affected: 0 };
          }
          for (const [k, v] of Object.entries(set)) {
            row[k] = typeof v === "function" ? new Date(to.getTime()) : v;
          }
          return { affected: 1 };
        }),
      };
      return builder;
    }),
  };
  const svc = new RealCapabilityService(
    repo as never,
    { log: auditLog } as never,
    null,
  );
  return { svc, row };
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

  it("反证②：成功路径调 svc.transfer(id, {owner, backer}, actor)，两字段都透传", async () => {
    const { controller, svc, saved } = makeController();
    const dto = plainToInstance(TransferCapabilityDto, {
      owner: NEW_OWNER,
      backer: NEW_BACKER,
    });

    await expect(controller.transfer(CAP_ID, dto, admin)).resolves.toBe(saved);

    expect(svc.transfer).toHaveBeenCalledTimes(1);
    expect(svc.transfer).toHaveBeenCalledWith(
      CAP_ID,
      { owner: NEW_OWNER, backer: NEW_BACKER },
      actor,
    );
    // 孤儿化反证：传给 service 的 patch 里没有任何额外字段。
    const patch = svc.transfer.mock.calls[0][1] as Record<string, unknown>;
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

describe("CapabilityService.transfer — 治理审计（N16）", () => {
  it("反证④：capability.transfer 审计含 owner/backer 前后值；通用审计 capability.update 并存", async () => {
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const { svc } = makeTransferService(auditLog);

    const saved = await svc.transfer(
      CAP_ID,
      { owner: NEW_OWNER, backer: NEW_BACKER },
      actor,
    );

    expect(saved.owner).toBe(NEW_OWNER);
    expect(saved.backer).toBe(NEW_BACKER);
    const actions = auditLog.mock.calls.map(
      ([payload]) => (payload as { action: string }).action,
    );
    expect(actions).toEqual(["capability.update", "capability.transfer"]);
    const transferPayload = auditLog.mock.calls[1][0] as {
      action: string;
      resource: string;
      resourceId: string;
      detail: Record<string, unknown>;
    };
    expect(transferPayload.action).toBe("capability.transfer");
    expect(transferPayload.resource).toBe("capability");
    expect(transferPayload.resourceId).toBe(CAP_ID);
    expect(transferPayload.detail.before).toEqual({
      owner: OLD_OWNER,
      backer: OLD_BACKER,
    });
    expect(transferPayload.detail.after).toEqual({
      owner: NEW_OWNER,
      backer: NEW_BACKER,
    });
  });

  it("反证⑤：审计写失败（audit.log reject）不阻断移交主链，仍返回移交后的行", async () => {
    const auditLog = jest.fn().mockRejectedValue(new Error("audit store down"));
    const { svc } = makeTransferService(auditLog);

    await expect(
      svc.transfer(CAP_ID, { owner: NEW_OWNER, backer: NEW_BACKER }, actor),
    ).resolves.toMatchObject({ owner: NEW_OWNER, backer: NEW_BACKER });
    expect(auditLog).toHaveBeenCalledTimes(2);
  });
});

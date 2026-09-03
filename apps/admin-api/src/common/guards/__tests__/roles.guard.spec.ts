import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "../roles.guard";
import { Roles } from "../../decorators/roles.decorator";
import { UserRole } from "../../../modules/users/entities/user.entity";

/**
 * R4 F-1 regression: RolesGuard must be registered globally (APP_GUARD after
 * JwtAuthGuard) and enforce @Roles metadata with the correct precedence:
 * method-level @Roles overrides class-level @Roles; an empty @Roles() resets
 * the class requirement (used by the machine-auth push-result callback);
 * routes without any @Roles metadata stay open to any authenticated user.
 */

// No @Roles anywhere — any authenticated user passes (JwtAuthGuard upstream).
class NoRolesFixture {
  handler() {}
}

// Method-level restriction.
class MethodRolesFixture {
  @Roles(UserRole.ADMIN)
  adminHandler() {}

  @Roles(UserRole.USER)
  userHandler() {}
}

// Class-level restriction with an empty method-level override.
@Roles(UserRole.ADMIN)
class ClassRolesFixture {
  adminHandler() {}

  // Machine-to-machine callback pattern (executor-packages push-result).
  @Roles()
  machineHandler() {}
}

const makeContext = (
  handler: (...args: unknown[]) => unknown,
  cls: unknown,
  user: unknown,
): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

describe("RolesGuard", () => {
  let guard: RolesGuard;

  beforeEach(() => {
    guard = new RolesGuard(new Reflector());
  });

  describe("routes without @Roles metadata", () => {
    it("allows any authenticated user", () => {
      const ctx = makeContext(
        NoRolesFixture.prototype.handler,
        NoRolesFixture,
        { role: UserRole.USER },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it("allows admins", () => {
      const ctx = makeContext(
        NoRolesFixture.prototype.handler,
        NoRolesFixture,
        { role: UserRole.ADMIN },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe("method-level @Roles(ADMIN)", () => {
    it("allows role=admin", () => {
      const ctx = makeContext(
        MethodRolesFixture.prototype.adminHandler,
        MethodRolesFixture,
        { role: UserRole.ADMIN },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it("denies role=user (403)", () => {
      const ctx = makeContext(
        MethodRolesFixture.prototype.adminHandler,
        MethodRolesFixture,
        { role: UserRole.USER },
      );
      expect(guard.canActivate(ctx)).toBe(false);
    });
  });

  describe("method-level @Roles(USER)", () => {
    it("allows role=user", () => {
      const ctx = makeContext(
        MethodRolesFixture.prototype.userHandler,
        MethodRolesFixture,
        { role: UserRole.USER },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it("denies role=admin", () => {
      const ctx = makeContext(
        MethodRolesFixture.prototype.userHandler,
        MethodRolesFixture,
        { role: UserRole.ADMIN },
      );
      expect(guard.canActivate(ctx)).toBe(false);
    });
  });

  describe("class-level @Roles(ADMIN)", () => {
    it("allows role=admin", () => {
      const ctx = makeContext(
        ClassRolesFixture.prototype.adminHandler,
        ClassRolesFixture,
        { role: UserRole.ADMIN },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it("denies role=user (403)", () => {
      const ctx = makeContext(
        ClassRolesFixture.prototype.adminHandler,
        ClassRolesFixture,
        { role: UserRole.USER },
      );
      expect(guard.canActivate(ctx)).toBe(false);
    });

    it("denies an unauthenticated request (no req.user)", () => {
      const ctx = makeContext(
        ClassRolesFixture.prototype.adminHandler,
        ClassRolesFixture,
        undefined,
      );
      expect(guard.canActivate(ctx)).toBe(false);
    });
  });

  describe("empty @Roles() override (machine-auth callback pattern)", () => {
    it("resets the class-level ADMIN requirement for role=user", () => {
      const ctx = makeContext(
        ClassRolesFixture.prototype.machineHandler,
        ClassRolesFixture,
        { role: UserRole.USER },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it("passes when there is no req.user (@Public machine callback)", () => {
      const ctx = makeContext(
        ClassRolesFixture.prototype.machineHandler,
        ClassRolesFixture,
        undefined,
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });
});

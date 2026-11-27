import { ExecutionContext, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";

import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { ErrorCode } from "../../../common/errors/error-codes";
import { RolesGuard } from "../../../common/guards/roles.guard";
import type { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { SOP_RELEASE_AUDIT_ACTIONS } from "../../agent/runtime/release-outcome.audit";
import { UserRole } from "../../users/entities/user.entity";
import {
  RETRYABLE_REASONS,
  ReleaseRetryController,
  type RetryReleaseDto,
} from "../release-retry.controller";
import type { ReleaseApprovalService } from "../release-approval.service";
import type { ReleaseIfApprovedReason } from "../release-approval.service";
import type { AuditService } from "../../audit/audit.service";

/**
 * ADR-045 一键重试窄端点的内存替身单测。
 * 只证明 controller 的白名单闸 / 调用语义 / 幂等边界 / 角色元数据；
 * 真 PG + 真 Nest 的副作用断言由 verify-retry 的 e2e 覆盖。
 */

type Outcome = { published: boolean; reason?: ReleaseIfApprovedReason };

const APPROVAL_KEY = "approval-key-1";

const ADMIN: AuthUser = {
  id: 1,
  username: "supervisor",
  email: "supervisor@example.com",
  role: UserRole.ADMIN,
  isActive: true,
};

const body = (expectedReason: string): RetryReleaseDto => ({ expectedReason });

function makeHarness(next: () => Outcome | Promise<Outcome>) {
  const releaseSpy = jest.fn(
    async (_key: string, _fp: string | null): Promise<Outcome> => next(),
  );
  const auditLog = jest.fn(async (_payload: unknown): Promise<void> => {});
  const controller = new ReleaseRetryController(
    {
      releaseByApprovalKey: releaseSpy,
    } as unknown as ReleaseApprovalService,
    { log: auditLog } as unknown as AuditService,
  );
  return { controller, releaseSpy, auditLog };
}

describe("ReleaseRetryController 一键重试", () => {
  it.each(RETRYABLE_REASONS)(
    "白名单内 reason=%s ⇒ 调 releaseByApprovalKey(approvalKey, null) 且 published:true",
    async (reason) => {
      const { controller, releaseSpy, auditLog } = makeHarness(() => ({
        published: true,
      }));

      const res = await controller.retry(APPROVAL_KEY, body(reason), ADMIN);

      expect(res).toEqual({ retried: true, published: true });
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledWith(APPROVAL_KEY, null);
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: SOP_RELEASE_AUDIT_ACTIONS.succeeded,
          resource: "agent_approval",
          resourceId: APPROVAL_KEY,
          result: "success",
          detail: expect.objectContaining({
            approvalKey: APPROVAL_KEY,
            expectedReason: reason,
            published: true,
            attempt: "retry",
            publishedBy: "agent:tool-call",
          }),
        }),
      );
    },
  );

  it("publish_failed（consume 之后失败）⇒ 拒绝且不调用服务", async () => {
    const { controller, releaseSpy, auditLog } = makeHarness(() => ({
      published: true,
    }));

    await expect(
      controller.retry(APPROVAL_KEY, body("publish_failed"), ADMIN),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.VALIDATION_FAILED,
      params: { detail: expect.stringContaining("publish_failed") },
    });

    expect(releaseSpy).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("未知 reason / 空 reason ⇒ 拒绝且不调用服务", async () => {
    for (const reason of ["totally_unknown", ""]) {
      const { controller, releaseSpy } = makeHarness(() => ({
        published: true,
      }));
      await expect(
        controller.retry(APPROVAL_KEY, body(reason), ADMIN),
      ).rejects.toMatchObject({ errorCode: ErrorCode.VALIDATION_FAILED });
      expect(releaseSpy).not.toHaveBeenCalled();
    }
  });

  it("重试仍失败 ⇒ 返回 published:false 不抛 5xx，落 release_failed 审计", async () => {
    const { controller, releaseSpy, auditLog } = makeHarness(() => ({
      published: false,
      reason: "content_changed",
    }));

    const res = await controller.retry(
      APPROVAL_KEY,
      body("content_changed"),
      ADMIN,
    );

    expect(res).toEqual({
      retried: true,
      published: false,
      reason: "content_changed",
    });
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: SOP_RELEASE_AUDIT_ACTIONS.failed,
        resourceId: APPROVAL_KEY,
        result: "failure",
        detail: expect.objectContaining({
          approvalKey: APPROVAL_KEY,
          published: false,
          reason: "content_changed",
          attempt: "retry",
        }),
      }),
    );
  });

  it("服务抛错也收敛为业务失败，不升级成 5xx", async () => {
    const { controller, auditLog } = makeHarness(() => {
      throw new Error("boom");
    });

    const res = await controller.retry(
      APPROVAL_KEY,
      body("dependency_unavailable"),
      ADMIN,
    );

    expect(res).toEqual({
      retried: true,
      published: false,
      reason: "publish_failed",
    });
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: SOP_RELEASE_AUDIT_ACTIONS.failed }),
    );
  });

  it("二次重试不重复发布：consume 幂等，publish 只发生一次", async () => {
    const state = { publishCount: 0 };
    const { controller, releaseSpy } = makeHarness(() => {
      if (state.publishCount > 0) {
        // 首次已 consume：服务侧条件写落空，不再 publish。
        return { published: false, reason: "approval_not_consumed" };
      }
      state.publishCount += 1;
      return { published: true };
    });

    const first = await controller.retry(
      APPROVAL_KEY,
      body("content_changed"),
      ADMIN,
    );
    const second = await controller.retry(
      APPROVAL_KEY,
      body("content_changed"),
      ADMIN,
    );

    expect(first).toEqual({ retried: true, published: true });
    expect(second).toEqual({
      retried: true,
      published: false,
      reason: "approval_not_consumed",
    });
    expect(releaseSpy).toHaveBeenCalledTimes(2);
    expect(state.publishCount).toBe(1);
  });

  it("类级 @Roles(ADMIN) + 类/方法路由元数据：非 ADMIN 被 RolesGuard 挡下", () => {
    const handler = ReleaseRetryController.prototype.retry;

    expect(Reflect.getMetadata(ROLES_KEY, ReleaseRetryController)).toEqual([
      UserRole.ADMIN,
    ]);
    expect(Reflect.getMetadata(PATH_METADATA, ReleaseRetryController)).toBe(
      "workbench",
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      "release-approvals/:approvalKey/retry",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(
      `/${Reflect.getMetadata(PATH_METADATA, ReleaseRetryController)}/` +
        `${Reflect.getMetadata(PATH_METADATA, handler)}`,
    ).toBe("/workbench/release-approvals/:approvalKey/retry");

    const guard = new RolesGuard(new Reflector());
    const ctx = (role: UserRole): ExecutionContext =>
      ({
        getHandler: () => handler,
        getClass: () => ReleaseRetryController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as unknown as ExecutionContext;

    expect(guard.canActivate(ctx(UserRole.USER))).toBe(false);
    expect(guard.canActivate(ctx(UserRole.ADMIN))).toBe(true);
  });
});

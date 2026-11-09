import { Logger } from "@nestjs/common";
import {
  ApplicationApprovalCollaborator,
  type ApplicationApprovalCollaboratorDeps,
  type DeploymentEventRecorder,
} from "../application-approval.collaborator";
import {
  AppDeployment,
  DeploymentApprovalStatus,
  DeploymentStatus,
  DeploymentTriggerType,
} from "../entities/app-deployment.entity";
import { AppDeploymentEventType } from "../entities/app-deployment-event.entity";

/**
 * B1a 拆分的独立单测（**不走 DI 装配**，`new ApplicationApprovalCollaborator(...)` 直构）。
 *
 * ## 这是 B 方案的核心资产
 *
 * 审批决策的**全部语义**现在可以在**不构造 `AppDeploymentService`**（9 个位置
 * 参数 + Nest DI）的前提下验证。这是 A 方案（只抽 util）给不了的：util 抽走
 * 纯函数后，**决策流程的顺序与闸门**（条件 UPDATE 的 affected 闸、第二人规则、
 * 「推送失败不阻断审批返回」）仍然埋在 service 里，无法脱离 service 测。
 *
 * 本文件把这些闸门逐条钉住，并含**反证有牙**的用例（改坏行为 ⇒ 用例转红）。
 */

/** 造一个待审批的部署行。 */
function makePendingDeployment(
  over: Partial<AppDeployment> = {},
): AppDeployment {
  return {
    id: "dep-1",
    applicationId: "app-1",
    status: DeploymentStatus.PENDING,
    approvalStatus: DeploymentApprovalStatus.PENDING_APPROVAL,
    approvalMeta: { requestedBy: 1, requestedByName: "requester" },
    executorId: "exec-1",
    executorAddress: "10.0.0.1",
    deployedVersion: "v1",
    triggerType: DeploymentTriggerType.MANUAL,
    operator: "requester",
    ...over,
  } as AppDeployment;
}

/** 协作者的替身依赖 + 记录器。 */
function makeDeps(over: Partial<ApplicationApprovalCollaboratorDeps> = {}) {
  const events: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const pushes: Array<unknown[]> = [];
  const updates: Array<Record<string, unknown>> = [];
  const logger = new Logger("test");

  let row: AppDeployment | null = makePendingDeployment();
  let affected = 1;

  const deps: ApplicationApprovalCollaboratorDeps = {
    repo: {
      findOne: jest.fn(async () => row),
      update: jest.fn(async (criteria: unknown, values: unknown) => {
        updates.push({ criteria, values });
        return { affected };
      }),
    } as never,
    audit: {
      log: jest.fn(async (entry: Record<string, unknown>) => {
        audits.push(entry);
      }),
    } as never,
    appService: {
      findByIdRaw: jest.fn(async () => ({ version: "v-app" })),
    } as never,
    logger,
    onEvent: (async (input: Record<string, unknown>) => {
      events.push(input);
    }) as unknown as DeploymentEventRecorder,
    maskForRead: (d: AppDeployment) =>
      ({ ...d, masked: true }) as AppDeployment,
    loadApplication: async () => ({ version: "v-app" }),
    pushDeploy: async (...args: unknown[]) => {
      pushes.push(args);
    },
    ...over,
  };

  return {
    deps,
    events,
    audits,
    pushes,
    updates,
    logger,
    setRow: (r: AppDeployment | null) => {
      row = r;
    },
    setAffected: (n: number) => {
      affected = n;
    },
  };
}

describe("ApplicationApprovalCollaborator — 审批决策（独立构造）", () => {
  describe("approveDeployment", () => {
    it("待审批行 → 条件 UPDATE 领取 → 状态置 APPROVED", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      const out = await c.approveDeployment("dep-1", {
        id: 2,
        name: "approver",
      });

      expect(out.approvalStatus).toBe(DeploymentApprovalStatus.APPROVED);
      // 领取闸必须是**条件 UPDATE**（id + PENDING_APPROVAL）
      expect(h.updates[0].criteria).toEqual({
        id: "dep-1",
        approvalStatus: DeploymentApprovalStatus.PENDING_APPROVAL,
      });
      expect(
        (h.updates[0].values as Record<string, unknown>).approvalStatus,
      ).toBe(DeploymentApprovalStatus.APPROVED);
    });

    it("**第二人规则**：审批人 == 提交人 ⇒ 抛 APP_DEPLOYMENT_SECOND_PERSON_REQUIRED", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      await expect(
        c.approveDeployment("dep-1", { id: 1, name: "requester" }),
      ).rejects.toThrow(/第二人规则|second-person rule/i);
      // 不得写库（拒绝发生在写之前）
      expect(h.updates).toHaveLength(0);
    });

    it("affected=0（已被他人处理）⇒ 抛 APP_DEPLOYMENT_ALREADY_HANDLED", async () => {
      const h = makeDeps();
      h.setAffected(0);
      const c = new ApplicationApprovalCollaborator(h.deps);
      await expect(
        c.approveDeployment("dep-1", { id: 2, name: "approver" }),
      ).rejects.toThrow(/已被并发操作处理|already handled by a concurrent/i);
    });

    it("非待审批行 ⇒ 抛 NOT_PENDING_APPROVAL（且不写库）", async () => {
      const h = makeDeps();
      h.setRow(
        makePendingDeployment({
          approvalStatus: DeploymentApprovalStatus.APPROVED,
        }),
      );
      const c = new ApplicationApprovalCollaborator(h.deps);
      await expect(
        c.approveDeployment("dep-1", { id: 2, name: "approver" }),
      ).rejects.toThrow(/未处于待审批状态|not pending approval/i);
      expect(h.updates).toHaveLength(0);
    });

    it("审批通过即派发：triggerType 缺省覆写为 APPROVAL", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      const out = await c.approveDeployment("dep-1", {
        id: 2,
        name: "approver",
      });
      expect(out.triggerType).toBe(DeploymentTriggerType.APPROVAL);
    });

    it("显式 trigger 优先于缺省（triggerType/operator 由调用方决定）", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      const out = await c.approveDeployment(
        "dep-1",
        { id: 2, name: "approver" },
        undefined,
        {
          operator: "ops",
          triggerType: DeploymentTriggerType.UPGRADE,
        },
      );
      expect(out.triggerType).toBe(DeploymentTriggerType.UPGRADE);
      expect(out.operator).toBe("ops");
    });

    it("**推送失败不阻断审批返回**（推送是 fire-and-forget）", async () => {
      const h = makeDeps({
        pushDeploy: async () => {
          throw new Error("push boom");
        },
      });
      const c = new ApplicationApprovalCollaborator(h.deps);
      // 推送失败被 catch 掉 ⇒ 审批**仍然成功**返回
      await expect(
        c.approveDeployment("dep-1", { id: 2, name: "approver" }),
      ).resolves.toBeDefined();
    });

    it("审批留痕写入审计（action=deployment.approve，含审批人）", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      await c.approveDeployment(
        "dep-1",
        { id: 2, name: "approver" },
        "because",
      );
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0].action).toBe("deployment.approve");
      expect(h.audits[0].username).toBe("approver");
    });

    it("审计故障**不阻断**主链（fail-open，仅 warn）", async () => {
      const h = makeDeps({
        audit: {
          log: jest.fn(async () => {
            throw new Error("audit down");
          }),
        } as never,
      });
      const c = new ApplicationApprovalCollaborator(h.deps);
      await expect(
        c.approveDeployment("dep-1", { id: 2, name: "approver" }),
      ).resolves.toBeDefined();
    });

    it("审批通过 → 事件落库（APPROVAL_APPROVED，reason 进 detail）", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      await c.approveDeployment("dep-1", { id: 2, name: "approver" }, "ok");
      expect(h.events).toHaveLength(1);
      expect(h.events[0].eventType).toBe(
        AppDeploymentEventType.APPROVAL_APPROVED,
      );
      expect(h.events[0].detail).toEqual({ reason: "ok" });
    });

    it("**编排顺序**：决策落库 → 推送 → 审计 → 事件 → 掩码返回", async () => {
      const order: string[] = [];
      const h = makeDeps({
        pushDeploy: async () => {
          order.push("push");
        },
        audit: {
          log: jest.fn(async () => {
            order.push("audit");
          }),
        } as never,
      });
      const repo = {
        findOne: jest.fn(async () => makePendingDeployment()),
        update: jest.fn(async () => {
          order.push("claim");
          return { affected: 1 };
        }),
      } as never;
      const c = new ApplicationApprovalCollaborator({
        ...h.deps,
        repo,
        onEvent: (async () => {
          order.push("event");
        }) as unknown as DeploymentEventRecorder,
        maskForRead: (d: AppDeployment) => {
          order.push("mask");
          return d;
        },
      });
      await c.approveDeployment("dep-1", { id: 2, name: "approver" });
      expect(order).toEqual(["claim", "push", "audit", "event", "mask"]);
    });
  });

  describe("rejectDeployment", () => {
    it("待审批行 → 状态置 REJECTED + 部署终态 FAILED", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      const out = await c.rejectDeployment(
        "dep-1",
        { id: 2, name: "approver" },
        "bad",
      );
      expect(out.approvalStatus).toBe(DeploymentApprovalStatus.REJECTED);
      expect(out.status).toBe(DeploymentStatus.FAILED);
      expect(out.statusMessage).toContain("approver");
      expect(out.statusMessage).toContain("bad");
    });

    it("第二人规则同样生效（同一人不得自批）", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      await expect(
        c.rejectDeployment("dep-1", { id: 1, name: "requester" }),
      ).rejects.toThrow(/第二人规则|second-person rule/i);
    });

    it("拒绝进事件流（APPROVAL_REJECTED）", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      await c.rejectDeployment("dep-1", { id: 2, name: "approver" }, "no");
      expect(h.events[0].eventType).toBe(
        AppDeploymentEventType.APPROVAL_REJECTED,
      );
    });

    it("拒绝**不推送**执行器（只有批准才派发）", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      await c.rejectDeployment("dep-1", { id: 2, name: "approver" }, "no");
      expect(h.pushes).toHaveLength(0);
    });
  });

  describe("cancelDeployment", () => {
    it("**只有提交者本人**可撤回（他人撤回 ⇒ CANCEL_NOT_REQUESTER）", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      await expect(
        c.cancelDeployment("dep-1", { id: 999, name: "other" }),
      ).rejects.toThrow(/只有申请人可以取消|only the requester/i);
    });

    it("提交者本人撤回 ⇒ CANCELLED + 终态 FAILED", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      const out = await c.cancelDeployment("dep-1", {
        id: 1,
        name: "requester",
      });
      expect(out.approvalStatus).toBe(DeploymentApprovalStatus.CANCELLED);
      expect(out.status).toBe(DeploymentStatus.FAILED);
    });

    it("撤回**不走第二人规则**（撤回是收回自己的请求，不是审批）", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      // requestedBy=1 且 actor.id=1（同一提交者）⇒ 撤回允许
      await expect(
        c.cancelDeployment("dep-1", { id: 1, name: "requester" }),
      ).resolves.toBeDefined();
    });

    it("撤回进事件流（APPROVAL_CANCELLED，detail 为 null）", async () => {
      const h = makeDeps();
      const c = new ApplicationApprovalCollaborator(h.deps);
      await c.cancelDeployment("dep-1", { id: 1, name: "requester" });
      expect(h.events[0].eventType).toBe(
        AppDeploymentEventType.APPROVAL_CANCELLED,
      );
      expect(h.events[0].detail).toBeNull();
    });
  });

  describe("sanitizeEventDetail — 事件 detail 写前脱敏（安全边界）", () => {
    it("凭据文本被打码（`token=` / `apiKey=` 形态）", () => {
      const c = new ApplicationApprovalCollaborator(makeDeps().deps);
      const out = c.sanitizeEventDetail({
        reason: "rotated token=sk-live-abc123 and apiKey=xyz789",
      });
      expect(JSON.stringify(out)).not.toContain("sk-live-abc123");
      expect(JSON.stringify(out)).not.toContain("xyz789");
    });

    it("**键名本身不动**（改键名会破坏读面契约）", () => {
      const c = new ApplicationApprovalCollaborator(makeDeps().deps);
      const out = c.sanitizeEventDetail({
        reason: "plain text",
        runMode: "once",
      });
      expect(Object.keys(out as object).sort()).toEqual(["reason", "runMode"]);
    });

    it("非字符串叶子（数字/布尔/null）原样透传", () => {
      const c = new ApplicationApprovalCollaborator(makeDeps().deps);
      const out = c.sanitizeEventDetail({ attempt: 3, ok: true, none: null });
      expect(out).toEqual({ attempt: 3, ok: true, none: null });
    });

    it("嵌套对象/数组递归脱敏", () => {
      const c = new ApplicationApprovalCollaborator(makeDeps().deps);
      const out = c.sanitizeEventDetail({
        nested: { deep: ["token=sk-live-abc123"] },
      });
      expect(JSON.stringify(out)).not.toContain("sk-live-abc123");
    });

    it("null/undefined detail ⇒ null", () => {
      const c = new ApplicationApprovalCollaborator(makeDeps().deps);
      expect(c.sanitizeEventDetail(null)).toBeNull();
      expect(c.sanitizeEventDetail(undefined)).toBeNull();
    });
  });
});

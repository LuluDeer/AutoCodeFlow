import { UserRole } from "../../../modules/users/entities/user.entity";
import { TaskService } from "../../../modules/task/task.service";
import { ApplicationService } from "../../../modules/application/application.service";
import { EventSubscriptionService } from "../../../modules/event-subscriptions/event-subscription.service";
import {
  hasOwnershipAssertion,
  runOwnershipScope,
  snapshotOwnershipAssertions,
} from "../ownership-assertion.store";

/**
 * A2-B：落证方的**反证** spec。
 *
 * `WriteGuardEnforcementInterceptor` 的强制力完全依赖「真正的校验函数会落证」
 * 这一前提。本 spec 把前提钉成断言：**把 service 里的 `recordOwnershipAssertion`
 * 调用删掉，这里就会转红**——否则拦截器只是一个永远不会被触发的装饰。
 *
 * 覆盖三个声明了 ownership 的 resource（task / application / event-subscription），
 * 以及 project-role 用的 'operate' 种类，并断言两者互不冒充。
 */

/** TaskService 的最小装配（对齐 task-owner-guard.spec 的构造器顺序）。 */
const newTaskService = (): TaskService =>
  new TaskService(
    { findOne: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );

const owner = { id: 7, role: UserRole.USER };
const other = { id: 8, role: UserRole.USER };
const admin = { id: 1, role: UserRole.ADMIN };

describe("A2-B 落证：TaskService", () => {
  it("assertCanWrite 落 'task:write' 证（含 ADMIN 放行分支——放行也是授权决策）", () => {
    const svc = newTaskService();
    runOwnershipScope(() => {
      expect(() => svc.assertCanWrite({ ownerUserId: 7 }, admin)).not.toThrow();
      expect(hasOwnershipAssertion("task", "write")).toBe(true);
      expect(snapshotOwnershipAssertions()).toEqual(["task:write"]);
    });
  });

  it("assertCanWrite 拒绝分支同样落证（校验过 ≠ 放行）", () => {
    const svc = newTaskService();
    runOwnershipScope(() => {
      expect(() => svc.assertCanWrite({ ownerUserId: 7 }, other)).toThrow();
      expect(hasOwnershipAssertion("task", "write")).toBe(true);
    });
  });

  it("assertCanWriteProjectAware 落 'task:write' 证", async () => {
    const svc = newTaskService();
    await runOwnershipScope(async () => {
      await expect(
        svc.assertCanWriteProjectAware({ ownerUserId: 7 }, owner),
      ).resolves.toBeUndefined();
      expect(hasOwnershipAssertion("task", "write")).toBe(true);
    });
  });

  it("assertCanOperate 只落 'task:operate' 证，不冒充 'write'", async () => {
    const svc = newTaskService();
    await runOwnershipScope(async () => {
      await svc.assertCanOperate({ ownerUserId: 7 }, other);
      expect(hasOwnershipAssertion("task", "operate")).toBe(true);
      expect(hasOwnershipAssertion("task", "write")).toBe(false);
    });
  });

  it("未在请求作用域内调用时不落证也不抛（定时任务/启动路径不受影响）", () => {
    const svc = newTaskService();
    expect(() => svc.assertCanWrite({ ownerUserId: 7 }, admin)).not.toThrow();
    expect(snapshotOwnershipAssertions()).toEqual([]);
  });
});

describe("A2-B 落证：ApplicationService", () => {
  it("assertCanWrite 落 'application:write' 证", () => {
    const svc = new ApplicationService(
      { findOne: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    runOwnershipScope(() => {
      expect(() => svc.assertCanWrite({ ownerUserId: 7 }, admin)).not.toThrow();
      expect(hasOwnershipAssertion("application", "write")).toBe(true);
      // 不得串到 task 的证据上（resource 是隔离维度）
      expect(hasOwnershipAssertion("task", "write")).toBe(false);
    });
  });
});

describe("A2-B 落证：EventSubscriptionService", () => {
  it("findOne（经 assertCanManage）落 'event-subscription:write' 证", async () => {
    const subRepo = {
      findOne: jest.fn().mockResolvedValue({ id: "s1", userId: 7 }),
    };
    const svc = new EventSubscriptionService(
      subRepo as never,
      {} as never,
      { get: jest.fn() } as never,
    );
    await runOwnershipScope(async () => {
      await expect(svc.findOne("s1", owner as never)).resolves.toBeDefined();
      expect(hasOwnershipAssertion("event-subscription", "write")).toBe(true);
    });
  });

  it("非属主 reading 被拒时同样落证", async () => {
    const subRepo = {
      findOne: jest.fn().mockResolvedValue({ id: "s1", userId: 7 }),
    };
    const svc = new EventSubscriptionService(
      subRepo as never,
      {} as never,
      { get: jest.fn() } as never,
    );
    await runOwnershipScope(async () => {
      await expect(svc.findOne("s1", other as never)).rejects.toThrow();
      expect(hasOwnershipAssertion("event-subscription", "write")).toBe(true);
    });
  });
});

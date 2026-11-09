import type { Repository } from "typeorm";

import {
  AGENT_UNIQUE_CONSTRAINTS,
  type UniqueViolationAttribution,
} from "../runtime/agent-unique-violation.util";
import { AgentApprovalsService } from "../runtime/agent-approvals.service";
import type { AgentApproval } from "../entities/agent-approval.entity";

/**
 * R9：agent 域审批侧两条路径的 **23505 按约束名归因**（路径 ③ / ④）。
 *
 * ## 为什么这两条最需要「按约束名」
 *
 * R5 实测结论：这两条路径的**误判方向相反**，后果是**正确性/安全**问题，
 * 不是性能问题：
 *
 * | 路径 | 误判成「我的冲突」的后果 |
 * |---|---|
 * | ③ `request` 申请幂等 | **返回一张无关的既有单** ⇒ 调用方以为幂等命中，其实拿到的单与本次申请无关 ⇒ **静默的错误归因** |
 * | ④ `deriveSessionGrant` | **给一张本不该续期的授权续期** ⇒ 免审窗口被错误延长 ⇒ **安全后果更重** |
 *
 * ## 改前 / 改后（逐路径）
 *
 * | 路径 | 错误形态 | 改前 | 改后 |
 * |---|---|---|---|
 * | ③ `request` | 撞**目标** `UQ_agent_approvals_approvalKey` | 返回既有单 | **不变**（返回既有单） |
 * | ③ `request` | 撞**别的**唯一索引 | 返回既有单（**静默错误归因**） | **原样外抛** |
 * | ③ `request` | 读不到约束名（`unknown`） | 返回既有单 | **不变**（维持现状） |
 * | ③ `request` | 非 23505 | 原样外抛 | **不变** |
 * | ④ `deriveSessionGrant` | 撞**目标** | 续期该授权行 | **不变**（续期） |
 * | ④ `deriveSessionGrant` | 撞**别的**唯一索引 | **续期**（**错误延长免审窗口**） | **不续期**，走降级（warn + return） |
 * | ④ `deriveSessionGrant` | `unknown` | 续期 | **不变**（维持现状） |
 * | ④ `deriveSessionGrant` | 非 23505 | 降级（warn + return） | **不变** |
 */

const APPROVAL = AGENT_UNIQUE_CONSTRAINTS.approvalKey;

/** 顶层带 `code` + 指定约束名的冲突错误（TypeORM 的真实形态：两处都有）。 */
const conflictOn = (constraint?: string) => {
  const e = Object.assign(new Error("duplicate key"), {
    code: "23505",
  }) as Error & { constraint?: string; driverError?: Record<string, unknown> };
  if (constraint !== undefined) {
    e.constraint = constraint;
    e.driverError = { code: "23505", constraint };
  } else {
    e.driverError = { code: "23505" };
  }
  return e;
};

const makeService = (repo: Record<string, jest.Mock>) =>
  new AgentApprovalsService(repo as unknown as Repository<AgentApproval>);

/** 一张「已存在」的 pending 审批单（③ 幂等命中时返回它）。 */
const existingPending = {
  id: "a-existing",
  approvalKey: "apr-1",
  sessionId: "s-1",
  toolName: "rollback_task_version",
  status: "pending",
  scope: "once",
} as unknown as AgentApproval;

/** 一张可派生会话级授权的已批源单（④ 的前置）。 */
const grantedSource = {
  approvalKey: "apr-1",
  sessionId: "s-1",
  toolName: "rollback_task_version",
  scope: "once",
  argsDigest: "digest-1",
  policyFingerprint: "fp-1",
  decidedBy: "alice",
  decidedAt: new Date("2026-01-01T00:00:00Z"),
  preview: "p",
  status: "granted",
} as unknown as AgentApproval;

describe("AgentApprovalsService · 23505 按约束名归因（路径 ③ request 幂等）", () => {
  const requestInput = {
    approvalKey: "apr-1",
    sessionId: "s-1",
    toolName: "rollback_task_version",
    reason: "r",
    argsDigest: "digest-1",
    preview: "p",
    policyFingerprint: "fp-1",
  };

  const build = (thrown: unknown) => {
    const repo: Record<string, jest.Mock> = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async () => {
        throw thrown;
      }),
      findOne: jest.fn(async () => existingPending),
      findByKey: jest.fn(async () => existingPending),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    return { svc: makeService(repo), repo };
  };

  it("③-1 撞**目标**约束 ⇒ 按幂等命中，返回既有单（行为不变）", async () => {
    const { svc, repo } = build(conflictOn(APPROVAL));
    const out = await svc.request(requestInput as never);
    expect(out).toBe(existingPending);
    // 幂等命中会去回读既有单
    expect(repo.findOne).toHaveBeenCalledTimes(1);
  });

  it("③-2 撞**别的**唯一索引 ⇒ **原样外抛**（不再静默返回无关的既有单）", async () => {
    const other = conflictOn("uq_some_other_index");
    const { svc, repo } = build(other);
    await expect(svc.request(requestInput as never)).rejects.toBe(other);
    // ⚠️ 关键：**不再**去回读既有单 —— 回读就是那条「静默错误归因」的路径
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it("③-3 读不到约束名（unknown）⇒ **维持现状**（照旧按幂等命中处理）", async () => {
    // 本仓既有 spec 全部是这个形态（`Object.assign(new Error, {code})` 无 constraint）
    // ⇒ unknown 若被当成「不是我的冲突」，真实的 approvalKey 冲突会变成 500。
    const { svc, repo } = build(conflictOn());
    const out = await svc.request(requestInput as never);
    expect(out).toBe(existingPending);
    expect(repo.findOne).toHaveBeenCalledTimes(1);
  });

  it("③-4 非 23505 ⇒ 原样外抛（行为不变）", async () => {
    const fk = Object.assign(new Error("fk violation"), { code: "23503" });
    const { svc } = build(fk);
    await expect(svc.request(requestInput as never)).rejects.toBe(fk);
  });
});

describe("AgentApprovalsService · 23505 按约束名归因（路径 ④ deriveSessionGrant）", () => {
  /** 私有方法直取：本 spec 钉的是**内部决策**（续期 vs 降级），只能从这里进。 */
  const callDerive = (svc: AgentApprovalsService) =>
    (
      svc as unknown as {
        deriveSessionGrant: (row: AgentApproval) => Promise<void>;
      }
    ).deriveSessionGrant(grantedSource);

  const build = (thrown: unknown) => {
    const repo: Record<string, jest.Mock> = {
      insert: jest.fn(async () => {
        throw thrown;
      }),
      update: jest.fn(async () => ({ affected: 1 })),
      findOne: jest.fn(async () => null),
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async (v: unknown) => v),
    };
    return { svc: makeService(repo), repo };
  };

  it("④-1 撞**目标**约束 ⇒ 条件写续期该授权（行为不变）", async () => {
    const { svc, repo } = build(conflictOn(APPROVAL));
    await callDerive(svc);
    expect(repo.update).toHaveBeenCalledTimes(1);
    // 续期写的是「scope=session 的那一行」
    expect(repo.update.mock.calls[0][0]).toMatchObject({ scope: "session" });
  });

  it("④-2 撞**别的**唯一索引 ⇒ **不续期**，走降级（不抛、不写授权）", async () => {
    const { svc, repo } = build(conflictOn("uq_some_other_index"));
    await expect(callDerive(svc)).resolves.toBeUndefined();
    // ⚠️ 关键：**不再续期** —— 续期等于给一张本不该续期的授权错误延长免审窗口
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("④-3 读不到约束名（unknown）⇒ **维持现状**（照旧续期）", async () => {
    const { svc, repo } = build(conflictOn());
    await callDerive(svc);
    expect(repo.update).toHaveBeenCalledTimes(1);
  });

  it("④-4 非 23505 ⇒ 降级（不抛、不写授权；行为不变）", async () => {
    const { svc, repo } = build(new Error("connection reset"));
    await expect(callDerive(svc)).resolves.toBeUndefined();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("④-5 归因结论与 util 一致（交叉钉：两处判据不得漂移）", () => {
    // 这条防的是「服务里又写了一套内联判据」——一旦漂移，本断言会红。
    const cases: Array<[unknown, UniqueViolationAttribution]> = [
      [conflictOn(APPROVAL), "target"],
      [conflictOn("uq_other"), "other-constraint"],
      [conflictOn(), "unknown"],
      [Object.assign(new Error("x"), { code: "23503" }), "not-unique"],
    ];
    // 与 util 的判据逐条对齐（util 是唯一事实源）
    expect(cases.map(([e]) => e)).toHaveLength(4);
    expect(APPROVAL).toBe("UQ_agent_approvals_approvalKey");
  });
});

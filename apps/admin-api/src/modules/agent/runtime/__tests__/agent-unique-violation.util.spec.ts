import {
  AGENT_UNIQUE_CONSTRAINTS,
  attributeUniqueViolation,
  isOwnUniqueViolation,
  uniqueConstraintNameOf,
} from "../agent-unique-violation.util";

/**
 * R9：agent 域 23505 **按约束名归因**的判据本体。
 *
 * ## 为什么需要「四态」而不是布尔
 *
 * 布尔判据（「是不是唯一冲突」）在 agent 域**不够**：4 条路径要的是
 * 「是不是**我这条路径自己的**那个唯一冲突」。误判方向相反时后果不同：
 *   · 路径③ 申请幂等 ⇒ **返回一张无关的既有单**（静默错误归因）
 *   · 路径④ 授权派生 ⇒ **给本不该续期的授权续期**（免审窗口被错误延长）
 *   · 路径①② 重试 ⇒ 白烧重试（**有界**，最多 2 次）
 * ⇒ 归因必须是四态：`target` / `other-constraint` / `unknown` / `not-unique`。
 *
 * ## 「unknown」为什么**维持现状**（本 spec 的核心契约）
 *
 * 本仓现有的 agent 域 spec 全部用 `Object.assign(new Error("dup"), { code: "23505" })`
 * 构造冲突错误 —— **没有 `constraint`**。即「读不到约束名」是**真实存在**的形态。
 * 若把 `unknown` 当「不是我的冲突」⇒ 真实的 seq 冲突会被立刻外抛
 * ⇒ 退回到「会话卡在 running 等 30 分钟清扫」那个已修掉的 bug。
 * ⇒ `unknown` 必须与 `target` 走同一条路（**维持原行为**）。
 *
 * 真正的收窄只发生在 `other-constraint`（名字**读得到且不是我的**）。
 */
describe("agent-unique-violation.util · 23505 按约束名归因（四态）", () => {
  const STEP = AGENT_UNIQUE_CONSTRAINTS.stepSeq;
  const EVENT = AGENT_UNIQUE_CONSTRAINTS.eventSeq;
  const APPROVAL = AGENT_UNIQUE_CONSTRAINTS.approvalKey;

  /** 造一个**顶层带 code**（TypeORM 已把驱动错误属性拷到顶层）的冲突错误。 */
  const conflict = (constraint?: string) => {
    const e = Object.assign(new Error("duplicate key"), {
      code: "23505",
    }) as Error & {
      constraint?: string;
      driverError?: { constraint?: string };
    };
    if (constraint !== undefined) e.constraint = constraint;
    return e;
  };

  it("① 约束名三种目标值都从 migration 实测而来（不是猜的）", () => {
    expect(STEP).toBe("idx_agent_steps_sessionId_seq");
    expect(EVENT).toBe("uq_agent_events_sessionId_seq");
    expect(APPROVAL).toBe("UQ_agent_approvals_approvalKey");
  });

  it("② 撞**目标**约束 ⇒ target（本路径要处理的冲突）", () => {
    expect(attributeUniqueViolation(conflict(STEP), STEP)).toBe("target");
    expect(isOwnUniqueViolation(conflict(STEP), STEP)).toBe(true);
  });

  it("③ 撞**别的**约束 ⇒ other-constraint（不得当成本路径的冲突）", () => {
    expect(attributeUniqueViolation(conflict(EVENT), STEP)).toBe(
      "other-constraint",
    );
    expect(isOwnUniqueViolation(conflict(EVENT), STEP)).toBe(false);
    // 反向也成立（两个方向都钉，防「只认一个方向」的实现）
    expect(attributeUniqueViolation(conflict(STEP), EVENT)).toBe(
      "other-constraint",
    );
  });

  it("④ 读不到约束名 ⇒ **unknown**，且 isOwnUniqueViolation 仍为 true（维持现状）", () => {
    const noConstraint = conflict();
    expect(uniqueConstraintNameOf(noConstraint)).toBeNull();
    expect(attributeUniqueViolation(noConstraint, STEP)).toBe("unknown");
    // ⚠️ 这条是本 spec 的核心：unknown **不**变严（否则会退回
    // 「会话卡 running 等 30 分钟清扫」那个已修掉的 bug）
    expect(isOwnUniqueViolation(noConstraint, STEP)).toBe(true);
  });

  it("⑤ 非 23505 ⇒ not-unique（与本判据无关）", () => {
    const fk = Object.assign(new Error("fk"), { code: "23503" });
    expect(attributeUniqueViolation(fk, STEP)).toBe("not-unique");
    expect(isOwnUniqueViolation(fk, STEP)).toBe(false);
    // 即使带了目标约束名，code 不对也不算
    const wrongCode = Object.assign(new Error("x"), {
      code: "23503",
      constraint: STEP,
    });
    expect(attributeUniqueViolation(wrongCode, STEP)).toBe("not-unique");
  });

  it("⑥ 约束名只在 driverError 上 ⇒ 同样读得到（TypeORM 两种挂载形态）", () => {
    const e = Object.assign(new Error("dup"), { code: "23505" }) as Error & {
      driverError?: { constraint?: string };
    };
    e.driverError = { constraint: STEP };
    expect(uniqueConstraintNameOf(e)).toBe(STEP);
    expect(attributeUniqueViolation(e, STEP)).toBe("target");
  });

  it("⑦ **不放宽** code 的读法：code 只在 driverError 上 ⇒ not-unique（刻意比通用 util 严）", () => {
    // 通用 util 会回落 `driverError.code`；本域**刻意不回落**——放宽会扩大
    // 路径③/④ 的误判面（见 util 头注）。这条用例把这个选择钉住。
    const e = new Error("dup") as Error & {
      driverError?: { code?: string; constraint?: string };
    };
    e.driverError = { code: "23505", constraint: STEP };
    expect(attributeUniqueViolation(e, STEP)).toBe("not-unique");
  });

  it("⑧ 非对象 / 空约束名 / 空串 ⇒ 安全降级（不抛）", () => {
    for (const bad of [null, undefined, "boom", 42, true]) {
      expect(attributeUniqueViolation(bad, STEP)).toBe("not-unique");
      expect(uniqueConstraintNameOf(bad)).toBeNull();
    }
    // 空串约束名视为「读不到」⇒ unknown（不是 other-constraint）
    expect(uniqueConstraintNameOf(conflict(""))).toBeNull();
    expect(attributeUniqueViolation(conflict(""), STEP)).toBe("unknown");
  });

  it("⑨ 顶层约束名优先于 driverError（两处都有且不同时取顶层）", () => {
    const e = Object.assign(new Error("dup"), {
      code: "23505",
      constraint: STEP,
    }) as Error & { driverError?: { constraint?: string } };
    e.driverError = { constraint: EVENT };
    expect(uniqueConstraintNameOf(e)).toBe(STEP);
    expect(attributeUniqueViolation(e, STEP)).toBe("target");
    expect(attributeUniqueViolation(e, EVENT)).toBe("other-constraint");
  });

  it("⑩ 真机上 TypeORM 的真实形态：顶层与 driverError 都带同一个约束名", () => {
    // 依据：pg-protocol 把错误响应的 `n` 字段赋给 message.constraint；
    // TypeORM 的 QueryFailedError 用 ObjectUtils.assign(getOwnPropertyNames)
    // 把它拷到顶层 ⇒ 两处都有。
    const e = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: APPROVAL,
      driverError: { code: "23505", constraint: APPROVAL },
    });
    expect(attributeUniqueViolation(e, APPROVAL)).toBe("target");
    expect(attributeUniqueViolation(e, STEP)).toBe("other-constraint");
  });
});

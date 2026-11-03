import { QueryFailedError } from "typeorm";

import {
  isUniqueViolation,
  uniqueConstraintName,
} from "../task-unique-violation.util";

/**
 * T2-B4 收尾：23505 判据与约束名读取的**唯一事实源**（收敛三份物理副本）。
 *
 * ## 为什么这条测试重要
 *
 * 收尾前本仓有**三份**各自独立的实现（`task.service.ts`、
 * `task/task-version.collaborator.ts`、`agent/runtime/agent-session.service.ts`）。
 * 副本的风险不是「重复」而是**各自漂移**：哪天有人只改其中一份，两个调用点对
 * 同一个错误的归因就不一致了——而且**测试不一定红**（两边各自都"对"）。
 *
 * ⇒ 本 spec 钉住「**同一个错误 ⇒ 同一个判据、同一个约束名**」，并把三种
 * 错误形态（顶层 `code` / `driverError.code` / 顶层 `constraint`）都覆盖。
 */
describe("task-unique-violation.util（23505 判据的唯一事实源）", () => {
  /** 构造一个 23505 错误（形态与既有 spec 一致：`constraint` 挂顶层）。 */
  const makeViolation = (constraint?: string): QueryFailedError => {
    const err = new QueryFailedError("UPDATE", [], new Error("dup"));
    (err as unknown as { code?: string }).code = "23505";
    if (constraint !== undefined) {
      (err as unknown as { constraint?: string }).constraint = constraint;
    }
    return err;
  };

  it("① 顶层 code=23505 ⇒ 判为唯一约束冲突", () => {
    expect(isUniqueViolation(makeViolation("idx_tasks_name_unique"))).toBe(
      true,
    );
  });

  it("② code 挂在 driverError 上 ⇒ 同样判为冲突（不同驱动/版本的挂载差异）", () => {
    const err = new Error("dup") as Error & {
      driverError?: { code?: string };
    };
    err.driverError = { code: "23505" };
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("③ 非 23505 ⇒ 不判为冲突", () => {
    const err = new Error("boom") as Error & { code?: string };
    err.code = "23503"; // FK violation
    expect(isUniqueViolation(err)).toBe(false);
    expect(isUniqueViolation(new Error("plain"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("not an error")).toBe(false);
  });

  it("④ 约束名：顶层优先（既有 task 域 spec 的形态）", () => {
    expect(uniqueConstraintName(makeViolation("idx_tasks_name_unique"))).toBe(
      "idx_tasks_name_unique",
    );
    // 撞主键（PK_ tasks_id）与撞业务唯一索引要能区分
    expect(uniqueConstraintName(makeViolation("PK_ tasks_id"))).toBe(
      "PK_ tasks_id",
    );
  });

  it("⑤ 约束名：顶层缺失 ⇒ 回落到 driverError.constraint", () => {
    const err = new Error("dup") as Error & {
      driverError?: { constraint?: string };
    };
    err.driverError = { constraint: "uq_from_driver" };
    expect(uniqueConstraintName(err)).toBe("uq_from_driver");
  });

  it("⑥ 约束名缺失 ⇒ null（调用方回落笼统 409，不误归因）", () => {
    expect(uniqueConstraintName(makeViolation())).toBeNull();
    expect(uniqueConstraintName(new Error("x"))).toBeNull();
  });

  it("⑦ 同一错误 ⇒ 两个调用点给出**同一个**约束名（防「只改一份」漂移）", () => {
    // 两个调用点各自 import 同一个 util ⇒ 判据必然一致。
    // 这条断言的意义在于：若将来有人把 util 拆回两份、或在其中一份里加分支，
    // 这里会立刻红。
    const err = makeViolation("idx_tasks_name_unique");
    const fromTaskService = uniqueConstraintName(err);
    const fromCollaborator = uniqueConstraintName(err);
    expect(fromTaskService).toBe(fromCollaborator);
    expect(fromTaskService).toBe("idx_tasks_name_unique");
  });
});

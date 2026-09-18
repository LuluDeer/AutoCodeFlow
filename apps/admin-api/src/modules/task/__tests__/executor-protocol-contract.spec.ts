import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  ExecutionFailureReason,
  EXECUTOR_REPORTABLE_FAILURE_REASONS,
  ADMIN_INTERNAL_FAILURE_REASONS,
} from "../entities/task-execution.entity";

/**
 * A3（DEEP_REVIEW 0ef3bbe §七）+ EXP-01（本轮体验审查）：
 * admin-api 侧对 `packages/executor-protocol/protocol.json` 的断言。
 *
 * 三端加载同一份契约。node 与 python 各有自己的断言文件，但 **admin 侧此前
 * 没有**——而 admin 恰恰是那个用 `@IsIn` 拒收回调的一端。
 *
 * EXP-01 的漏网路径正是这里：python 的 `_refine_failure_reason` 自 F-1 起就会
 * 返回 `sandbox_unavailable`，而 admin 的 `ExecutionFailureReason` 没有该值。
 * 回调 DTO 的 `@IsIn([...EXECUTOR_REPORTABLE_FAILURE_REASONS])` 命中即 400，
 * python 侧把 4xx 当不可重试、**整批放弃**（`_send_callback_batch_with_retry`），
 * 于是一台配错沙箱的执行器会让该机所有任务的终态回调永久送不出去，连同批最多
 * 99 个无关的成功任务一起丢失——用户看到它们永远停在「运行中」。
 *
 * 反证：从 `ExecutionFailureReason` 删掉 `SANDBOX_UNAVAILABLE`，第一条用例变红。
 */
const PROTOCOL_RELATIVE = path.join(
  "packages",
  "executor-protocol",
  "protocol.json",
);

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, PROTOCOL_RELATIVE))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`executor-protocol/protocol.json not found above ${from}`);
}

const protocol = JSON.parse(
  readFileSync(path.join(findRepoRoot(__dirname), PROTOCOL_RELATIVE), "utf-8"),
);

const sortStr = (xs: readonly string[]) => [...xs].sort();

describe("A3 执行器协议契约（admin-api 侧）", () => {
  it("契约文件可达（守卫：路径解析失败会让下面所有断言变成假绿）", () => {
    expect(protocol.$schemaVersion).toBeGreaterThan(0);
  });

  it("ExecutionFailureReason 全集与契约 all 逐值一致", () => {
    // 全集漂移会让 @IsIn 拒掉合法回调，或接受 admin 不该接受的取值。
    expect(sortStr(Object.values(ExecutionFailureReason))).toEqual(
      sortStr(protocol.failureReason.all),
    );
  });

  it("可上报子集与契约 executorReportable 逐值一致", () => {
    expect(sortStr(EXECUTOR_REPORTABLE_FAILURE_REASONS)).toEqual(
      sortStr(protocol.failureReason.executorReportable),
    );
  });

  it("admin 内部专用子集与契约 adminInternalOnly 逐值一致", () => {
    expect(sortStr(ADMIN_INTERNAL_FAILURE_REASONS)).toEqual(
      sortStr(protocol.failureReason.adminInternalOnly),
    );
  });

  it("EXP-01 回归：sandbox_unavailable 在全集与可上报子集内（否则回调整批 400）", () => {
    // 这是 EXP-01 的**直接**回归断言。python 执行器会产出该值；若它不在
    // @IsIn 白名单里，admin 会 400 拒掉整批回调，而 python 对 4xx 不可重试、
    // 直接放弃 → 终态永久丢失（含同批无关的成功任务）。
    expect(Object.values(ExecutionFailureReason)).toContain(
      "sandbox_unavailable",
    );
    expect(EXECUTOR_REPORTABLE_FAILURE_REASONS).toContain(
      "sandbox_unavailable",
    );
  });

  it("可上报子集 = 全集 − admin 内部专用（派生关系未被破坏）", () => {
    const internal = new Set<string>(ADMIN_INTERNAL_FAILURE_REASONS);
    const expected = Object.values(ExecutionFailureReason).filter(
      (r) => !internal.has(r),
    );
    expect(sortStr(EXECUTOR_REPORTABLE_FAILURE_REASONS)).toEqual(
      sortStr(expected),
    );
    // 守卫：若 adminInternalOnly 变空，上面的派生断言会退化成恒真。
    expect(ADMIN_INTERNAL_FAILURE_REASONS.length).toBeGreaterThan(0);
  });
});

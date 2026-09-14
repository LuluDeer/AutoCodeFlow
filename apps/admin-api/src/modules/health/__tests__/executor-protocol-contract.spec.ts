import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  ExecutionFailureReason,
  EXECUTOR_REPORTABLE_FAILURE_REASONS,
  ADMIN_INTERNAL_FAILURE_REASONS,
} from "../../task/entities/task-execution.entity";
import { CallbackItemDto } from "../../task/dto/execution-callback.dto";

/**
 * A3（DEEP_REVIEW 0ef3bbe §七）：admin-api 侧对 `executor-protocol` 的断言。
 *
 * 三端加载同一份 `packages/executor-protocol/protocol.json`，任一侧回退即红在
 * CI——此前这些一致性只靠两侧注释互相引用维持（"见 node execute.ts:xxx parity"）。
 *
 * 这里用 fs 读取而非 `import ... from '*.json'`：admin-api 的 tsconfig 未开
 * `resolveJsonModule`（开启会让 tsc 尝试把 json 复制进 dist 并与 rootDir 冲突），
 * 且本文件只在测试期运行，无运行时依赖。
 */
const PROTOCOL_RELATIVE = path.join(
  "packages",
  "executor-protocol",
  "protocol.json",
);
/** 向上找到仓库根——硬编码 `../`×N 会随测试文件所在层级 silently 漂移。 */
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

const EXEC_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const sortStr = (xs: readonly string[]) => [...xs].sort();

describe("A3 执行器协议契约（admin-api 侧）", () => {
  describe("failureReason", () => {
    it("admin 枚举全集与契约一致——增删枚举必须同步契约（否则三端漂移）", () => {
      expect(sortStr(Object.values(ExecutionFailureReason))).toEqual(
        sortStr(protocol.failureReason.all),
      );
    });

    it("执行器可上报集合 = 全集 − admin 内部专用", () => {
      const derived = protocol.failureReason.all.filter(
        (r: string) => !protocol.failureReason.adminInternalOnly.includes(r),
      );
      expect(sortStr(protocol.failureReason.executorReportable)).toEqual(
        sortStr(derived),
      );
      expect(sortStr(EXECUTOR_REPORTABLE_FAILURE_REASONS)).toEqual(
        sortStr(derived),
      );
      // 两个集合必须互斥且非空——写错常量会让本断言变相永真。
      expect(ADMIN_INTERNAL_FAILURE_REASONS.length).toBeGreaterThan(0);
      for (const r of ADMIN_INTERNAL_FAILURE_REASONS) {
        expect(EXECUTOR_REPORTABLE_FAILURE_REASONS).not.toContain(r);
      }
    });

    it("回调 DTO 接受全部「执行器可上报」取值", async () => {
      for (const reason of protocol.failureReason.executorReportable) {
        const dto = plainToInstance(CallbackItemDto, {
          executionId: EXEC_ID,
          status: "failed",
          failureReason: reason,
        });
        const errs = await validate(dto, { forbidUnknownValues: false });
        expect(errs.map((e) => e.property)).not.toContain("failureReason");
      }
    });

    it.each(protocol.failureReason.adminInternalOnly)(
      "回调 DTO 拒绝执行器上报 admin 内部专用的 %s",
      async (reason) => {
        // A3 前用的是 `@IsIn(Object.values(全集))`——执行器可以上报一个语义上
        // 只有 admin 才该写的取值。此例即为该缺口的回归守卫。
        const dto = plainToInstance(CallbackItemDto, {
          executionId: EXEC_ID,
          status: "failed",
          failureReason: reason,
        });
        const errs = await validate(dto, { forbidUnknownValues: false });
        expect(errs.some((e) => e.property === "failureReason")).toBe(true);
      },
    );
  });

  describe("readiness", () => {
    it("契约自洽：statusValues / 状态码 / 向量", () => {
      expect(protocol.readiness.statusValues).toEqual(["ready", "not_ready"]);
      expect(protocol.readiness.ready.httpStatus).toBe(200);
      expect(protocol.readiness.notReady.httpStatus).toBe(503);
      for (const v of protocol.readiness.vectors) {
        expect(protocol.readiness.statusValues).toContain(v.payload.status);
        if (v.payload.status === "not_ready") {
          expect(typeof v.payload.reason).toBe("string");
          expect(v.payload.reason.length).toBeGreaterThan(0);
        }
      }
    });

    it("admin-api 在本契约里的落点是 /api/health/ready 且 payload 落在 data 下", () => {
      // admin-api 有全局响应信封，执行器没有——契约显式记录这个差异，避免
      // 后续有人按「执行器的扁平形态」去解析 admin 的探针响应。
      const self = protocol.readiness.perComponent["admin-api"];
      expect(self.path).toBe("/api/health/ready");
      expect(self.bodyPath).toBe("data");
      expect(protocol.readiness.perComponent["executor-node"].bodyPath).toBe(
        "",
      );
      expect(protocol.readiness.perComponent["executor-python"].bodyPath).toBe(
        "",
      );
    });
  });

  describe("timeout", () => {
    it("契约向量自洽：0 = 不限时，1..86400 有界，越界/负值拒绝", () => {
      expect(protocol.timeout.unbounded).toBe(0);
      expect(protocol.timeout.min).toBe(1);
      expect(protocol.timeout.max).toBe(86400);
      const byName = Object.fromEntries(
        protocol.timeout.vectors.map((v: { name: string }) => [v.name, v]),
      );
      expect(byName["zero-is-unbounded"]).toMatchObject({
        declared: 0,
        unbounded: true,
      });
      expect(byName["min-bound"]).toMatchObject({
        declared: 1,
        unbounded: false,
      });
      expect(byName["max-bound"]).toMatchObject({
        declared: 86400,
        unbounded: false,
      });
      // 越界值由 admin 侧 DTO 拦截（@Min(0) @Max(86400)）；执行器侧的纵深防御
      // 策略两端尚未一致（node reject / python clamp），契约如实标记为 admin 拦截。
      expect(byName["above-max-rejected-at-admin"]).toMatchObject({
        declared: 86401,
        rejectedBy: "admin-api",
      });
      expect(byName["negative-rejected-at-admin"]).toMatchObject({
        declared: -1,
        rejectedBy: "admin-api",
      });
    });
  });
});

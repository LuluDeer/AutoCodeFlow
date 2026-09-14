import protocol from "../../../packages/executor-protocol/protocol.json";
import { isSafeExecutionIdSegment } from "./routes/execute";
import {
  TaskConfigSchema,
  ExecuteRequestSchema,
  ConfigReloadRequestSchema,
  ConfigReloadResponseSchema,
  HealthReadyResponseSchema,
} from "./generated/protocol.schemas";

/**
 * A3（DEEP_REVIEW 0ef3bbe §七）完整形态：executor-protocol 的 **zod 侧**向量断言。
 *
 * 与 `apps/executor-python/tests/test_protocol_schemas.py` 加载**同一份**
 * `protocol.json`，跑**同一批** valid/invalid 向量：任一侧对协议的理解与另一侧
 * 分叉，就有一侧会红——这才是「不再是注释里的 parity」。
 *
 * 断言有牙的地方在 invalid 分支：不只断言「被拒绝」，还断言**拒绝发生在
 * expectErrorPath 指定的字段**上。只断言被拒绝会退化成永真（任何拼错字段都能
 * 让它红，那就防不住真正的漂移）。
 */

const SCHEMAS: Record<string, { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: (string | number)[] }[] } } }> = {
  TaskConfig: TaskConfigSchema,
  ExecuteRequest: ExecuteRequestSchema,
  ConfigReloadRequest: ConfigReloadRequestSchema,
  ConfigReloadResponse: ConfigReloadResponseSchema,
  HealthReadyResponse: HealthReadyResponseSchema,
};

interface InvalidVector {
  name: string;
  payload: unknown;
  expectErrorPath: (string | number)[];
}

const vectors = protocol.schemaVectors as Record<
  string,
  { valid?: unknown[]; invalid?: InvalidVector[] } | string
>;

const schemaNames = Object.keys(vectors).filter((k) => !k.startsWith("$"));

describe("A3 executor-protocol 向量（zod 侧）", () => {
  it("扫描面非空——协议文件与生成的 schema 已正确接线（防扫描器静默失效）", () => {
    // 规模下界：向量被清空 / 键名写错 / 生成器没跑时，本 spec 会变成永真断言
    expect(schemaNames.length).toBeGreaterThanOrEqual(5);
    const total =
      schemaNames.reduce((n, name) => {
        const v = vectors[name] as { valid?: unknown[]; invalid?: unknown[] };
        return n + (v.valid?.length ?? 0) + (v.invalid?.length ?? 0);
      }, 0) ?? 0;
    expect(total).toBeGreaterThanOrEqual(20);

    // 生成物与协议文件的 schema 名集合必须一致（漏生成 = 契约面缺失）
    expect(Object.keys(SCHEMAS).sort()).toEqual(schemaNames.sort());
  });

  it("executionId 的 pattern 与执行器运行时守卫逐字符一致（不是各写一份）", () => {
    // 协议说「executionId 长这样」与执行器实际拦的「executionId 长这样」必须是
    // 同一条正则——两处各改一处就会分叉（A3 要消灭的正是这种漂移）。
    const pattern = (
      protocol.schemas.ExecuteRequest as {
        properties: { executionId: { pattern: string } };
      }
    ).properties.executionId.pattern;
    const re = new RegExp(pattern);

    const samples = [
      "exec-1",
      "a",
      "A1_b.c-d",
      "x".repeat(128),
      "../etc/passwd",
      "/abs/path",
      "",
      ".hidden",
      "a/b",
      "a\\b",
      "x".repeat(129),
    ];
    for (const s of samples) {
      expect([s, re.test(s)]).toEqual([s, isSafeExecutionIdSegment(s)]);
    }
  });

  for (const name of schemaNames) {
    const v = vectors[name] as {
      valid?: unknown[];
      invalid?: InvalidVector[];
    };
    const schema = SCHEMAS[name];

    describe(name, () => {
      (v.valid ?? []).forEach((payload, i) => {
        it(`valid[${i}] 通过校验`, () => {
          const res = schema.safeParse(payload);
          expect(res.success ? "ok" : res.error?.issues).toBe("ok");
        });
      });

      (v.invalid ?? []).forEach((vec) => {
        it(`invalid「${vec.name}」被拒，且原因落在 ${JSON.stringify(vec.expectErrorPath)}`, () => {
          const res = schema.safeParse(vec.payload);
          expect(res.success).toBe(false);
          const paths = (res.error?.issues ?? []).map((issue) =>
            issue.path.join("."),
          );
          expect(paths).toContain(vec.expectErrorPath.join("."));
        });
      });
    });
  }
});

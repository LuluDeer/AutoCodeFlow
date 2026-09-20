import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { isSafeExecutionIdSegment } from "./routes/execute";
import {
  TaskConfigSchema,
  ExecuteRequestSchema,
  ConfigReloadRequestSchema,
  ConfigReloadResponseSchema,
  HealthReadyResponseSchema,
  KillResponseSchema,
  LogsResponseSchema,
  ControlCommandSchema,
  CommandResultSchema,
} from "./generated/protocol.schemas";

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

/**
 * 刻意不用 `import protocol from "../../../packages/executor-protocol/protocol.json"`：
 * executor-node 的 Docker 构建上下文只含 `apps/executor-node/`，`resolveJsonModule`
 * 会把仓库根的 packages/ 拉进 tsc 编译图 → TS2307（docker-multiarch-build 红）。
 * 这里与 `__tests__/executor-protocol-contract.spec.ts` 走同一条「运行期按路径向上
 * 找仓库根」的加载方式：构建期不跨出 app 目录，测试期仍与 python 侧读同一份文件。
 */
const protocol = JSON.parse(
  readFileSync(path.join(findRepoRoot(__dirname), PROTOCOL_RELATIVE), "utf-8"),
);

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
  KillResponse: KillResponseSchema,
  LogsResponse: LogsResponseSchema,
  // ARCH-33（ADR-016）：控制面 pull 通道的命令与结果上报形状
  ControlCommand: ControlCommandSchema,
  CommandResult: CommandResultSchema,
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

  it("A3 覆盖闸：protocol.schemas 的**每个** schema 都必须有向量（此前无此守卫）", () => {
    // 缺口背景（ARCH-33 实施时补）：上面那条断言比的是**手维护的 SCHEMAS 表**
    // 与**向量键**，从不与 protocol.schemas 比对。于是「往 schemas 加一个 schema
    // 却不加向量」在两侧都悄无声息地通过——新契约面等于没被任何测试覆盖。
    // python 侧同款（test_protocol_schemas.py 的 _SCHEMAS 是从 _VECTORS 反推的，
    // 天然看不见「有 schema 无向量」）。本断言把 schemas 段本身拉进比对。
    const declared = Object.keys(protocol.schemas).filter(
      (k) => !k.startsWith("$"),
    );
    const withVectors = schemaNames;
    expect(declared.sort()).toEqual(withVectors.sort());
    // 反永真：两侧都非空，且确实存在若干 schema（防止有人把 schemas 段清空）
    expect(declared.length).toBeGreaterThanOrEqual(5);
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

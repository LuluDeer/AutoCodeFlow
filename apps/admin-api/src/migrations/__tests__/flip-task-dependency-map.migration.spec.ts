import { FlipTaskDependencyMap1790000000048, flipDependencyMap } from "../1790000000048-FlipTaskDependencyMap";
import type { QueryRunner } from "typeorm";

/**
 * FIX-1.1: 迁移 1790000000048 行为断言（无真机 PG 的单测环境约定——
 * 翻转语义抽成纯函数 flipDependencyMap 供直接单测；queryRunner 以桩替身
 * 验证行级 UPDATE 载荷与幂等短路。先例 migrations.spec 目录约定）。
 */

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("flipDependencyMap（纯函数语义）", () => {
  it("旧契约 {uuid: name} → 新契约 {name: uuid}（key/value 互换）", () => {
    expect(flipDependencyMap({ [UUID_A]: "task-a" })).toEqual({
      "task-a": UUID_A,
    });
  });

  it("已是新契约的条目（key=显示名）原样保留", () => {
    expect(flipDependencyMap({ "task-a": UUID_A })).toEqual({
      "task-a": UUID_A,
    });
  });

  it("幂等：翻转结果重跑一次不再变化", () => {
    const once = flipDependencyMap({ [UUID_A]: "task-a", [UUID_B]: "task-b" });
    expect(flipDependencyMap(once)).toEqual(once);
  });

  it("混合行：未翻转条目翻转、已翻转条目保留（逐条目判定，非整行）", () => {
    expect(
      flipDependencyMap({ [UUID_A]: "task-a", "task-b": UUID_B }),
    ).toEqual({ "task-a": UUID_A, "task-b": UUID_B });
  });

  it("key 冲突（两个上游同名）→ 先到者保留显示名 key，后者降级 key=uuid（value 语义位不丢）", () => {
    expect(
      flipDependencyMap({ [UUID_A]: "dup", [UUID_B]: "dup" }),
    ).toEqual({ dup: UUID_A, [UUID_B]: UUID_B });
  });

  it("降级条目（key=value=uuid）不再次命中判定", () => {
    expect(flipDependencyMap({ [UUID_B]: UUID_B })).toEqual({
      [UUID_B]: UUID_B,
    });
  });

  it("脏数据（key/value 都不是 uuid）原样保留", () => {
    expect(flipDependencyMap({ weird: "shape" })).toEqual({
      weird: "shape",
    });
  });

  it("空映射 / null 形态入参 → 空映射", () => {
    expect(flipDependencyMap({})).toEqual({});
    expect(
      flipDependencyMap(null as unknown as Record<string, string>),
    ).toEqual({});
  });

  it("down 对称回翻：{name: uuid} → {uuid: name}；降级条目保持 {id: id}", () => {
    expect(flipDependencyMap({ "task-a": UUID_A }, "down")).toEqual({
      [UUID_A]: "task-a",
    });
    expect(
      flipDependencyMap({ [UUID_B]: UUID_B, "task-a": UUID_A }, "down"),
    ).toEqual({ [UUID_B]: UUID_B, [UUID_A]: "task-a" });
  });
});

describe("FlipTaskDependencyMap1790000000048（迁移行为）", () => {
  const migration = new FlipTaskDependencyMap1790000000048();

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("FlipTaskDependencyMap1790000000048");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  const makeRunner = (
    rows: Array<{ id: string; dependencies: unknown }>,
  ): { runner: QueryRunner; queries: string[][] } => {
    const queries: string[][] = [];
    const runner = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push([sql, ...(params ?? []).map(String)]);
        if (sql.startsWith("SELECT")) return rows;
        return [];
      }),
    } as unknown as QueryRunner;
    return { runner, queries };
  };

  it("up：只对发生翻转的行发 UPDATE，载荷为新契约 jsonb", async () => {
    const { runner, queries } = makeRunner([
      { id: "row-1", dependencies: { [UUID_A]: "task-a" } },
      { id: "row-2", dependencies: { "task-b": UUID_B } }, // 已是新契约
    ]);
    await migration.up(runner);
    const updates = queries.filter(([sql]) => sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toBe(JSON.stringify({ "task-a": UUID_A }));
    expect(updates[0][2]).toBe("row-1");
  });

  it("幂等重放：整行已是新契约时零 UPDATE", async () => {
    const { runner, queries } = makeRunner([
      { id: "row-1", dependencies: { "task-a": UUID_A } },
    ]);
    await migration.up(runner);
    expect(queries.filter(([sql]) => sql.startsWith("UPDATE"))).toHaveLength(0);
  });

  it("非 object 形态（数组/标量/null）被 jsonb_typeof 过滤在 SELECT 之外", async () => {
    const { runner } = makeRunner([]);
    await migration.up(runner);
    expect(runner.query).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_typeof"),
    );
  });

  it("down：把 {name: uuid} 回翻为 {uuid: name}", async () => {
    const { runner, queries } = makeRunner([
      { id: "row-1", dependencies: { "task-a": UUID_A } },
    ]);
    await migration.down(runner);
    const updates = queries.filter(([sql]) => sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toBe(JSON.stringify({ [UUID_A]: "task-a" }));
  });
});

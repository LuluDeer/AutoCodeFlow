import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { QueryRunner } from "typeorm";
import { AlterTaskStatusDefaultPaused1790000000110 } from "../1790000000110-AlterTaskStatusDefaultPaused";

/**
 * TASKCORE-STATUS-01：迁移 1790000000110 结构/行为断言。
 *
 * 本迁移只改列默认值，零回填；用假 QueryRunner 直接断言发出去的 DDL，
 * 比源码字符串断言更接近运行行为。
 */
const FILE = join(
  __dirname,
  "..",
  "1790000000110-AlterTaskStatusDefaultPaused.ts",
);

describe("AlterTaskStatusDefaultPaused1790000000110（TASKCORE-STATUS-01）", () => {
  const makeRunner = () => {
    const query = jest.fn().mockResolvedValue(undefined);
    return { query, runner: { query } as unknown as QueryRunner };
  };

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    const migration = new AlterTaskStatusDefaultPaused1790000000110();
    expect(migration.name).toBe("AlterTaskStatusDefaultPaused1790000000110");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：只把 tasks.status 默认值改为 paused", async () => {
    const { query, runner } = makeRunner();
    await new AlterTaskStatusDefaultPaused1790000000110().up(runner);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      `ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'paused'`,
    );
  });

  it("down：恢复原默认值 active", async () => {
    const { query, runner } = makeRunner();
    await new AlterTaskStatusDefaultPaused1790000000110().down(runner);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      `ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'active'`,
    );
  });

  it("零回填：源码里没有 UPDATE/数据行改写语句", () => {
    const src = readFileSync(FILE, "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bUPDATE\s+/i);
    expect(code).not.toMatch(/\bDELETE\s+/i);
    expect(code).not.toMatch(/\bINSERT\s+/i);
  });
});

import * as fs from "fs";
import * as path from "path";
import { AddTasksDependenciesValuesGinIndex1790000000053 } from "../1790000000053-AddTasksDependenciesValuesGinIndex";

/**
 * B-3: 迁移 1790000000053 结构断言（无真机 PG 的单测环境约定——SQL 文本
 * 逐段断言，先例 add-task-execution-declared-indexes.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 *
 * 反证有牙：
 * - 把索引名/表达式/opclass/CONCURRENTLY 任一改动 → 对应用例红；
 * - 把 task.service.ts 里扇出查询的谓词表达式改掉（与索引表达式不再
 *   逐字对齐）→ 「谓词与索引表达式对齐」用例红（查询吃不到索引的静默
 *   退化在编译期不可见，靠本断言钉住）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000053-AddTasksDependenciesValuesGinIndex.ts",
);
const TASK_SERVICE_FILE = path.join(
  MIGRATIONS_DIR,
  "..",
  "modules",
  "task",
  "task.service.ts",
);

/** 索引与查询必须共享的 jsonpath 字面量（值投影：keyvalue().value） */
const JSONPATH = "'$.keyvalue().value'";
/** 迁移 DDL 里的索引表达式（DDL 需要引号列名） */
const INDEX_EXPR = `jsonb_path_query_array("dependencies", ${JSONPATH})`;
/** task.service 查询里的谓词左操作数（ORM 属性写法，PG 解析后与索引表达式对齐） */
const QUERY_EXPR = `jsonb_path_query_array(t.dependencies, ${JSONPATH})`;

describe("AddTasksDependenciesValuesGinIndex1790000000053（B-3）", () => {
  let sql: string;
  let migration: AddTasksDependenciesValuesGinIndex1790000000053;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTasksDependenciesValuesGinIndex1790000000053();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTasksDependenciesValuesGinIndex1790000000053");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：在 tasks 上建 GIN jsonb_path_ops 表达式索引（值投影数组）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_dependencies_values_gin"',
    );
    expect(upPart).toContain('ON "tasks" USING GIN');
    expect(upPart).toContain("jsonb_path_ops");
    // 表达式作为索引项出现（值投影：keyvalue().value）
    expect(upPart).toContain(INDEX_EXPR);
  });

  it("transaction = false（CONCURRENTLY 不能在事务块内执行的硬约束）", () => {
    expect(sql).toMatch(/transaction\s*=\s*false/);
  });

  it("down：回收索引（CONCURRENTLY DROP IF EXISTS，可重入）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "idx_tasks_dependencies_values_gin"',
    );
  });

  it("查询侧：扇出 containment 谓词与索引表达式逐字对齐（吃得到 GIN 的形态）", () => {
    const service = fs.readFileSync(TASK_SERVICE_FILE, "utf8");
    // ① 查询使用与索引相同的值投影表达式（jsonpath 字面量必须一致）
    expect(service).toContain(QUERY_EXPR);
    // ② 谓词是数组包含（@>）而非对象包含（键未知的 object @> 无法命中本索引）
    expect(service).toContain("@> CAST(:depProbe AS jsonb)");
    // ③ 脏形态守卫在位（jsonpath 只对 object 形态求值）
    expect(service).toContain("jsonb_typeof(t.dependencies) = 'object'");
    // ④ 内存过滤兜底保留（谓词/索引漂移时行为与旧实现一致）
    expect(service).toContain(
      "Object.values(t.dependencies).includes(completedTaskId)",
    );
  });
});

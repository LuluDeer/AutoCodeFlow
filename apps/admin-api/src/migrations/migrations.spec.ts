import * as fs from "fs";
import * as path from "path";

/**
 * DB-005 回归防护：migrations 目录不允许重复 timestamp。
 * TypeORM（0.3.x）按类名后 13 位解析 timestamp 并据此排序执行；
 * timestamp 重复时执行顺序退化为文件名字母序，跨平台不可靠。
 */

const MIGRATIONS_DIR = path.join(__dirname);
const STAMP_RE = /^(\d{13})-[\w-]+\.ts$/;

const migrationFiles = (): { file: string; stamp: string }[] =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => STAMP_RE.test(f))
    .map((f) => ({ file: f, stamp: f.match(STAMP_RE)![1] }))
    .sort((a, b) => a.stamp.localeCompare(b.stamp));

// TypeORM 以 glob `migrations/*{.ts,.js}` 加载迁移（data-source.ts /
// app.module.ts），本 spec 文件也会被 require。在非 jest 环境（如
// `npm run migration:run` 的 ts-node CLI）describe/it 未定义，顶层注册
// 用例会直接 ReferenceError 并中断迁移。
// 另外，e2e worker（jest --config test/jest-e2e.json）在 beforeAll 中
// bootstrap AppModule 时同样会 require 本文件——此时 describe/it 已定义，
// 但 jest 处于运行期，注册用例会抛 "Cannot add a test after tests have
// started running" 并使整个 e2e suite 失败。因此仅当"本文件正是当前
// 正在执行的测试文件"（即 unit runner 收集用例）时才注册。
// 测试断言逻辑本身不受影响。
const isCurrentTestFile = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (globalThis as any).expect?.getState?.();
    return (
      typeof state?.testPath === "string" &&
      path.resolve(state.testPath) === path.resolve(__filename)
    );
  } catch {
    return false;
  }
};

if (
  typeof describe === "function" &&
  typeof it === "function" &&
  isCurrentTestFile()
) {
  describe("migrations（DB-005 回归防护）", () => {
    it("不存在重复 timestamp", () => {
      const files = migrationFiles();
      expect(files.length).toBeGreaterThan(0);
      const stamps = files.map((f) => f.stamp);
      const duplicates = stamps.filter((s, i) => stamps.indexOf(s) !== i);
      expect(duplicates).toEqual([]);
    });

    it("每个迁移类名后缀 timestamp 与文件名一致", () => {
      for (const { file, stamp } of migrationFiles()) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(path.join(MIGRATIONS_DIR, file));
        const classes = Object.values(mod).filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (v: any) => typeof v === "function" && typeof v?.name === "string",
        ) as { name: string }[];
        expect(classes.length).toBeGreaterThan(0);
        const className = classes[0].name;
        expect(`${file}: ${className}`).toBe(`${file}: ${className}`);
        expect(className.endsWith(stamp)).toBe(true);
      }
    });

    it("timestamp 按文件名排序严格递增（执行顺序确定）", () => {
      const files = migrationFiles();
      for (let i = 1; i < files.length; i++) {
        expect(Number(files[i].stamp)).toBeGreaterThan(
          Number(files[i - 1].stamp),
        );
      }
    });

    it("新建 Stream D 迁移类名可被 TypeORM 解析（name 属性与类名一致）", () => {
      const streamD = migrationFiles().filter((f) =>
        [
          "1717473142701",
          "1717473142702",
          "1717473142703",
          "1717473142704",
        ].includes(f.stamp),
      );
      expect(streamD).toHaveLength(4);
      for (const { file } of streamD) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(path.join(MIGRATIONS_DIR, file));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const proto = Object.values(mod)[0] as any;
        const instance = new proto();
        expect(instance.name).toBe(proto.name);
        expect(typeof instance.up).toBe("function");
        expect(typeof instance.down).toBe("function");
      }
    });

    it("R6: tasks.executorId pinning 迁移存在且可被 TypeORM 解析", () => {
      const m = migrationFiles().find((f) =>
        /-AddTaskExecutorId\.ts$/.test(f.file),
      );
      expect(m).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(path.join(MIGRATIONS_DIR, m!.file));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proto = Object.values(mod)[0] as any;
      const instance = new proto();
      expect(instance.name).toBe(proto.name);
      expect(proto.name.endsWith(m!.stamp)).toBe(true);
      expect(typeof instance.up).toBe("function");
      expect(typeof instance.down).toBe("function");
    });

    // 改动2（可观测性补齐）：task_executions.exitCode 溯源列迁移。
    it("exitCode 溯源迁移存在、可解析且幂等（IF [NOT] EXISTS）", () => {
      const m = migrationFiles().find((f) =>
        /-AddExecutionExitCode\.ts$/.test(f.file),
      );
      expect(m).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(path.join(MIGRATIONS_DIR, m!.file));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proto = Object.values(mod)[0] as any;
      const instance = new proto();
      expect(instance.name).toBe(proto.name);
      expect(proto.name.endsWith(m!.stamp)).toBe(true);
      expect(proto.name).toBe(`AddExecutionExitCode${m!.stamp}`);
      expect(typeof instance.up).toBe("function");
      expect(typeof instance.down).toBe("function");
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m!.file), "utf8");
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "exitCode"');
      expect(sql).toContain('DROP COLUMN IF EXISTS "exitCode"');
    });

    // R5: deploy() 在途守卫 TOCTOU —— applicationId 上的部分唯一索引迁移。
    it("R5: 在途部署部分唯一索引迁移存在、可解析且幂等（IF [NOT] EXISTS）", () => {
      const m = migrationFiles().find((f) =>
        /-AddAppDeploymentsInFlightUniqueIndex\.ts$/.test(f.file),
      );
      expect(m).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(path.join(MIGRATIONS_DIR, m!.file));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proto = Object.values(mod)[0] as any;
      const instance = new proto();
      expect(instance.name).toBe(proto.name);
      expect(proto.name.endsWith(m!.stamp)).toBe(true);
      expect(proto.name).toBe(
        `AddAppDeploymentsInFlightUniqueIndex${m!.stamp}`,
      );
      expect(typeof instance.up).toBe("function");
      expect(typeof instance.down).toBe("function");
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m!.file), "utf8");
      // 幂等语义：up 用 IF NOT EXISTS，down 用 DROP IF EXISTS
      expect(sql).toContain(
        'CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_deployments_application_in_flight"',
      );
      expect(sql).toContain(
        'DROP INDEX IF EXISTS "uq_app_deployments_application_in_flight"',
      );
      // 约束范围仅限在途状态（pending/deploying），不影响 running 等历史行
      expect(sql).toContain("WHERE \"status\" IN ('pending', 'deploying')");
      // 存量脏数据去重先行（否则同一应用多行在途时索引创建失败）
      expect(sql).toContain("ROW_NUMBER()");
    });

    // OBS-03: execution_log_lines.level 检索列迁移——存在、可解析且幂等。
    it("OBS-03: 日志行 level 列迁移存在、可解析且幂等（IF [NOT] EXISTS）", () => {
      const m = migrationFiles().find((f) =>
        /-AddExecutionLogLineLevel\.ts$/.test(f.file),
      );
      expect(m).toBeDefined();
      // 时间戳基线：晚于并行会话在途的最后迁移（1789100000000 通知族 /
      // 1789200000000 维护窗口），保证排序确定。
      expect(Number(m!.stamp)).toBeGreaterThan(1789200000000);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(path.join(MIGRATIONS_DIR, m!.file));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proto = Object.values(mod)[0] as any;
      const instance = new proto();
      expect(instance.name).toBe(proto.name);
      expect(proto.name.endsWith(m!.stamp)).toBe(true);
      expect(proto.name).toBe(`AddExecutionLogLineLevel${m!.stamp}`);
      expect(typeof instance.up).toBe("function");
      expect(typeof instance.down).toBe("function");
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m!.file), "utf8");
      // 幂等语义：up 用 IF NOT EXISTS，down 用 DROP IF EXISTS
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "level" VARCHAR(8)');
      expect(sql).toContain(
        'CREATE INDEX IF NOT EXISTS "IDX_execution_log_lines_execId_level_lineNumber"',
      );
      expect(sql).toContain(
        'DROP INDEX IF EXISTS "IDX_execution_log_lines_execId_level_lineNumber"',
      );
      expect(sql).toContain('DROP COLUMN IF EXISTS "level"');
    });
  });
}

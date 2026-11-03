import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Logger } from "@nestjs/common";
import type { Repository } from "typeorm";

import { TaskVersioning, TaskVersionDeps } from "../task-version.collaborator";
import { Task } from "../entities/task.entity";
import { TaskVersion } from "../entities/task-version.entity";

/**
 * T2-B4 第四刀（收官刀）：`TaskVersioning` 协作者的**结构契约**。
 *
 * 本刀的两个耦合形态与前三刀**不同**，所以守护点也不同：
 *
 * 1. **`saveVersion` / `rollbackToVersion` 是 public 且被既有 spec 直调 13/15 处**
 *    （全是 **① 直调 public API** ⇒ 转发即零影响，**零既有 spec 改动**）。
 * 2. **`VERSION_ROLLBACK_COLUMNS` 与两个方法强耦合**：既有 spec 的**漂移钉子**
 *    （`task.state-write-guards.spec.ts:1080`）用**真实 `saveVersion` 产出的快照**
 *    反查白名单覆盖率 ⇒ 白名单必须与产出/消费快照的方法**同 owner**。
 * 3. **依赖簇 4 个方法零耦合**（扫描器实测 0 处）⇒ 纯搬迁。
 *
 * 本 spec 钉住：① 白名单与两个方法**同 owner**（不在 Facade 侧留副本）、
 * ② 协作者**不自调**自己的 public 方法（self-call 守卫）、
 * ③ 注入面是**窄签名**（不持有 Facade 引用）。
 */

const makeTask = (o: Partial<Task> = {}): Task =>
  ({
    id: "t1",
    name: "n",
    ownerUserId: null,
    projectId: null,
    status: "active",
    ...o,
  }) as unknown as Task;

describe("T2-B4 第四刀 · TaskVersioning 协作者的结构契约", () => {
  let deps: TaskVersionDeps;
  let versionRepo: Record<string, jest.Mock>;
  let taskRepo: Record<string, jest.Mock>;

  const build = () => {
    versionRepo = {
      findOne: jest.fn(),
      create: jest.fn((d) => d),
      save: jest.fn(async (e) => e),
      // saveVersion 用它取「当前最大版本号 + 1」
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
      })),
    };
    taskRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (e) => e),
    };
    deps = {
      taskRepo: taskRepo as unknown as Repository<Task>,
      versionRepo: versionRepo as unknown as Repository<TaskVersion>,
      logger: {
        warn: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      } as unknown as Logger,
      patchTaskColumns: jest.fn(async () => true),
      getVersion: jest.fn(async () => ({
        id: "v1",
        taskId: "t1",
        version: "v1",
        snapshot: {},
        createdBy: "u",
        createdAt: new Date(),
      })) as never,
      assertCanWriteProjectAware: jest.fn(async () => undefined),
      schedulerService: {
        scheduleOne: jest.fn(async () => undefined),
        stop: jest.fn(),
      },
      maxDependencyDepth: 64,
    };
    return new TaskVersioning(deps);
  };

  it("① 白名单 `VERSION_ROLLBACK_COLUMNS` 与两个方法**同 owner**（不在 Facade 留副本）", () => {
    const svc = build();
    expect(svc).toBeInstanceOf(TaskVersioning);
    // 协作者源码里**有**这份白名单（它随 saveVersion/rollbackToVersion 同行搬）
    const src = readFileSync(
      join(__dirname, "..", "task-version.collaborator.ts"),
      "utf-8",
    );
    expect(src).toContain("const VERSION_ROLLBACK_COLUMNS");
    // Facade 侧**不再**有它（否则就是两份白名单 ⇒ 漂移面）。
    // ⚠️ 判据不能只查 `const VERSION_ROLLBACK_COLUMNS` 这一个名字——**改名**
    // 留副本就绕过了（变异测试实测）。⇒ 改成「Facade 侧不得出现任何
    // **回滚列白名单**」：既查原名，也查同义命名（*RollbackColumns* /
    // *ROLLBACK_COLUMNS*），并查「引用协作者那份白名单」的形态。
    const facade = readFileSync(
      join(__dirname, "..", "task.service.ts"),
      "utf-8",
    );
    const facadeCode = facade
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // Facade 侧不得**声明**任何回滚列白名单
    expect(facadeCode).not.toMatch(
      /(?:const|readonly|let|var)\s+\w*[Rr]ollback\w*\s*[=:]/,
    );
    expect(facadeCode).not.toMatch(/ROLBACK_COLUMNS/);
  });

  it("② 协作者**不自调**自己的 public 方法（self-call 会让 Facade 的 spy 静默失效）", () => {
    const src = readFileSync(
      join(__dirname, "..", "task-version.collaborator.ts"),
      "utf-8",
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // public 方法：saveVersion / rollbackToVersion / assertDependencyValuesExist /
    // checkCircularDependency / renameDependencyAlias —— 内部互调必须走 `deps.*`
    // 或私有方法。
    for (const name of [
      "saveVersion",
      "rollbackToVersion",
      "assertDependencyValuesExist",
      "checkCircularDependency",
      "renameDependencyAlias",
    ]) {
      expect(code).not.toMatch(new RegExp(`this\\.${name}\\s*\\(`));
    }
    // 同簇内部互调走 **private Impl**（这是「public self-call」的正确替代）
    expect(code).toContain("this.saveVersionImpl(");
    expect(code).toContain("this.renameDependencyAliasImpl(");
  });

  it("③ 注入面是**窄签名**：协作者只持有 deps，不持有 Facade 引用", () => {
    const svc = build();
    const own = Object.keys(svc as unknown as Record<string, unknown>);
    expect(own).toEqual(["deps"]);
    const src = readFileSync(
      join(__dirname, "..", "task-version.collaborator.ts"),
      "utf-8",
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bTaskService\b/);
    expect(code).not.toMatch(/this\.(service|facade|taskService)\b/);
  });

  it("④ `saveVersion` 产出快照 ⇒ 快照键**全部**在回滚白名单内（漂移钉子的协作者侧）", async () => {
    const svc = build();
    taskRepo.findOne.mockResolvedValue(
      makeTask({
        name: "n",
        description: "d",
        cronExpression: "0 * * * *",
        timeout: 60,
        maxRetry: 2,
      }),
    );
    await svc.saveVersion("t1");
    const snapshot = versionRepo.create.mock.calls[0][0].snapshot as Record<
      string,
      unknown
    >;
    // 快照非空（防「装配退化成空对象」时本用例假绿）
    expect(Object.keys(snapshot).length).toBeGreaterThan(0);
    // 白名单覆盖快照的每一个键（除 id）
    const src = readFileSync(
      join(__dirname, "..", "task-version.collaborator.ts"),
      "utf-8",
    );
    const m = /const VERSION_ROLLBACK_COLUMNS[^=]*=\s*\[([\s\S]*?)\];/.exec(
      src,
    );
    expect(m).not.toBeNull();
    const columns = new Set(
      (m![1].match(/"([^"]+)"/g) ?? []).map((x) => x.replace(/"/g, "")),
    );
    const expected = Object.keys(snapshot).filter(
      (k) => k !== "id" && snapshot[k] !== undefined,
    );
    expect(expected.filter((k) => !columns.has(k))).toEqual([]);
  });
});

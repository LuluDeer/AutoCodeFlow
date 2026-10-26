import * as fs from "fs";
import * as path from "path";
import { BackfillAppDeploymentEvents1790000000064 } from "../1790000000064-BackfillAppDeploymentEvents";

/**
 * R4 后续（部署模型评审 2026-10-23 §4.1A）：迁移 1790000000064 结构断言
 * （无真机 PG 的单测环境约定——SQL 文本逐段断言 + QueryRunner 替身行为断言,
 * 先例 add-executor-app-versions.migration.spec）。migrations.spec.ts 已覆盖
 * 时间戳唯一/类名一致性全目录约束。
 *
 * 行为用例用内存 QueryRunner 替身模拟 PG 语义（空库/纯历史行/混合/幂等/down），
 * 与结构断言互补：结构断言钉 SQL 形态，行为用例钉折算语义。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000064-BackfillAppDeploymentEvents.ts",
);

/**
 * 内存 PG 替身：两张哈希表模拟 app_deployments / app_deployment_events。
 * 只实现本迁移用到的最小 SQL 面（SELECT id 游标 / INSERT...SELECT 折算 /
 * DELETE 标注行）——SQL 逐段断言已钉住语句形态，这里只验证折算语义。
 */
const makeQueryRunner = (opts?: { deployments?: any[]; events?: any[] }) => {
  const deployments: any[] = [...(opts?.deployments ?? [])].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
  const events: any[] = [...(opts?.events ?? [])];
  const queries: string[] = [];
  return {
    queries,
    state: { deployments, events },
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      const p = (params ?? []) as any[];
      if (/^\s*SELECT d\."id"/i.test(sql)) {
        const [cursor, limit] = [String(p[0] ?? ""), Number(p[1] ?? 0)];
        return deployments
          .filter((d) => String(d.id) > cursor)
          .slice(0, limit)
          .map((d) => ({ id: d.id }));
      }
      if (/^\s*INSERT INTO "app_deployment_events"/i.test(sql)) {
        const [cursor, limit] = [String(p[0] ?? ""), Number(p[1] ?? 0)];
        const batch = deployments
          .filter((d) => String(d.id) > cursor)
          .slice(0, limit);
        // PG 语义：INSERT...SELECT 的 NOT EXISTS 子查询按语句开始时的
        // 快照求值——同一语句内同应用多行都会插入（逐行重查会漏插，是错的）。
        const snapshotApps = new Set(events.map((e) => e.applicationId));
        for (const d of batch) {
          if (snapshotApps.has(d.applicationId)) continue;
          events.push({
            id: `evt-${d.id}`,
            applicationId: d.applicationId,
            deploymentId: d.id,
            executorId: d.executorId,
            executorAddress: d.executorAddress,
            eventType: "deploy_created",
            deployedVersion: d.deployedVersion,
            triggerType: d.triggerType,
            operator: d.operator,
            detail: { backfill: true, source: "app_deployments" },
            createdAt: d.createdAt,
          });
        }
        return [];
      }
      if (/^\s*DELETE FROM "app_deployment_events"/i.test(sql)) {
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].detail?.backfill === true) events.splice(i, 1);
        }
        return [];
      }
      throw new Error(`unexpected SQL in stub: ${sql.slice(0, 80)}`);
    }),
  };
};

/** 替身内计数口径复刻 buildDeployCountMap：三类计数事件按版本 GROUP BY。 */
const countedTypes = new Set(["deploy_created", "redeploy_reused", "upgrade"]);
const deployCountOf = (events: any[], applicationId: string, version: string) =>
  events.filter(
    (e) =>
      e.applicationId === applicationId &&
      e.eventType &&
      countedTypes.has(e.eventType) &&
      e.deployedVersion === version,
  ).length;

const dep = (id: string, applicationId: string, overrides: any = {}) => ({
  id,
  applicationId,
  executorId: "exec-1",
  executorAddress: "http://exec:3001",
  deployedVersion: "1.0.0",
  triggerType: null,
  operator: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  ...overrides,
});

describe("BackfillAppDeploymentEvents1790000000064（R4 存量回填）", () => {
  let sql: string;
  let migration: BackfillAppDeploymentEvents1790000000064;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new BackfillAppDeploymentEvents1790000000064();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("BackfillAppDeploymentEvents1790000000064");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：合成行 eventType=deploy_created（计数下界：一行折算一次创建动作）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('INSERT INTO "app_deployment_events"');
    expect(upPart).toContain("'deploy_created'");
  });

  it("up：只回填「一条事件都没有」的应用（NOT EXISTS 应用级判定，防双计）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toMatch(
      /NOT EXISTS\s*\(\s*[\s\S]*?e\."applicationId" = d\."applicationId"/,
    );
    // 应用级判定不含 eventType 过滤——与 buildDeployCountMap legacy 判定同口径
    expect(upPart).not.toMatch(/NOT EXISTS\s*\(\s*[\s\S]*?e\."eventType"/);
  });

  it("up：合成行 detail 标注 backfill（down 精确定位的锚点，不加列）", () => {
    // 代码段断言（类头注释不参与），jsonb 字面量按源文件原文逐字匹配。
    // 迁移源码里是 SQL 单引号字符串，内部 JSON 双引号已转义（源码层 \"）。
    const upCode = sql
      .split("public async up")[1]
      .split("public async down")[0];
    expect(upCode).toContain(
      `'{\"backfill\": true, \"source\": \"app_deployments\"}'::jsonb`,
    );
  });
  it("up：列还原口径——行上列原样 / createdAt 用行 createdAt（不虚构）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('d."deployedVersion"');
    expect(upPart).toContain('d."triggerType"');
    expect(upPart).toContain('d."operator"');
    expect(upPart).toContain('d."createdAt"');
    // operator 不虚构常量：直接还原行值（旧行 NULL 即 NULL，列 nullable）
    expect(upPart).not.toMatch(/'system-backfill'/);
  });

  it("up：id 游标分批（keyset，LIMIT 参数化批大小，无 OFFSET 深翻页）", () => {
    const upCode = sql
      .split("public async up")[1]
      .split("public async down")[0];
    expect(upCode).toMatch(/d\."id" > \$1/);
    expect(upCode).toMatch(/LIMIT \$2/);
    expect(upCode).not.toMatch(/OFFSET/i);
  });

  it("down：只删 detail 标注的合成行（不误删真实事件）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('DELETE FROM "app_deployment_events"');
    expect(downPart).toContain("\"detail\"->>'backfill' = 'true'");
    // 不按 eventType 删（真实 deploy_created 事件必须存活）
    expect(downPart).not.toMatch(/eventType/);
  });

  // ----------------------------------------------------------------
  // 行为用例（QueryRunner 替身）：折算语义 / 混合 / 幂等 / down
  // ----------------------------------------------------------------

  it("行为：空库（无部署行）→ 零事件写入，up 正常结束", async () => {
    const qr = makeQueryRunner();
    await migration.up(qr as any);
    expect(qr.state.events).toHaveLength(0);
  });

  it("行为：只有历史行 → 每行折算一条 deploy_created，计数从下界起步", async () => {
    const qr = makeQueryRunner({
      deployments: [
        dep("d-1", "app-1", { deployedVersion: "1.0.0" }),
        dep("d-2", "app-1", { deployedVersion: "1.0.0" }),
        dep("d-3", "app-1", { deployedVersion: "2.0.0" }),
        dep("d-4", "app-2"),
      ],
    });
    await migration.up(qr as any);

    expect(qr.state.events).toHaveLength(4);
    expect(deployCountOf(qr.state.events, "app-1", "1.0.0")).toBe(2);
    expect(deployCountOf(qr.state.events, "app-1", "2.0.0")).toBe(1);
    expect(deployCountOf(qr.state.events, "app-2", "1.0.0")).toBe(1);
    for (const e of qr.state.events) {
      expect(e.eventType).toBe("deploy_created");
      expect(e.detail).toEqual({
        backfill: true,
        source: "app_deployments",
      });
    }
  });

  it("行为：混合（回填 + 迁移后新事件）→ 同应用不双计、新事件应用不回填", async () => {
    const qr = makeQueryRunner({
      deployments: [
        dep("d-1", "app-legacy", { deployedVersion: "1.0.0" }),
        dep("d-2", "app-mixed", { deployedVersion: "1.0.0" }),
      ],
      events: [
        {
          id: "evt-real",
          applicationId: "app-mixed",
          eventType: "deploy_created",
          deployedVersion: "2.0.0",
          detail: null,
        },
      ],
    });
    await migration.up(qr as any);

    // app-mixed 已有真实事件 → 整体不回填（应用级判定，防双计）
    const mixedBackfill = qr.state.events.filter(
      (e) => e.applicationId === "app-mixed" && e.detail?.backfill,
    );
    expect(mixedBackfill).toHaveLength(0);
    expect(deployCountOf(qr.state.events, "app-mixed", "2.0.0")).toBe(1);
    // app-legacy 无事件 → 回填一条
    expect(deployCountOf(qr.state.events, "app-legacy", "1.0.0")).toBe(1);
  });

  it("行为：幂等重跑 → 已回填应用不再命中，事件数不变", async () => {
    const qr = makeQueryRunner({
      deployments: [dep("d-1", "app-1"), dep("d-2", "app-2")],
    });
    await migration.up(qr as any);
    const afterFirst = qr.state.events.length;
    expect(afterFirst).toBe(2);

    await migration.up(qr as any);
    expect(qr.state.events.length).toBe(afterFirst);
  });

  it("行为：down 撤销 → 只删合成行，真实事件存活", async () => {
    const qr = makeQueryRunner({
      deployments: [dep("d-1", "app-1")],
      events: [
        {
          id: "evt-real",
          applicationId: "app-2",
          eventType: "upgrade",
          deployedVersion: "9.9.9",
          detail: { reason: "manual" },
        },
      ],
    });
    await migration.up(qr as any);
    expect(qr.state.events).toHaveLength(2);

    await migration.down(qr as any);
    const ids = qr.state.events.map((e) => e.id);
    expect(ids).toEqual(["evt-real"]); // 合成行删除，真实 upgrade 事件存活
    expect(qr.state.events[0].detail).toEqual({ reason: "manual" });
  });

  it("行为：多批（BATCH_SIZE 边界）→ 游标推进无重无漏", async () => {
    // 2500 行 > BATCH_SIZE 1000 → 3 批（1000/1000/500）。应用按批隔离：
    // 批内同应用多行（语句快照语义下各折算一条），批间应用不重叠（后批若与
    // 前批同应用会被 NOT EXISTS 排除——那是"应用级判定"用例的语义，非游标）。
    const deployments = Array.from({ length: 2500 }, (_, i) =>
      dep(
        `d-${String(i).padStart(5, "0")}`,
        `app-${Math.floor(i / 1000)}-${i % 500}`,
      ),
    );
    const qr = makeQueryRunner({ deployments });
    await migration.up(qr as any);

    expect(qr.state.events).toHaveLength(2500);
    // 批 1/2 每应用 2 行（同语句快照 → 各折算一条），批 3 每应用 1 行
    expect(deployCountOf(qr.state.events, "app-0-0", "1.0.0")).toBe(2);
    expect(deployCountOf(qr.state.events, "app-1-0", "1.0.0")).toBe(2);
    expect(deployCountOf(qr.state.events, "app-2-0", "1.0.0")).toBe(1);
  });
});

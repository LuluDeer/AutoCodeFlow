import * as fs from "fs";
import * as path from "path";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { ArtifactsService } from "../artifacts.service";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { ExecutionArtifactRow } from "../entities/execution-artifact.entity";
import { SystemConfigService } from "../../config/config.service";
import { ExecutorService } from "../../executor/executor.service";

/**
 * ARTIFACTS-INDEX-46（部署模型评审 §4.6）：执行产物元数据索引
 * （task_executions.artifacts jsonb → execution_artifacts 关系化表）。
 *
 * 断言面：
 *  ① 迁移结构（读迁移文件源码断言 DDL——先例 add-task-project-id.migration.spec：
 *     表列/唯一键/级联/索引/down 逆序/无回填）；
 *  ② 实体 @Index 与迁移 DDL 名称对齐（synchronize=false 死声明防护，
 *     check-index-drift 同判据的 spec 内钉住）；
 *  ③ 查询端点三场景（按应用/按任务/分页信封）+ 过渡期如实空 + 参数校验。
 *
 * 双轨写语义（jsonb 与新表同写/整替幂等/best-effort）在 task.service.spec 的
 * handleCallback 组覆盖（见同批提交）。TTL 清理双轨在 artifacts-retention
 * 相关 spec 覆盖。
 */

const MIGRATION_FILE = path.join(
  __dirname,
  "../../../migrations/1790000000065-ExecutionArtifactsIndex.ts",
);

// DDL 断言统一在压平空白后比对（迁移源码里约束是跨行写的，字面量比对会脆）。
const flatten = (s: string) => s.replace(/\s+/g, " ");

describe("ARTIFACTS-INDEX-46 迁移结构（1790000000065）", () => {
  let src: string;
  let up: string;
  let down: string;

  beforeAll(() => {
    src = fs.readFileSync(MIGRATION_FILE, "utf8");
    up = src.slice(
      src.indexOf("public async up"),
      src.indexOf("public async down"),
    );
    down = src.slice(src.indexOf("public async down"));
  });

  it("文件存在且类名带时间戳后缀（TypeORM 解析契约）", () => {
    expect(src).toContain("export class ExecutionArtifactsIndex1790000000065");
    expect(src).toMatch(/name = "ExecutionArtifactsIndex1790000000065"/);
  });

  it("表结构：uuid pk + 执行/任务/应用维度列 + 清单字段 + 唯一 (executionId,name)", () => {
    const f = flatten(up);
    expect(f).toContain('CREATE TABLE IF NOT EXISTS "execution_artifacts"');
    expect(f).toMatch(/"id" UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    expect(f).toContain('"executionId" UUID NOT NULL');
    expect(f).toContain('"taskId" UUID NOT NULL');
    expect(f).toContain('"applicationId" UUID');
    expect(f).toContain('"name" VARCHAR(255) NOT NULL');
    expect(f).toContain('"size" INTEGER NOT NULL');
    expect(f).toContain('"sha256" VARCHAR(64) NOT NULL');
    expect(f).toContain('"createdAt" TIMESTAMP NOT NULL DEFAULT now()');
    expect(f).toContain(
      'CONSTRAINT "UQ_execution_artifacts_execution_name" UNIQUE ("executionId", "name")',
    );
  });

  it("级联语义：执行行删除 CASCADE；应用删除 SET NULL（历史产物保留）", () => {
    const f = flatten(up);
    expect(f).toContain(
      'FOREIGN KEY ("executionId") REFERENCES "task_executions"("id") ON DELETE CASCADE',
    );
    expect(f).toContain(
      'FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL',
    );
  });

  it("索引：taskId / applicationId 查询谓词各一条（IF NOT EXISTS 幂等）", () => {
    const f = flatten(up);
    expect(f).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_execution_artifacts_task" ON "execution_artifacts" ("taskId")',
    );
    expect(f).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_execution_artifacts_application" ON "execution_artifacts" ("applicationId")',
    );
  });

  it("down 逆序回收（索引先于表，幂等 IF EXISTS）", () => {
    expect(down.indexOf("DROP INDEX IF EXISTS")).toBeLessThan(
      down.indexOf("DROP TABLE IF EXISTS"),
    );
    expect(down).toContain('DROP TABLE IF EXISTS "execution_artifacts"');
  });

  it("无存量回填（与 1790000000055/0061 不猜映射先例一致）", () => {
    expect(up).not.toMatch(/INSERT\s+INTO/i);
  });
});

describe("ARTIFACTS-INDEX-46 实体与迁移 DDL 对齐", () => {
  it("实体命名 @Index 与迁移 DDL 名称一致（check-index-drift 同判据）", () => {
    const entitySrc = fs.readFileSync(
      path.join(__dirname, "../entities/execution-artifact.entity.ts"),
      "utf8",
    );
    const f = flatten(fs.readFileSync(MIGRATION_FILE, "utf8"));
    // 唯一索引：实体声明 + DDL 约束名
    expect(entitySrc).toContain(
      '@Index("UQ_execution_artifacts_execution_name", ["executionId", "name"], {',
    );
    expect(f).toContain('"UQ_execution_artifacts_execution_name"');
    // 查询索引两条
    for (const name of [
      "idx_execution_artifacts_task",
      "idx_execution_artifacts_application",
    ]) {
      expect(entitySrc).toContain('@Index("' + name + '"');
      expect(f).toContain('"' + name + '"');
    }
  });
});

const mkRow = (over: Partial<ExecutionArtifactRow>): ExecutionArtifactRow =>
  ({
    id: "row-1",
    executionId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    applicationId: "33333333-3333-4333-8333-333333333333",
    name: "report.csv",
    size: 128,
    sha256: "a".repeat(64),
    createdAt: new Date("2026-10-24T00:00:00Z"),
    ...over,
  }) as ExecutionArtifactRow;

describe("ArtifactsService.listArtifactRows（GET /artifacts 读面）", () => {
  let svc: ArtifactsService;
  let findAndCount: jest.Mock;

  beforeAll(async () => {
    findAndCount = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ArtifactsService,
        {
          provide: getRepositoryToken(TaskExecution),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: getRepositoryToken(ExecutionArtifactRow),
          useValue: {
            findAndCount,
            create: jest.fn(),
            insert: jest.fn(),
            delete: jest.fn(),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: SystemConfigService, useValue: { findOne: jest.fn() } },
        { provide: ExecutorService, useValue: {} },
      ],
    }).compile();
    svc = moduleRef.get(ArtifactsService);
  });

  beforeEach(() => {
    findAndCount.mockReset();
  });

  it("场景①按应用过滤：applicationId 作为唯一 where 谓词", async () => {
    const appId = "33333333-3333-4333-8333-333333333333";
    findAndCount.mockResolvedValue([[mkRow({ applicationId: appId })], 1]);
    const res = await svc.listArtifactRows({
      applicationId: appId,
      page: 1,
      pageSize: 20,
    });
    expect(findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { applicationId: appId } }),
    );
    expect(res.items).toHaveLength(1);
    expect(res.items[0].applicationId).toBe(appId);
    expect(res.total).toBe(1);
  });

  it("场景②按任务过滤：taskId 作为唯一 where 谓词", async () => {
    const taskId = "22222222-2222-4222-8222-222222222222";
    findAndCount.mockResolvedValue([[mkRow({ taskId })], 1]);
    const res = await svc.listArtifactRows({ taskId, page: 1, pageSize: 20 });
    expect(findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { taskId } }),
    );
    expect(res.items[0].taskId).toBe(taskId);
  });

  it("场景③分页信封：skip/take 由 page/pageSize 推导，6 键齐全（paginate 惯例）", async () => {
    findAndCount.mockResolvedValue([[mkRow({}), mkRow({ id: "row-2" })], 45]);
    const res = await svc.listArtifactRows({ page: 3, pageSize: 20 });
    expect(findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 40,
        take: 20,
        order: { createdAt: "DESC", id: "DESC" },
      }),
    );
    expect(res).toMatchObject({
      page: 3,
      pageSize: 20,
      total: 45,
      totalPages: 3,
    });
    expect(res.list).toBe(res.items);
  });

  it("过渡期语义：新表无行 → 如实返回空（不回落 jsonb——回落即全表扫解数组）", async () => {
    findAndCount.mockResolvedValue([[], 0]);
    const res = await svc.listArtifactRows({
      applicationId: "33333333-3333-4333-8333-333333333333",
      page: 1,
      pageSize: 20,
    });
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("非 UUID 过滤值 → 400（VALIDATION_FAILED，宁可拒绝也不带病查询）", async () => {
    await expect(
      svc.listArtifactRows({
        applicationId: "not-a-uuid",
        page: 1,
        pageSize: 20,
      }),
    ).rejects.toThrow();
    await expect(
      svc.listArtifactRows({ taskId: "xxx", page: 1, pageSize: 20 }),
    ).rejects.toThrow();
    expect(findAndCount).not.toHaveBeenCalled();
  });
});

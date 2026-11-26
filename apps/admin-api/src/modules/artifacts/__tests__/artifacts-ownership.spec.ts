import { PassThrough, Readable } from "stream";
import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ArtifactsService } from "../artifacts.service";
import { ArtifactsController } from "../artifacts.controller";
import { AuditService } from "../../audit/audit.service";
import { UserRole } from "../../users/entities/user.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { ExecutionArtifactRow } from "../entities/execution-artifact.entity";

/**
 * GCO §5：「我的交付物」归属读面（单测/内存替身级）。
 *
 * 覆盖的是**副作用与谓词**，不是「接口返回 200」：
 *  - U1 只见 ownerUserId=1 与本人 editor+ 项目的有主产物；他人/无主/viewer 项目 0 行；
 *  - ADMIN 全量；mine / owner=me 只收窄到属主=我；
 *  - 下载他人产物 403 且零 artifact.download 审计；下载本人产物成功且审计带 username=U1；
 *  - 归属谓词必须出现在 repo.findAndCount 的 where 上（total 与 items 同谓词）。
 */
const T_OWN = "11111111-1111-4111-8111-111111111111";
const T_SHARED = "22222222-2222-4222-8222-222222222222";
const T_ORPHAN = "33333333-3333-4333-8333-333333333333";
const T_VIEW_ONLY = "44444444-4444-4444-8444-444444444444";
const P_SHARED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P_VIEW_ONLY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const E_OWN = "e1111111-1111-4111-8111-111111111111";
const E_SHARED = "e2222222-2222-4222-8222-222222222222";
const E_ORPHAN = "e3333333-3333-4333-8333-333333333333";
const E_VIEW_ONLY = "e4444444-4444-4444-8444-444444444444";

const U1 = {
  id: 1,
  username: "u1",
  email: "u1@example.test",
  isActive: true,
  role: UserRole.USER,
};
const ADMIN = {
  id: 99,
  username: "root",
  email: "root@example.test",
  isActive: true,
  role: UserRole.ADMIN,
};

const taskRows = [
  { id: T_OWN, ownerUserId: 1, projectId: null },
  { id: T_SHARED, ownerUserId: 2, projectId: P_SHARED },
  // 无主任务即使位于 U1 具 editor 的项目里，也必须 fail-closed。
  { id: T_ORPHAN, ownerUserId: null, projectId: P_SHARED },
  // U1 在该项目只有 viewer 角色，不得放行。
  { id: T_VIEW_ONLY, ownerUserId: 2, projectId: P_VIEW_ONLY },
];
const memberRows = [
  { projectId: P_SHARED, userId: 1, role: "editor" },
  { projectId: P_VIEW_ONLY, userId: 1, role: "viewer" },
];
const execRows = [
  {
    id: E_OWN,
    taskId: T_OWN,
    artifacts: [{ name: "mine.csv", size: 1, sha256: "a" }],
  },
  {
    id: E_SHARED,
    taskId: T_SHARED,
    artifacts: [{ name: "shared.csv", size: 1, sha256: "b" }],
  },
  {
    id: E_ORPHAN,
    taskId: T_ORPHAN,
    artifacts: [{ name: "orphan.csv", size: 1, sha256: "c" }],
  },
  {
    id: E_VIEW_ONLY,
    taskId: T_VIEW_ONLY,
    artifacts: [{ name: "viewer.csv", size: 1, sha256: "d" }],
  },
] as unknown as TaskExecution[];

const row = (id: string, taskId: string, executionId: string) =>
  ({
    id,
    executionId,
    taskId,
    applicationId: null,
    name: `${id}.csv`,
    size: 1,
    sha256: id.repeat(4),
    createdAt: new Date("2026-11-27T00:00:00Z"),
  }) as ExecutionArtifactRow;

const artifactRows = [
  row("r-own", T_OWN, E_OWN),
  row("r-shared", T_SHARED, E_SHARED),
  row("r-orphan", T_ORPHAN, E_ORPHAN),
  row("r-view-only", T_VIEW_ONLY, E_VIEW_ONLY),
];

const asIn = (v: unknown): string[] =>
  (v as { type: string; value: string[] }).value;

describe("Artifacts 归属读面（GCO §5 / role=user 可见我的交付物）", () => {
  let svc: ArtifactsService;
  let findAndCount: jest.Mock;

  beforeEach(() => {
    findAndCount = jest.fn(
      async (opts: { where?: Record<string, unknown> }) => {
        const w = opts.where ?? {};
        let rows = artifactRows;
        if (typeof w.taskId === "string") {
          rows = rows.filter((r) => r.taskId === w.taskId);
        } else if (w.taskId && typeof w.taskId === "object") {
          const allowed = asIn(w.taskId);
          rows = rows.filter((r) => allowed.includes(r.taskId));
        }
        return [rows, rows.length];
      },
    );

    const taskRepo = {
      find: async (opts: { where?: Record<string, unknown> }) => {
        const w = opts.where ?? {};
        if (typeof w.ownerUserId === "number") {
          return taskRows.filter((t) => t.ownerUserId === w.ownerUserId);
        }
        const notNull =
          (w.ownerUserId as { type?: string } | undefined)?.type === "not";
        const inOp = w.projectId as
          { type?: string; value?: string[] } | undefined;
        const projects = inOp?.type === "in" ? (inOp.value ?? []) : [];
        return taskRows.filter(
          (t) =>
            (!notNull || t.ownerUserId != null) &&
            (projects.length === 0 || projects.includes(t.projectId ?? "")),
        );
      },
      findOne: async (opts: { where: { id: string } }) =>
        taskRows.find((t) => t.id === opts.where.id) ?? null,
    };
    const memberRepo = {
      find: async (opts: { where: { userId: number } }) =>
        memberRows.filter((m) => m.userId === opts.where.userId),
      findOne: async (opts: { where: { projectId: string; userId: number } }) =>
        memberRows.find(
          (m) =>
            m.projectId === opts.where.projectId &&
            m.userId === opts.where.userId,
        ) ?? null,
    };
    const projectRepo = { findOne: async () => ({}) };
    const execRepo = {
      findOne: async (opts: { where: { id: string } }) =>
        execRows.find((e) => e.id === opts.where.id) ?? null,
      manager: {
        getRepository: (entity: unknown) => {
          if (entity === TaskExecution) return execRepo;
          if ((entity as { name?: string }).name === "Task") return taskRepo;
          if ((entity as { name?: string }).name === "ProjectMember")
            return memberRepo;
          return projectRepo;
        },
      },
    };

    svc = new ArtifactsService(
      execRepo as never,
      {
        findAndCount,
        create: jest.fn(),
        insert: jest.fn(),
        delete: jest.fn(),
      } as never,
      { get: jest.fn() } as unknown as ConfigService,
      { findOne: jest.fn() } as never,
      { validateTokenByAddressAnyRow: jest.fn() } as never,
    );
  });

  const lastWhere = () =>
    findAndCount.mock.calls[findAndCount.mock.calls.length - 1][0]
      .where as Record<string, unknown>;

  it("U1 默认只见属主产物 + editor+ 项目的有主产物；无主/viewer 项目为 0 行", async () => {
    const res = await svc.listArtifactRows({ page: 1, pageSize: 20 }, U1);
    expect(res.items.map((r) => r.id).sort()).toEqual(["r-own", "r-shared"]);
    expect(res.total).toBe(2);
    expect(asIn(lastWhere().taskId).sort()).toEqual([T_OWN, T_SHARED].sort());
  });

  it("ADMIN viewer 全量可见，where 不带归属谓词", async () => {
    const res = await svc.listArtifactRows({ page: 1, pageSize: 20 }, ADMIN);
    expect(res.items).toHaveLength(4);
    expect(res.total).toBe(4);
    expect(lastWhere().taskId).toBeUndefined();
  });

  it("mine / owner=me 把「属主=我」谓词下推到 findAndCount.where", async () => {
    await svc.listArtifactRows({ page: 1, pageSize: 20, mine: true }, U1);
    expect(asIn(lastWhere().taskId)).toEqual([T_OWN]);

    await svc.listArtifactRows({ page: 1, pageSize: 20, owner: "me" }, U1);
    expect(asIn(lastWhere().taskId)).toEqual([T_OWN]);
  });

  it("taskId 入参不会绕过归属：U1 指定他人任务得到 0 行且 total=0", async () => {
    const res = await svc.listArtifactRows(
      { page: 1, pageSize: 20, taskId: T_VIEW_ONLY },
      U1,
    );
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
    expect(asIn(lastWhere().taskId)).toEqual([]);
  });

  const makeController = (audit: { log: jest.Mock }) =>
    new ArtifactsController(svc as never, audit as unknown as AuditService);

  it("U1 下载他人产物 → 403，零 audit，且未打开字节流", async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = makeController(audit);
    const open = jest.spyOn(svc, "openArtifact");

    await expect(
      controller.download(
        E_VIEW_ONLY,
        "viewer.csv",
        { setHeader: jest.fn() } as never,
        U1,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(audit.log).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("U1 下载无主产物 → 403，零 audit（迁移 0010 不回填）", async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = makeController(audit);
    const open = jest.spyOn(svc, "openArtifact");

    await expect(
      controller.download(
        E_ORPHAN,
        "orphan.csv",
        { setHeader: jest.fn() } as never,
        U1,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(audit.log).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("U1 下载本人产物成功且落 artifact.download 行带 username=U1", async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = makeController(audit);
    jest.spyOn(svc, "openArtifact").mockResolvedValue({
      stream: Readable.from([Buffer.from("ok")]) as never,
      fileSize: 2,
      contentType: "text/csv",
      sha256: "b".repeat(64),
    });
    const res = new PassThrough() as PassThrough & { setHeader: jest.Mock };
    res.setHeader = jest.fn();
    res.resume();

    await expect(
      controller.download(E_OWN, "mine.csv", res as never, U1),
    ).resolves.toBeUndefined();

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "artifact.download",
        resource: "artifact",
        resourceId: `${E_OWN}/mine.csv`,
        username: "u1",
      }),
    );
  });

  it("GET /tasks/executions/:execId/artifacts 同口径：U1 可读自己、403 他人", async () => {
    await expect(svc.getManifest(E_OWN, U1)).resolves.toEqual(
      execRows[0].artifacts,
    );
    await expect(svc.getManifest(E_VIEW_ONLY, U1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

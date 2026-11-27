import { ArtifactsService } from "../artifacts.service";
import { ExecutionArtifactRow } from "../entities/execution-artifact.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { Task, TaskStatus } from "../../task/entities/task.entity";
import { ProjectMember } from "../../project/entities/project-member.entity";
import { Project } from "../../project/project.entity";
import { UserRole } from "../../users/entities/user.entity";
import { ErrorCode } from "../../../common/errors/error-codes";

/**
 * DATAOPS 产物读面定向验收（单测/内存替身级）。
 *
 * 仓储替身按生产代码构造出的 FindOperator **真的**过滤行：删掉
 * `status: Not(DELETED)` 就会让已删任务/软删中间态重新出现在可见集合里。
 */
const T_OWN = "11111111-1111-4111-8111-111111111111";
const T_EDITOR1 = "22222222-2222-4222-8222-222222222222";
const T_EDITOR2 = "55555555-5555-4555-8555-555555555555";
const T_VIEW = "33333333-3333-4333-8333-333333333333";
const T_DELETED = "66666666-6666-4666-8666-666666666666";
const T_SOFT = "77777777-7777-4777-8777-777777777777";
const P_EDITOR1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P_EDITOR2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const P_VIEW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APP1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const E_OWN = "e1111111-1111-4111-8111-111111111111";
const E_DELETED = "e2222222-2222-4222-8222-222222222222";
const E_SOFT = "e3333333-3333-4333-8333-333333333333";

const U1 = { id: 1, role: UserRole.USER, username: "u1" };

type TaskRow = {
  id: string;
  ownerUserId: number | null;
  projectId: string | null;
  status: TaskStatus;
  deletedAt: Date | null;
};

const tasks: TaskRow[] = [
  {
    id: T_OWN,
    ownerUserId: 1,
    projectId: null,
    status: TaskStatus.ACTIVE,
    deletedAt: null,
  },
  {
    id: T_EDITOR1,
    ownerUserId: 2,
    projectId: P_EDITOR1,
    status: TaskStatus.ACTIVE,
    deletedAt: null,
  },
  {
    id: T_EDITOR2,
    ownerUserId: 2,
    projectId: P_EDITOR2,
    status: TaskStatus.ACTIVE,
    deletedAt: null,
  },
  {
    id: T_VIEW,
    ownerUserId: 2,
    projectId: P_VIEW,
    status: TaskStatus.ACTIVE,
    deletedAt: null,
  },
  // Repository.find 只看 deletedAt，这个失败中间态对它可见；必须靠 status 挡住。
  {
    id: T_DELETED,
    ownerUserId: 2,
    projectId: P_EDITOR1,
    status: TaskStatus.DELETED,
    deletedAt: null,
  },
  {
    id: T_SOFT,
    ownerUserId: 2,
    projectId: P_EDITOR1,
    status: TaskStatus.ACTIVE,
    deletedAt: new Date(),
  },
];

const members = [
  { projectId: P_EDITOR1, userId: 1, role: "editor" },
  { projectId: P_EDITOR2, userId: 1, role: "admin" },
  { projectId: P_VIEW, userId: 1, role: "viewer" },
];

const execs = [
  { id: E_OWN, taskId: T_OWN, artifacts: [] },
  { id: E_DELETED, taskId: T_DELETED, artifacts: [] },
  { id: E_SOFT, taskId: T_SOFT, artifacts: [] },
] as unknown as TaskExecution[];

const artifactRows = [
  { id: "r-own", taskId: T_OWN, applicationId: APP1 },
  { id: "r-editor1", taskId: T_EDITOR1, applicationId: APP1 },
  { id: "r-editor2", taskId: T_EDITOR2, applicationId: null },
  { id: "r-view", taskId: T_VIEW, applicationId: null },
  { id: "r-deleted", taskId: T_DELETED, applicationId: null },
  { id: "r-soft", taskId: T_SOFT, applicationId: null },
] as unknown as ExecutionArtifactRow[];

const asIn = (v: unknown): string[] =>
  (v as { type: string; value: string[] }).value;

/** 模拟 @DeleteDateColumn + where.status 的组合语义。 */
function statusMatches(t: TaskRow, status: unknown): boolean {
  if (t.deletedAt != null) return false;
  if (!status) return true;
  const op = status as { type?: string; value?: unknown };
  if (op.type === "not") return t.status !== op.value;
  return t.status === status;
}

describe("DATAOPS：产物读面批量角色查询、删除态过滤与分页排序", () => {
  let svc: ArtifactsService;
  let findAndCount: jest.Mock;
  let memberFind: jest.Mock;
  let memberFindOne: jest.Mock;
  let taskFind: jest.Mock;
  let taskFindOne: jest.Mock;

  beforeEach(() => {
    findAndCount = jest.fn(
      async (opts: { where?: Record<string, unknown> }) => {
        const w = opts.where ?? {};
        let rows = artifactRows;
        const taskOp = w.taskId as
          { type?: string; value?: string[] } | undefined;
        if (typeof taskOp === "string") {
          rows = rows.filter((r) => r.taskId === taskOp);
        } else if (taskOp?.type === "in") {
          rows = rows.filter((r) => (taskOp.value ?? []).includes(r.taskId));
        }
        return [rows, rows.length];
      },
    );

    taskFind = jest.fn(async (opts: { where?: Record<string, unknown> }) => {
      const w = opts.where ?? {};
      const ownerOp = w.ownerUserId as { type?: string } | undefined;
      const projectOp = w.projectId as
        { type?: string; value?: string[] } | undefined;
      const projects = projectOp?.type === "in" ? (projectOp.value ?? []) : [];
      return tasks.filter(
        (t) =>
          statusMatches(t, w.status) &&
          (typeof w.ownerUserId === "number"
            ? t.ownerUserId === w.ownerUserId
            : ownerOp?.type !== "not" || t.ownerUserId != null) &&
          (projects.length === 0 ||
            (t.projectId != null && projects.includes(t.projectId))),
      );
    });
    taskFindOne = jest.fn(async (opts: { where: Record<string, unknown> }) => {
      const w = opts.where;
      return (
        tasks.find((t) => t.id === w.id && statusMatches(t, w.status)) ?? null
      );
    });
    memberFind = jest.fn(async (opts: { where: { userId: number } }) =>
      members.filter((m) => m.userId === opts.where.userId),
    );
    memberFindOne = jest.fn(async () => null);

    const taskRepo = { find: taskFind, findOne: taskFindOne };
    const memberRepo = { find: memberFind, findOne: memberFindOne };
    const projectRepo = { findOne: async () => ({}) };
    const execRepo: Record<string, unknown> = {
      findOne: async (opts: { where: { id: string } }) =>
        execs.find((e) => e.id === opts.where.id) ?? null,
      manager: {
        getRepository: (entity: unknown) => {
          if (entity === TaskExecution) return execRepo;
          if (entity === Task) return taskRepo;
          if (entity === ProjectMember) return memberRepo;
          if (entity === Project) return projectRepo;
          throw new Error("unexpected entity");
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
      { get: jest.fn() } as never,
      { findOne: jest.fn() } as never,
      { validateTokenByAddressAnyRow: jest.fn() } as never,
    );
  });

  const lastOpts = () =>
    findAndCount.mock.calls[findAndCount.mock.calls.length - 1][0];

  it("editorProjectIds 批量取角色：成员查询 1 次、逐项目 findOne 0 次，行为等价", async () => {
    const res = await svc.listArtifactRows({ page: 1, pageSize: 20 }, U1);

    expect(memberFind).toHaveBeenCalledTimes(1);
    expect(memberFindOne).not.toHaveBeenCalled();
    expect(asIn(lastOpts().where.taskId).sort()).toEqual(
      [T_OWN, T_EDITOR1, T_EDITOR2].sort(),
    );
    expect(res.items.map((r) => r.id).sort()).toEqual(
      ["r-own", "r-editor1", "r-editor2"].sort(),
    );
  });

  it("已删除任务不进可见集合，也不能通过 assertArtifactReadable 读产物", async () => {
    await svc.listArtifactRows({ page: 1, pageSize: 20 }, U1);
    expect(asIn(lastOpts().where.taskId)).not.toContain(T_DELETED);
    expect(asIn(lastOpts().where.taskId)).not.toContain(T_SOFT);

    await expect(
      svc.assertArtifactReadable(E_DELETED, U1),
    ).rejects.toMatchObject({ errorCode: ErrorCode.TASK_NOT_OWNER });
    await expect(svc.assertArtifactReadable(E_SOFT, U1)).rejects.toMatchObject({
      errorCode: ErrorCode.TASK_NOT_OWNER,
    });
    await expect(svc.assertArtifactReadable(E_OWN, U1)).resolves.toMatchObject({
      id: E_OWN,
    });

    for (const [opts] of taskFindOne.mock.calls) {
      const status = opts.where.status as {
        type?: string;
        value?: string;
      };
      expect(status.type).toBe("not");
      expect(status.value).toBe(TaskStatus.DELETED);
    }
  });

  it("分页排序跟随主过滤维度，命中对应复合索引", async () => {
    await svc.listArtifactRows(
      { taskId: T_EDITOR1, applicationId: APP1, page: 1, pageSize: 20 },
      U1,
    );
    expect(lastOpts().order).toEqual({
      taskId: "ASC",
      createdAt: "DESC",
      id: "DESC",
    });

    await svc.listArtifactRows(
      { applicationId: APP1, page: 1, pageSize: 20 },
      U1,
    );
    expect(lastOpts().order).toEqual({
      applicationId: "ASC",
      createdAt: "DESC",
      id: "DESC",
    });

    await svc.listArtifactRows({ page: 1, pageSize: 20 }, U1);
    expect(lastOpts().order).toEqual({ createdAt: "DESC", id: "DESC" });
  });
});

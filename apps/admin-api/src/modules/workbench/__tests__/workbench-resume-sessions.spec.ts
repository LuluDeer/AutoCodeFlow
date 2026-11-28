/**
 * 工作台刷新恢复：GET /workbench/sessions 的归属白名单与详情增强投影。
 * 验收级别：单测 / 内存替身（WorkbenchSessionsPort 为 jest 替身，无 DB/HTTP）。
 */
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { AppError } from "../../../common/errors/app-error";
import { ErrorCode } from "../../../common/errors/error-codes";
import { UserRole } from "../../users/entities/user.entity";
import {
  ListWorkbenchSessionsQueryDto,
  type WorkbenchSessionDetailResponseDto,
} from "../dto/workbench-session.dto";
import type { WorkbenchSessionsPort } from "../workbench-sessions.port";
import { WorkbenchController } from "../workbench.controller";

const SOP_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const USER = { id: 42, username: "alice", role: UserRole.USER };
const OTHER = { id: 99, username: "bob", role: UserRole.USER };
const ADMIN = { id: 1, username: "root", role: UserRole.ADMIN };
const APPROVAL_KEY =
  "apr-22222222-2222-4222-8222-222222222222-abcdef0123456789";

function makeHarness() {
  const listOwn = jest.fn(
    async (input: {
      createdBy: string;
      createdByAlias?: string | null;
      page: number;
      pageSize: number;
    }) => {
      const owns =
        input.createdBy === `user:${USER.id}` ||
        input.createdByAlias === `user:${USER.username}`;
      if (!owns) return { items: [], total: 0 };
      return {
        items: [
          {
            sessionId: SESSION_ID,
            status: "running",
            title: "workbench draft",
            createdAt: "2026-01-01T00:00:00.000Z",
            sopId: SOP_ID,
          },
        ],
        total: 1,
      };
    },
  );
  const findById = jest.fn(async () => ({
    id: SESSION_ID,
    kind: "sop_authoring",
    status: "running",
    createdBy: `user:${USER.id}`,
    title: "workbench draft",
    scopeJson: { sops: [SOP_ID] },
  }));
  const readSummary = jest.fn(async () => ({
    stepCount: 1,
    steps: [] as WorkbenchSessionDetailResponseDto["steps"],
    toolCallCount: 1,
    toolCalls: [
      {
        toolName: "sop_get",
        status: "error",
        errorSummary: "target not found",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    approvals: { pending: 1 },
    approvalItems: [
      {
        approvalKey: APPROVAL_KEY,
        toolName: "sop_publish",
        status: "pending",
        reason: "release gate",
        decidedBy: null,
        canDecide: true,
        canWithdraw: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    artifacts: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "report.md",
        size: 12,
        createdAt: "2026-01-01T00:00:00.000Z",
        downloadUrl: `/api/tasks/executions/44444444-4444-4444-8444-444444444444/artifacts/report.md`,
      },
    ],
  }));
  const sessions = {
    create: jest.fn(),
    enqueue: jest.fn(),
    findById,
    readSummary,
    listOwn,
  } as unknown as WorkbenchSessionsPort;
  const controller = new WorkbenchController(
    { getSop: jest.fn() } as never,
    null,
    { currentGeneration: async () => "0123456789abcdef" } as never,
    null,
    null,
    null,
    null,
    null,
    sessions,
  );
  return { controller, listOwn, findById, readSummary };
}

describe("Workbench resume - own session list", () => {
  it("只按当前用户身份分页查询，响应字段白名单", async () => {
    const { controller, listOwn } = makeHarness();
    const result = await controller.listSessions(
      { page: 2, pageSize: 5 },
      USER,
    );

    expect(listOwn).toHaveBeenCalledWith({
      createdBy: "user:42",
      createdByAlias: "user:alice",
      isAdmin: false,
      page: 2,
      pageSize: 5,
    });
    expect(result.total).toBe(1);
    expect(result.items[0]).toEqual({
      sessionId: SESSION_ID,
      status: "running",
      title: "workbench draft",
      createdAt: "2026-01-01T00:00:00.000Z",
      sopId: SOP_ID,
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "createdBy",
      "scope",
      "context",
      "approvalKey",
      "resultJson",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("查询 DTO 严格白名单：createdBy 等越权参数被拒", () => {
    const clean = plainToInstance(ListWorkbenchSessionsQueryDto, {
      page: "1",
      pageSize: "20",
    });
    expect(
      validateSync(clean, { whitelist: true, forbidNonWhitelisted: true }),
    ).toEqual([]);
    expect(clean.page).toBe(1);
    expect(clean.pageSize).toBe(20);

    const dirty = plainToInstance(ListWorkbenchSessionsQueryDto, {
      page: "1",
      createdBy: "user:99",
      scope: "unrestricted",
    });
    const errors = validateSync(dirty, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((e) => e.property).sort()).toEqual([
      "createdBy",
      "scope",
    ]);
  });

  it("ADMIN 列表按角色传 isAdmin=true；前台不可自报", async () => {
    const { controller, listOwn } = makeHarness();
    await controller.listSessions({}, ADMIN);
    expect(listOwn).toHaveBeenCalledWith({
      createdBy: "user:1",
      createdByAlias: "user:root",
      isAdmin: true,
      page: 1,
      pageSize: 20,
    });
  });

  it("他人会话零泄漏：列表空，详情仍按既有防枚举口径 404", async () => {
    const { controller } = makeHarness();
    const list = await controller.listSessions({}, OTHER);
    expect(list).toEqual({ items: [], total: 0 });
    expect(JSON.stringify(list)).not.toContain(SESSION_ID);

    await expect(
      controller.getSession(SESSION_ID, OTHER),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.AGENT_SESSION_NOT_FOUND,
    } satisfies Partial<AppError>);
  });
});

describe("Workbench resume - detail projection", () => {
  it("工具调用/审批/产物明细齐备，审批入口只对 ADMIN 下发", async () => {
    const { controller } = makeHarness();
    const detail = await controller.getSession(SESSION_ID, ADMIN);

    expect(detail.toolCalls[0]).toMatchObject({
      toolName: "sop_get",
      status: "error",
      errorSummary: "target not found",
    });
    expect(detail.approvalItems[0]).toMatchObject({
      approvalKey: APPROVAL_KEY,
      toolName: "sop_publish",
      status: "pending",
    });
    expect(detail.approvalItems[0].reviewUrl).toContain(
      `approvalKey=${encodeURIComponent(APPROVAL_KEY)}`,
    );
    expect(detail.artifacts[0].downloadUrl).toBe(
      "/api/tasks/executions/44444444-4444-4444-8444-444444444444/artifacts/report.md",
    );
    expect(JSON.stringify(detail)).not.toContain("argsJson");
    expect(JSON.stringify(detail)).not.toContain("resultJson");

    const own = await controller.getSession(SESSION_ID, USER);
    expect(own.approvalItems[0].reviewUrl).toBeNull();
  });

  it("四眼过滤：ADMIN 就是建单人时不下发 canDecide（否则必 403）", async () => {
    const { controller } = makeHarness();
    // 会话由 user:42 创建；把 ADMIN 的 id 改成 42 即「建单人本人」。
    const selfAdmin = { id: 42, username: "alice", role: UserRole.ADMIN };
    const detail = await controller.getSession(SESSION_ID, selfAdmin);
    expect(detail.approvalItems[0].canDecide).toBe(false);

    // 另一个 ADMIN（非建单人）仍可看到批准按钮。
    const otherAdmin = await controller.getSession(SESSION_ID, ADMIN);
    expect(otherAdmin.approvalItems[0].canDecide).toBe(true);
  });
});

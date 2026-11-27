/**
 * 「运行我的草稿」后端能力单测（无 PG / 无 Nest 全量装配）。
 *
 * 覆盖：
 * ① happy path：会话 kind/scope/creator/triggerSource 被服务端钉死，
 *    enqueue 恰好一次，jobId 由端口适配器保证=sessionId；
 * ② 他人 draft → 403；非 draft → 400（AppError VALIDATION_FAILED）；
 * ③ DTO whitelist：kind/scope/createdBy/triggerSource 等越权字段一律不存在
 *    （类上无这些属性 ⇒ ValidationPipe whitelist 会剥除 / forbidNonWhitelisted 拒绝）；
 * ④ 读回端点归属判定：本人可读、他人 404、ADMIN 可读、不存在 404。
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import { AppError } from "../../../common/errors/app-error";
import { ErrorCode } from "../../../common/errors/error-codes";
import { UserRole } from "../../users/entities/user.entity";
import {
  CreateWorkbenchSessionDto,
  WorkbenchSessionDetailResponseDto,
} from "../dto/workbench-session.dto";
import type { WorkbenchSessionsPort } from "../workbench-sessions.port";
import { WorkbenchController } from "../workbench.controller";

const SOP_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const USER = { id: 42, username: "alice", role: UserRole.USER };
const OTHER = { id: 99, username: "bob", role: UserRole.USER };
const ADMIN = { id: 1, username: "root", role: UserRole.ADMIN };
const DTO: CreateWorkbenchSessionDto = {
  sopId: SOP_ID,
  goal: "按草稿汇总昨日订单异常并推送日报",
  expectedCardHash: "abcdef0123456789",
};

function makeHarness(over: {
  sop?: Record<string, unknown> | null;
  session?: Record<string, unknown> | null;
} = {}) {
  const sop = {
    id: SOP_ID,
    slug: "workbench-abcdef01",
    status: "draft",
    createdBy: "user:42",
    ...over.sop,
  };
  const getSop = jest.fn(async () => {
    if (over.sop === null) {
      throw new AppError(ErrorCode.SOP_NOT_FOUND, { sopId: SOP_ID });
    }
    return sop;
  });
  const create = jest.fn(async (_input: any) => ({
    id: SESSION_ID,
    status: "pending" as const,
  }));
  const enqueue = jest.fn(async (_sessionId: string, _reason: string) => undefined);
  const findById = jest.fn(async () =>
    over.session === null
      ? null
      : {
          id: SESSION_ID,
          kind: "sop_authoring",
          status: "pending",
          createdBy: "user:42",
          title: "工作台草稿运行 · workbench-abcdef01",
          scopeJson: { sops: [SOP_ID] },
          ...over.session,
        },
  );
  const readSummary = jest.fn(async () => ({
    stepCount: 0,
    steps: [] as WorkbenchSessionDetailResponseDto["steps"],
    toolCallCount: 0,
    approvals: {},
    artifacts: [] as WorkbenchSessionDetailResponseDto["artifacts"],
  }));
  const sessions = { create, enqueue, findById, readSummary } as unknown as WorkbenchSessionsPort;
  // 构造器新增的 sessions 端口追加在末尾（第 9 位），前面的 8 个依赖按既有顺序占位。
  const controller = new WorkbenchController(
    { getSop } as never,
    null,
    { currentGeneration: async () => "0123456789abcdef" } as never,
    null,
    null,
    null,
    null,
    null,
    sessions,
  );
  return { controller, getSop, create, enqueue, findById, readSummary };
}

describe("Workbench sessions — 运行我的草稿", () => {
  it("① happy path：钉死 kind/scope/creator/trigger，入队恰好一次", async () => {
    const h = makeHarness();
    const res = await h.controller.createSession(DTO, USER);

    expect(res).toEqual({ sessionId: SESSION_ID, status: "pending" });
    expect(h.create).toHaveBeenCalledTimes(1);
    const input = h.create.mock.calls[0][0];
    expect(input.kind).toBe("sop_authoring");
    expect(input.scope).toEqual({ sops: [SOP_ID] });
    expect(input.createdBy).toBe("user:42");
    expect(input.triggerSource).toBe("workbench");
    expect(input.context).toMatchObject({
      goal: DTO.goal,
      sopId: SOP_ID,
      cardHash: DTO.expectedCardHash,
      policyGeneration: "0123456789abcdef",
    });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith(SESSION_ID, "trigger:workbench");
  });

  it("② 他人 draft → 403", async () => {
    const h = makeHarness({ sop: { createdBy: "user:99" } });
    await expect(h.controller.createSession(DTO, USER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.create).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("③ 非 draft → 400 VALIDATION_FAILED，零会话/零入队", async () => {
    const h = makeHarness({ sop: { status: "published" } });
    let caught: unknown;
    try {
      await h.controller.createSession(DTO, USER);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as AppError).errorCode).toBe(ErrorCode.VALIDATION_FAILED);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("④ ADMIN 可以代跑他人 draft（管理面例外）", async () => {
    const h = makeHarness({ sop: { createdBy: "user:99" } });
    const res = await h.controller.createSession(DTO, ADMIN);
    expect(res.sessionId).toBe(SESSION_ID);
    expect(h.create.mock.calls[0][0].createdBy).toBe("user:1");
  });

  it("⑤ DTO whitelist：kind/scope/createdBy/triggerSource 注入字段不存在", async () => {
    const klass = CreateWorkbenchSessionDto as unknown as {
      prototype: Record<string, unknown>;
    };
    for (const key of [
      "kind",
      "scope",
      "createdBy",
      "triggerSource",
      "status",
      "sessionId",
    ]) {
      expect(klass.prototype[key]).toBeUndefined();
    }
    // 真实 class-validator：合法字段全对、无错误；越权字段即使出现在原始
    // payload 里也不会成为 DTO 的校验目标（HTTP 层 ValidationPipe whitelist
    // + forbidNonWhitelisted 会在进入 handler 之前剥除/拒绝，见 e2e 覆盖）。
    const forged = plainToInstance(CreateWorkbenchSessionDto, {
      ...DTO,
      kind: "incident",
      scope: { apps: ["*"] },
    } as never);
    const errors = await validate(forged);
    expect(errors).toEqual([]);
  });

  it("⑥ expectedCardHash 必须 16 位十六进制", async () => {
    const bad = plainToInstance(CreateWorkbenchSessionDto, {
      ...DTO,
      expectedCardHash: "not-a-hash",
    } as never);
    const errors = await validate(bad);
    expect(errors.some((e) => e.property === "expectedCardHash")).toBe(true);
  });

  it("⑦ 读回：本人可读；他人/不存在 404；ADMIN 可读", async () => {
    const own = makeHarness();
    const detail = await own.controller.getSession(SESSION_ID, USER);
    expect(detail.sessionId).toBe(SESSION_ID);
    expect(detail.scope).toEqual({ sops: [SOP_ID] });
    expect(detail.stepCount).toBe(0);

    // AppError 按状态码挂到内置异常原型上（见 app-error.ts），故 instanceof
    // NotFoundException 亦为真；同时 errorCode 必须带对。
    const assertNotFound = async (p: Promise<unknown>) => {
      try {
        await p;
        throw new Error("expected rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
        expect((err as AppError).errorCode).toBe(
          ErrorCode.AGENT_SESSION_NOT_FOUND,
        );
      }
    };
    const other = makeHarness();
    await assertNotFound(other.controller.getSession(SESSION_ID, OTHER));

    const missing = makeHarness({ session: null });
    await assertNotFound(missing.controller.getSession(SESSION_ID, USER));

    const admin = makeHarness();
    await expect(
      admin.controller.getSession(SESSION_ID, ADMIN),
    ).resolves.toMatchObject({ sessionId: SESSION_ID });
  });

  it("⑧ 依赖缺席 → 503 DEPENDENCY_UNAVAILABLE（不回空壳）", async () => {
    const controller = new WorkbenchController({ getSop: jest.fn() } as never);
    let caught: unknown;
    try {
      await controller.createSession(DTO, USER);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect((caught as AppError).errorCode).toBe(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );
  });
});

/**
 * R289 · SOP 单条指派取消 — 级别 3 真 PG + 真 Nest 进程内集成测试。
 *
 * 与 `agent-resume-bullmq.spec.ts` 同一环境隔离纪律：
 * 仅当显式给出隔离 PG 映射端口 `SOP_CANCEL_TEST_PG_PORT`（且非宿主默认 5432）时运行，
 * 避免未跑迁移的 CI 单测分片误连开发机/宿主库；给出端口后即直连真实 PostgreSQL，
 * 任何建表/约束/触发器/权限问题均硬失败，绝不静默跳过。
 *
 * 覆盖真实副作用（对应 Stage 1 红队验收清单 #16）：
 *  ① `POST /sop/assignments/:id/cancel`（含脱敏密钥的 `reason`）真实落库 `status='cancelled'`、
 *     保留 `resultJson`、写 1 条 `audit_logs`（`sop.assignment.cancel` / `sop_assignment` /
 *     `detail.sopId` / 脱敏后 `detail.reason` + `detail.reasonLength`），且 `lagging` 与
 *     `clarifications/pending` 双收件箱计数实减 1 并移除该行；
 *  ② 并发双取消（`Promise.all` 真 PG 行锁竞争）：仅 1 胜（200 + 1 条审计）1 败（400
 *     `SOP_ASSIGNMENT_TERMINAL` + 0 审计）；
 *  ③ 空体/`{}` 200（审计省略 `reason`），未知键/超 500 字/非 UUID 400，不存在 404，
 *     已 `completed` 400 且不覆写不落审计；
 *  ④ 取消后 `humanReply` 返 400 `SOP_ASSIGNMENT_TERMINAL` 且澄清行不动；`failed` 工单
 *     `humanReply` 仍 201 放行（R280 语义）；
 *  ⑤ 取消后执行器侧 `pollPending` 不再下发、`recordProgress` 抛 `SOP_ASSIGNMENT_TERMINAL`、
 *     `completeAssignment` 返回 `{ accepted: false }` 且 DB 保持 `cancelled`。
 */
import { randomUUID } from "node:crypto";
import {
  type ExecutionContext,
  type INestApplication,
  ValidationPipe,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import request from "supertest";
import { DataSource, Repository } from "typeorm";

import { HttpExceptionFilter } from "../../../common/filters/http-exception.filter";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { AuditLog } from "../../audit/entities/audit-log.entity";
import { AuditService } from "../../audit/audit.service";
import { UserRole } from "../../users/entities/user.entity";
import { AgentSessionService } from "../../agent/runtime/agent-session.service";
import { AGENT_QUEUE_NAME } from "../../agent/runtime/agent.processor";
import { ExecutorService } from "../../executor/executor.service";
import { NotificationService } from "../../notification/notification.service";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { AgentMedia } from "../entities/agent-media.entity";
import { Sop } from "../entities/sop.entity";
import { SopAssignment } from "../entities/sop-assignment.entity";
import { SopClarification } from "../entities/sop-clarification.entity";
import { SopVersion } from "../entities/sop-version.entity";
import { SopAssignmentActionsService } from "../sop-assignment-actions.service";
import { SopAssignmentLagService } from "../sop-assignment-lag.service";
import { SopClarificationInboxService } from "../sop-clarification-inbox.service";
import { SopController } from "../sop.controller";
import { SopMediaService } from "../sop-media.service";
import { SopService } from "../sop.service";

const rawPgPort = process.env.SOP_CANCEL_TEST_PG_PORT;
const live = rawPgPort === undefined ? describe.skip : describe;

type VerificationSettle = (
  assignmentId: string,
  verdict: "passed" | "failed" | "unclear",
) => Promise<void>;
type ApprovalWakeupProbe = (sessionId: string) => Promise<void>;

/**
 * ADR-027 测试替身保真：AgentSessionService 的两个「反向注册」端口在这里
 * 必须保持真服务同签名、同语义——调用即存下回调（可调用的 setter），不是
 * 空 no-op。`SopService.onModuleInit()` 会调 `attachVerificationSettle`，
 * 替身漏一个方法就让 app.init() 直接 TypeError（CI e2e-full 已复现）。
 * getter 让用例能断言回调确实注册成功，避免再次出现「假绿」。
 */
function makeAgentSessionsStub() {
  let verificationSettle: VerificationSettle | null = null;
  let approvalWakeupProbe: ApprovalWakeupProbe | null = null;
  return {
    create: jest.fn(async () => ({ id: randomUUID() })),
    requireById: jest.fn(),
    findStatusByIds: jest.fn(async () => []),
    attachVerificationSettle: jest.fn((settle: VerificationSettle) => {
      verificationSettle = settle;
    }),
    attachApprovalWakeupProbe: jest.fn((probe: ApprovalWakeupProbe) => {
      approvalWakeupProbe = probe;
    }),
    getVerificationSettle: () => verificationSettle,
    getApprovalWakeupProbe: () => approvalWakeupProbe,
  };
}

live("SOP 单条指派取消 · 真 PG + 真 Nest 集成验收（级别 3）", () => {
  let app: INestApplication;
  let db: DataSource;
  let sopRepo: Repository<Sop>;
  let versionRepo: Repository<SopVersion>;
  let assignmentRepo: Repository<SopAssignment>;
  let clarificationRepo: Repository<SopClarification>;
  let auditRepo: Repository<AuditLog>;
  let sopService: SopService;
  const agentSessionsStub = makeAgentSessionsStub();

  const createdSopIds: string[] = [];
  const createdAssignmentIds: string[] = [];
  const createdClarificationIds: string[] = [];
  const runTag = `r289-int-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const port = Number(rawPgPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === 5432) {
      throw new Error(
        "SOP_CANCEL_TEST_PG_PORT must be an isolated mapped port (not 5432)",
      );
    }
    const database = process.env.SOP_CANCEL_TEST_PG_DB ?? "autoflow_r289";
    if (!/(^|_)(test|e2e|r\d+)(_|$)/i.test(database)) {
      throw new Error(`Refusing to run against non-test database: ${database}`);
    }
    const host = process.env.SOP_CANCEL_TEST_PG_HOST ?? "127.0.0.1";
    const username = process.env.SOP_CANCEL_TEST_PG_USER ?? "autoflow";
    const password = process.env.SOP_CANCEL_TEST_PG_PASSWORD ?? "test";

    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "postgres",
          host,
          port,
          username,
          password,
          database,
          entities: [
            Sop,
            SopVersion,
            SopAssignment,
            SopClarification,
            AgentMedia,
            AuditLog,
          ],
          synchronize: false,
        }),
        TypeOrmModule.forFeature([
          Sop,
          SopVersion,
          SopAssignment,
          SopClarification,
          AgentMedia,
          AuditLog,
        ]),
      ],
      controllers: [SopController],
      providers: [
        AuditService,
        SopService,
        SopAssignmentActionsService,
        SopAssignmentLagService,
        SopClarificationInboxService,
        {
          provide: SopMediaService,
          useValue: {
            requireById: jest.fn(),
            openStream: jest.fn(),
            listByAssignment: jest.fn(async () => []),
          },
        },
        {
          provide: ExecutorService,
          useValue: {
            getAgentCapabilities: jest.fn(async () => ["agent:sop"]),
            listSopCapableExecutors: jest.fn(async () => []),
            findByAddress: jest.fn(async () => null),
          },
        },
        {
          provide: AgentSessionService,
          useValue: agentSessionsStub,
        },
        {
          provide: NotificationService,
          useValue: { notify: jest.fn(async () => undefined) },
        },
        {
          provide: SchedulerService,
          useValue: { getStats: () => ({ isLeader: false }) },
        },
        {
          provide: getQueueToken(AGENT_QUEUE_NAME),
          useValue: { add: jest.fn(async () => undefined) },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => undefined) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: 9001, username: "r289-admin", role: UserRole.ADMIN };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    // 反向注册必须真的落进替身：SopService.onModuleInit 在 app.init() 里注册
    // verification settle；缺方法会让这里抛 TypeError，缺语义会让 getter 为空。
    expect(agentSessionsStub.attachVerificationSettle).toHaveBeenCalledTimes(1);
    expect(agentSessionsStub.getVerificationSettle()).toBeInstanceOf(Function);

    db = app.get(DataSource);
    sopRepo = db.getRepository(Sop);
    versionRepo = db.getRepository(SopVersion);
    assignmentRepo = db.getRepository(SopAssignment);
    clarificationRepo = db.getRepository(SopClarification);
    auditRepo = db.getRepository(AuditLog);
    sopService = app.get(SopService);
  });

  afterAll(async () => {
    try {
      if (db?.isInitialized) {
        if (createdClarificationIds.length > 0) {
          await db.query(
            `DELETE FROM sop_clarifications WHERE id = ANY($1::uuid[])`,
            [createdClarificationIds],
          );
        }
        if (createdAssignmentIds.length > 0) {
          await db.query(
            `DELETE FROM sop_assignments WHERE id = ANY($1::uuid[])`,
            [createdAssignmentIds],
          );
        }
        if (createdSopIds.length > 0) {
          await db.query(
            `DELETE FROM sop_versions WHERE "sopId" = ANY($1::uuid[])`,
            [createdSopIds],
          );
          await db.query(`DELETE FROM sops WHERE id = ANY($1::uuid[])`, [
            createdSopIds,
          ]);
        }
        // SEC-10：audit_logs 有 append-only 触发器，测试收尾在事务内显式开启 bypass GUC 清理测试审计行。
        const resourceIds = [
          ...createdAssignmentIds,
          ...createdClarificationIds,
          ...createdSopIds,
        ];
        if (resourceIds.length > 0) {
          await db.transaction(async (mgr) => {
            await mgr.query(`SET LOCAL app.bypass_audit_guard = 'on'`);
            await mgr.query(
              `DELETE FROM audit_logs WHERE "resourceId" = ANY($1::text[])`,
              [resourceIds],
            );
          });
        }
      }
    } finally {
      await app?.close();
    }
  });

  async function seedSop(suffix: string): Promise<Sop> {
    const sop = sopRepo.create({
      slug: `${runTag}-${suffix}`,
      title: `R289 SOP ${suffix}`,
      status: "published",
      currentVersion: "1.0.0",
      frontMatterJson: { acceptance: [] },
      bodyMarkdown: "# R289 integration test",
      createdBy: "user:9001",
    });
    const saved = await sopRepo.save(sop);
    createdSopIds.push(saved.id);
    const v = versionRepo.create({
      sopId: saved.id,
      version: "1.0.0",
      frontMatterJson: { acceptance: [], capabilities: [] },
      bodyMarkdown: "# R289 integration test",
      changelog: "init",
      contentHash: randomUUID().replace(/-/g, ""),
      publishedBy: "user:9001",
      publishedAt: new Date(),
    });
    await versionRepo.save(v);
    return saved;
  }

  async function seedAssignment(
    sopId: string,
    overrides: Partial<SopAssignment> = {},
    ageHours = 0,
  ): Promise<SopAssignment> {
    const row = assignmentRepo.create({
      sopId,
      sopVersion: "1.0.0",
      targetExecutorId: randomUUID(),
      status: "blocked",
      clarificationRound: 5,
      maxRounds: 5,
      resultJson: null,
      attempt: 0,
      assignedBy: "user:9001",
      ...overrides,
    });
    const saved = await assignmentRepo.save(row);
    createdAssignmentIds.push(saved.id);
    if (ageHours > 0) {
      const oldTs = new Date(Date.now() - ageHours * 3600 * 1000);
      await db.query(
        `UPDATE sop_assignments SET "updatedAt" = $2 WHERE id = $1`,
        [saved.id, oldTs],
      );
      saved.updatedAt = oldTs;
    }
    return saved;
  }

  async function seedClarification(
    assignmentId: string,
    overrides: Partial<SopClarification> = {},
  ): Promise<SopClarification> {
    const row = clarificationRepo.create({
      assignmentId,
      round: 6,
      question: "maxRounds exhausted test question",
      resolution: "escalated_to_human",
      answer: null,
      ...overrides,
    });
    const saved = await clarificationRepo.save(row);
    createdClarificationIds.push(saved.id);
    return saved;
  }

  it("blocked 滞留单单条取消：真实落库、保留 resultJson、审计脱敏、双收件箱扣减、执行器侧全闭合", async () => {
    const sop = await seedSop("blocked-flow");
    const executorId = randomUUID();
    const a = await seedAssignment(
      sop.id,
      {
        targetExecutorId: executorId,
        status: "blocked",
        resultJson: { keep: "evidence" },
      },
      48,
    );
    const clar = await seedClarification(a.id, {
      resolution: "escalated_to_human",
    });

    // 取消前：两个收件箱均包含该单
    const lagBefore = await request(app.getHttpServer())
      .get("/sop/assignments/lagging?hours=24")
      .expect(200);
    expect(
      lagBefore.body.items.some(
        (x: { assignmentId: string }) => x.assignmentId === a.id,
      ),
    ).toBe(true);
    const lagTotalBefore = lagBefore.body.total as number;

    const inboxBefore = await request(app.getHttpServer())
      .get("/sop/clarifications/pending")
      .expect(200);
    expect(
      inboxBefore.body.items.some(
        (x: { clarificationId: string }) => x.clarificationId === clar.id,
      ),
    ).toBe(true);
    const inboxTotalBefore = inboxBefore.body.total as number;

    // 执行单条取消（带敏感凭据测试 reason 脱敏）
    const secret = "sk-live-secret1234567890abcdef";
    const reason = `滞留超 48h 人工取消，误粘密钥 ${secret}`;
    const res = await request(app.getHttpServer())
      .post(`/sop/assignments/${a.id}/cancel`)
      .send({ reason })
      .expect(200);

    expect(res.body.previousStatus).toBe("blocked");
    expect(res.body.assignment.id).toBe(a.id);
    expect(res.body.assignment.status).toBe("cancelled");
    expect(res.body.assignment.resultJson).toEqual({ keep: "evidence" });

    // ① 真 PG 行断言：status=cancelled 且 resultJson 未覆写
    const dbRow = await assignmentRepo.findOne({ where: { id: a.id } });
    expect(dbRow?.status).toBe("cancelled");
    expect(dbRow?.resultJson).toEqual({ keep: "evidence" });

    // ② 真 PG audit_logs 断言：恰 1 条、action/resource/detail.sopId、无明文密钥
    const audits = await auditRepo.find({
      where: { resource: "sop_assignment", resourceId: a.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("sop.assignment.cancel");
    expect(audits[0].userId).toBe(9001);
    expect(audits[0].username).toBe("r289-admin");
    expect(audits[0].detail).toMatchObject({
      sopId: sop.id,
      sopVersion: "1.0.0",
      executorId,
      from: "blocked",
      to: "cancelled",
      scope: "single",
      reasonLength: reason.length,
    });
    expect(String(audits[0].detail?.reason ?? "")).not.toContain(secret);

    // ③ 双收件箱真 SQL 对账：计数实减 1 且条目消失
    const lagAfter = await request(app.getHttpServer())
      .get("/sop/assignments/lagging?hours=24")
      .expect(200);
    expect(
      lagAfter.body.items.some(
        (x: { assignmentId: string }) => x.assignmentId === a.id,
      ),
    ).toBe(false);
    expect(lagAfter.body.total).toBe(lagTotalBefore - 1);

    const inboxAfter = await request(app.getHttpServer())
      .get("/sop/clarifications/pending")
      .expect(200);
    expect(
      inboxAfter.body.items.some(
        (x: { clarificationId: string }) => x.clarificationId === clar.id,
      ),
    ).toBe(false);
    expect(inboxAfter.body.total).toBe(inboxTotalBefore - 1);

    // ④ 取消后 humanReply 拦截 400 SOP_ASSIGNMENT_TERMINAL，澄清行不动
    const replyRes = await request(app.getHttpServer())
      .post(`/sop/assignments/${a.id}/clarifications/${clar.id}/reply`)
      .send({ resolution: "answered", answer: "should be rejected" })
      .expect(400);
    expect(replyRes.body.errorCode).toBe("SOP_ASSIGNMENT_TERMINAL");
    const clarAfter = await clarificationRepo.findOne({
      where: { id: clar.id },
    });
    expect(clarAfter?.resolution).toBe("escalated_to_human");
    expect(clarAfter?.answer).toBeNull();

    // ⑤ 执行器侧全闭合：poll 不再下发、progress 400、complete accepted:false
    const polled = await sopService.pollPending({ executorId });
    expect(polled).toEqual([]);

    await expect(
      sopService.recordProgress({ assignmentId: a.id, executorId }),
    ).rejects.toMatchObject({ errorCode: "SOP_ASSIGNMENT_TERMINAL" });

    const completed = await sopService.completeAssignment({
      assignmentId: a.id,
      executorId,
      status: "completed",
      attempt: 1,
      result: { summary: "late completion" },
    });
    expect(completed).toEqual({ accepted: false });
    expect(
      (await assignmentRepo.findOne({ where: { id: a.id } }))?.status,
    ).toBe("cancelled");
  });

  it("并发双取消（真 PG 行锁）：仅 1 胜（200 + 1 条审计）1 败（400 SOP_ASSIGNMENT_TERMINAL + 0 审计）", async () => {
    const sop = await seedSop("race");
    const a = await seedAssignment(sop.id, { status: "blocked" });

    const [r1, r2] = await Promise.all([
      request(app.getHttpServer())
        .post(`/sop/assignments/${a.id}/cancel`)
        .send({ reason: "admin-A" }),
      request(app.getHttpServer())
        .post(`/sop/assignments/${a.id}/cancel`)
        .send({ reason: "admin-B" }),
    ]);

    const statuses = [r1.status, r2.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 400]);
    const loser = r1.status === 400 ? r1 : r2;
    expect(loser.body.errorCode).toBe("SOP_ASSIGNMENT_TERMINAL");
    expect(loser.body.params).toEqual({ status: "cancelled" });

    const audits = await auditRepo.find({
      where: { resource: "sop_assignment", resourceId: a.id },
    });
    expect(audits).toHaveLength(1);
  });

  it("空体/{} 均 200（省略 reason），未知键/超长/非 UUID 400，不存在 404，completed 400 不落审计", async () => {
    const sop = await seedSop("validation");
    const aEmpty = await seedAssignment(sop.id, { status: "assigned" });
    const aBrace = await seedAssignment(sop.id, { status: "stalled" });
    const aDone = await seedAssignment(sop.id, {
      status: "completed",
      resultJson: { ok: true },
    });

    // 空请求体（不发 JSON body）
    const resEmpty = await request(app.getHttpServer())
      .post(`/sop/assignments/${aEmpty.id}/cancel`)
      .expect(200);
    expect(resEmpty.body.previousStatus).toBe("assigned");
    expect(resEmpty.body.assignment.status).toBe("cancelled");
    const emptyAudit = await auditRepo.findOne({
      where: { resource: "sop_assignment", resourceId: aEmpty.id },
    });
    expect(emptyAudit?.detail).not.toHaveProperty("reason");
    expect(emptyAudit?.detail).not.toHaveProperty("reasonLength");

    // 空对象 {}
    const resBrace = await request(app.getHttpServer())
      .post(`/sop/assignments/${aBrace.id}/cancel`)
      .send({})
      .expect(200);
    expect(resBrace.body.previousStatus).toBe("stalled");

    // 未知键 → 400
    await request(app.getHttpServer())
      .post(`/sop/assignments/${aDone.id}/cancel`)
      .send({ reason: "ok", extra: 1 })
      .expect(400);

    // 超 500 字符 → 400
    await request(app.getHttpServer())
      .post(`/sop/assignments/${aDone.id}/cancel`)
      .send({ reason: "x".repeat(501) })
      .expect(400);

    // 非 UUID → 400 INVALID_VALUE_FORMAT
    const badUuid = await request(app.getHttpServer())
      .post("/sop/assignments/not-a-uuid/cancel")
      .send({})
      .expect(400);
    expect(badUuid.body.errorCode).toBe("INVALID_VALUE_FORMAT");

    // 不存在 UUID → 404 SOP_ASSIGNMENT_NOT_FOUND
    const missing = await request(app.getHttpServer())
      .post(`/sop/assignments/${randomUUID()}/cancel`)
      .send({})
      .expect(404);
    expect(missing.body.errorCode).toBe("SOP_ASSIGNMENT_NOT_FOUND");

    // completed 终态 → 400 SOP_ASSIGNMENT_TERMINAL，DB 与审计不动
    const doneRes = await request(app.getHttpServer())
      .post(`/sop/assignments/${aDone.id}/cancel`)
      .send({})
      .expect(400);
    expect(doneRes.body.errorCode).toBe("SOP_ASSIGNMENT_TERMINAL");
    expect(doneRes.body.params).toEqual({ status: "completed" });
    expect(
      (await assignmentRepo.findOne({ where: { id: aDone.id } }))?.status,
    ).toBe("completed");
    expect(
      await auditRepo.count({
        where: { resource: "sop_assignment", resourceId: aDone.id },
      }),
    ).toBe(0);
  });

  it("R280 语义保底：failed 工单仍允许 humanReply（201），不误伤既有升级修订链路", async () => {
    const sop = await seedSop("failed-reply");
    const aFailed = await seedAssignment(sop.id, { status: "failed" });
    const clar = await seedClarification(aFailed.id, {
      resolution: "escalated_to_human",
    });

    const res = await request(app.getHttpServer())
      .post(`/sop/assignments/${aFailed.id}/clarifications/${clar.id}/reply`)
      .send({ resolution: "answered", answer: "补充说明后可重派" })
      .expect(201);
    expect(res.body.ok).toBe(true);
    const updatedClar = await clarificationRepo.findOne({
      where: { id: clar.id },
    });
    expect(updatedClar?.resolution).toBe("answered");
  });
});
